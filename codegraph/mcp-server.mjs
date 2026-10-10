#!/usr/bin/env node
// MCP stdio server exposing codegraph to any MCP client (Antigravity, Claude Desktop, …).
// Raw JSON-RPC on purpose: no SDK dependency, so nothing here needs module resolution
// beyond node builtins.
// Repo-agnostic: the target repository is a per-call `root` argument, so one server instance
// serves any checkout. CODEGRAPH_ROOT is only a fallback default.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { availableParallelism } from 'node:os'


const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
let CodeGraphEngine, SemanticCheckerWorker, McpProjectRuntime, DaemonQueryEngine, isFrameworkExport, qualifiedQuery, controlFileHashes, createSourcePolicy, fileContentHash, GraphStore, MmapQueryCache, prepareQueryViewCache, nativeMmapAdapter, createLanguageAnalyzers, createTypeScriptLanguageAnalyzer
if (direct) await import('./mcp.mjs')
else {
  ;({ CodeGraphEngine } = await import('./tool-engine.mjs'))
  ;({ SemanticCheckerWorker } = await import('./semantic-checker-worker.mjs'))
  ;({ McpProjectRuntime } = await import('./mcp-runtime.mjs'))
  ;({ DaemonQueryEngine } = await import('./daemon-query-engine.mjs'))
  ;({ isFrameworkExport } = await import('./framework-exports.mjs'))
  ;({ qualifiedQuery } = await import('./query-target.mjs'))
  ;({ controlFileHashes, createSourcePolicy, fileContentHash } = await import('./source-policy.mjs'))
  ;({ GraphStore } = await import('./store.mjs'))
  ;({ MmapQueryCache } = await import('./mmap-query-cache.mjs'))
  ;({ prepareQueryViewCache } = await import('./query-cache-schema.mjs'))
  ;({ nativeMmapAdapter } = await import('./native/mmap-adapter.mjs'))
  ;({ createLanguageAnalyzers } = await import('./language-analyzer.mjs'))
  ;({ createTypeScriptLanguageAnalyzer } = await import('./typescript-language-analyzer.mjs'))
}

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

export function createService(options = {}) {
const configured = options.workerCount ?? Number(process.env.CODEGRAPH_PARSER_WORKERS)
const workerBudget = Number.isInteger(configured) && configured >= 0 ? Math.max(1, configured) : Math.max(1, availableParallelism() - 1)
const rss = options.rss ?? (() => process.memoryUsage().rss)
const retentionHighWaterBytes = 1024 ** 3
const roots = new Map()
let heavy = null, closingHeavy = null, retiringHeavy = null, running = null, closed = false, lastRoot = null
const resolveRoot = (a) => {
  const raw = typeof a?.root === 'string' && a.root.trim()
  if (!raw) throw new Error('missing required argument "root": absolute path of the repository to analyze.')
  const root = path.resolve(raw)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`"${root}" is not a valid directory — pass the repository root you are working in.`)
  return fs.realpathSync(root)
}
const analyzersFor = (root) => createLanguageAnalyzers(root, [createTypeScriptLanguageAnalyzer])
const call = {}
function descriptor(root, owner) {
  if (closed) throw new Error('CodeGraph service is closed')
  root = resolveRoot({ root })
  let item = roots.get(root)
  if (!item) {
    const policy = createSourcePolicy(root, analyzersFor(root))
    item = { root, policy, owners: new Set(), listeners: new Set(), jobs: [], reads: 0, query: null, cache: null, watchRuntime: null }
    roots.set(root, item)
    const facade = {
      policy, reconcile: async () => {}, dispose: async () => {},
      registeredFiles: () => {
        const files = new Set()
        try { for (const file of Object.keys(new GraphStore(root).readGeneration().sources ?? {})) files.add(file) } catch {}
        for (const [file, hash] of Object.entries(controlFileHashes(root, analyzersFor(root)))) if (hash) files.add(file)
        return files
      },
      incremental: async (events) => {
        await enqueue(item, 'incremental', { events }, { watcher: true })
        setImmediate(() => void cleanup())
      },
    }
    item.facade = facade
    startWatch(item)
  }
  if (owner) item.owners.add(owner)
  return item
}
function startWatch(item) {
  item.watchRuntime = new McpProjectRuntime(item.root, { engine: item.facade, nativeWatch: options.watchFactory, onError: error => process.stderr.write(`codegraph watcher: ${error.message}\n`) })
  item.watchReady = item.watchRuntime.start()
}
const idle = item => !item.admissionPending && !item.owners.size && !item.listeners.size && !item.jobs.length && !item.reads && running?.item !== item && !item.watchRuntime.queue?.pending.size && !item.watchRuntime.queue?.running
function queryCacheFor(root) {
  const item = descriptor(root)
  return item.cache ??= new MmapQueryCache({ filePath: prepareQueryViewCache(path.join(root, '.codegraph')), root, adapter: nativeMmapAdapter })
}
async function deactivate() {
  const previous = heavy; heavy = null
  if (!previous) { await closingHeavy; return }
  retiringHeavy = previous
  const closing = Promise.resolve(closingHeavy).then(() => previous.runtime.close())
  closingHeavy = closing
  try { await closing } finally { if (closingHeavy === closing) { closingHeavy = null; retiringHeavy = null } }
}
async function activate(item, args = {}) {
  await item.retiring
  if (heavy?.item === item && heavy.profile === args.profile) return heavy.runtime
  await deactivate()
  const engine = options.engineFactory ? await options.engineFactory(item.root, args) : new CodeGraphEngine(item.root, {
    queryCache: queryCacheFor(item.root), profile: args.profile,
    validationWorkerFactory: () => new SemanticCheckerWorker({ structuralCount: workerBudget - 1 }),
  })
  const runtime = new McpProjectRuntime(item.root, { engine, sharedWatcher: true })
  runtime.initialized = item.freshnessDone === true && !!engine.validatedGeneration
  heavy = { item, runtime, profile: args.profile }
  return runtime
}
async function releaseQuery(item) {
  const query = item.query, cache = item.cache
  item.query = null; item.cache = null
  await query?.dispose(); cache?.dispose()
}
async function cleanup() {
  for (const item of roots.values()) if (item.clearCache && !item.reads && !item.cache?.leases.some(Boolean) && heavy?.item !== item && retiringHeavy?.item !== item && running?.item !== item) {
    item.clearCache = false
    await releaseQuery(item)
  }
  if (rss() > retentionHighWaterBytes) {
    for (const item of roots.values()) if (!item.reads && item.cache && !item.cache.leases.some(Boolean) && heavy?.item !== item && retiringHeavy?.item !== item && running?.item !== item) {
      await releaseQuery(item)
    }
    if (!running && heavy && idle(heavy.item)) {
      const item = heavy.item
      await deactivate()
      if (rss() > retentionHighWaterBytes && !item.reads && item.cache && !item.cache.leases.some(Boolean) && heavy?.item !== item && retiringHeavy?.item !== item && running?.item !== item) await releaseQuery(item)
    }
  }
  for (const [root, item] of roots) if (idle(item) && !item.retiring) {
    item.retiring = (async () => {
      await item.watchReady
      if (!idle(item)) return
      await item.watchRuntime.close()
      if (!idle(item)) { startWatch(item); return }
      if (heavy?.item === item) await deactivate()
      if (!idle(item)) { startWatch(item); return }
      await releaseQuery(item)
      if (!idle(item)) { startWatch(item); return }
      roots.delete(root)
    })()
    try { await item.retiring } finally { item.retiring = null }
  }
}
function enqueue(item, op, args = {}, context = {}) {
  if (['build', 'reconcile', 'pinQuery', 'snapshotComplete'].includes(op)) item.admitted = true
  if (closed) return Promise.reject(new Error('CodeGraph service is closed'))
  let job = op === 'build' ? item.jobs.find(job => job.op === op && isDeepStrictEqual(job.args, args)) : null
  if (!job && op === 'build' && running?.item === item && running.op === op && isDeepStrictEqual(running.args, args)) job = running
  if (!job) { job = { item, op, args, watcher: context.watcher === true, waiters: new Set() }; item.jobs.push(job) }
  const promise = new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal: context.signal }
    waiter.abort = () => {
      job.waiters.delete(waiter); reject(new Error('request cancelled'))
      if (!job.waiters.size && running === job) void deactivate().catch(error => process.stderr.write(`codegraph cancellation: ${error.message}\n`))
    }
    job.waiters.add(waiter)
    if (context.signal?.aborted) waiter.abort()
    else context.signal?.addEventListener('abort', waiter.abort, { once: true })
  })
  void drain()
  return promise
}
async function drain() {
  if (running || closed) return
  const ring = [...roots.values()]
  const index = ring.findIndex(item => item.root === lastRoot)
  let item = null
  for (let step = 1; step <= ring.length; step += 1) {
    const candidate = ring[(index + step) % ring.length]
    if (candidate.jobs.length) { item = candidate; break }
  }
  if (!item) { await cleanup(); return }
  const job = item.jobs.shift(); running = job; lastRoot = item.root
  let value, failure
  const publication = ['build', 'incremental', 'reconcile'].includes(job.op)
  if (publication) for (const listener of item.listeners) listener({ status: 'indexing' })
  try {
    await cleanup()
    if (!job.waiters.size) throw new Error('request cancelled')
    const runtime = await activate(item, job.args)
    if (job.op === 'refresh') {
      await deactivate()
      item.clearCache = true
      value = {}
    }
    else if (job.op === 'pinQuery' || job.op === 'snapshotComplete') {
      if (!runtime.initialized) {
        const reconciled = await runtime.engine.reconcile()
        if (reconciled?.validation) await reconciled.validation
        runtime.initialized = true; item.freshnessDone = true
        item.watchRuntime.registered = new Set(runtime.engine.registeredFiles?.() ?? [])
      }
      value = job.op === 'pinQuery'
        ? await runtime.engine.pinQuery(job.args.query, job.args.options)
        : await runtime.engine.snapshotComplete(job.args.generation, job.args.options)
      if (job.op === 'snapshotComplete' && value?.mapped) value = value.graph
      if (job.op === 'pinQuery' && value?.graph?.mapped) value.graph = value.graph.graph
      if (job.op === 'pinQuery' && value?.rows && !Array.isArray(value.rows)) {
        const rows = []
        for await (const row of value.rows) rows.push(row)
        value.rows = rows
      }
    }
    else value = await runtime.engine[job.op](...(job.op === 'incremental' ? [job.args.events] : []))
    if (value?.validation) await value.validation
    if (job.op === 'incremental' && !job.watcher) for (const event of job.args.events ?? []) {
      const file = item.policy.normalize(path.resolve(item.root, event.path))
      if (item.policy.isIgnoredRelative(file) || !item.policy.isSourceRelative(file) && !item.policy.isControlRelative(file)) continue
      if (event.type === 'unlink') item.watchRuntime.registered.delete(file)
      else item.watchRuntime.registered.add(file)
    }
    runtime.initialized = true
    if (job.op === 'build' || job.op === 'reconcile') {
      item.freshnessDone = true
      item.watchRuntime.registered = new Set(runtime.engine.registeredFiles?.() ?? [])
    }
  } catch (error) { failure = error; item.admitted = false; try { await deactivate() } catch {} }
  if (publication) for (const listener of item.listeners) listener({ status: 'ready' })
  for (const waiter of job.waiters) {
    waiter.signal?.removeEventListener('abort', waiter.abort)
    failure ? waiter.reject(failure) : waiter.resolve(value)
  }
  running = null
  await cleanup(); void drain()
}
async function queryEngineFor(root) {
  const item = descriptor(root)
  if (!item.query && fs.existsSync(path.join(root, '.codegraph', 'CURRENT'))) {
    const manifest = new GraphStore(root).readGeneration()
    if (!analyzersFor(root).isManifestCompatible(manifest, Object.keys(manifest.sources ?? {}))) await enqueue(item, 'reconcile')
  }
  if (!item.query) item.query = new DaemonQueryEngine(root, {
    cache: queryCacheFor(root), disposeFallback: false,
    engineFactory: async () => ({
      pinQuery: (query, options) => enqueue(item, 'pinQuery', { query, options }, options),
      snapshotComplete: (generation, options) => enqueue(item, 'snapshotComplete', { generation, options }, options),
    }),
  })
  if (!item.admitted && !item.admission) {
    item.admissionPending = true
    item.admission = new Promise(resolve => setImmediate(resolve)).then(async () => {
      if (!closed && !item.admitted && fs.existsSync(path.join(root, '.codegraph', 'CURRENT'))) await enqueue(item, 'reconcile')
    }).catch(error => { item.admission = null; process.stderr.write(`codegraph freshness: ${error.message}\n`) }).finally(() => { item.admissionPending = false; void cleanup() })
  }
  return item.query
}
const indexRuntime = (root, args, context) => enqueue(descriptor(root), 'build', args, context)
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
  const root = resolveRoot(a); const engine = await queryEngineFor(root); const target = qualifiedQuery(required(a, 'symbol'), analyzersFor(root))
  const pinned = await engine.pinQuery({ type: 'refs', edgeCoverage: 'complete', resolved: true, ...target }, { signal }); const rows = await cappedRows(pinned.rows, signal)
  return rows.map((edge) => `${edge.fromSymbol.file}:${edge.fromSymbol.line} -> ${edge.toSymbol.file}:${edge.toSymbol.line}${edge.call ? ' call' : ''}`).join('\n') || '(no results)'
}
call.codegraph_deps = async (a, { signal } = {}) => {
  const root = resolveRoot(a); const engine = await queryEngineFor(root); const target = required(a, 'target')
  const request = { type: 'deps', resolved: true, ...qualifiedQuery(target, analyzersFor(root)) }
  const pinned = await engine.pinQuery(request, { signal }); const { metadata } = pinned; const rows = await cappedRows(pinned.rows, signal)
  return `${JSON.stringify(metadata)}\n${rows.map((edge) => `${edge.fromSymbol.file}:${edge.fromSymbol.line} -> ${edge.toSymbol.file}:${edge.toSymbol.line}${edge.call ? ' call' : ''}`).join('\n') || '(no results)'}`
}
call.codegraph_callers = async (a, { signal } = {}) => {
  const root = resolveRoot(a); const engine = await queryEngineFor(root); const pinned = await engine.pinQuery({ type: 'graph', edgeCoverage: 'calls', limit: 1 }, { signal }); const graph = pinned.graph; const depth = Math.max(0, Number(a.depth ?? 3))
  const target = qualifiedQuery(required(a, 'symbol'), analyzersFor(root))
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
call.codegraph_index = async (a, context) => {
  const { root, ...args } = a
  return JSON.stringify(await indexRuntime(resolveRoot(a), args, context))
}

call.codegraph_refresh = async (a, context) => JSON.stringify(await enqueue(descriptor(resolveRoot(a)), 'reconcile', {}, context))
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


async function handle(req, context = {}) {
  const { id, method, params } = req
  const reply = result => ({ jsonrpc: '2.0', id, result })
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codegraph', version: '1.0.0' } })
  if (method === 'tools/list') return reply({ tools: TOOLS })
  if (method === 'ping') return reply({})
  if (method === 'tools/call') {
    const fn = call[params?.name]
    if (!fn) return error(-32602, `unknown tool: ${params?.name}`)
    let item
    try {
      const args = { ...params.arguments, root: params.arguments?.root ?? context.root }
      item = descriptor(resolveRoot(args), context.owner); item.reads += 1
      const text = await fn(args, context)
      return reply({ content: [{ type: 'text', text }] })
    } catch (err) { return reply({ content: [{ type: 'text', text: `error: ${err.message}` }], isError: true }) }
    finally { if (item) { item.reads -= 1; await cleanup() } }
  }
  if (id !== undefined) return error(-32601, `method not found: ${method}`)
}
return {
  handle,
  async *query(root, request, context = {}) {
    const item = descriptor(root, context.owner); item.reads += 1
    try { yield* (await queryEngineFor(item.root)).query(request, context) }
    finally { item.reads -= 1; await cleanup() }
  },
  async queryBatch(root, request, context = {}) {
    const item = descriptor(root, context.owner); item.reads += 1
    try { return await (await queryEngineFor(item.root)).queryBatch(request, context) }
    finally { item.reads -= 1; await cleanup() }
  },
  mutate(root, op, args = {}, context = {}) { return enqueue(descriptor(root, context.owner), op, args, context) },
  subscribe(root, listener, context = {}) {
    const item = descriptor(root, context.owner); item.listeners.add(listener)
    return () => { item.listeners.delete(listener); void cleanup() }
  },
  release(root, owner) { const item = roots.get(root); item?.owners.delete(owner); return cleanup() },
  status() {
    const checker = (heavy ?? retiringHeavy)?.runtime.engine.validationWorker
    let observedWorkerCount = checker?.worker && checker.worker.threadId !== -1 ? 1 : 0
    for (const apartment of checker?.parserPool?.workers ?? []) if (apartment.worker && apartment.worker.threadId !== -1) observedWorkerCount += 1
    return { servicePid: process.pid, workerBudget, observedWorkerCount, heavyRoot: heavy?.item.root ?? null, cacheOwners: [...roots.values()].filter(item => item.cache).length, roots: [...roots.values()].map(item => ({ root: item.root, watchers: item.watchRuntime?.watcher ? 1 : 0, activeQueries: item.reads, pendingHeavy: item.jobs.length, runtime: heavy?.item === item })), rssBytes: rss(), retentionHighWaterBytes, activeWork: !!running || !!closingHeavy }
  },
  async close() {
    closed = true
    let failure
    try { await deactivate() } catch (error) { failure = error }
    for (const item of roots.values()) {
      for (const job of item.jobs) for (const waiter of job.waiters) waiter.reject(new Error('CodeGraph service is closed'))
      item.jobs.length = 0
      const released = await Promise.allSettled([item.watchReady.then(() => item.watchRuntime.close()), item.query?.dispose()])
      for (const result of released) if (result.status === 'rejected') failure ??= result.reason
      try { item.cache?.dispose() } catch (error) { failure ??= error }
    }
    roots.clear()
    if (failure) throw failure

  },
}
}
