import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { DaemonQueryEngine } from '../daemon-query-engine.mjs'
import { QueryDaemon, daemonSocketPath } from '../query-daemon.mjs'

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

test('domain analysis: daemon does not accept a socket connection until its async query engine is ready', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-ready-before-listen-'))
  temporaryRoots.add(root)
  let releaseEngine = () => {}
  const engineGate = new Promise((resolve) => { releaseEngine = resolve })
  const daemon = new QueryDaemon(root, { engineFactory: async () => { await engineGate; return { queryBatch: async () => [{ ready: true }], dispose: async () => {} } } })
  openDaemons.add(daemon)

  const starting = daemon.start()
  await new Promise((resolve) => setImmediate(resolve))
  const beforeReady = await new Promise((resolve) => {
    const socket = net.createConnection(daemonSocketPath(root))
    socket.once('connect', () => { socket.destroy(); resolve('connected') })
    socket.once('error', () => resolve('refused'))
  })
  releaseEngine()
  await starting
  const socket = net.createConnection(daemonSocketPath(root))
  await once(socket, 'connect')
  socket.destroy()

  assert.equal(beforeReady, 'refused')
})

test('hotpath gate: a fresh ready daemon starts within 500 milliseconds with a 100 millisecond stretch diagnostic', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-light-start-perf-'))
  temporaryRoots.add(root)
  const daemon = new QueryDaemon(root, { engineFactory: async () => ({ queryBatch: async () => [], dispose: async () => {} }) })
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
