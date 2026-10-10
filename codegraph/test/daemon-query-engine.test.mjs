import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { spawn, spawnSync } from 'node:child_process'
import { DaemonQueryEngine } from '../daemon-query-engine.mjs'
import { QueryDaemon, QueryDaemonClient } from '../query-daemon.mjs'

const temporaryRoots = new Set()
const openEngines = new Set()
const openDaemons = new Set()

test.afterEach(async () => {
  await Promise.allSettled([...openDaemons].map((daemon) => daemon.close()))
  await Promise.allSettled([...openEngines].map((engine) => engine.dispose()))
  openDaemons.clear()
  openEngines.clear()
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
  temporaryRoots.clear()
})

const serviceDriverSource = `
import readline from 'node:readline'
import { createService } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'mcp-server.mjs'))}
const service = createService()
const owner = {}
const pending = new Set()
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  if (!line.trim()) return
  const work = service.handle(JSON.parse(line), { owner, root: process.env.CODEGRAPH_ROOT }).then(reply => {
    if (reply !== undefined) process.stdout.write(JSON.stringify(reply) + '\\n')
  }).finally(() => pending.delete(work))
  pending.add(work)
})
lines.on('close', async () => {
  await Promise.all([...pending])
  await new Promise(resolve => setImmediate(resolve))
  await service.close()
})
`
const serviceDriver = (directory) => {
  const file = path.join(directory, 'owned-service-driver.mjs')
  fs.writeFileSync(file, serviceDriverSource)
  return file
}

test('MCP root shares one mmap cache between query and semantic engines and disposes it once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-shared-cache-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-shared-cache-loader-'))
  temporaryRoots.add(root); temporaryRoots.add(loaderRoot)
  const loaderPath = path.join(loaderRoot, 'shared-cache-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/mmap-query-cache.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export class MmapQueryCache {
      constructor() { this.id = 'root-cache'; this.disposed = false; process.stderr.write('CACHE_CREATED\\\\n') }
      dispose() { if (this.disposed) throw new Error('cache disposed twice'); this.disposed = true; process.stderr.write('CACHE_DISPOSED\\\\n') }
    }
  \` }
  if (url.endsWith('/query-cache-schema.mjs')) return { format: 'module', shortCircuit: true, source: \`export const prepareQueryViewCache = () => 'cache.bin'\` }
  if (url.endsWith('/native/mmap-adapter.mjs')) return { format: 'module', shortCircuit: true, source: \`export const nativeMmapAdapter = {}\` }
  if (url.endsWith('/source-policy.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export const controlFileHashes = () => ({})
    export const fileContentHash = () => ''
    export const createSourcePolicy = () => ({ scan: () => [], normalize: () => '', acceptWatchPath: () => false, isSourceRelative: () => false })
  \` }
  if (url.endsWith('/daemon-query-engine.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export class DaemonQueryEngine {
      constructor(root, options) { this.cache = options.cache; this.engineFactory = options.engineFactory; process.stderr.write('QUERY_CACHE ' + this.cache.id + '\\\\n') }
      async pinQuery() { return { metadata: { freshness: 'validated', coverage: 'calls', revision: null, validatedGeneration: 'g' }, rows: [] } }
      async dispose() {}
    }
  \` }
  if (url.endsWith('/tool-engine.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export class CodeGraphEngine {
      constructor(root, options) { this.mmapQueryCache = options.queryCache; process.stderr.write('ENGINE_CACHE ' + options.queryCache.id + '\\\\n') }
      async build() { return { generation: 'g', parsedFiles: [], reusedFiles: [] } }
      async dispose() {}
    }
  \` }
  if (url.endsWith('/mcp-runtime.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export class McpProjectRuntime {
      constructor(root, options) { this.engine = options.engine }
      async start() {}
      async index() { return { generation: 'g', parsedFiles: [], reusedFiles: [] } }
      async close() { await this.engine.dispose() }
    }
  \` }
  return nextLoad(url, context)
}
`)
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_query', arguments: { root, query: { type: 'symbols' } } } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_index', arguments: { root } } }) + '\n'
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, serviceDriver(loaderRoot)], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })

  assert.deepEqual(result.stderr.trim().split('\n'), ['CACHE_CREATED', 'QUERY_CACHE root-cache', 'ENGINE_CACHE root-cache', 'CACHE_DISPOSED'])
})

test('domain analysis: default-generation symbol queries pin CURRENT and acquire the calls page without constructing GraphStore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-current-symbols-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-current\n')
  const acquisitions = []
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire(request) { acquisitions.push(request); return { value: { mappedView: { matchingSymbols: () => [{ id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }] } }, release() {} } }, dispose() {} }),
    engineFactory: () => { throw new Error('heavy fallback must not be constructed') },
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'symbols', name: 'target', limit: 200 })

  assert.deepEqual({ acquisitions, rows }, {
    acquisitions: [{ generation: 'generation-current', coverage: 'calls' }],
    rows: [{ id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
  })
})

test('combinatorial all-pairs: each query kind selects its required mapped coverage', async (t) => {
  const cases = [
    { name: 'symbols uses calls', request: { type: 'symbols', limit: 200 }, expectedCoverage: 'calls' },
    { name: 'deps uses calls', request: { type: 'deps', name: 'caller', limit: 200 }, expectedCoverage: 'calls' },
    { name: 'refs uses complete', request: { type: 'refs', name: 'target', limit: 200 }, expectedCoverage: 'complete' },
    { name: 'graph uses complete', request: { type: 'graph', limit: 1 }, expectedCoverage: 'complete' },
  ]
  for (const entry of cases) await t.test(entry.name, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-coverage-'))
    temporaryRoots.add(root)
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
    fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-coverage')
    const acquisitions = []
    const engine = new DaemonQueryEngine(root, {
      cacheFactory: () => ({ acquire(request) { acquisitions.push(request); return { value: { mappedView: { generation: 'generation-coverage', edgeCoverage: entry.expectedCoverage, graph: { generation: 'generation-coverage', edgeCoverage: 'complete', files: [], symbols: [], edges: [] }, matchingSymbols: () => [], relationships: () => [] } }, release() {} } }, dispose() {} }),
      engineFactory: () => { throw new Error('unexpected fallback') },
    })
    openEngines.add(engine)

    await engine.queryBatch(entry.request)

    assert.deepEqual(acquisitions, [{ generation: 'generation-coverage', coverage: entry.expectedCoverage }])
  })
})

test('domain boundary: a deps calls-page miss falls back instead of reading non-call edges from a complete page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-deps-no-complete-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-coverage')
  const acquisitions = []
  const fallbackRequests = []
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire(request) { acquisitions.push(request); return request.coverage === 'complete' ? { value: { mappedView: { relationships: () => [{ from: 'syntax-owner', to: 'dependency-id', line: 8, call: false }] } }, release() {} } : null }, dispose() {} }),
    engineFactory: () => ({ queryBatch: async (request) => { fallbackRequests.push(request); return [{ from: 'caller-id', to: 'dependency-id', line: 4, call: true }] }, dispose: async () => {} }),
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'deps', name: 'caller', limit: 200 })

  assert.deepEqual({ acquisitions, fallbackRequests, rows }, {
    acquisitions: [{ generation: 'generation-coverage', coverage: 'calls' }],
    fallbackRequests: [{ type: 'deps', name: 'caller', limit: 200 }],
    rows: [{ from: 'caller-id', to: 'dependency-id', line: 4, call: true }],
  })
})

test('domain boundary: a symbols calls-page miss may use the complete page without constructing fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-symbols-complete-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-coverage')
  const acquisitions = []
  let fallbackCreations = 0
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire(request) { acquisitions.push(request); return request.coverage === 'complete' ? { value: { mappedView: { matchingSymbols: () => [{ id: 'target-id', name: 'target' }] } }, release() {} } : null }, dispose() {} }),
    engineFactory: () => { fallbackCreations += 1; return { queryBatch: async () => [{ unexpected: true }], dispose: async () => {} } },
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'symbols', name: 'target', limit: 200 })

  assert.deepEqual({ acquisitions, fallbackCreations, rows }, {
    acquisitions: [{ generation: 'generation-coverage', coverage: 'calls' }, { generation: 'generation-coverage', coverage: 'complete' }],
    fallbackCreations: 0,
    rows: [{ id: 'target-id', name: 'target' }],
  })
})

test('boundary value: a resolved refs limit of two preserves line then caller ordering and returns exactly two endpoint-enriched rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-resolved-limit-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-resolved')
  const symbols = new Map([
    ['caller-a', { id: 'caller-a', file: 'src/a.ts', name: 'callerA', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
    ['caller-b', { id: 'caller-b', file: 'src/b.ts', name: 'callerB', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
    ['target-id', { id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
  ])
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => ({ value: { mappedView: {
      relationships: () => [{ from: 'caller-b', to: 'target-id', line: 9, call: true }, { from: 'caller-b', to: 'target-id', line: 4, call: false }, { from: 'caller-a', to: 'target-id', line: 4, call: true }],
      matchingSymbols: ({ id }) => [symbols.get(id)],
    } }, release() {} }), dispose() {} }),
    engineFactory: () => { throw new Error('unexpected fallback') },
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'refs', name: 'target', resolved: true, limit: 2 })

  assert.deepEqual(rows, [
    { from: 'caller-a', to: 'target-id', line: 4, call: true, fromSymbol: { id: 'caller-a', file: 'src/a.ts', name: 'callerA', kind: 'function', line: 1 }, toSymbol: { id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2 } },
    { from: 'caller-b', to: 'target-id', line: 4, call: false, fromSymbol: { id: 'caller-b', file: 'src/b.ts', name: 'callerB', kind: 'function', line: 1 }, toSymbol: { id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2 } },
  ])
})

test('boundary value: a raw deps limit of zero returns no rows without constructing the fallback engine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-zero-limit-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-zero')
  let fallbackCreations = 0
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => ({ value: { mappedView: { relationships: () => [{ from: 'caller-id', to: 'target-id', line: 3, call: true }] } }, release() {} }), dispose() {} }),
    engineFactory: () => { fallbackCreations += 1; return { queryBatch: async () => [{ unexpected: true }], dispose: async () => {} } },
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'deps', name: 'caller', limit: 0 })

  assert.deepEqual({ fallbackCreations, rows }, { fallbackCreations: 0, rows: [] })
})

test('error guessing: concurrent mapped misses coalesce one lazy heavy engine construction and preserve each fallback result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-coalesce-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-missing')
  let creations = 0
  let releaseConstruction = () => {}
  const constructionGate = new Promise((resolve) => { releaseConstruction = resolve })
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => null, dispose() {} }),
    engineFactory: async () => { creations += 1; await constructionGate; return { queryBatch: async (request) => [{ name: request.name }], query: async function * () {}, dispose: async () => {} } },
  })
  openEngines.add(engine)

  const first = engine.queryBatch({ type: 'symbols', name: 'first', limit: 200 })
  const second = engine.queryBatch({ type: 'symbols', name: 'second', limit: 200 })
  await new Promise((resolve) => setImmediate(resolve))
  releaseConstruction()

  assert.deepEqual({ creations, first: await first, second: await second }, { creations: 1, first: [{ name: 'first' }], second: [{ name: 'second' }] })
})

test('error guessing: corrupt mapped acquisition fails closed and delegates the exact request to the heavy engine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-corrupt-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-corrupt')
  const fallbackRequests = []
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => { throw new Error('corrupt mapped page') }, dispose() {} }),
    engineFactory: () => ({ queryBatch: async (request) => { fallbackRequests.push(request); return [{ source: 'fallback' }] }, dispose: async () => {} }),
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'refs', name: 'target', resolved: false, limit: 1 })

  assert.deepEqual({ fallbackRequests, rows }, { fallbackRequests: [{ type: 'refs', name: 'target', resolved: false, limit: 1 }], rows: [{ source: 'fallback' }] })
})

test('domain boundary: an explicit historical generation is acquired instead of CURRENT', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-explicit-generation-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-current')
  const acquisitions = []
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire(request) { acquisitions.push(request); return { value: { mappedView: { matchingSymbols: () => [{ name: 'historical' }] } }, release() {} } }, dispose() {} }),
    engineFactory: () => { throw new Error('unexpected fallback') },
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'symbols', generation: 'generation-historical', limit: 1 })

  assert.deepEqual({ acquisitions, rows }, { acquisitions: [{ generation: 'generation-historical', coverage: 'calls' }], rows: [{ name: 'historical' }] })
})

test('domain boundary: consistency latest always delegates to the heavy engine even when CURRENT has a primed mapped page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-latest-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-current')
  let acquisitions = 0
  let creations = 0
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => { acquisitions += 1; return { value: { mappedView: { matchingSymbols: () => [{ name: 'stale' }] } }, release() {} } }, dispose() {} }),
    engineFactory: () => { creations += 1; return { queryBatch: async () => [{ name: 'latest', freshness: 'provisional' }], dispose: async () => {} } },
  })
  openEngines.add(engine)

  const rows = await engine.queryBatch({ type: 'symbols', consistency: 'latest', limit: 200 })

  assert.deepEqual({ acquisitions, creations, rows }, { acquisitions: 0, creations: 1, rows: [{ name: 'latest', freshness: 'provisional' }] })
})

test('equivalence partition: async query yields the exact queryBatch rows in their original order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-stream-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-stream')
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => ({ value: { mappedView: { matchingSymbols: () => [{ name: 'first' }, { name: 'second' }] } }, release() {} }), dispose() {} }),
    engineFactory: () => { throw new Error('unexpected fallback') },
  })
  openEngines.add(engine)

  const rows = []
  for await (const row of engine.query({ type: 'symbols', limit: 200 })) rows.push(row)

  assert.deepEqual(rows, [{ name: 'first' }, { name: 'second' }])
})

test('error guessing: dispose releases the active mapped lease cache and lazily-created fallback exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-dispose-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-dispose')
  let releases = 0
  let cacheDisposals = 0
  let fallbackDisposals = 0
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: ({ generation }) => generation === 'generation-dispose' ? { value: { mappedView: { matchingSymbols: () => [] } }, release() { releases += 1 } } : null, dispose() { cacheDisposals += 1 } }),
    engineFactory: () => ({ queryBatch: async () => [], dispose: async () => { fallbackDisposals += 1 } }),
  })
  await engine.queryBatch({ type: 'symbols', limit: 200 })
  await engine.queryBatch({ type: 'symbols', generation: 'generation-miss', limit: 200 })

  await engine.dispose()
  await engine.dispose()

  assert.deepEqual({ releases, cacheDisposals, fallbackDisposals }, { releases: 1, cacheDisposals: 1, fallbackDisposals: 1 })
})

test('architecture boundary: a primed mapped query loads no tool engine parser TypeScript or ts-morph modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-import-root-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-import-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-primed')
  const loaderPath = path.join(loaderRoot, 'record-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.includes('/tool-engine.mjs') || url.includes('/parser.mjs') || url.includes('/typescript') || url.includes('/ts-morph')) process.stderr.write(url + '\\n')
  return nextLoad(url, context)
}
`)
  const source = `
import { DaemonQueryEngine } from './daemon-query-engine.mjs'
const engine = new DaemonQueryEngine(${JSON.stringify(root)}, { cacheFactory: () => ({ acquire: () => ({ value: { mappedView: { matchingSymbols: () => [{ name: 'primed' }] } }, release() {} }), dispose() {} }), engineFactory: () => { throw new Error('fallback loaded') } })
const rows = await engine.queryBatch({ type: 'symbols', name: 'primed', limit: 200 })
await engine.dispose()
process.stdout.write(JSON.stringify(rows))
`

  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, '--input-type=module', '--eval', source], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })

  assert.deepEqual({ status: result.status, stdout: result.stdout, forbiddenLoads: result.stderr.split('\n').filter((line) => line.includes('/tool-engine.mjs') || line.includes('/parser.mjs') || line.includes('/typescript') || line.includes('/ts-morph')) }, { status: 0, stdout: '[{"name":"primed"}]', forbiddenLoads: [] })
})

test('architecture boundary: an explicit-root primed MCP reply is unchanged before semantic hydration starts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-mapped-deps-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-mapped-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return target() }\n')
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'deps', name: 'caller', limit: 200 }), '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const loaderPath = path.join(loaderRoot, 'record-loader.mjs')
  const entryPath = path.join(loaderRoot, 'ordered-mcp.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (!url.endsWith('/tool-engine.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: \`
    export class CodeGraphEngine {
      constructor() {}
      async reconcile() { process.stderr.write('HYDRATION_AFTER_REPLY ' + Boolean(globalThis.__mappedReplyWritten) + '\\\\n'); return this }
      async dispose() {}
    }
  \` }
}
`)
  fs.writeFileSync(entryPath, `
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => {
  if (String(chunk).includes('"id":1')) globalThis.__mappedReplyWritten = true
  return write(chunk, ...args)
}
${serviceDriverSource}
`)
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { root, target: 'caller' } } }) + '\n'

  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, entryPath], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  const response = JSON.parse(result.stdout.trim())
  const expectedText = `${JSON.stringify({ revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration: fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8').trim() })}\nsrc/calls.ts:2 -> src/calls.ts:1 call`

  assert.deepEqual(
    { indexedStatus: indexed.status, primedStatus: primed.status, status: result.status, isError: response.result?.isError, text: response.result?.content?.[0]?.text, hydrationOrder: result.stderr.trim() },
    { indexedStatus: 0, primedStatus: 0, status: 0, isError: undefined, text: expectedText, hydrationOrder: 'HYDRATION_AFTER_REPLY true' },
  )
})

test('architecture boundary: a CODEGRAPH_ROOT primed MCP reply is unchanged before semantic hydration starts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-default-root-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-default-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return target() }\n')
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'deps', name: 'caller', limit: 200 }), '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const loaderPath = path.join(loaderRoot, 'record-loader.mjs')
  const entryPath = path.join(loaderRoot, 'ordered-mcp.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (!url.endsWith('/tool-engine.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: \`
    export class CodeGraphEngine {
      constructor() {}
      async reconcile() { process.stderr.write('HYDRATION_AFTER_REPLY ' + Boolean(globalThis.__mappedReplyWritten) + '\\\\n'); return this }
      async dispose() {}
    }
  \` }
}
`)
  fs.writeFileSync(entryPath, `
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => {
  if (String(chunk).includes('"id":1')) globalThis.__mappedReplyWritten = true
  return write(chunk, ...args)
}
${serviceDriverSource}
`)
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { target: 'caller' } } }) + '\n'

  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, entryPath], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000, env: { ...process.env, CODEGRAPH_ROOT: root } })
  const response = JSON.parse(result.stdout.trim())
  const expectedText = `${JSON.stringify({ revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration: fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8').trim() })}\nsrc/calls.ts:2 -> src/calls.ts:1 call`

  assert.deepEqual(
    { indexedStatus: indexed.status, primedStatus: primed.status, status: result.status, isError: response.result?.isError, text: response.result?.content?.[0]?.text, hydrationOrder: result.stderr.trim() },
    { indexedStatus: 0, primedStatus: 0, status: 0, isError: undefined, text: expectedText, hydrationOrder: 'HYDRATION_AFTER_REPLY true' },
  )
})

test('equivalence partitioning: codegraph_query diagnostics adds a nonnegative server timing receipt without forwarding the control key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-query-diagnostics-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-query-diagnostics-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  const loaderPath = path.join(loaderRoot, 'query-diagnostics-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/source-policy.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export const controlFileHashes = () => ({})
    export const fileContentHash = () => ''
    export const createSourcePolicy = () => ({ scan: () => [], normalize: () => '', acceptWatchPath: () => false, isSourceRelative: () => false })
  \` }
  if (url.endsWith('/daemon-query-engine.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export class DaemonQueryEngine {
      constructor() {}
      async pinQuery(request) {
        if ('diagnostics' in request) throw new Error('diagnostics leaked into engine query')
        return {
          metadata: { freshness: 'validated', coverage: 'calls', revision: null, validatedGeneration: 'generation-1' },
          rows: (async function* () { yield { name: 'value' } })(),
        }
      }
      async dispose() {}
    }
  \` }
  return nextLoad(url, context)
}
`)
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_query', arguments: { root, query: { type: 'symbols', name: 'value', diagnostics: true } } } }) + '\n'

  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, serviceDriver(loaderRoot)], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  const response = JSON.parse(result.stdout.trim())
  const [metadataLine, row] = response.result?.content?.[0]?.text.split('\n') ?? []
  const metadata = JSON.parse(metadataLine)

  assert.deepEqual(
    { status: result.status, isError: response.result?.isError, metadata: { freshness: metadata.freshness, coverage: metadata.coverage, revision: metadata.revision, validatedGeneration: metadata.validatedGeneration, serverPidIsPositiveInteger: Number.isInteger(metadata.serverPid) && metadata.serverPid > 0, serverDurationIsNonnegative: Number.isFinite(metadata.serverDurationMs) && metadata.serverDurationMs >= 0 }, row },
    { status: 0, isError: undefined, metadata: { freshness: 'validated', coverage: 'calls', revision: null, validatedGeneration: 'generation-1', serverPidIsPositiveInteger: true, serverDurationIsNonnegative: true }, row: '{"name":"value"}' },
  )
})

test('equivalence partitioning: codegraph_query without diagnostics preserves the existing response bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-query-no-diagnostics-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-query-no-diagnostics-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  const loaderPath = path.join(loaderRoot, 'query-no-diagnostics-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/source-policy.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export const controlFileHashes = () => ({})
    export const fileContentHash = () => ''
    export const createSourcePolicy = () => ({ scan: () => [], normalize: () => '', acceptWatchPath: () => false, isSourceRelative: () => false })
  \` }
  if (url.endsWith('/daemon-query-engine.mjs')) return { format: 'module', shortCircuit: true, source: \`
    export class DaemonQueryEngine {
      constructor() {}
      async pinQuery() {
        return {
          metadata: { freshness: 'validated', coverage: 'calls', revision: null, validatedGeneration: 'generation-1' },
          rows: (async function* () { yield { name: 'value' } })(),
        }
      }
      async dispose() {}
    }
  \` }
  return nextLoad(url, context)
}
`)
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_query', arguments: { root, query: { type: 'symbols', name: 'value' } } } }) + '\n'

  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, serviceDriver(loaderRoot)], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  const response = JSON.parse(result.stdout.trim())
  const text = response.result?.content?.[0]?.text
  const expectedText = '{"freshness":"validated","coverage":"calls","revision":null,"validatedGeneration":"generation-1"}\n{"name":"value"}'

  assert.deepEqual(
    { status: result.status, isError: response.result?.isError, text },
    { status: 0, isError: undefined, text: expectedText },
  )
})

test('domain analysis: a source changed before the first MCP read labels the cached dependency with its validated generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-stale-before-read-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return target() }\n')
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'deps', name: 'caller', limit: 200 }), '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const validatedGeneration = fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8').trim()
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return 0 }\n')
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { root, target: 'caller' } } }) + '\n'

  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  const response = JSON.parse(result.stdout.trim())
  const [metadata, row] = response.result?.content?.[0]?.text.split('\n') ?? []

  assert.deepEqual(
    { indexedStatus: indexed.status, primedStatus: primed.status, status: result.status, isError: response.result?.isError, metadata: JSON.parse(metadata), row },
    { indexedStatus: 0, primedStatus: 0, status: 0, isError: undefined, metadata: { revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration }, row: 'src/calls.ts:2 -> src/calls.ts:1 call' },
  )
})

test('error guessing: a stale primed MCP query returns the validated cache while background promotion is stalled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-stalled-promotion-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-stalled-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return target() }\n')
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'deps', name: 'caller', limit: 200 }), '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const validatedGeneration = fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8').trim()
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return 0 }\n')
  const loaderPath = path.join(loaderRoot, 'stall-runtime-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (!url.endsWith('/tool-engine.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: \`
    export class CodeGraphEngine {
      constructor() {}
      async reconcile() { process.stderr.write('PROMOTION_STARTED\\\\n'); await new Promise(() => {}) }
      async dispose() {}
    }
  \` }
}
`)
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, serviceDriver(loaderRoot)], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, CODEGRAPH_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { root, target: 'caller' } } }) + '\n'
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  const responseData = once(child.stdout, 'data')

  try {
    child.stdin.write(request)
    const [promotion] = await Promise.race([
      once(child.stderr, 'data'),
      new Promise((resolve) => setTimeout(() => resolve(['promotion did not start']), 2_000)),
    ])
    const response = await Promise.race([
      responseData.then(() => JSON.parse(stdout.trim())),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 250)),
    ])
    const text = response === 'blocked' ? '' : response.result?.content?.[0]?.text
    const [metadata, row] = text ? text.split('\n') : ['', '']

    assert.deepEqual(
      { indexedStatus: indexed.status, primedStatus: primed.status, promotion: String(promotion).trim(), response: response === 'blocked' ? 'blocked' : { metadata: JSON.parse(metadata), row } },
      { indexedStatus: 0, primedStatus: 0, promotion: 'PROMOTION_STARTED', response: { metadata: { revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration }, row: 'src/calls.ts:2 -> src/calls.ts:1 call' } },
    )
  } finally {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => {})
  }
})

test('combinatorial concurrency: mapped MCP queries return unchanged while one semantic runtime hydrates in the background', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-background-hydration-'))
  const loaderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-background-hydration-loader-'))
  temporaryRoots.add(root)
  temporaryRoots.add(loaderRoot)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return target() }\n')
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'deps', name: 'caller', limit: 200 }), '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  assert.equal(indexed.status, 0, indexed.stderr)
  assert.equal(primed.status, 0, primed.stderr)
  const validatedGeneration = fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8').trim()
  const loaderPath = path.join(loaderRoot, 'stall-runtime-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (!url.endsWith('/tool-engine.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: \`
    export class CodeGraphEngine {
      constructor() { process.stderr.write('RUNTIME_CREATED\\\\n'); }
      async reconcile() { process.stderr.write('HYDRATION_STARTED\\\\n'); await new Promise(() => {}) }
      async dispose() {}
    }
  \` }
}
`)
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, serviceDriver(loaderRoot)], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const firstRequest = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { root, target: 'caller' } } }) + '\n'
  const secondRequest = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { root, target: 'caller' } } }) + '\n'

  try {
    const observed = await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.stdout.off('data', inspect)
        child.stderr.off('data', inspect)
        child.off('error', fail)
        child.off('exit', exited)
      }
      const fail = error => { cleanup(); reject(error) }
      const exited = (code, signal) => fail(new Error(`Hydration fixture exited before replies: ${code}/${signal}; ${stderr}`))
      const inspect = () => {
        const responses = stdout.trim().split('\n').filter(Boolean)
        if (responses.length === 2 && stderr.includes('HYDRATION_STARTED')) {
          cleanup()
          resolve({ responses, stderr })
        }
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('error', fail)
      child.once('exit', exited)
      child.stdin.write(firstRequest + secondRequest)
      inspect()
    })
    const responses = observed.responses.map((line) => JSON.parse(line))
    const output = `${JSON.stringify({ revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration })}\nsrc/calls.ts:2 -> src/calls.ts:1 call`

    assert.deepEqual(
      { indexedStatus: indexed.status, primedStatus: primed.status, runtimeCreations: observed.stderr.match(/RUNTIME_CREATED/g)?.length ?? 0, hydrationStarted: observed.stderr.includes('HYDRATION_STARTED'), responses: responses.map((response) => ({ id: response.id, isError: response.result?.isError, text: response.result?.content?.[0]?.text })) },
      { indexedStatus: 0, primedStatus: 0, runtimeCreations: 1, hydrationStarted: true, responses: [{ id: 1, isError: undefined, text: output }, { id: 2, isError: undefined, text: output }] },
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  }
})

test('domain analysis: tsconfig content changed before the first MCP read labels the cached result with its validated generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-stale-config-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'calls.ts'), 'export function target() { return 1 }\nexport function caller() { return target() }\n')
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'deps', name: 'caller', limit: 200 }), '--root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  const validatedGeneration = fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8').trim()
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_deps', arguments: { root, target: 'caller' } } }) + '\n'

  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  const response = JSON.parse(result.stdout.trim())
  const [metadata, row] = response.result?.content?.[0]?.text.split('\n') ?? []

  assert.deepEqual(
    { indexedStatus: indexed.status, primedStatus: primed.status, status: result.status, isError: response.result?.isError, metadata: JSON.parse(metadata), row },
    { indexedStatus: 0, primedStatus: 0, status: 0, isError: undefined, metadata: { revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration }, row: 'src/calls.ts:2 -> src/calls.ts:1 call' },
  )
})

test('internal query contract: validated metrics are read directly without constructing the parser fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-internals-direct-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-internal')
  let fallbackCreations = 0
  const engine = new DaemonQueryEngine(root, { cacheFactory: () => ({ acquireInternal: () => ({ value: { metrics: () => [{ record: 'metrics', metrics: { cyclomatic: 1, branchCount: 0, nestingDepth: 0 } }] }, release() {} }), acquire: () => null, dispose() {} }), engineFactory: () => { fallbackCreations += 1; throw new Error('parser fallback forbidden') } })
  openEngines.add(engine)
  const rows = await engine.queryBatch({ type: 'internals', operation: 'metrics', file: 'src/a.ts', owner: { id: 0 }, generation: 'generation-internal', limit: 1 })
  assert.deepEqual({ fallbackCreations, rows }, { fallbackCreations: 0, rows: [{ record: 'metrics', metrics: { cyclomatic: 1, branchCount: 0, nestingDepth: 0 } }] })
})

test('domain analysis: daemon accepts transport before its async query engine is ready but gates queries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-ready-before-listen-'))
  temporaryRoots.add(root)
  let releaseEngine, factoryEntered
  const engineGate = new Promise(resolve => { releaseEngine = resolve })
  const entered = new Promise(resolve => { factoryEntered = resolve })
  let queryCalls = 0
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'token'),
    engineFactory: async () => { factoryEntered(); await engineGate; return { queryBatch: async () => { queryCalls += 1; return [{ ready: true }] }, dispose: async () => {} } },
  })
  openDaemons.add(daemon)
  const starting = daemon.start()
  t.after(() => releaseEngine())
  await entered
  const client = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => client.close())
  const transport = net.createConnection(daemon.endpoint)
  t.after(() => transport.destroy())
  await once(transport, 'connect')
  const connecting = client.connect()
  assert.equal(queryCalls, 0)
  let received = false
  const querying = client.request('queryBatch', { query: { type: 'symbols' } }).then(rows => { received = true; return rows })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received, false)
  releaseEngine()
  await starting
  await connecting
  assert.deepEqual(await querying, [{ ready: true }])
  assert.equal(queryCalls, 1)
})

test('hotpath gate: a fresh ready daemon starts within 500 milliseconds with a 100 millisecond stretch diagnostic', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-start-perf-'))
  temporaryRoots.add(root)
  const daemon = new QueryDaemon(root, { endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'token'), engineFactory: async () => ({ queryBatch: async () => [], dispose: async () => {} }) })
  openDaemons.add(daemon)

  const started = performance.now()
  await daemon.start()
  const elapsedMs = performance.now() - started
  t.diagnostic(`fresh lightweight daemon startup ${elapsedMs.toFixed(3)}ms; stretch=${elapsedMs <= 100 ? 'met' : 'missed'}`)

  assert.equal(elapsedMs <= 500, true)
})

test('hotpath gate: the first primed resolved refs query completes within 50 milliseconds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-first-ref-perf-'))
  temporaryRoots.add(root)
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-fast')
  const engine = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => ({ value: { mappedView: {
      relationships: () => [{ from: 'caller-id', to: 'target-id', line: 7, call: true }],
      matchingSymbols: ({ id }) => id === 'caller-id' ? [{ id: 'caller-id', file: 'src/caller.ts', name: 'caller', kind: 'function', line: 6 }] : [{ id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2 }],
    } }, release() {} }), dispose() {} }),
    engineFactory: () => { throw new Error('unexpected fallback') },
  })
  openEngines.add(engine)

  const started = performance.now()
  const rows = await engine.queryBatch({ type: 'refs', name: 'target', resolved: true, limit: 200 })
  const elapsedMs = performance.now() - started
  t.diagnostic(`first primed resolved refs ${elapsedMs.toFixed(3)}ms`)

  assert.deepEqual({ under50ms: elapsedMs <= 50, rows }, { under50ms: true, rows: [{ from: 'caller-id', to: 'target-id', line: 7, call: true, fromSymbol: { id: 'caller-id', file: 'src/caller.ts', name: 'caller', kind: 'function', line: 6 }, toSymbol: { id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 2 } }] })
})
