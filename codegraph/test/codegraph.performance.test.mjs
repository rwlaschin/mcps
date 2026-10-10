import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import * as benchmark from '../scripts/codegraph.performance.mjs'
import * as parserPoolModule from '../parser-apartment-pool.mjs'
import { QueryDaemonClient } from '../query-daemon.mjs'

// Transport/process plumbing only: no profile unit test opens the user's global service.
function isolatedProfileService(t) {
  const service = new EventEmitter(); service.pid = 43; service.exitCode = null; service.signalCode = null; service.stderr = new EventEmitter()
  service.kill = signal => { service.signalCode = signal; queueMicrotask(() => service.emit('exit', null, signal)); return true }
  const state = { closes: 0, requests: [] }
  t.mock.method(QueryDaemonClient.prototype, 'connect', async function () { return this })
  t.mock.method(QueryDaemonClient.prototype, 'request', async (_operation) => { state.requests.push(_operation); if (_operation === 'status') return { servicePid: 43 }; assert.equal(_operation, 'shutdown'); service.exitCode = 0; queueMicrotask(() => service.emit('exit', 0, null)); return {} })
  t.mock.method(QueryDaemonClient.prototype, 'close', async () => { state.closes++ })
  return { service, state }
}

const completeReport = {
  schemaVersion: 2,
  provenance: { root: '/private/tmp/codegraph-performance/dnd-community-and-marketplace', sourceRoot: '/repos/dnd-community-and-marketplace', repository: 'dnd-community-and-marketplace', sourceFiles: 863, commit: '0123456789abcdef' },
  benchmarks: {
    refs: { indexed: { n: 1, p50Ms: 1.11, p90Ms: 1.11 }, updated: { n: 5, p50Ms: 2.12, p90Ms: 2.92 } },
    deps: { indexed: { n: 1, p50Ms: 4.11, p90Ms: 4.11 }, updated: { n: 5, p50Ms: 5.12, p90Ms: 5.92 } },
    callers: { indexed: { n: 1, p50Ms: 7.11, p90Ms: 7.11 }, updated: { n: 5, p50Ms: 8.12, p90Ms: 8.92 } },
    dead: { indexed: { n: 1, p50Ms: 10.11, p90Ms: 10.11 }, updated: { n: 5, p50Ms: 11.12, p90Ms: 11.92 } },
    queryNamed: { indexed: { n: 1, p50Ms: 13.11, p90Ms: 13.11 }, updated: { n: 5, p50Ms: 14.12, p90Ms: 14.92 } },
    queryCapped: { indexed: { n: 1, p50Ms: 16.11, p90Ms: 16.11 }, updated: { n: 5, p50Ms: 17.12, p90Ms: 17.92 } },
    querySingle: { indexed: { n: 1, p50Ms: 19.11, p90Ms: 19.11 }, updated: { n: 5, p50Ms: 20.12, p90Ms: 20.92 } },
    cyclo: { indexed: { n: 1, p50Ms: 22.11, p90Ms: 22.11 }, updated: { n: 5, p50Ms: 23.12, p90Ms: 23.92 } },
  },
  updates: {
    initialIndex: { n: 1, p50Ms: 101.1, p90Ms: 101.1, parsedFiles: 863, validatedFiles: 863 },
    update: { n: 5, p50Ms: 12.3, p90Ms: 18.7, parsedFiles: 1, validatedFiles: 1 },
  },
  correctness: { consistent: true, originalRepositoryUnchanged: true, cleanShutdown: true },
}

const semanticQueryDriver = String.raw`
(async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { CodeGraphEngine } = await import('./tool-engine.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-query-timing-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'\nexport const b = a\n")
  const engine = new CodeGraphEngine(root, {  })
  await engine.build()
  const cold = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true })
  const warm = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true })
  process.stdout.write(JSON.stringify({
    cold: cold.map(({ fromSymbol, toSymbol, call, line }) => ({ from: fromSymbol.name, to: toSymbol.name, call, line })),
    warm: warm.map(({ fromSymbol, toSymbol, call, line }) => ({ from: fromSymbol.name, to: toSymbol.name, call, line })),
  }))
  await engine.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})()
`

const runSemanticQueries = (enabled) => {
  const env = { ...process.env }
  if (enabled) env.CODEGRAPH_DEBUG_POOL = '1'
  else delete env.CODEGRAPH_DEBUG_POOL
  return spawnSync(process.execPath, ['-e', semanticQueryDriver], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 20_000 })
}

test('equivalence partition: rejects a missing repository root', () => {
  assert.throws(() => benchmark.parseArgs([]), /--root/)
})

test('equivalence partition: rejects an empty repository root', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '']), /--root/)
})

test('domain analysis: omitting profiling selectors preserves the existing lifecycle options', () => {
  assert.deepEqual(
    benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace']),
    { root: '/repos/dnd-community-and-marketplace', samples: 5, json: undefined, markdown: undefined, readme: undefined },
  )
})

test('domain analysis: watcher update preserves sorted exact parsed and validated file sets beside their counts', async () => {
  const result = await benchmark.measureWatcherUpdate({
    root: '/mirror', state: 'unchanged-surface', previousGeneration: 'g1', phase: 'unchanged-surface incremental update', timeoutMs: 100,
    mutate: () => {},
    readMetadata: async () => ({ generation: 'g2', status: 'validated', parsedFiles: ['src/z.ts', 'src/a.ts'], validatedFiles: ['src/z.ts', 'src/m.ts', 'src/a.ts'] }),
    clock: (() => { const times = [10, 18]; return () => times.shift() })(),
  })

  assert.deepEqual(result, { ms: 8, generation: 'g2', parsedFiles: 2, validatedFiles: 3, parsedFileSet: ['src/a.ts', 'src/z.ts'], validatedFileSet: ['src/a.ts', 'src/m.ts', 'src/z.ts'] })
})

test('domain analysis: the documented symbol targets reference and named-symbol requests while location-only reference receipts remain valid', async () => {
  const options = benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--symbol', 'renderMap'])
  const workloads = benchmark.workloadsFor(options.symbol).filter(({ key }) => ['refs', 'queryNamed', 'querySingle'].includes(key))
  const calls = []
  const sweep = await benchmark.runSweep({
    timed: async (_method, params) => {
      calls.push(params)
      return params.name === 'codegraph_refs'
        ? { message: { result: { content: [{ text: 'src/pages/map/consumer.ts:42 -> src/pages/map/render.ts:9 call' }] } }, ms: 1 }
        : { message: { result: { content: [{ text: 'src/pages/map/render.ts:9 renderMap' }] } }, ms: 1 }
    },
  }, '/repo', workloads, options.symbol)

  assert.deepEqual(
    { symbol: options.symbol, workloads, requestNames: [calls[0].name, calls[1].name, calls[2].name], receipts: { refs: sweep.refs.receipt, queryNamed: sweep.queryNamed.receipt, querySingle: sweep.querySingle.receipt } },
    {
      symbol: 'renderMap',
      workloads: [
        { key: 'refs', label: 'References', tool: 'codegraph_refs', arguments: { symbol: 'renderMap' } },
        { key: 'queryNamed', label: 'Named-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', name: 'renderMap', limit: 2000 } } },
        { key: 'querySingle', label: 'Single-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', name: 'renderMap', limit: 1 } } },
      ],
      requestNames: ['codegraph_refs', 'codegraph_query', 'codegraph_query'],
      receipts: { refs: 'src/pages/map/consumer.ts:42 -> src/pages/map/render.ts:9 call', queryNamed: 'src/pages/map/render.ts:9 renderMap', querySingle: 'src/pages/map/render.ts:9 renderMap' },
    },
  )
})

test('equivalence partition: CPU profiling accepts one caller-owned destination without heap or trace', () => {
  assert.deepEqual(
    benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--profile', '--cpu', '/profiles/update.cpuprofile']),
    { root: '/repos/dnd-community-and-marketplace', samples: 5, json: undefined, markdown: undefined, readme: undefined, symbol: undefined, profile: { cpu: '/profiles/update.cpuprofile' } },
  )
})

test('equivalence partition: heap profiling accepts one caller-owned destination without CPU or trace', () => {
  assert.deepEqual(
    benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--profile', '--heap', '/profiles/update.heapprofile']),
    { root: '/repos/dnd-community-and-marketplace', samples: 5, json: undefined, markdown: undefined, readme: undefined, symbol: undefined, profile: { heap: '/profiles/update.heapprofile' } },
  )
})

test('equivalence partition: trace profiling accepts one caller-owned destination without CPU or heap', () => {
  assert.deepEqual(
    benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--profile', '--trace', '/profiles/update.trace.json']),
    { root: '/repos/dnd-community-and-marketplace', samples: 5, json: undefined, markdown: undefined, readme: undefined, symbol: undefined, profile: { trace: '/profiles/update.trace.json' } },
  )
})

test('boundary analysis: profile capture rejects an empty profiler selection', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--profile']), /profile.*cpu.*heap.*trace|at least one/i)
})

test('domain analysis: profiling accepts an explicit caller-owned diagnostic log', () => {
  assert.deepEqual(
    benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--profile', '--cpu', '/profiles/update.cpuprofile', '--diagnostic-log', '/profiles/update.pool.log']),
    { root: '/repos/dnd-community-and-marketplace', samples: 5, json: undefined, markdown: undefined, readme: undefined, symbol: undefined, profile: { cpu: '/profiles/update.cpuprofile' }, diagnosticLog: '/profiles/update.pool.log' },
  )
})

test('equivalence partition: a diagnostic log without profile capture is rejected', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--diagnostic-log', '/profiles/update.pool.log']), /diagnostic.*profile/i)
})

test('boundary analysis: accepts one sample as the minimum useful run', () => {
  assert.equal(benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--samples', '1']).samples, 1)
})

test('boundary analysis: rejects zero samples', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--samples', '0']), /--samples/)
})

test('equivalence partition: rejects a non-numeric sample count', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--samples', 'many']), /--samples/)
})

test('equivalence partition: rejects an unknown command-line option', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--unexpected']), /unknown option/)
})

test('combinatorial analysis: parses only the supported output options together', () => {
  assert.deepEqual(
    benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--samples', '2', '--json', 'result.json', '--markdown', 'result.md', '--readme', 'README.md']),
    { root: '/repos/dnd-community-and-marketplace', samples: 2, json: 'result.json', markdown: 'result.md', readme: 'README.md' },
  )
})

test('equivalence partition: explicitly requests replacement of the frozen benchmark snapshot', () => {
  assert.equal(benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--refresh-snapshot']).refreshSnapshot, true)
})

test('domain analysis: the default frozen snapshot lives inside the CodeGraph working directory', (context) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-local-snapshot-'))
  context.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }))

  let message
  try {
    benchmark.resolvePerformanceSnapshot(sourceRoot)
    message = 'snapshot unexpectedly exists'
  } catch (error) {
    message = error.message
  }

  assert.match(message, /\/Users\/mac\/Documents\/Projects\/mcps\/codegraph\/\.performance-snapshots\/codegraph-performance-local-snapshot-[^/]+-[a-f0-9]{12}; run again with --refresh-snapshot/)
})

test('boundary analysis: summarizes one sample as both p50 and p90', () => {
  assert.deepEqual(benchmark.summarizeSamples([7.25]), { n: 1, p50Ms: 7.25, p90Ms: 7.25 })
})

test('boundary analysis: selects observed p50 and p90 values without averaging timings', () => {
  assert.deepEqual(benchmark.summarizeSamples([90, 10, 50, 30, 70]), { n: 5, p50Ms: 50, p90Ms: 90 })
})

test('boundary analysis: nearest-rank percentiles select the lower observation for two samples at p50', () => {
  assert.deepEqual(benchmark.summarizeSamples([20, 10]), { n: 2, p50Ms: 10, p90Ms: 20 })
})

test('boundary analysis: nearest-rank percentiles select observations five and nine for ten samples', () => {
  assert.deepEqual(benchmark.summarizeSamples([100, 10, 90, 20, 80, 30, 70, 40, 60, 50]), { n: 10, p50Ms: 50, p90Ms: 90 })
})

test('equivalence partition: rejects an empty timing sample set', () => {
  assert.throws(() => benchmark.summarizeSamples([]), /sample/i)
})

test('equivalence partition: rejects a non-finite timing sample', () => {
  assert.throws(() => benchmark.summarizeSamples([Number.NaN]), /sample|finite/i)
})

test('domain analysis: declares the eight exact production workload requests', () => {
  assert.deepEqual(benchmark.WORKLOADS, [
    { key: 'refs', label: 'References', tool: 'codegraph_refs', arguments: { symbol: 'src/query/event.ts:useSessionEvent' } },
    { key: 'deps', label: 'Dependencies', tool: 'codegraph_deps', arguments: { file: 'src/pages/game/GamePopoutShell.tsx' } },
    { key: 'callers', label: 'Callers', tool: 'codegraph_callers', arguments: { symbol: 'fetchSessionStoryArcState', depth: 3 } },
    { key: 'dead', label: 'Dead exports', tool: 'codegraph_dead', arguments: { prefix: 'src/query' } },
    { key: 'queryNamed', label: 'Named-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', name: 'useSessionEvent', limit: 2000 } } },
    { key: 'queryCapped', label: 'Symbol list (2,000 max)', tool: 'codegraph_query', arguments: { query: { type: 'symbols', limit: 2000 } } },
    { key: 'querySingle', label: 'Single-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', file: 'src/query/event.ts', name: 'useSessionEvent', limit: 1 } } },
    { key: 'cyclo', label: 'Cyclomatic complexity', tool: 'codegraph_internals', arguments: { operation: 'metrics', file: 'src/query/event.ts', owner: { symbol: 'useSessionEvent' }, metrics: ['cyclomatic'] } },
  ])
})

test('domain analysis: strips only the leading freshness metadata line from semantic receipts', () => {
  assert.equal(
    benchmark.normalizeSemanticReceipt('generation: first\nuseSessionEvent\ngeneration: semantic content'),
    'useSessionEvent\ngeneration: semantic content',
  )
})

test('equivalence partition: preserves a receipt with no freshness metadata', () => {
  assert.equal(benchmark.normalizeSemanticReceipt('useSessionEvent\ngeneration: semantic content'), 'useSessionEvent\ngeneration: semantic content')
})

test('domain analysis: accepts a generation that advances after refresh', () => {
  assert.doesNotThrow(() => benchmark.assertGenerationAdvanced('generation-a', 'generation-b'))
})

test('domain analysis: rejects an unchanged validated generation after refresh', () => {
  assert.throws(() => benchmark.assertGenerationAdvanced('generation-a', 'generation-a'), /generation.*advance|unchanged/i)
})

test('equivalence partition: rejects a missing current validated generation', () => {
  assert.throws(() => benchmark.assertGenerationAdvanced('generation-a', ''), /generation.*advance|unchanged/i)
})

test('equivalence partition: rejects an empty endpoint-specific receipt', () => {
  assert.throws(() => benchmark.assertExpectedReceipt('refs', ''), /refs|empty|receipt/i)
})

test('domain analysis: rejects a nonempty but semantically incorrect named-symbol receipt', () => {
  assert.throws(() => benchmark.assertExpectedReceipt('queryNamed', 'unrelatedSymbol'), /useSessionEvent|receipt|semantic/i)
})

test('domain analysis: accepts the expected named-symbol receipt', () => {
  assert.doesNotThrow(() => benchmark.assertExpectedReceipt('queryNamed', 'src/query/event.ts: useSessionEvent'))
})

test('combinatorial analysis: accepts endpoint-specific receipts for the remaining seven workloads', () => {
  assert.deepEqual(
    [
      benchmark.assertExpectedReceipt('refs', 'src/query/event.ts: useSessionEvent'),
      benchmark.assertExpectedReceipt('deps', 'src/pages/game/GamePopoutShell.tsx'),
      benchmark.assertExpectedReceipt('callers', 'src/services/data/session/storyArcState.ts: fetchSessionStoryArcState'),
      benchmark.assertExpectedReceipt('dead', '3 exports in src/query'),
      benchmark.assertExpectedReceipt('queryCapped', '{"name":"useSessionEvent"}'),
      benchmark.assertExpectedReceipt('querySingle', 'useSessionEvent'),
      benchmark.assertExpectedReceipt('cyclo', '{"record":"metrics","metrics":{"cyclomatic":3}}'),
    ],
    ['src/query/event.ts: useSessionEvent', 'src/pages/game/GamePopoutShell.tsx', 'src/services/data/session/storyArcState.ts: fetchSessionStoryArcState', '3 exports in src/query', '{"name":"useSessionEvent"}', 'useSessionEvent', '{"record":"metrics","metrics":{"cyclomatic":3}}'],
  )
})

test('equivalence partition: rejects a receipt for an unknown workload', () => {
  assert.throws(() => benchmark.assertExpectedReceipt('unknown', 'nonempty'), /unknown.*receipt|semantically expected/i)
})

test('error guessing: rejects a request that exceeds its timeout', async () => {
  await assert.rejects(benchmark.withTimeout(new Promise(() => {}), 5, 'MCP request'), /MCP request.*timed out/i)
})

test('error guessing: rejects an update that exceeds its timeout', async () => {
  await assert.rejects(benchmark.withTimeout(new Promise(() => {}), 5, 'incremental update'), /incremental update.*timed out/i)
})

test('equivalence partition: clears the timeout after an operation resolves', async () => {
  assert.equal(await benchmark.withTimeout(Promise.resolve('finished'), 100, 'operation'), 'finished')
})

test('domain analysis: leaf update timing starts at mutation and ends when watcher metadata publishes a new validated generation', async () => {
  const events = []
  const metadata = [
    { generation: 'generation-a', status: 'validated' },
    { generation: 'generation-b', status: 'validating' },
    { generation: 'generation-b', status: 'validated', parsedFiles: ['leaf.ts'], validatedFiles: ['leaf.ts'] },
  ]

  const result = await benchmark.measureWatcherUpdate({
    root: '/mirror', state: 'leaf', previousGeneration: 'generation-a', phase: 'leaf incremental update', timeoutMs: 100,
    mutate: () => events.push('mutate leaf'),
    readMetadata: async () => { events.push('poll metadata'); return metadata.shift() },
    wait: async () => events.push('wait'),
    clock: (() => { const times = [10, 35]; return () => times.shift() })(),
  })

  assert.deepEqual(
    { events, result },
    { events: ['mutate leaf', 'poll metadata', 'wait', 'poll metadata', 'wait', 'poll metadata'], result: { ms: 25, generation: 'generation-b', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['leaf.ts'], validatedFileSet: ['leaf.ts'] } },
  )
})

test('performance contract: leaf update timing includes the first complete-reference query after validated publication', async () => {
  const events = []

  const result = await benchmark.measureWatcherUpdate({
    root: '/mirror', state: 'leaf', previousGeneration: 'generation-a', phase: 'leaf incremental update', timeoutMs: 100,
    mutate: () => events.push('mutate leaf'),
    readMetadata: async () => { events.push('validated publication'); return { generation: 'generation-b', status: 'validated', parsedFiles: ['leaf.ts'], validatedFiles: ['leaf.ts'] } },
    afterValidated: async () => events.push('complete refs query'),
    clock: (() => { const times = [10, 50]; return () => times.shift() })(),
  })

  assert.deepEqual(
    { events, result },
    { events: ['mutate leaf', 'validated publication', 'complete refs query'], result: { ms: 40, generation: 'generation-b', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['leaf.ts'], validatedFileSet: ['leaf.ts'] } },
  )
})

test('domain analysis: changed-surface watcher timing waits for one-file validated publication without calling explicit refresh', async () => {
  const calls = []

  await benchmark.measureWatcherUpdate({
    root: '/mirror', state: 'cascade', previousGeneration: 'generation-leaf', phase: 'cascade incremental update', timeoutMs: 100,
    mutate: () => calls.push('mutate cascade'),
    readMetadata: async () => { calls.push('poll metadata'); return { generation: 'generation-cascade', status: 'validated', parsedFiles: ['types.ts'], validatedFiles: ['types.ts'] } },
    wait: async () => calls.push('wait'),
    clock: (() => { const times = [50, 90]; return () => times.shift() })(),
  })

  assert.deepEqual(calls, ['mutate cascade', 'poll metadata'])
})

test('equivalence partition: watcher metadata reports the unchanged generation without reading manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-same-'))
  fs.mkdirSync(path.join(root, '.codegraph'))
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-a\n')

  assert.deepEqual(benchmark.watcherMetadata(root, 'generation-a', 'leaf'), { generation: 'generation-a', status: 'validated' })
  fs.rmSync(root, { recursive: true, force: true })
})

test('domain analysis: watcher metadata returns the exact work sets persisted by the validated generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-authoritative-'))
  const cache = path.join(root, '.codegraph')
  fs.mkdirSync(path.join(cache, 'generations'), { recursive: true })
  fs.writeFileSync(path.join(cache, 'CURRENT'), 'generation-b\n')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-a.json'), '{"sources":{"src/types/index.ts":"old"}}')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-b.json'), '{"sources":{"src/types/index.ts":"new"},"parsedFiles":["src/types/index.ts"],"validatedFiles":["src/types/index.ts"]}')

  assert.deepEqual(
    benchmark.watcherMetadata(root, 'generation-a', 'changed-surface'),
    { generation: 'generation-b', status: 'validated', parsedFiles: ['src/types/index.ts'], validatedFiles: ['src/types/index.ts'] },
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('error guessing: watcher metadata rejects a validated generation that omitted authoritative work sets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-missing-work-'))
  const cache = path.join(root, '.codegraph')
  fs.mkdirSync(path.join(cache, 'generations'), { recursive: true })
  fs.writeFileSync(path.join(cache, 'CURRENT'), 'generation-b\n')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-a.json'), '{"sources":{"src/types/index.ts":"old"}}')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-b.json'), '{"sources":{"src/types/index.ts":"new"}}')

  assert.throws(() => benchmark.watcherMetadata(root, 'generation-a', 'changed-surface'), /parsedFiles.*validatedFiles|authoritative work sets/i)
  fs.rmSync(root, { recursive: true, force: true })
})

test('equivalence partition: rejects an unknown mutation state', () => {
  assert.throws(() => benchmark.applyStateMutation('/tmp', 'indexed'), /unknown benchmark state/)
})

test('domain analysis: sequential update mutations append exactly one unique declaration while preserving every other file byte', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-mutation-'))
  const source = path.join(root, 'src', 'types', 'index.ts')
  const sibling = path.join(root, 'src', 'sibling.ts')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'export type Id = string\n')
  fs.writeFileSync(sibling, 'export const sibling = true\n')
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const originalSource = fs.readFileSync(source)
  const originalSibling = fs.readFileSync(sibling)

  benchmark.applyStateMutation(root, 'update', 1)
  benchmark.applyStateMutation(root, 'update', 2)

  const updatedSource = fs.readFileSync(source)
  assert.deepEqual(
    {
      files: fs.readdirSync(path.join(root, 'src')).sort(),
      targetBytesChanged: !updatedSource.equals(originalSource),
      originalBytesRemainPrefix: updatedSource.subarray(0, originalSource.length).equals(originalSource),
      siblingBytesUnchanged: fs.readFileSync(sibling).equals(originalSibling),
      targetText: updatedSource.toString('utf8'),
      surface1Count: updatedSource.toString('utf8').match(/CodeGraphPerformanceSurface1/g)?.length,
      surface2Count: updatedSource.toString('utf8').match(/CodeGraphPerformanceSurface2/g)?.length,
    },
    {
      files: ['sibling.ts', 'types'],
      targetBytesChanged: true,
      originalBytesRemainPrefix: true,
      siblingBytesUnchanged: true,
      targetText: 'export type Id = string\nexport type CodeGraphPerformanceSurface1 = Id\nexport type CodeGraphPerformanceSurface2 = Id\n',
      surface1Count: 1,
      surface2Count: 1,
    },
  )
})

test('error guessing: a disposable mirror isolates update mutations from the source repository', async (context) => {
  const temporaryRoot = fs.mkdtempSync('/tmp/codegraph-performance-test-')
  const sourceRoot = path.join(temporaryRoot, 'source')
  fs.mkdirSync(sourceRoot)
  fs.writeFileSync(path.join(sourceRoot, 'dependency.ts'), 'export const dependency = 1\n')
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))

  const mirrorRoot = await benchmark.createDisposableMirror(sourceRoot)
  fs.writeFileSync(path.join(mirrorRoot, 'dependency.ts'), 'export const dependency = 2\n')

  assert.equal(fs.readFileSync(path.join(sourceRoot, 'dependency.ts'), 'utf8'), 'export const dependency = 1\n')
})

test('error guessing: a disposable mirror excludes caches, dependencies, build output, and sockets', async (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-exclusions-'))
  const sourceRoot = path.join(temporaryRoot, 'source')
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(path.join(sourceRoot, '.git'))
  fs.mkdirSync(path.join(sourceRoot, '.codegraph'))
  fs.mkdirSync(path.join(sourceRoot, 'node_modules'))
  fs.mkdirSync(path.join(sourceRoot, 'dist'))
  fs.writeFileSync(path.join(sourceRoot, 'generated.cache'), 'generated')
  fs.writeFileSync(path.join(sourceRoot, 'source.ts'), 'export const source = true\n')
  fs.symlinkSync(path.join(temporaryRoot, 'missing.sock'), path.join(sourceRoot, 'server.sock'))
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))

  const mirrorRoot = await benchmark.createDisposableMirror(sourceRoot)

  assert.deepEqual(fs.readdirSync(mirrorRoot), ['source.ts'])
})

test('error guessing: a failed mirror copy removes its temporary parent', async () => {
  const missingSource = path.join(os.tmpdir(), `codegraph-performance-missing-${process.pid}`)

  await assert.rejects(benchmark.createDisposableMirror(missingSource), /ENOENT|no such file/i)
})

test('domain analysis: source snapshot changes with source bytes but ignores excluded cache bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-snapshot-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, '.codegraph'))
  fs.writeFileSync(path.join(root, 'src', 'source.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(root, '.codegraph', 'cache.bin'), 'first cache')
  const before = benchmark.sourceSnapshot(root)
  fs.writeFileSync(path.join(root, '.codegraph', 'cache.bin'), 'second cache')
  const afterCache = benchmark.sourceSnapshot(root)
  fs.writeFileSync(path.join(root, 'src', 'source.ts'), 'export const value = 2\n')
  const afterSource = benchmark.sourceSnapshot(root)

  assert.deepEqual({ cacheStable: afterCache === before, sourceChanged: afterSource !== before }, { cacheStable: true, sourceChanged: true })
  fs.rmSync(root, { recursive: true, force: true })
})

test('error guessing: removes a disposable mirror after a successful benchmark operation', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-clean-success-'))
  fs.writeFileSync(path.join(temporaryRoot, 'source.ts'), 'export const source = true\n')

  const mirrorRoot = await benchmark.withDisposableMirror(temporaryRoot, async (createdRoot) => createdRoot)

  assert.equal(fs.existsSync(mirrorRoot), false)
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('error guessing: removes a disposable mirror after a failed benchmark operation', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-clean-failure-'))
  fs.writeFileSync(path.join(temporaryRoot, 'source.ts'), 'export const source = true\n')
  let mirrorRoot = ''

  await assert.rejects(
    benchmark.withDisposableMirror(temporaryRoot, async (createdRoot) => { mirrorRoot = createdRoot; throw new Error('benchmark failed') }),
    /benchmark failed/,
  )

  assert.equal(fs.existsSync(mirrorRoot), false)
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('error guessing: an ordinary run requires the frozen snapshot before inspecting or indexing live fixtures', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-fixtures-'))
  let captures = 0
  const message = await benchmark.captureReport({ root: temporaryRoot, samples: 1 }, {
    lock: async (_root, operation) => operation(),
    snapshot: async () => { throw new Error('frozen performance snapshot is missing; run again with --refresh-snapshot') },
    capture: async () => { captures += 1 },
  }).then(() => 'unexpectedly completed', (error) => error.message)

  assert.deepEqual(
    { message, captures, indexed: fs.existsSync(path.join(temporaryRoot, '.codegraph')) },
    { message: 'frozen performance snapshot is missing; run again with --refresh-snapshot', captures: 0, indexed: false },
  )
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('equivalence partition: rejects a repository root that is a file', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-file-root-'))
  const file = path.join(temporaryRoot, 'not-a-repository')
  fs.writeFileSync(file, 'not a directory')

  await assert.rejects(benchmark.captureReport({ root: file, samples: 1 }), /not a directory/i)
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('error guessing: a benchmark failure leaves a supplied README byte-identical', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-readme-'))
  const readme = path.join(temporaryRoot, 'README.md')
  fs.writeFileSync(readme, '# Original README\n')
  spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/codegraph.performance.mjs'), '--root', temporaryRoot, '--samples', '1', '--readme', readme], { encoding: 'utf8' })

  assert.equal(fs.readFileSync(readme, 'utf8'), '# Original README\n')
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('domain analysis: atomically writes every report artifact and replaces only the marked README block', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-artifacts-'))
  const json = path.join(temporaryRoot, 'result.json')
  const markdown = path.join(temporaryRoot, 'result.md')
  const readme = path.join(temporaryRoot, 'README.md')
  fs.writeFileSync(readme, '# Before\n<!-- codegraph-performance:start -->\nold\n<!-- codegraph-performance:end -->\nAfter\n')

  benchmark.writeReportArtifacts({ json, markdown, readme }, '{"complete":true}\n', 'new metrics\n')

  assert.deepEqual(
    { json: fs.readFileSync(json, 'utf8'), markdown: fs.readFileSync(markdown, 'utf8'), readme: fs.readFileSync(readme, 'utf8') },
    { json: '{"complete":true}\n', markdown: 'new metrics\n', readme: '# Before\n<!-- codegraph-performance:start -->\nnew metrics\n<!-- codegraph-performance:end -->\nAfter\n' },
  )
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('equivalence partition: rejects a README without generated performance markers', () => {
  assert.throws(() => benchmark.replaceReadmeMetrics('# CodeGraph\n', 'metrics'), /marker/i)
})

test('boundary analysis: rejects reversed generated performance markers', () => {
  assert.throws(() => benchmark.replaceReadmeMetrics('<!-- codegraph-performance:end -->\n<!-- codegraph-performance:start -->', 'metrics'), /marker/i)
})

test('alternate flow: omitting --readme writes JSON and Markdown without touching README', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-outputs-'))
  const json = path.join(temporaryRoot, 'result.json')
  const markdown = path.join(temporaryRoot, 'result.md')
  const readme = path.join(temporaryRoot, 'README.md')
  fs.writeFileSync(readme, '# Existing README\n')

  benchmark.writeReportArtifacts({ json, markdown, readme: undefined }, '{"ok":true}\n', 'metrics\n')

  assert.deepEqual(
    { json: fs.readFileSync(json, 'utf8'), markdown: fs.readFileSync(markdown, 'utf8'), readme: fs.readFileSync(readme, 'utf8') },
    { json: '{"ok":true}\n', markdown: 'metrics\n', readme: '# Existing README\n' },
  )
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('error guessing: failure cleanup stops the MCP exactly once', async () => {
  let stops = 0

  await assert.rejects(
    benchmark.stopAfter({ stop: async () => { stops += 1 } }, async () => { throw new Error('request failed') }),
    /request failed/,
  )

  assert.equal(stops, 1)

  await assert.rejects(
    benchmark.stopAfter({ stop: async () => { throw new Error('shutdown timed out') } }, async () => { throw new Error('request failed') }),
    /request failed; MCP shutdown also failed: shutdown timed out/,
  )
})

test('error guessing: receipt comparison rejects one semantically drifting endpoint', () => {
  const expected = Object.fromEntries(benchmark.WORKLOADS.map(({ key }) => [key, { sha256: `${key}-stable` }]))
  const actual = structuredClone(expected)
  actual.cyclo.sha256 = 'cyclo-drifted'

  assert.throws(() => benchmark.assertReceiptsMatch(expected, actual), /cyclo.*drifted/i)
})

test('error guessing: source edits after the frozen snapshot do not invalidate its report', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-live-source-'))
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-frozen-snapshot-'))
  for (const root of [sourceRoot, snapshotRoot]) {
    fs.mkdirSync(path.join(root, 'src', 'query'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'pages', 'game'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'services', 'data', 'session'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'types'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'query', 'event.ts'), 'useSessionEvent')
    fs.writeFileSync(path.join(root, 'src', 'pages', 'game', 'GamePopoutShell.tsx'), 'GamePopoutShell')
    fs.writeFileSync(path.join(root, 'src', 'services', 'data', 'session', 'storyArcState.ts'), 'fetchSessionStoryArcState')
    fs.writeFileSync(path.join(root, 'src', 'utils', 'plotSameSelectedItem.ts'), 'plotSameSelectedItem')
    fs.writeFileSync(path.join(root, 'src', 'types', 'index.ts'), 'Shared')
  }
  const sweep = Object.fromEntries(benchmark.WORKLOADS.map(({ key }) => [key, { ms: 1, sha256: `${key}-stable` }]))
  const sample = { root: snapshotRoot, sourceFiles: 5, sweeps: { indexed: sweep, updated: sweep }, updates: { initialIndex: { ms: 10, parsedFiles: 5, validatedFiles: 5 }, update: { ms: 2, parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] } } }

  const report = await benchmark.captureReport({ root: sourceRoot, samples: 1 }, {
    snapshot: async (_root, options) => { assert.equal(options.refresh, false); return snapshotRoot },
    capture: async () => { fs.writeFileSync(path.join(sourceRoot, 'src', 'query', 'event.ts'), 'changed after snapshot'); return [sample] },
  })

  assert.deepEqual(
    { benchmarkRoot: report.provenance.root, sourceRoot: report.provenance.sourceRoot, sourceChanged: fs.readFileSync(path.join(sourceRoot, 'src', 'query', 'event.ts'), 'utf8'), valid: report.correctness.consistent },
    { benchmarkRoot: snapshotRoot, sourceRoot, sourceChanged: 'changed after snapshot', valid: true },
  )
  fs.rmSync(sourceRoot, { recursive: true, force: true })
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
})

test('domain analysis: refresh-snapshot explicitly replaces the frozen input before one lifecycle starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-refresh-source-'))
  fs.mkdirSync(path.join(root, 'src', 'query'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'pages', 'game'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'services', 'data', 'session'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'types'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'query', 'event.ts'), 'useSessionEvent')
  fs.writeFileSync(path.join(root, 'src', 'pages', 'game', 'GamePopoutShell.tsx'), 'GamePopoutShell')
  fs.writeFileSync(path.join(root, 'src', 'services', 'data', 'session', 'storyArcState.ts'), 'fetchSessionStoryArcState')
  fs.writeFileSync(path.join(root, 'src', 'utils', 'plotSameSelectedItem.ts'), 'plotSameSelectedItem')
  fs.writeFileSync(path.join(root, 'src', 'types', 'index.ts'), 'Shared')
  const calls = []

  await assert.rejects(
    benchmark.captureReport({ root, samples: 1, refreshSnapshot: true }, {
      snapshot: async (source, options) => { calls.push(['snapshot', source, options.refresh]); return '/frozen/refreshed' },
      capture: async (snapshot, options) => { calls.push(['capture', snapshot, options.samples]); throw new Error('stop after lifecycle start') },
    }),
    /stop after lifecycle start/,
  )

  assert.deepEqual(calls, [['snapshot', root, true], ['capture', '/frozen/refreshed', 1]])
  fs.rmSync(root, { recursive: true, force: true })
})

test('error guessing: a concurrent report cannot enter snapshot resolution while another lifecycle owns its repository lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-concurrent-lock-'))
  const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-locks-'))
  const lock = (target, operation) => benchmark.withSnapshotLock(target, operation, { directory: lockDirectory })
  let releaseFirst
  let signalEntered
  const entered = new Promise((resolve) => { signalEntered = resolve })
  const hold = new Promise((resolve) => { releaseFirst = resolve })
  const first = benchmark.captureReport({ root, samples: 1 }, { lock,
    snapshot: async () => '/frozen/shared',
    capture: async () => { signalEntered(); await hold; throw new Error('first lifecycle released') },
  })
  await entered

  const secondMessage = await Promise.race([
    benchmark.captureReport({ root, samples: 1 }, { lock,
      snapshot: async () => { throw new Error('second reached snapshot resolution') },
      capture: async () => { throw new Error('second reached capture lifecycle') },
    }).then(() => 'second unexpectedly completed', (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('second did not fail within 100 ms'), 100)),
  ])
  releaseFirst()
  const firstMessage = await first.then(() => 'first unexpectedly completed', (error) => error.message)

  assert.deepEqual(
    { secondWasLocked: /performance snapshot.*already.*use/i.test(secondMessage), firstMessage },
    { secondWasLocked: true, firstMessage: 'first lifecycle released' },
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(lockDirectory, { recursive: true, force: true })
})

test('error guessing: a lifecycle failure releases its repository snapshot lock for the next report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-failed-lock-'))
  const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-locks-'))
  const lock = (target, operation) => benchmark.withSnapshotLock(target, operation, { directory: lockDirectory })
  const firstMessage = await benchmark.captureReport({ root, samples: 1 }, { lock,
    snapshot: async () => '/frozen/shared',
    capture: async () => { throw new Error('first lifecycle failed') },
  }).then(() => 'first unexpectedly completed', (error) => error.message)
  const secondMessage = await benchmark.captureReport({ root, samples: 1 }, { lock,
    snapshot: async () => { throw new Error('second acquired released lock') },
    capture: async () => { throw new Error('second reached lifecycle') },
  }).then(() => 'second unexpectedly completed', (error) => error.message)

  assert.deepEqual({ firstMessage, secondMessage }, { firstMessage: 'first lifecycle failed', secondMessage: 'second acquired released lock' })
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(lockDirectory, { recursive: true, force: true })
})

test('domain analysis: a successful report releases its repository snapshot lock for the next report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-success-lock-'))
  const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-locks-'))
  const lock = (target, operation) => benchmark.withSnapshotLock(target, operation, { directory: lockDirectory })
  const sweep = {
    refs: { ms: 1, sha256: 'refs' }, deps: { ms: 1, sha256: 'deps' }, callers: { ms: 1, sha256: 'callers' }, dead: { ms: 1, sha256: 'dead' },
    queryNamed: { ms: 1, sha256: 'queryNamed' }, queryCapped: { ms: 1, sha256: 'queryCapped' }, querySingle: { ms: 1, sha256: 'querySingle' },
    cyclo: { ms: 1, sha256: 'cyclo' },
  }
  const sample = { root, sourceFiles: 5, sweeps: { indexed: sweep, updated: sweep }, updates: { initialIndex: { ms: 10, parsedFiles: 5, validatedFiles: 5 }, update: { ms: 2, parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] } } }
  const first = await benchmark.captureReport({ root, samples: 1 }, { lock, snapshot: async () => root, capture: async () => [sample] })
  const secondMessage = await benchmark.captureReport({ root, samples: 1 }, { lock,
    snapshot: async () => { throw new Error('second acquired released lock') },
    capture: async () => { throw new Error('second reached lifecycle') },
  }).then(() => 'second unexpectedly completed', (error) => error.message)

  assert.deepEqual({ firstConsistent: first.correctness.consistent, secondMessage }, { firstConsistent: true, secondMessage: 'second acquired released lock' })
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(lockDirectory, { recursive: true, force: true })
})

test('profiling boundary: parent artifact discovery uses the parser pool exact worker-profile derivation', () => {
  assert.equal(typeof benchmark.deriveWorkerProfile, 'function')
  assert.equal(benchmark.deriveWorkerProfile, parserPoolModule.deriveWorkerProfile)
})

test('error guessing: a dead snapshot owner restores its exact backup before entering an operation when canonical is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-crash-source-'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-crash-lock-'))
  const target = path.join(directory, 'repository-snapshot')
  const owner = 99_999_999
  fs.mkdirSync(`${target}.${owner}.previous`)
  fs.writeFileSync(path.join(`${target}.${owner}.previous`, 'marker.txt'), 'restored backup')
  fs.writeFileSync(path.join(directory, 'repository-snapshot.lock'), `${owner}\n`)

  const observed = await benchmark.withSnapshotLock(root, async () => ({
    marker: fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'),
    backupExists: fs.existsSync(`${target}.${owner}.previous`),
  }), { directory, target })

  assert.deepEqual(
    { observed, targetExists: fs.existsSync(target), lockExists: fs.existsSync(path.join(directory, 'repository-snapshot.lock')) },
    { observed: { marker: 'restored backup', backupExists: false }, targetExists: true, lockExists: false },
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(directory, { recursive: true, force: true })
})

test('error guessing: a dead owner keeps a completed canonical snapshot and removes only its exact stale backup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-completed-source-'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-completed-lock-'))
  const target = path.join(directory, 'repository-snapshot')
  const owner = 99_999_999
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'marker.txt'), 'completed canonical')
  fs.mkdirSync(`${target}.${owner}.previous`)
  fs.writeFileSync(path.join(`${target}.${owner}.previous`, 'marker.txt'), 'stale exact backup')
  fs.mkdirSync(`${target}.123.previous`)
  fs.writeFileSync(path.join(`${target}.123.previous`, 'marker.txt'), 'unrelated backup')
  fs.writeFileSync(path.join(directory, 'repository-snapshot.lock'), `${owner}\n`)

  const observed = await benchmark.withSnapshotLock(root, async () => ({
    marker: fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'),
    exactBackupExists: fs.existsSync(`${target}.${owner}.previous`),
    unrelatedBackup: fs.readFileSync(path.join(`${target}.123.previous`, 'marker.txt'), 'utf8'),
  }), { directory, target })

  assert.deepEqual(
    { observed, lockExists: fs.existsSync(path.join(directory, 'repository-snapshot.lock')) },
    { observed: { marker: 'completed canonical', exactBackupExists: false, unrelatedBackup: 'unrelated backup' }, lockExists: false },
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(directory, { recursive: true, force: true })
})

test('combinatorial analysis: rejects a report missing one operation-state pair', () => {
  const report = structuredClone(completeReport)
  delete report.benchmarks.callers.updated
  assert.throws(() => benchmark.assertCompleteReport(report), /callers.*updated|updated.*callers/i)
})

test('domain analysis: rejects a report without one update timing', () => {
  const report = structuredClone(completeReport)
  delete report.updates.update
  assert.throws(() => benchmark.assertCompleteReport(report), /missing update/i)
})

test('error guessing: rejects output drift across update states', () => {
  const report = structuredClone(completeReport)
  report.correctness.consistent = false
  assert.throws(() => benchmark.assertCompleteReport(report), /consistent|drift/i)
})

test('error guessing: rejects an unclean MCP shutdown', () => {
  const report = structuredClone(completeReport)
  report.correctness.cleanShutdown = false
  assert.throws(() => benchmark.assertCompleteReport(report), /shutdown/i)
})

test('equivalence partition: renders one project-size and feature summary sentence first', () => {
  assert.match(benchmark.renderMarkdown(completeReport), /^CodeGraph was tested against the 863-source-file D&D Community and Marketplace project in one production MCP lifecycle\./)
})

test('equivalence partition: serializes a complete schema-v2 report with a trailing newline', () => {
  assert.equal(benchmark.serializeReport(completeReport), `${JSON.stringify(completeReport, null, 2)}\n`)
})

test('combinatorial analysis: renders every operation and state as p50 / p90 milliseconds', () => {
  const markdown = benchmark.renderMarkdown(completeReport)
  assert.match(markdown, /\| Operation \| Indexed \| Post-update \|/)
  assert.match(markdown, /\| References \| 1\.11 \/ 1\.11 ms \| 2\.12 \/ 2\.92 ms \|/)
  assert.match(markdown, /\| Dependencies \| 4\.11 \/ 4\.11 ms \| 5\.12 \/ 5\.92 ms \|/)
  assert.match(markdown, /\| Callers \| 7\.11 \/ 7\.11 ms \| 8\.12 \/ 8\.92 ms \|/)
  assert.match(markdown, /\| Dead exports \| 10\.11 \/ 10\.11 ms \| 11\.12 \/ 11\.92 ms \|/)
  assert.match(markdown, /\| Named-symbol query \| 13\.11 \/ 13\.11 ms \| 14\.12 \/ 14\.92 ms \|/)
  assert.match(markdown, /\| Symbol list \(2,000 max\) \| 16\.11 \/ 16\.11 ms \| 17\.12 \/ 17\.92 ms \|/)
  assert.match(markdown, /\| Single-symbol query \| 19\.11 \/ 19\.11 ms \| 20\.12 \/ 20\.92 ms \|/)
  assert.match(markdown, /\| Cyclomatic complexity \| 22\.11 \/ 22\.11 ms \| 23\.12 \/ 23\.92 ms \|/)
})

test('domain analysis: renders update latency separately and exposes work counts', () => {
  const markdown = benchmark.renderMarkdown(completeReport)
  assert.match(markdown, /\| Initial index \| 101\.10 \/ 101\.10 ms \| 863 \| 863 \|/)
  assert.match(markdown, /\| One-file update \| 12\.30 \/ 18\.70 ms \| 1 \| 1 \|/)
})

test('domain analysis: Markdown labels the production-runtime initial index', () => {
  assert.match(benchmark.renderMarkdown(completeReport), /\| Initial index \|/)
})

test('error guessing: Markdown avoids instructional placeholder labels', () => {
  assert.doesNotMatch(benchmark.renderMarkdown(completeReport), /Thing being tested|Cold or warm/i)
})

test('equivalence partition: CPU profile launch passes only CPU profiler flags', async (t) => {
  const { service } = isolatedProfileService(t)
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = 0; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() {} }
  let args, proxyArgs

  await benchmark.startMcp({ root: '/repo', profile: { cpu: '/private/tmp/profiles/update.cpuprofile' }, spawnChild: (_command, childArgs) => { if (childArgs.includes('daemon')) { args = childArgs; return service } proxyArgs = childArgs; return child } }).stop()

  assert.deepEqual(args, ['--cpu-prof', '--cpu-prof-dir=/private/tmp/profiles', '--cpu-prof-name=update.cpuprofile', path.resolve(import.meta.dirname, '..', 'tool.mjs'), 'daemon', '--root', '/repo'])
  assert.deepEqual(proxyArgs, [path.resolve(import.meta.dirname, '..', 'mcp.mjs')])
})

test('error guessing: a synchronous MCP spawn failure closes the diagnostic file descriptor', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diagnostic-spawn-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const originalClose = fs.closeSync
  let closed = 0
  fs.closeSync = (descriptor) => { closed += 1; return originalClose(descriptor) }

  try {
    assert.throws(
      () => benchmark.startMcp({ diagnosticLog: path.join(directory, 'profile.log'), spawnChild: () => { throw new Error('spawn failed') } }),
      /spawn failed/,
    )
  } finally {
    fs.closeSync = originalClose
  }

  assert.equal(closed, 1)
})

test('process lifecycle: controller termination stops the MCP group once and unregisters signal listeners', async () => {
  const controller = new EventEmitter()
  controller.pid = 7
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() {} }
  const signals = []
  controller.kill = (pid, signal) => { signals.push([pid, signal]) }
  const mcp = benchmark.startMcp({ root: '/repo', platform: 'linux', controller, spawnChild: () => child, killProcess: (pid, signal) => { signals.push([pid, signal]); queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal) }) } })

  controller.emit('SIGTERM')
  await new Promise((resolve) => setImmediate(resolve))
  const signalsAfterControllerTermination = [...signals]
  await mcp.stop()

  assert.deepEqual({ signalsAfterControllerTermination, signals, sigtermListeners: controller.listenerCount('SIGTERM'), sigintListeners: controller.listenerCount('SIGINT') }, {
    signalsAfterControllerTermination: [[-42, 'SIGTERM'], [7, 'SIGTERM']],
    signals: [[-42, 'SIGTERM'], [7, 'SIGTERM']],
    sigtermListeners: 0,
    sigintListeners: 0,
  })
})

test('domain analysis: clean CPU shutdown reports deterministic main and semantic-worker profile paths', async (t) => {
  const { service } = isolatedProfileService(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpu-artifacts-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'CPU.before.cpuprofile'), 'preexisting')
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() { fs.writeFileSync(path.join(directory, 'update.cpuprofile'), 'main'); fs.writeFileSync(path.join(directory, 'update.worker-semantic.cpuprofile'), 'worker'); queueMicrotask(() => child.emit('exit', 0, null)) } }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: path.join(directory, 'update.cpuprofile') }, spawnChild: (_command, childArgs) => childArgs.includes('daemon') ? service : child, platform: 'linux', killProcess() {} })

  const stopped = await mcp.stop()

  assert.deepEqual(
    { stopped, files: fs.readdirSync(directory).sort(), contents: [fs.readFileSync(path.join(directory, 'update.cpuprofile'), 'utf8'), fs.readFileSync(path.join(directory, 'update.worker-semantic.cpuprofile'), 'utf8')] },
    { stopped: { main: { cpu: path.join(directory, 'update.cpuprofile') }, workers: [{ label: 'semantic', cpu: path.join(directory, 'update.worker-semantic.cpuprofile') }] }, files: ['CPU.before.cpuprofile', 'update.cpuprofile', 'update.worker-semantic.cpuprofile'], contents: ['main', 'worker'] },
  )
})

test('error guessing: timed-out CPU shutdown leaves deterministic profiles at their requested paths', async (t) => {
  const { service } = isolatedProfileService(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpu-timeout-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() {} }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: path.join(directory, 'timeout.cpuprofile') }, spawnChild: (_command, childArgs) => childArgs.includes('daemon') ? service : child, platform: 'linux', shutdownTimeoutMs: 1, killProcess: () => { fs.writeFileSync(path.join(directory, 'timeout.cpuprofile'), 'main'); fs.writeFileSync(path.join(directory, 'timeout.worker-semantic.cpuprofile'), 'worker') } })

  await assert.rejects(mcp.stop(), /shutdown timed out/)

  assert.deepEqual(
    { files: fs.readdirSync(directory).sort(), contents: [fs.readFileSync(path.join(directory, 'timeout.cpuprofile'), 'utf8'), fs.readFileSync(path.join(directory, 'timeout.worker-semantic.cpuprofile'), 'utf8')] },
    { files: ['timeout.cpuprofile', 'timeout.worker-semantic.cpuprofile'], contents: ['main', 'worker'] },
  )
})

test('domain analysis: clean profiled shutdown preserves child diagnostics at the caller path and scopes pool logging to that child', async (t) => {
  const { service } = isolatedProfileService(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diagnostic-clean-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const diagnosticLog = path.join(directory, 'update.pool.log')
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() { child.stderr.emit('data', 'worker allocated slot 4\n'); child.stderr.emit('data', 'main restored slot 4\n'); queueMicrotask(() => child.emit('exit', 0, null)) } }
  let childEnvironment
  const parentDebug = process.env.CODEGRAPH_DEBUG_POOL
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: path.join(directory, 'update.cpuprofile') }, diagnosticLog, spawnChild: (_command, childArgs, options) => { childEnvironment = options.env; return childArgs.includes('daemon') ? service : child }, platform: 'linux', killProcess() {} })

  await mcp.stop()
  fs.renameSync(diagnosticLog, path.join(directory, 'closed.pool.log'))

  assert.deepEqual(
    { bytes: fs.readFileSync(path.join(directory, 'closed.pool.log'), 'utf8'), childDebug: childEnvironment.CODEGRAPH_DEBUG_POOL, parentUnchanged: process.env.CODEGRAPH_DEBUG_POOL === parentDebug },
    { bytes: 'worker allocated slot 4\nmain restored slot 4\n', childDebug: '1', parentUnchanged: true },
  )
})

test('error guessing: timed-out profiled shutdown preserves and closes diagnostics written before forced termination', async (t) => {
  const { service } = isolatedProfileService(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diagnostic-timeout-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const diagnosticLog = path.join(directory, 'update.pool.log')
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() { child.stderr.emit('data', 'waiting for pool slot 299\n') } }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: path.join(directory, 'update.cpuprofile') }, diagnosticLog, spawnChild: (_command, childArgs) => childArgs.includes('daemon') ? service : child, platform: 'linux', shutdownTimeoutMs: 1, killProcess() {} })

  await assert.rejects(mcp.stop(), /shutdown timed out/)
  fs.renameSync(diagnosticLog, path.join(directory, 'closed.pool.log'))

  assert.equal(fs.readFileSync(path.join(directory, 'closed.pool.log'), 'utf8'), 'waiting for pool slot 299\n')
})

test('equivalence partition: heap profile launch passes only heap profiler flags', async (t) => {
  const { service } = isolatedProfileService(t)
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = 0; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() {} }
  let args, proxyArgs

  await benchmark.startMcp({ root: '/repo', profile: { heap: '/private/tmp/profiles/update.heapprofile' }, spawnChild: (_command, childArgs) => { if (childArgs.includes('daemon')) { args = childArgs; return service } proxyArgs = childArgs; return child } }).stop()

  assert.deepEqual(args, ['--heap-prof', '--heap-prof-dir=/private/tmp/profiles', '--heap-prof-name=update.heapprofile', path.resolve(import.meta.dirname, '..', 'tool.mjs'), 'daemon', '--root', '/repo'])
  assert.deepEqual(proxyArgs, [path.resolve(import.meta.dirname, '..', 'mcp.mjs')])
})

test('equivalence partition: trace profile launch passes only trace profiler flags', async (t) => {
  const { service } = isolatedProfileService(t)
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = 0; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() {} }
  let args, proxyArgs

  await benchmark.startMcp({ root: '/repo', profile: { trace: '/private/tmp/profiles/update.trace.json' }, spawnChild: (_command, childArgs) => { if (childArgs.includes('daemon')) { args = childArgs; return service } proxyArgs = childArgs; return child } }).stop()

  assert.deepEqual(args, ['--trace-event-categories=v8,node,node.async_hooks', '--trace-event-file-pattern=/private/tmp/profiles/update.trace.json', path.resolve(import.meta.dirname, '..', 'tool.mjs'), 'daemon', '--root', '/repo'])
  assert.deepEqual(proxyArgs, [path.resolve(import.meta.dirname, '..', 'mcp.mjs')])
})

test('domain analysis: POSIX shutdown signals the whole MCP process group', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  const signals = []
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'linux', killProcess: (pid, signal) => { signals.push([pid, signal]); queueMicrotask(() => child.emit('exit', null, 'SIGTERM')) } })

  await mcp.stop()

  assert.deepEqual(signals, [[-42, 'SIGTERM']])
})

test('domain analysis: Windows shutdown signals the direct MCP child', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  const signals = []
  child.kill = (signal) => { signals.push(signal); queueMicrotask(() => child.emit('exit', null, 'SIGTERM')) }
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'win32' })

  await mcp.stop()

  assert.deepEqual(signals, ['SIGTERM'])
})

test('equivalence partition: stopping an already cleanly exited MCP resolves immediately', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = 0; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }

  await assert.doesNotReject(benchmark.startMcp({ spawnChild: () => child }).stop())
})

test('equivalence partition: stopping an already failed MCP reports its exit code', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = 2; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }

  await assert.rejects(benchmark.startMcp({ spawnChild: () => child }).stop(), /shutdown failed \(2\)/)
})

test('equivalence partition: stopping an MCP already terminated by SIGTERM resolves immediately', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = 'SIGTERM'
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }

  await assert.doesNotReject(benchmark.startMcp({ spawnChild: () => child }).stop())
})

test('equivalence partition: stopping an MCP already terminated by another signal rejects', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = 'SIGKILL'
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }

  await assert.rejects(benchmark.startMcp({ spawnChild: () => child }).stop(), /shutdown failed \(SIGKILL\)/)
})

test('domain analysis: a live MCP clean exit code completes shutdown', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() { queueMicrotask(() => child.emit('exit', 0, null)) } }
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'linux', killProcess() {} })

  await assert.doesNotReject(mcp.stop())
})

test('error guessing: live MCP exit with a failure code rejects shutdown with stderr', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() { queueMicrotask(() => { child.stderr.emit('data', 'shutdown detail'); child.emit('exit', 3, null) }) } }
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'linux', killProcess() {} })

  await assert.rejects(mcp.stop(), /shutdown failed \(3\): shutdown detail/)
})

test('error guessing: live MCP exit by an unexpected signal rejects shutdown with that signal', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')) } }
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'linux', killProcess() {} })

  await assert.rejects(mcp.stop(), /shutdown failed \(SIGKILL\)/)
})

test('error guessing: shutdown timeout force-kills the MCP process group', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  const signals = []
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'linux', shutdownTimeoutMs: 1, killProcess: (pid, signal) => { signals.push([pid, signal]) } })

  await assert.rejects(mcp.stop(), /shutdown timed out/)

  assert.deepEqual(signals, [[-42, 'SIGTERM'], [-42, 'SIGKILL']])
})

test('error guessing: a failed force-kill reports the signal error', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  const mcp = benchmark.startMcp({ spawnChild: () => child, platform: 'linux', shutdownTimeoutMs: 1, killProcess: (_pid, signal) => { if (signal === 'SIGKILL') throw new Error('kill denied') } })

  await assert.rejects(mcp.stop(), /kill denied/)
})

test('error guessing: malformed MCP stdout is ignored before a matching response resolves', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() { queueMicrotask(() => child.stdout.emit('data', '\nnot-json\n{"id":999}\n{"id":1,"result":{"ok":true}}\n')) }, end() {} }
  const mcp = benchmark.startMcp({ spawnChild: () => child, requestTimeoutMs: 100 })

  const result = await mcp.timed('test', {})

  assert.deepEqual(result.message, { id: 1, result: { ok: true } })
})

test('error guessing: pending MCP request rejects with captured stderr when the child exits', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() { queueMicrotask(() => { child.stderr.emit('data', 'fatal detail'); child.emit('exit', 2, null) }) }, end() {} }
  const mcp = benchmark.startMcp({ spawnChild: () => child, requestTimeoutMs: 100 })

  await assert.rejects(mcp.timed('test', {}), /MCP exited \(2\): fatal detail/)
})

test('boundary analysis: a large diagnostic stream keeps only a bounded stderr tail in the thrown error', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() { queueMicrotask(() => { child.stderr.emit('data', `${'x'.repeat(70_000)}TAIL`); child.emit('exit', 2, null) }) }, end() {} }
  const mcp = benchmark.startMcp({ spawnChild: () => child, requestTimeoutMs: 100 })

  const message = await mcp.timed('test', {}).then(() => 'resolved', (error) => error.message)

  assert.deepEqual({ bounded: Buffer.byteLength(message) <= 65_536, endsWithTail: message.endsWith('TAIL') }, { bounded: true, endsWithTail: true })
})

test('error guessing: pending MCP request reports a terminating signal when no exit code exists', async () => {
  const child = new EventEmitter()
  child.pid = 42; child.exitCode = null; child.signalCode = null
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')) }, end() {} }
  const mcp = benchmark.startMcp({ spawnChild: () => child, requestTimeoutMs: 100 })

  await assert.rejects(mcp.timed('test', {}), /MCP exited \(SIGKILL\)/)
})

test('error guessing: a JSON-RPC error aborts a workload sweep with the server message', async () => {
  const mcp = { timed: async () => ({ message: { error: { message: 'query rejected' } }, ms: 1 }) }

  await assert.rejects(benchmark.runSweep(mcp, '/repo'), /codegraph_refs failed: query rejected/)
})

test('error guessing: an MCP tool error aborts a workload sweep with its text receipt', async () => {
  const mcp = { timed: async () => ({ message: { result: { isError: true, content: [{ text: 'tool rejected' }] } }, ms: 1 }) }

  await assert.rejects(benchmark.runSweep(mcp, '/repo'), /codegraph_refs failed: tool rejected/)
})

test('domain analysis: CPU profile capture starts the production MCP on the disposable mirror with its caller-owned destination', async () => {
  const starts = []

  await assert.rejects(
    benchmark.captureSample('/source', {
      withMirror: async (_root, operation) => operation('/private/tmp/codegraph-performance/project'),
      coldBuild: async () => ({ ms: 10, generation: 'generation-a', parsedFiles: 2, validatedFiles: 2 }),
      profile: { cpu: '/profiles/update.cpuprofile' },
      start: (request) => { starts.push(request); throw new Error('stop after profile launch') },
    }),
    /stop after profile launch/,
  )

  assert.deepEqual(starts, [{ root: '/private/tmp/codegraph-performance/project', profile: { cpu: '/profiles/update.cpuprofile' }, requestTimeoutMs: 0 }])
})

test('equivalence partition: a CPU profile starts MCP before indexing and never invokes the external cold build', async () => {
  const coldBuilds = []
  const starts = []

  await assert.rejects(
    benchmark.captureSample('/source', {
      withMirror: async (_root, operation) => operation('/private/tmp/codegraph-performance/project'),
      profile: { cpu: '/profiles/update.cpuprofile' },
      coldBuild: async (...args) => { coldBuilds.push(args); return { ms: 10, generation: 'generation-a', parsedFiles: 2, validatedFiles: 2 } },
      start: (request) => { starts.push(request); throw new Error('stop after profile launch') },
    }),
    /stop after profile launch/,
  )

  assert.deepEqual(
    { coldBuilds, requestTimeoutMs: starts[0].requestTimeoutMs },
    { coldBuilds: [], requestTimeoutMs: 0 },
  )
})

test('single production MCP lifecycle contract: one MCP identity performs initial index and every measured update', async () => {
  const calls = { start: 0, initialize: 0, index: 0, refresh: 0, query: 0, stop: 0 }
  const queryReceivers = []
  const watcherCalls = []
  const mcp = {
    async timed(method, params) {
      if (method === 'initialize') {
        calls.initialize += 1
        return { message: { result: {} }, ms: 1 }
      }
      if (params.name === 'codegraph_index') {
        calls.index += 1
        return { message: { result: { content: [{ text: '{"generation":"g1","parsedFiles":["src/a.ts","src/b.ts"],"validatedFiles":["src/a.ts","src/b.ts"]}' }] } }, ms: 10 }
      }
      if (params.name === 'codegraph_refresh') {
        calls.refresh += 1
        return { message: { result: { content: [{ text: '{}' }] } }, ms: 1 }
      }
      calls.query += 1
      queryReceivers.push(this)
      const receipts = {
        codegraph_refs: 'src/query/event.ts: useSessionEvent',
        codegraph_deps: 'src/pages/game/GamePopoutShell.tsx',
        codegraph_callers: 'storyArcState.ts: fetchSessionStoryArcState',
        codegraph_dead: 'exports in src/query',
        codegraph_internals: 'validatedGeneration: g1\n{"record":"metrics","metrics":{"cyclomatic":3}}',
      }
      const text = params.name === 'codegraph_query'
        ? (params.arguments.query.name || params.arguments.query.file ? 'useSessionEvent' : '{"name":"useSessionEvent"}')
        : receipts[params.name]
      return { message: { result: { content: [{ text }] } }, ms: 1 }
    },
    async stop() {
      calls.stop += 1
    },
  }
  const samples = await benchmark.captureLifecycle('/source', {
    samples: 2,
    withMirror: async (_root, operation) => operation('/mirror'),
    start: () => {
      calls.start += 1
      return mcp
    },
    watcherUpdate: async ({ state, mutationIndex, previousGeneration }) => {
      watcherCalls.push({ state, mutationIndex, previousGeneration })
      return { ms: mutationIndex, generation: `g${mutationIndex + 1}`, parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] }
    },
    progress: () => {},
  })

  assert.deepEqual(
    {
      calls,
      everyQueryUsedStartedMcp: queryReceivers.every((receiver) => receiver === mcp),
      watcherCalls,
      sampleShapes: samples.map((sample) => ({
        root: sample.root,
        sourceFiles: sample.sourceFiles,
        sweepKeys: Object.keys(sample.sweeps),
        updateKeys: Object.keys(sample.updates),
        update: sample.updates.update,
      })),
    },
    {
      calls: { start: 1, initialize: 1, index: 1, refresh: 1, query: 24, stop: 1 },
      everyQueryUsedStartedMcp: true,
      watcherCalls: [
        { state: 'update', mutationIndex: 1, previousGeneration: 'g1' },
        { state: 'update', mutationIndex: 2, previousGeneration: 'g2' },
      ],
      sampleShapes: [
        { root: '/mirror', sourceFiles: 2, sweepKeys: ['indexed', 'updated'], updateKeys: ['update', 'initialIndex'], update: { ms: 1, generation: 'g2', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] } },
        { root: '/mirror', sourceFiles: 2, sweepKeys: ['indexed', 'updated'], updateKeys: ['update'], update: { ms: 2, generation: 'g3', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] } },
      ],
    },
  )
})

test('domain analysis: lifecycle measures queryCapped after every exported-type update without requiring its growing receipt to equal the indexed baseline', async () => {
  let queryCappedCalls = 0
  const watcherCalls = []
  const mcp = {
    async timed(method, params) {
      if (method === 'initialize') return { message: { result: {} }, ms: 1 }
      if (params.name === 'codegraph_index') return { message: { result: { content: [{ text: '{"generation":"g1","parsedFiles":["src/types/index.ts"],"validatedFiles":["src/types/index.ts"]}' }] } }, ms: 1 }
      if (params.name === 'codegraph_refresh') return { message: { result: { content: [{ text: '{}' }] } }, ms: 1 }
      const receipts = {
        codegraph_refs: 'src/query/event.ts: useSessionEvent',
        codegraph_deps: 'src/pages/game/GamePopoutShell.tsx',
        codegraph_callers: 'storyArcState.ts: fetchSessionStoryArcState',
        codegraph_dead: 'exports in src/query',
        codegraph_internals: 'validatedGeneration: g1\n{"record":"metrics","metrics":{"cyclomatic":3}}',
      }
      let text
      if (params.name !== 'codegraph_query') text = receipts[params.name]
      else if (params.arguments.query.name || params.arguments.query.file) text = 'useSessionEvent'
      else {
        queryCappedCalls += 1
        text = `{"name":"symbol-${queryCappedCalls}"}`
      }
      return { message: { result: { content: [{ text }] } }, ms: 1 }
    },
    async stop() {},
  }

  const samples = await benchmark.captureLifecycle('/source', {
    samples: 2,
    withMirror: async (_root, operation) => operation('/mirror'),
    start: () => mcp,
    watcherUpdate: async ({ state, mutationIndex, previousGeneration }) => {
      watcherCalls.push({ state, mutationIndex, previousGeneration })
      return { ms: 1, generation: `g${mutationIndex + 1}`, parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] }
    },
    progress: () => {},
  })

  assert.deepEqual(
    { queryCappedCalls, watcherCalls, samples: samples.length, everySampleMeasuredQueryCapped: samples.every((sample) => sample.sweeps.updated.queryCapped.ms === 1) },
    {
      queryCappedCalls: 3,
      watcherCalls: [
        { state: 'update', mutationIndex: 1, previousGeneration: 'g1' },
        { state: 'update', mutationIndex: 2, previousGeneration: 'g2' },
      ],
      samples: 2,
      everySampleMeasuredQueryCapped: true,
    },
  )
})

test('domain analysis: report accepts dynamic queryCapped receipts but still rejects drift in a stable workload', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-dynamic-query-report-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const indexed = {
    refs: { ms: 1, sha256: 'refs-stable' },
    deps: { ms: 2, sha256: 'deps-stable' },
    callers: { ms: 3, sha256: 'callers-stable' },
    dead: { ms: 4, sha256: 'dead-stable' },
    queryNamed: { ms: 5, sha256: 'queryNamed-stable' },
    queryCapped: { ms: 6, sha256: 'queryCapped-before-update' },
    querySingle: { ms: 7, sha256: 'querySingle-stable' },
    cyclo: { ms: 8, sha256: 'cyclo-stable' },
  }
  const updated = {
    refs: { ms: 11, sha256: 'refs-stable' },
    deps: { ms: 12, sha256: 'deps-stable' },
    callers: { ms: 13, sha256: 'callers-stable' },
    dead: { ms: 14, sha256: 'dead-stable' },
    queryNamed: { ms: 15, sha256: 'queryNamed-stable' },
    queryCapped: { ms: 16, sha256: 'queryCapped-after-update' },
    querySingle: { ms: 17, sha256: 'querySingle-stable' },
    cyclo: { ms: 18, sha256: 'cyclo-stable' },
  }
  const sample = {
    root,
    sourceFiles: 2,
    sweeps: { indexed, updated },
    updates: {
      initialIndex: { ms: 20, parsedFiles: 2, validatedFiles: 2 },
      update: { ms: 3, parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] },
    },
  }

  const report = await benchmark.captureReport({ root, samples: 1 }, { snapshot: async () => root, capture: async () => [sample] })
  const stableDrift = structuredClone(sample)
  stableDrift.sweeps.updated.callers.sha256 = 'callers-drifted'
  const stableDriftMessage = await benchmark.captureReport(
    { root, samples: 1 },
    { snapshot: async () => root, capture: async () => [stableDrift] },
  ).then(() => 'stable drift unexpectedly accepted', (error) => error.message)

  assert.deepEqual(
    { queryCapped: report.benchmarks.queryCapped, stableDriftMessage },
    {
      queryCapped: { indexed: { n: 1, p50Ms: 6, p90Ms: 6 }, updated: { n: 1, p50Ms: 16, p90Ms: 16 } },
      stableDriftMessage: 'callers semantic output drifted across update states',
    },
  )
})

test('single production MCP lifecycle contract: has no alternate selectors or execution routes', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'codegraph.performance.mjs'), 'utf8')
  assert.doesNotMatch(source, /--(?:temperature|phase|direct-engine|provisional-child|external-build)|runProvisionalChild|measureColdBuild|\b(?:phase|temperature|provisional|leaf|cascade|fullReindex)\b/)
})

test('domain analysis: main writes the validated report and rendered Markdown once', async () => {
  const writes = []
  const stdout = { write: (text) => writes.push(['stdout', text]) }

  await benchmark.main(['--root', '/repos/dnd-community-and-marketplace'], {
    capture: async () => completeReport,
    writeArtifacts: (options, json, markdown) => writes.push(['artifacts', options.root, json, markdown]),
    stdout,
  })

  assert.deepEqual(
    { calls: writes.map((entry) => entry[0]), stdoutStartsWithSummary: writes[1][1].startsWith('CodeGraph was tested against the 863-source-file') },
    { calls: ['artifacts', 'stdout'], stdoutStartsWithSummary: true },
  )
})

test('equivalence partition: gitValue returns the fallback for successful empty output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-git-empty-'))
  spawnSync('git', ['init', '-q'], { cwd: root })

  assert.equal(benchmark.gitValue(root, ['status', '--porcelain'], 'clean'), 'clean')
  fs.rmSync(root, { recursive: true, force: true })
})

test('equivalence partition: atomicWrite does nothing when no output path is supplied', () => {
  assert.equal(benchmark.atomicWrite(undefined, 'not written'), undefined)
})

test('domain analysis: runCli delegates successful execution without writing an error', async () => {
  const errors = []
  const exits = []

  await benchmark.runCli(['--root', '/repo'], { runMain: async (argv) => assert.deepEqual(argv, ['--root', '/repo']), stderr: { write: (text) => errors.push(text) }, setExitCode: (code) => exits.push(code) })

  assert.deepEqual({ errors, exits }, { errors: [], exits: [] })
})

test('error guessing: runCli reports a failed execution and sets exit code one', async () => {
  const errors = []
  const exits = []

  await benchmark.runCli([], { runMain: async () => { throw new Error('benchmark failed') }, stderr: { write: (text) => errors.push(text) }, setExitCode: (code) => exits.push(code) })

  assert.deepEqual({ errors, exits }, { errors: ['benchmark failed\n'], exits: [1] })
})

test('domain analysis: resolves the production MCP entry point', () => {
  assert.equal(benchmark.resolveMcpPath(), path.resolve(import.meta.dirname, '..', 'mcp.mjs'))
})

test('profile startup signal boundary: a SIGTERM-exited owned service rejects readiness instead of retrying forever', { timeout: 1000 }, async t => {
  const { service } = isolatedProfileService(t)
  service.exitCode = null; service.signalCode = 'SIGTERM'
  t.mock.method(QueryDaemonClient.prototype, 'connect', async () => { throw new Error('connect ECONNREFUSED') })
  const proxy = new EventEmitter(); proxy.pid = 42; proxy.exitCode = 0; proxy.signalCode = null
  proxy.stdout = new EventEmitter(); proxy.stderr = new EventEmitter(); proxy.stdin = { write() {}, end() {} }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: '/private/tmp/profiles/signal.cpuprofile' }, requestTimeoutMs: 40, spawnChild: (_command, args) => args.includes('daemon') ? service : proxy })
  t.after(async () => { service.exitCode = 1; service.emit('exit', 1, null); await mcp.stop().catch(() => {}) })
  await assert.rejects(mcp.timed('ping', {}), /profile service failed to bind/)
})

test('profile cleanup error guessing: a throwing owned-service kill still closes the daemon client', async t => {
  const { service, state } = isolatedProfileService(t)
  service.kill = () => { throw new Error('owned kill denied') }
  const proxy = new EventEmitter(); proxy.pid = 42; proxy.exitCode = 2; proxy.signalCode = null
  proxy.stdout = new EventEmitter(); proxy.stderr = new EventEmitter(); proxy.stdin = { write() {}, end() {} }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: '/private/tmp/profiles/kill-error.cpuprofile' }, spawnChild: (_command, args) => args.includes('daemon') ? service : proxy })
  t.after(async () => { service.exitCode = 1; await mcp.stop().catch(() => {}) })
  await assert.rejects(mcp.stop(), /owned kill denied/)
  assert.equal(state.closes, 1, 'a cleanup signal failure must not retain the service client')
})

test('profile cleanup exited partition: an already-exited owned service is never signalled and its client closes', async t => {
  const { service, state } = isolatedProfileService(t); service.exitCode = 1; service.signalCode = null
  let kills = 0; service.kill = () => { kills++; throw new Error('must not signal an exited child') }
  const proxy = new EventEmitter(); proxy.pid = 42; proxy.exitCode = 2; proxy.signalCode = null
  proxy.stdout = new EventEmitter(); proxy.stderr = new EventEmitter(); proxy.stdin = { write() {}, end() {} }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: '/private/tmp/profiles/exited.cpuprofile' }, spawnChild: (_command, args) => args.includes('daemon') ? service : proxy })
  await assert.rejects(mcp.stop(), /MCP shutdown failed \(2\)/)
  assert.deepEqual({ kills, closes: state.closes }, { kills: 0, closes: 1 })
})

test('profile cleanup signalled partition: a SIGTERM-exited owned service is never signalled again and its client closes', async t => {
  const { service, state } = isolatedProfileService(t); service.exitCode = null; service.signalCode = 'SIGTERM'
  let kills = 0; service.kill = () => { kills++; throw new Error('must not signal a signal-exited child') }
  const proxy = new EventEmitter(); proxy.pid = 42; proxy.exitCode = 2; proxy.signalCode = null
  proxy.stdout = new EventEmitter(); proxy.stderr = new EventEmitter(); proxy.stdin = { write() {}, end() {} }
  const mcp = benchmark.startMcp({ root: '/repo', profile: { cpu: '/private/tmp/profiles/signalled-exit.cpuprofile' }, spawnChild: (_command, args) => args.includes('daemon') ? service : proxy })
  t.after(async () => { service.exitCode = 1; await mcp.stop().catch(() => {}) })
  await assert.rejects(mcp.stop(), /MCP shutdown failed \(2\)/)
  assert.deepEqual({ kills, closes: state.closes }, { kills: 0, closes: 1 })
})
