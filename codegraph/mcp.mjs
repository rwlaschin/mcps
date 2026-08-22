#!/usr/bin/env node
// MCP stdio server exposing codegraph to any MCP client (Antigravity, Claude Desktop, …).
// Raw JSON-RPC on purpose: no SDK dependency, so nothing here needs module resolution
// beyond node builtins.
// Repo-agnostic: the target repository is a per-call `root` argument, so one server instance
// serves any checkout. CODEGRAPH_ROOT is only a fallback default.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DaemonQueryEngine } from './daemon-query-engine.mjs'
import { qualifiedQuery } from './query-target.mjs'
import { controlFileHashes, createSourcePolicy, fileContentHash } from './source-policy.mjs'
import { GraphStore } from './store.mjs'

const HERE = import.meta.dirname
const DEFAULT_ROOT = process.env.CODEGRAPH_ROOT ? path.resolve(process.env.CODEGRAPH_ROOT) : null
const CLI = path.join(HERE, 'cli.mjs')

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
      'READ-ONLY ANALYSIS. Lists exports with no reference outside their own file. This is NOT proof of dead code and is NOT a deletion list. Never delete, comment out, or modify anything based on this output — report the list and let the human decide. String-keyed dynamic access (registry[name]) is invisible to static resolution, and a text search CANNOT confirm deadness: framework-called exports have no textual callers either, so grep will appear to agree while you break the app. Framework-convention exports are withheld from the output for this reason.',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string', description: 'Optional path prefix to scope to, e.g. src/query' }, root: ROOT_PARAM },
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

function runCli(args, root) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args, '--root', root], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() || '(no results)'
  } catch (err) {
    // cli.mjs exits non-zero for "no such symbol" and missing index — both are useful answers.
    return [err.stdout, err.stderr].filter(Boolean).join('\n').trim() || `codegraph failed: ${err.message}`
  }
}

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
  return root
}

const call = {}

const runtimes = new Map()
async function runtimeFor(root) {
  let pending = runtimes.get(root)
  if (!pending) {
    stopLightWatcher(root)
    pending = import('./mcp-runtime.mjs').then(({ McpProjectRuntime }) => new McpProjectRuntime(root).start())
    runtimes.set(root, pending)
    try { await pending } catch (error) { runtimes.delete(root); throw error }
  }
  return pending
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
    const policy = createSourcePolicy(root)
    engine = new DaemonQueryEngine(root, {
      engineFactory: async () => (await runtimeFor(root)).engine,
      beforeQuery: async () => { const promotion = runtimes.get(root); if (promotion) await promotion },
      disposeFallback: false,
    })
    queryEngines.set(root, engine)
    watchForChanges(root)
    const freshness = Promise.resolve()
      .then(async () => { if (!diskMatchesGeneration(root, policy)) await runtimeFor(root) })
      .catch(async (error) => { queryEngines.delete(root); freshnessChecks.delete(root); await engine.dispose(); throw error })
    freshnessChecks.set(root, freshness)
  }
  await freshnessChecks.get(root)
  const promotion = runtimes.get(root)
  if (promotion) await promotion
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
  const engine = await queryEngineFor(resolveRoot(a)); const pinned = await engine.pinQuery({ type: 'graph', edgeCoverage: 'complete', limit: 1 }, { signal }); const graph = pinned.graph; const referenced = new Set(graph.edges.map((edge) => edge.to))
  const rows = graph.symbols.filter((symbol) => symbol.exported && !referenced.has(symbol.id) && (!a?.prefix || symbol.file.startsWith(a.prefix)))
  if (signal?.aborted) throw new Error('request cancelled')
  if (rows.length > MAX_MCP_RESULTS) throw new Error(`result exceeds MCP cap of ${MAX_MCP_RESULTS}; pass a path prefix`)
  return `${rows.length} export(s) with no resolved reference. NOT PROOF OF DEAD CODE.\n${rows.map((symbol) => `${symbol.file}:${symbol.line}  ${symbol.name}`).join('\n')}`
}
call.codegraph_index = async (a) => JSON.stringify(await (await runtimeFor(resolveRoot(a))).engine.build())

call.codegraph_refresh = async (a) => {
  const runtime = await runtimeFor(resolveRoot(a))
  return JSON.stringify(await runtime.engine.reconcile())
}
call.codegraph_query = async (a, { signal } = {}) => {
  const engine = await queryEngineFor(resolveRoot(a))
  if (!a?.query || typeof a.query !== 'object') throw new Error('missing required argument "query"')
  const consistency = a.query.generation ? 'validated' : (a.query.consistency ?? 'validated')
  if (a.query.generation && a.query.consistency === 'latest') throw new Error('explicit generation is validated and cannot be combined with latest consistency')
  const pinned = await engine.pinQuery({ ...a.query, consistency, limit: Math.min(a.query.limit ?? MAX_MCP_RESULTS, MAX_MCP_RESULTS) }, { signal })
  const rows = await cappedRows(pinned.rows, signal)
  const { freshness, coverage, revision, validatedGeneration } = pinned.metadata
  const metadata = { freshness, coverage, revision, validatedGeneration }
  return [JSON.stringify(metadata), ...rows.map((row) => JSON.stringify(row))].join('\n')
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
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
      return reply(id, { content: [{ type: 'text', text: await fn(params.arguments ?? {}, { signal: controller.signal }) }] })
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

if (!fs.existsSync(CLI)) {
  process.stderr.write(`codegraph-mcp: cli.mjs not found at ${CLI}\n`)
  process.exit(1)
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line)).catch((error) => process.stderr.write(`codegraph-mcp: ${error.message}\n`))
    } catch {
      process.stderr.write(`codegraph-mcp: bad JSON-RPC line\n`)
    }
  }
})
process.stdin.on('end', async () => {
  for (const root of lightWatchers.keys()) stopLightWatcher(root)
  await Promise.allSettled([...runtimes.values()].map(async (runtime) => (await runtime).close()))
  await Promise.allSettled([...queryEngines.values()].map((engine) => engine.dispose()))
})

if (DEFAULT_ROOT) queryEngineFor(DEFAULT_ROOT).catch((error) => process.stderr.write(`codegraph-mcp startup: ${error.message}\n`))
