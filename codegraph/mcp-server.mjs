#!/usr/bin/env node
// MCP stdio server exposing codegraph to any MCP client (Antigravity, Claude Desktop, …).
// Raw JSON-RPC on purpose: no SDK dependency, so nothing here needs module resolution
// beyond node builtins.
// Repo-agnostic: the target repository is a per-call `root` argument, so one server instance
// serves any checkout. CODEGRAPH_ROOT is only a fallback default.
import fs from 'node:fs'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'
import { DaemonQueryEngine } from './daemon-query-engine.mjs'
import { isFrameworkExport } from './framework-exports.mjs'
import { qualifiedQuery } from './query-target.mjs'
import { controlFileHashes, createSourcePolicy, fileContentHash } from './source-policy.mjs'
import { GraphStore } from './store.mjs'
import { MmapQueryCache } from './mmap-query-cache.mjs'
import { prepareQueryViewCache } from './query-cache-schema.mjs'
import { nativeMmapAdapter } from './native/mmap-adapter.mjs'

const DEFAULT_ROOT = process.env.CODEGRAPH_ROOT ? path.resolve(process.env.CODEGRAPH_ROOT) : null

// Deliberately names no repository: hardcoding one made every description claim to be about
// that project even when the agent was working somewhere else.
const SCOPE =
  'Analyzes ONE TypeScript/JavaScript repository per call. Pass `root` as the absolute path of the repository you are working in. Results are ONLY about that repository. Query responses disclose freshness, coverage, revision, and validatedGeneration so provisional syntax results cannot be mistaken for checker-validated v3 data.'

const ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path to the repository to analyze (JS or TS project). Use the workspace you are currently working in. Omit only if the server has a configured default.',
}

const TOOLS = [
  {
    name: 'codegraph_refs',
    description:
      'Every reference to a TypeScript/JavaScript symbol, resolved by the type checker rather than text search. Follows re-exports and aliases; does not false-hit same-named symbols on other types. Use before renaming, changing a signature, or deleting anything. Accepts "name", "file.ts:name", or "file.ts".',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Symbol name, or file.ts:name to disambiguate' }, root: ROOT_PARAM },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_callers',
    description:
      'Inverted call tree — walks upward from a symbol to the entry points that reach it (route handlers, page components). Answers "how does execution actually get here?". Use for tracing a request path or debugging unexpected invocation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        symbol: { type: 'string' },
        depth: { type: 'integer', description: 'Levels to walk upward (default 3; 2-3 is usually right)' },
        root: ROOT_PARAM,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_deps',
    description:
      'What a file or function calls, in-repo only (node_modules filtered out). Resolves imports to real declarations. Use to judge refactor scope or find the seams in an oversized module. Accepts a file path or a symbol name.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'File path (e.g. src/foo/Bar.tsx) or symbol name' }, root: ROOT_PARAM },
      required: ['target'],
    },
  },
  {
    name: 'codegraph_dead',
    description:
      'READ-ONLY ANALYSIS. Lists exports with no reference outside their own file. This is NOT proof of dead code and is NOT a deletion list. Never delete, comment out, or modify anything based on this output — report the list and let the human decide. String-keyed dynamic access (registry[name]) is invisible to static resolution, and a text search CANNOT confirm deadness: framework-called exports have no textual callers either, so grep will appear to agree while you break the app. Framework-convention exports are withheld from the output for this reason, and the withheld count is reported; pass includeFramework to list them anyway.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'Optional path prefix to scope to, e.g. src/query' },
        includeFramework: { type: 'boolean', description: 'List framework-convention exports too instead of withholding them. Default false.' },
        root: ROOT_PARAM,
      },
    },
  },
  {
    name: 'codegraph_internals',
    description: 'Inspect validated executable internals, scoped structural matches, control-flow paths, and CFG-derived metrics without reparsing source.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PARAM,
        operation: { type: 'string', enum: ['map', 'search', 'paths', 'metrics'] },
        file: { type: 'string', minLength: 1 },
        owner: { oneOf: [
          { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 0, maximum: 4294967295 } }, required: ['id'] },
          { type: 'object', additionalProperties: false, properties: { symbol: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 1 } }, required: ['symbol'] },
          { type: 'object', additionalProperties: false, properties: { line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 }, kind: { type: 'string', enum: ['module', 'function', 'arrow', 'method', 'constructor', 'getter', 'setter', 'static-block', 'field-initializer'] } }, required: ['line', 'column', 'kind'] },
        ] },
        view: { type: 'string', enum: ['syntax', 'control-flow', 'combined'] },
        match: { type: 'object', additionalProperties: false, minProperties: 1, properties: { nodeKind: { type: 'string', enum: ['entry', 'exit', 'statement', 'condition', 'loop', 'case', 'call', 'return', 'throw', 'break', 'continue', 'assignment', 'await', 'yield'] }, edgeKind: { type: 'string', enum: ['next', 'true', 'false', 'case', 'default', 'back', 'break', 'continue', 'return', 'throw', 'exception', 'finally'] }, relationKind: { type: 'string', enum: ['call', 'read', 'write'] }, role: { type: 'string', enum: ['body', 'condition', 'consequent', 'alternate', 'initializer', 'update', 'operand', 'callee', 'argument', 'handler', 'finalizer'] }, targetSymbolId: { type: 'string', minLength: 1 }, ancestorKind: { type: 'string' } } },
        from: { $ref: '#/$defs/nodeSelector' }, to: { $ref: '#/$defs/nodeSelector' }, avoid: { $ref: '#/$defs/nodeSelector' },
        metrics: { type: 'array', items: { type: 'string', enum: ['cyclomatic', 'branchCount', 'nestingDepth'] } },
        generation: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 2000 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 100 }, maxPaths: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['operation', 'file'],
      $defs: { nodeSelector: { type: 'object', additionalProperties: false, minProperties: 1, properties: { id: { type: 'integer', minimum: 0, maximum: 4294967295 }, nodeKind: { type: 'string', enum: ['entry', 'exit', 'statement', 'condition', 'loop', 'case', 'call', 'return', 'throw', 'break', 'continue', 'assignment', 'await', 'yield'] }, role: { type: 'string', enum: ['body', 'condition', 'consequent', 'alternate', 'initializer', 'update', 'operand', 'callee', 'argument', 'handler', 'finalizer'] }, symbolId: { type: 'string', minLength: 1 } } } },
    },
  },
  {
    name: 'codegraph_index',
    description:
      'Force a v3 symbol-graph build with eager call coverage and generation-pinned lazy reference enrichment. Normal edits are handled incrementally by the watcher.',
    inputSchema: { type: 'object', properties: { root: ROOT_PARAM } },
  },
  {
    name: 'codegraph_refresh',
    description: 'Reconcile the persistent incremental index with disk. Normally unnecessary because MCP startup and its watcher do this automatically.',
    inputSchema: { type: 'object', properties: { root: ROOT_PARAM } },
  },
  {
    name: 'codegraph_query',
    description: 'Query the incremental graph with explicit consistency. "latest" returns immediate provisional module-linked syntax; "validated" (the default) returns the last checker-validated v3 generation. Responses disclose freshness, coverage, revision, and validatedGeneration. Explicit generation pins are always validated.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PARAM,
        query: { type: 'object', description: 'Query object, e.g. {"type":"refs","name":"foo"}.' },
      },
      required: ['query'],
    },
  },
].map((t) => ({ ...t, description: `${SCOPE}\n\n${t.description}` }))

// Never String() a possibly-missing argument — that searches for the literal "undefined".
const required = (a, key) => {
  const v = a?.[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`missing required argument "${key}". Pass it as {"${key}": "<name>"}.`)
  }
  return v.trim()
}

const resolveRoot = (a) => {
  const raw = (typeof a?.root === 'string' && a.root.trim()) || DEFAULT_ROOT
  if (!raw) {
    throw new Error('missing required argument "root": absolute path of the repository to analyze.')
  }
  const root = path.resolve(raw)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`"${root}" is not a valid directory — pass the repository root you are working in.`)
  }
  // Symlinks alias one tree under several paths (/tmp vs /private/tmp on macOS). runtimes,
  // queryEngines, lightWatchers and freshnessChecks all key off this, so resolving here is what
  // stops one repository from getting two engines and two parser pools.
  return fs.realpathSync(root)
}

const call = {}

const runtimes = new Map()
const queryCaches = new Map()
const queryCacheFor = (root) => {
  let cache = queryCaches.get(root)
  if (!cache) {
    cache = new MmapQueryCache({ filePath: prepareQueryViewCache(path.join(root, '.codegraph')), root, adapter: nativeMmapAdapter })
    queryCaches.set(root, cache)
  }
  return cache
}
async function runtimeFor(root, initialize = (runtime) => runtime.start()) {
  let pending = runtimes.get(root)
  if (!pending) {
    stopLightWatcher(root)
    pending = import('./mcp-runtime.mjs').then(({ McpProjectRuntime }) => initialize(new McpProjectRuntime(root, { queryCache: queryCacheFor(root) })))
    runtimes.set(root, pending)
    try { await pending } catch (error) { runtimes.delete(root); throw error }
  }
  return pending
}
async function indexRuntime(root) {
  const active = runtimes.has(root)
  let result
  const runtime = await runtimeFor(root, async (created) => {
    result = await created.index()
    return created
  })
  return active ? runtime.index() : result
}

const queryEngines = new Map()
const lightWatchers = new Map()
const freshnessChecks = new Map()
const stopLightWatcher = (root) => { lightWatchers.get(root)?.close(); lightWatchers.delete(root) }
const promoteRuntime = (root) => { stopLightWatcher(root); runtimeFor(root).catch((error) => process.stderr.write(`codegraph-mcp: ${error.message}\n`)) }
const isWatchedChange = (policy, file) => {
  const relative = policy.normalize(file)
  return policy.acceptWatchPath(file) || (!fs.existsSync(file) && policy.isSourceRelative(relative))
}
async function startPollingWatcher(root, policy) {
  if (runtimes.has(root)) return
  try {
    // Native watch exhaustion must not load the parser just to remain fresh. Poll only accepted
    // sources here; the first real change promotes this lightweight guard to the full runtime.
    const { watch } = await import('chokidar')
    const watcher = watch(root, {
      persistent: false,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: true,
      ignored: (candidate, stats) => {
        const relative = policy.normalize(candidate)
        if (relative === '') return false
        if (policy.isIgnoredRelative(relative)) return true
        if (stats?.isDirectory()) return false
        if (stats?.isFile()) return !policy.acceptWatchPath(candidate)
        return false
      },
    })
    lightWatchers.set(root, watcher)
    watcher.on('all', (_event, file) => { if (isWatchedChange(policy, file)) promoteRuntime(root) })
    watcher.on('error', () => promoteRuntime(root))
  } catch { promoteRuntime(root) }
}
function watchForChanges(root) {
  if (lightWatchers.has(root) || runtimes.has(root)) return
  const policy = createSourcePolicy(root)
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
      if (!name) return
      const file = path.join(root, String(name))
      if (isWatchedChange(policy, file)) promoteRuntime(root)
    })
    lightWatchers.set(root, watcher)
    watcher.on('error', () => { stopLightWatcher(root); void startPollingWatcher(root, policy) })
  } catch { void startPollingWatcher(root, policy) }
}
const diskMatchesGeneration = (root, policy) => {
  try {
    const store = new GraphStore(root)
    const generation = store.readGeneration()
    const files = policy.scan()
    const indexed = Object.keys(generation.sources ?? {}).sort()
    return generation.controlHashes && JSON.stringify(generation.controlHashes) === JSON.stringify(controlFileHashes(root)) && files.length === indexed.length && files.every((file, index) => file === indexed[index] && fileContentHash(path.join(root, file)) === generation.sources[file])
  } catch { return false }
}
async function queryEngineFor(root) {
  let engine = queryEngines.get(root)
  if (!engine) {
    engine = new DaemonQueryEngine(root, {
      cache: queryCacheFor(root),
      engineFactory: async () => (await runtimeFor(root)).engine,
      disposeFallback: false,
    })
    queryEngines.set(root, engine)
    watchForChanges(root)
  }
  if (!freshnessChecks.has(root)) {
    const policy = createSourcePolicy(root)
    const freshness = new Promise((resolve) => setImmediate(resolve))
      .then(async () => { if (!diskMatchesGeneration(root, policy)) await runtimeFor(root) })
      .catch((error) => {
        freshnessChecks.delete(root)
        process.stderr.write(`codegraph-mcp refresh: ${error.message}\n`)
      })
    freshnessChecks.set(root, freshness)
  }
  return engine
}

const MAX_MCP_RESULTS = 2_000
const cappedRows = async (iterator, signal) => {
  const rows = []
  for await (const row of iterator) {
    if (signal?.aborted) throw new Error('request cancelled')
    if (rows.length >= MAX_MCP_RESULTS) throw new Error(`result exceeds MCP cap of ${MAX_MCP_RESULTS}; narrow the query`)
    rows.push(row)
  }
  return rows
}
const loc = (graph, id) => { const symbol = graph.symbols.find((item) => item.id === id); return symbol ? `${symbol.file}:${symbol.line}` : id }
call.codegraph_refs = async (a, { signal } = {}) => {
  const engine = await queryEngineFor(resolveRoot(a)); const target = qualifiedQuery(required(a, 'symbol'))
  const pinned = await engine.pinQuery({ type: 'refs', edgeCoverage: 'complete', resolved: true, ...target }, { signal }); const rows = await cappedRows(pinned.rows, signal)
  return rows.map((edge) => `${edge.fromSymbol.file}:${edge.fromSymbol.line} -> ${edge.toSymbol.file}:${edge.toSymbol.line}${edge.call ? ' call' : ''}`).join('\n') || '(no results)'
}
call.codegraph_deps = async (a, { signal } = {}) => {
  const engine = await queryEngineFor(resolveRoot(a)); const target = required(a, 'target')
  const request = { type: 'deps', resolved: true, ...qualifiedQuery(target) }
  const pinned = await engine.pinQuery(request, { signal }); const { metadata } = pinned; const rows = await cappedRows(pinned.rows, signal)
  return `${JSON.stringify(metadata)}\n${rows.map((edge) => `${edge.fromSymbol.file}:${edge.fromSymbol.line} -> ${edge.toSymbol.file}:${edge.toSymbol.line}${edge.call ? ' call' : ''}`).join('\n') || '(no results)'}`
}
call.codegraph_callers = async (a, { signal } = {}) => {
  const engine = await queryEngineFor(resolveRoot(a)); const pinned = await engine.pinQuery({ type: 'graph', edgeCoverage: 'calls', limit: 1 }, { signal }); const graph = pinned.graph; const depth = Math.max(0, Number(a.depth ?? 3))
  const target = qualifiedQuery(required(a, 'symbol'))
  const roots = graph.symbols.filter((symbol) => (!target.name || symbol.name === target.name) && (!target.file || symbol.file === target.file || symbol.file.endsWith(target.file))); const reverse = new Map()
  for (const edge of graph.edges) if (edge.call) { if (!reverse.has(edge.to)) reverse.set(edge.to, new Set()); reverse.get(edge.to).add(edge.from) }
  const output = []; const seen = new Set(); let frontier = roots.map((symbol) => [symbol.id, 0])
  while (frontier.length) {
    if (signal?.aborted) throw new Error('request cancelled')
    const [id, level] = frontier.shift(); if (seen.has(id)) continue; seen.add(id); output.push(`${'  '.repeat(level)}${loc(graph, id)}`)
    if (output.length > MAX_MCP_RESULTS) throw new Error(`result exceeds MCP cap of ${MAX_MCP_RESULTS}; lower depth`)
    if (level < depth) frontier.push(...[...(reverse.get(id) ?? [])].map((parent) => [parent, level + 1]))
  }
  return output.join('\n') || '(no results)'
}
call.codegraph_dead = async (a, { signal } = {}) => {
  const engine = await queryEngineFor(resolveRoot(a)); const pinned = await engine.pinQuery({ type: 'graph', edgeCoverage: 'complete', limit: 1 }, { signal }); const graph = pinned.graph
  // A same-file reference does not make an export live to the outside, so deadness is
  // "no incoming edge FROM ANOTHER FILE" — matching cli.mjs cmdDead and this tool's own
  // description. Filtering on any incoming edge would silently under-report.
  const fileById = new Map(graph.symbols.map((symbol) => [symbol.id, symbol.file]))
  const referencedAcrossFiles = new Set()
  for (const edge of graph.edges) if (fileById.get(edge.from) !== fileById.get(edge.to)) referencedAcrossFiles.add(edge.to)
  const includeFramework = a?.includeFramework === true
  const candidates = graph.symbols.filter((symbol) => symbol.exported && symbol.kind !== 'module' && !referencedAcrossFiles.has(symbol.id) && (!a?.prefix || symbol.file.startsWith(a.prefix)))
  const withheld = candidates.filter((symbol) => isFrameworkExport(symbol.name, symbol.file)).length
  const rows = includeFramework ? candidates : candidates.filter((symbol) => !isFrameworkExport(symbol.name, symbol.file))
  if (signal?.aborted) throw new Error('request cancelled')
  if (rows.length > MAX_MCP_RESULTS) throw new Error(`result exceeds MCP cap of ${MAX_MCP_RESULTS}; pass a path prefix`)
  const notes = [`${rows.length} export(s) with no reference outside their own file.`]
  if (withheld && !includeFramework) notes.push(`${withheld} framework-convention export(s) withheld (called by the framework, not by code).`)
  notes.push('NOT PROOF OF DEAD CODE. Dynamic/string-keyed access is invisible here.')
  notes.push('Do NOT delete anything from this list without explicit human approval.')
  return [...notes, ...rows.map((symbol) => `${symbol.file}:${symbol.line}  ${symbol.name}`)].join('\n')
}
call.codegraph_index = async (a) => JSON.stringify(await indexRuntime(resolveRoot(a)))

call.codegraph_refresh = async (a) => {
  const runtime = await runtimeFor(resolveRoot(a))
  return JSON.stringify(await runtime.engine.reconcile())
}
call.codegraph_internals = async (a, { signal } = {}) => {
  const operations = new Set(['map', 'search', 'paths', 'metrics'])
  if (!operations.has(a?.operation)) throw new Error('operation must be map, search, paths, or metrics')
  const root = resolveRoot(a)
  const file = required(a, 'file').split(path.sep).join('/')
  const absolute = path.resolve(root, file)
  const relative = path.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('file path is outside repository root')
  const integer = (key, min, max, fallback) => {
    const value = Object.hasOwn(a, key) ? a[key] : fallback
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} through ${max}`)
    return value
  }
  const limit = integer('limit', 1, 2000, 2000)
  const exactObject = (value, label, allowed, required = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
    const unknownKey = Object.keys(value).find((key) => !allowed.has(key))
    if (unknownKey) throw new Error(`field ${label}.${unknownKey} is not valid`)
    for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`)
  }
  if (a.owner) {
    exactObject(a.owner, 'owner', new Set(['id', 'symbol', 'line', 'column', 'kind']))
    const shapes = Number(Object.hasOwn(a.owner, 'id')) + Number(Object.hasOwn(a.owner, 'symbol')) + Number(Object.hasOwn(a.owner, 'kind'))
    if (shapes !== 1 || Object.hasOwn(a.owner, 'id') && Object.keys(a.owner).length !== 1 || Object.hasOwn(a.owner, 'kind') && (!Object.hasOwn(a.owner, 'line') || !Object.hasOwn(a.owner, 'column'))) throw new Error('owner must use exactly one supported selector shape')
  }
  if (a.match) exactObject(a.match, 'match', new Set(['nodeKind', 'edgeKind', 'relationKind', 'role', 'targetSymbolId', 'ancestorKind']))
  for (const key of ['from', 'to', 'avoid']) if (a[key]) exactObject(a[key], key, new Set(['id', 'nodeKind', 'role', 'symbolId']))
  if (['map', 'paths', 'metrics'].includes(a.operation) && !a.owner) throw new Error(`owner is required for ${a.operation}`)
  if (a.operation === 'search' && (!a.match || !Object.keys(a.match).length)) throw new Error('match must be a non-empty object')
  if (a.operation === 'paths' && (!a.from || !a.to)) throw new Error('from and to are required for paths')
  const allowed = {
    map: new Set(['root', 'operation', 'file', 'owner', 'view', 'generation', 'limit']),
    search: new Set(['root', 'operation', 'file', 'owner', 'match', 'generation', 'limit']),
    paths: new Set(['root', 'operation', 'file', 'owner', 'from', 'to', 'avoid', 'maxDepth', 'maxPaths', 'generation', 'limit']),
    metrics: new Set(['root', 'operation', 'file', 'owner', 'metrics', 'generation', 'limit']),
  }[a.operation]
  const unknown = Object.keys(a).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`field ${unknown} is not valid for ${a.operation}`)
  const request = { type: 'internals', ...a, root: undefined, file, limit }
  if (a.operation === 'paths') { request.maxDepth = integer('maxDepth', 1, 100, 100); request.maxPaths = integer('maxPaths', 1, 20, 20) }
  const pinned = await (await queryEngineFor(root)).pinQuery(request, { signal })
  const rows = await cappedRows(pinned.rows, signal)
  if (rows.length > limit) throw new Error(`result exceeds requested limit ${limit}; narrow the query`)
  return [JSON.stringify(pinned.metadata), ...rows.map((row) => JSON.stringify(row))].join('\n')
}
call.codegraph_query = async (a, { signal } = {}) => {
  const started = a?.query?.diagnostics === true ? process.hrtime.bigint() : null
  const engine = await queryEngineFor(resolveRoot(a))
  if (!a?.query || typeof a.query !== 'object') throw new Error('missing required argument "query"')
  const { diagnostics, ...query } = a.query
  const consistency = query.generation ? 'validated' : (query.consistency ?? 'validated')
  if (query.generation && query.consistency === 'latest') throw new Error('explicit generation is validated and cannot be combined with latest consistency')
  const pinned = await engine.pinQuery({ ...query, consistency, limit: Math.min(query.limit ?? MAX_MCP_RESULTS, MAX_MCP_RESULTS) }, { signal })
  const rows = await cappedRows(pinned.rows, signal)
  const { freshness, coverage, revision, validatedGeneration } = pinned.metadata
  const metadata = { freshness, coverage, revision, validatedGeneration }
  if (started !== null) Object.assign(metadata, { serverPid: process.pid, serverDurationMs: Number(process.hrtime.bigint() - started) / 1e6 })
  return [JSON.stringify(metadata), ...rows.map((row) => JSON.stringify(row))].join('\n')
}

// Under the shim, replies go back as messages rather than down this thread's stdout: worker stdout
// is forwarded to the host asynchronously with no way to await the handoff, so terminating the
// thread on reload or shutdown silently truncates whatever it had just written.
const send = (msg) => {
  const line = JSON.stringify(msg) + '\n'
  parentPort ? parentPort.postMessage({ out: line }) : process.stdout.write(line)
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(req) {
  const { id, method, params } = req

  if (method === 'notifications/cancelled') {
    activeRequests.get(params?.requestId)?.abort()
    return
  }

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'codegraph', version: '1.0.0' },
    })
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const fn = call[params?.name]
    if (!fn) return replyError(id, -32602, `unknown tool: ${params?.name}`)
    const controller = new AbortController(); activeRequests.set(id, controller)
    try {
      const args = params.arguments ?? {}
      const text = await fn(args, { signal: controller.signal })
      const root = resolveRoot(args)
      if (queryEngines.has(root)) promoteRuntime(root)
      return reply(id, { content: [{ type: 'text', text }] })
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true })
    } finally { activeRequests.delete(id) }
  }
  if (method === 'ping') return reply(id, {})
  // Notifications carry no id and expect no response.
  if (id === undefined) return
  replyError(id, -32601, `method not found: ${method}`)
}

const activeRequests = new Map()
// Requests still being answered. A client that writes one request and closes its pipe ends stdin
// while the query is in flight, so shutdown has to drain these before disposing any engine.
const inFlight = new Set()

let buffer = ''
const feed = (chunk) => {
  buffer += chunk
  for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const answering = handle(JSON.parse(line)).catch((error) => process.stderr.write(`codegraph-mcp: ${error.message}\n`))
      inFlight.add(answering)
      answering.finally(() => inFlight.delete(answering))
    } catch {
      process.stderr.write(`codegraph-mcp: bad JSON-RPC line\n`)
    }
  }
}

const releaseRoots = async () => {
  for (const controller of activeRequests.values()) controller.abort()
  while (inFlight.size) await Promise.allSettled([...inFlight])
  for (const root of lightWatchers.keys()) stopLightWatcher(root)
  const closing = [...runtimes.values()].map(async (runtime) => (await runtime).close())
  const disposing = [...queryEngines.values()].map((engine) => engine.dispose())
  runtimes.clear()
  queryEngines.clear()
  freshnessChecks.clear()
  await Promise.allSettled([...closing, ...disposing])
  for (const cache of queryCaches.values()) cache.dispose()
  queryCaches.clear()
}

// Run as a worker when the shim hosts one, so a code reload can terminate this thread and free its
// whole module graph. The shim owns stdin and forwards lines; worker stdout already reaches the
// client. Input arrives as a string; any other message is a control frame asking for the drain, and
// its reply is what tells the shim it is safe to terminate. Run directly off stdin otherwise, so
// `node mcp-server.mjs` still works on its own.
if (parentPort) {
  parentPort.on('message', (message) => {
    if (typeof message === 'string') return feed(message)
    const confirm = () => parentPort.postMessage({ released: true })
    releaseRoots().then(confirm, confirm)
  })
  parentPort.postMessage({ ready: true })
} else {
  process.stdin.on('data', feed)
  process.stdin.on('end', () => releaseRoots())
}

// SIGINT refreshes rather than exits: the stdio transport is the client's, so terminating would
// drop the connection instead of reloading. Dropping the cached runtimes, engines and mmap pages
// makes the next request re-read the index from disk. This refreshes STATE, not code — new source
// still needs a new process.
// SIGTERM exits, but through the same release path as stdin end. Node's default would terminate
// immediately, leaving the socket and mmap page behind for the next process to clean up.
process.on('SIGTERM', () => {
  releaseRoots()
    .catch((error) => process.stderr.write(`codegraph-mcp shutdown: ${error.message}\n`))
    .finally(() => process.exit(0))
})

let refreshing = null
const warmDefaultRoot = (context) => {
  if (!DEFAULT_ROOT) return
  try {
    const root = resolveRoot({ root: DEFAULT_ROOT })
    if (!diskMatchesGeneration(root, createSourcePolicy(root))) return
    queryEngineFor(root).catch((error) => process.stderr.write(`codegraph-mcp ${context}: ${error.message}\n`))
  } catch (error) {
    process.stderr.write(`codegraph-mcp ${context}: ${error.message}\n`)
  }
}
process.on('SIGINT', () => {
  if (refreshing) return
  refreshing = releaseRoots()
    .then(() => process.stderr.write('codegraph-mcp: refreshed — cached engines released\n'))
    .catch((error) => process.stderr.write(`codegraph-mcp refresh: ${error.message}\n`))
    .finally(() => {
      refreshing = null
      warmDefaultRoot('refresh')
    })
})

warmDefaultRoot('startup')
