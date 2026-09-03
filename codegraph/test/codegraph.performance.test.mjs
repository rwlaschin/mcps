import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import * as benchmark from '../scripts/codegraph.performance.mjs'

const completeReport = {
  schemaVersion: 2,
  provenance: { root: '/private/tmp/codegraph-performance/dnd-community-and-marketplace', sourceRoot: '/repos/dnd-community-and-marketplace', repository: 'dnd-community-and-marketplace', sourceFiles: 863, commit: '0123456789abcdef' },
  benchmarks: {
    refs: { indexed: { n: 5, p50Ms: 1.11, p90Ms: 1.91 }, leaf: { n: 5, p50Ms: 2.12, p90Ms: 2.92 }, cascade: { n: 5, p50Ms: 3.13, p90Ms: 3.93 } },
    deps: { indexed: { n: 5, p50Ms: 4.11, p90Ms: 4.91 }, leaf: { n: 5, p50Ms: 5.12, p90Ms: 5.92 }, cascade: { n: 5, p50Ms: 6.13, p90Ms: 6.93 } },
    callers: { indexed: { n: 5, p50Ms: 7.11, p90Ms: 7.91 }, leaf: { n: 5, p50Ms: 8.12, p90Ms: 8.92 }, cascade: { n: 5, p50Ms: 9.13, p90Ms: 9.93 } },
    dead: { indexed: { n: 5, p50Ms: 10.11, p90Ms: 10.91 }, leaf: { n: 5, p50Ms: 11.12, p90Ms: 11.92 }, cascade: { n: 5, p50Ms: 12.13, p90Ms: 12.93 } },
    queryNamed: { indexed: { n: 5, p50Ms: 13.11, p90Ms: 13.91 }, leaf: { n: 5, p50Ms: 14.12, p90Ms: 14.92 }, cascade: { n: 5, p50Ms: 15.13, p90Ms: 15.93 } },
    queryCapped: { indexed: { n: 5, p50Ms: 16.11, p90Ms: 16.91 }, leaf: { n: 5, p50Ms: 17.12, p90Ms: 17.92 }, cascade: { n: 5, p50Ms: 18.13, p90Ms: 18.93 } },
    querySingle: { indexed: { n: 5, p50Ms: 19.11, p90Ms: 19.91 }, leaf: { n: 5, p50Ms: 20.12, p90Ms: 20.92 }, cascade: { n: 5, p50Ms: 21.13, p90Ms: 21.93 } },
  },
  updates: {
    initialIndex: { n: 5, p50Ms: 101.1, p90Ms: 109.9 },
    leaf: { n: 5, p50Ms: 12.3, p90Ms: 18.7, parsedFiles: 1, validatedFiles: 1 },
    cascade: { n: 5, p50Ms: 52.4, p90Ms: 68.8, parsedFiles: 37, validatedFiles: 214 },
    fullReindex: { n: 5, p50Ms: 111.1, p90Ms: 119.9 },
  },
  correctness: { consistent: true, originalRepositoryUnchanged: true, cleanShutdown: true },
}

test('equivalence partition: rejects a missing repository root', () => {
  assert.throws(() => benchmark.parseArgs([]), /--root/)
})

test('equivalence partition: rejects an empty repository root', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '']), /--root/)
})

test('equivalence partition: rejects the obsolete --symbol option', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--symbol', 'useSessionEvent']), /unknown option.*--symbol/i)
})

test('equivalence partition: rejects the obsolete --profile option', () => {
  assert.throws(() => benchmark.parseArgs(['--root', '/repos/dnd-community-and-marketplace', '--profile']), /unknown option.*--profile/i)
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

test('domain analysis: declares the seven exact production workload requests', () => {
  assert.deepEqual(benchmark.WORKLOADS, [
    { key: 'refs', label: 'References', tool: 'codegraph_refs', arguments: { symbol: 'src/query/event.ts:useSessionEvent' } },
    { key: 'deps', label: 'Dependencies', tool: 'codegraph_deps', arguments: { file: 'src/pages/game/GamePopoutShell.tsx' } },
    { key: 'callers', label: 'Callers', tool: 'codegraph_callers', arguments: { symbol: 'fetchSessionStoryArcState', depth: 3 } },
    { key: 'dead', label: 'Dead exports', tool: 'codegraph_dead', arguments: { prefix: 'src/query' } },
    { key: 'queryNamed', label: 'Named-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', name: 'useSessionEvent', limit: 2000 } } },
    { key: 'queryCapped', label: 'Symbol list (2,000 max)', tool: 'codegraph_query', arguments: { query: { type: 'symbols', limit: 2000 } } },
    { key: 'querySingle', label: 'Single-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', file: 'src/query/event.ts', name: 'useSessionEvent', limit: 1 } } },
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

test('boundary analysis: rejects cascade validation of one file', () => {
  assert.throws(() => benchmark.assertCascadeValidation(1), /cascade|two|2/i)
})

test('boundary analysis: accepts cascade validation of two files', () => {
  assert.doesNotThrow(() => benchmark.assertCascadeValidation(2))
})

test('equivalence partition: accepts an array containing two cascade-validated files', () => {
  assert.doesNotThrow(() => benchmark.assertCascadeValidation(['src/types/index.ts', 'src/query/event.ts']))
})

test('equivalence partition: rejects a non-integer cascade validation count', () => {
  assert.throws(() => benchmark.assertCascadeValidation('2'), /cascade|two|2/i)
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

test('combinatorial analysis: accepts endpoint-specific receipts for the remaining six workloads', () => {
  assert.deepEqual(
    [
      benchmark.assertExpectedReceipt('refs', 'src/query/event.ts: useSessionEvent'),
      benchmark.assertExpectedReceipt('deps', 'src/pages/game/GamePopoutShell.tsx'),
      benchmark.assertExpectedReceipt('callers', 'src/services/data/session/storyArcState.ts: fetchSessionStoryArcState'),
      benchmark.assertExpectedReceipt('dead', '3 exports in src/query'),
      benchmark.assertExpectedReceipt('queryCapped', '{"name":"useSessionEvent"}'),
      benchmark.assertExpectedReceipt('querySingle', 'useSessionEvent'),
    ],
    ['src/query/event.ts: useSessionEvent', 'src/pages/game/GamePopoutShell.tsx', 'src/services/data/session/storyArcState.ts: fetchSessionStoryArcState', '3 exports in src/query', '{"name":"useSessionEvent"}', 'useSessionEvent'],
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

test('domain analysis: initial index timing performs exactly one cold tool build before runtime queries', async () => {
  const calls = []

  const result = await benchmark.measureColdBuild('/mirror', {
    build: async (root) => { calls.push(['tool.mjs build', root]); return { generation: 'indexed-generation', parsedFiles: 863, validatedFiles: 863, ms: 1250 } },
  })

  assert.deepEqual({ calls, result }, { calls: [['tool.mjs build', '/mirror']], result: { generation: 'indexed-generation', parsedFiles: 863, validatedFiles: 863, ms: 1250 } })
})

test('domain analysis: cold build invokes tool.mjs build once and parses its update receipt', async () => {
  const calls = []
  const result = await benchmark.buildOnce('/mirror', {
    run: (command, args, options) => { calls.push({ command, args, cwd: options.cwd, timeout: options.timeout }); return { status: 0, stdout: '{"generation":"g1","parsedFiles":["a.ts"],"validatedFiles":["a.ts"]}\n', stderr: '' } },
    clock: (() => { const times = [100, 145]; return () => times.shift() })(),
    timeoutMs: 500,
  })

  assert.deepEqual(
    { callCount: calls.length, args: calls[0].args.slice(-3), timeout: calls[0].timeout, result },
    { callCount: 1, args: ['build', '--root', '/mirror'], timeout: 500, result: { ms: 45, generation: 'g1', parsedFiles: 1, validatedFiles: 1 } },
  )
})

test('error guessing: cold build propagates a process launch error', async () => {
  await assert.rejects(benchmark.buildOnce('/mirror', { run: () => ({ error: new Error('spawn denied') }), clock: () => 0 }), /spawn denied/)
})

test('error guessing: cold build reports a nonzero exit and stderr', async () => {
  await assert.rejects(benchmark.buildOnce('/mirror', { run: () => ({ status: 2, signal: null, stdout: '', stderr: 'build broke' }), clock: () => 0 }), /cold build failed \(2\): build broke/)
})

test('error guessing: cold build reports a terminating signal when no status exists', async () => {
  await assert.rejects(benchmark.buildOnce('/mirror', { run: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: 'killed' }), clock: () => 0 }), /cold build failed \(SIGKILL\): killed/)
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
    { events: ['mutate leaf', 'poll metadata', 'wait', 'poll metadata', 'wait', 'poll metadata'], result: { ms: 25, generation: 'generation-b', parsedFiles: 1, validatedFiles: 1 } },
  )
})

test('domain analysis: cascade watcher timing waits for validated publication without calling explicit refresh', async () => {
  const calls = []

  await benchmark.measureWatcherUpdate({
    root: '/mirror', state: 'cascade', previousGeneration: 'generation-leaf', phase: 'cascade incremental update', timeoutMs: 100,
    mutate: () => calls.push('mutate cascade'),
    readMetadata: async () => { calls.push('poll metadata'); return { generation: 'generation-cascade', status: 'validated', parsedFiles: ['types.ts'], validatedFiles: ['types.ts', 'dependent.ts'] } },
    wait: async () => calls.push('wait'),
    clock: (() => { const times = [50, 90]; return () => times.shift() })(),
  })

  assert.deepEqual(calls, ['mutate cascade', 'poll metadata'])
})

test('error guessing: watcher publication timeout names the incremental phase', async () => {
  let polls = 0
  await assert.rejects(
    benchmark.measureWatcherUpdate({
      root: '/mirror', state: 'cascade', previousGeneration: 'generation-a', phase: 'cascade incremental update', timeoutMs: 1,
      mutate: () => {},
      readMetadata: async () => { polls += 1; return polls === 1 ? { generation: 'generation-a', status: 'validated' } : { generation: 'generation-b', status: 'validated' } },
      wait: async () => new Promise((resolve) => setTimeout(resolve, 2)),
      clock: () => 0,
    }),
    /cascade incremental update.*timed out/i,
  )
})

test('equivalence partition: watcher update defaults mutate the leaf and poll until publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-defaults-'))
  fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'utils', 'plotSameSelectedItem.ts'), 'export const leaf = true\n')
  let polls = 0

  const result = await benchmark.measureWatcherUpdate({
    root, state: 'leaf', previousGeneration: 'generation-a', phase: 'leaf incremental update', timeoutMs: 100,
    readMetadata: async () => { polls += 1; return polls === 1 ? { generation: 'generation-a', status: 'validated' } : { validatedGeneration: 'generation-b', freshness: 'validated', parsedFiles: 1, validatedFiles: 1 } },
  })

  assert.deepEqual({ generation: result.generation, parsedFiles: result.parsedFiles, validatedFiles: result.validatedFiles, mutated: fs.readFileSync(path.join(root, 'src', 'utils', 'plotSameSelectedItem.ts'), 'utf8') }, { generation: 'generation-b', parsedFiles: 1, validatedFiles: 1, mutated: 'export const leaf = true\n// codegraph performance benchmark\n' })
  fs.rmSync(root, { recursive: true, force: true })
})

test('equivalence partition: watcher metadata reports the unchanged generation without reading manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-same-'))
  fs.mkdirSync(path.join(root, '.codegraph'))
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-a\n')

  assert.deepEqual(benchmark.watcherMetadata(root, 'generation-a', 'leaf'), { generation: 'generation-a', status: 'validated' })
  fs.rmSync(root, { recursive: true, force: true })
})

test('domain analysis: watcher metadata computes cascade parsed files and reverse-dependent closure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-cascade-'))
  const cache = path.join(root, '.codegraph')
  fs.mkdirSync(path.join(cache, 'generations'), { recursive: true })
  fs.mkdirSync(path.join(cache, 'partitions'))
  fs.writeFileSync(path.join(cache, 'CURRENT'), 'generation-b\n')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-a.json'), '{"partitions":{"src/dependent.ts":"p1","src/transitive.ts":"p2"},"sources":{"src/types/index.ts":"old","src/dependent.ts":"same","src/transitive.ts":"same"}}')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-b.json'), '{"partitions":{},"sources":{"src/types/index.ts":"new","src/dependent.ts":"same","src/transitive.ts":"same"}}')
  fs.writeFileSync(path.join(cache, 'partitions', 'p1.json'), '{"dependencies":["src/types/index.ts"]}')
  fs.writeFileSync(path.join(cache, 'partitions', 'p2.json'), '{"dependencies":["src/dependent.ts"]}')

  const metadata = benchmark.watcherMetadata(root, 'generation-a', 'cascade')

  assert.deepEqual(metadata, { generation: 'generation-b', status: 'validated', parsedFiles: ['src/types/index.ts'], validatedFiles: ['src/types/index.ts', 'src/dependent.ts', 'src/transitive.ts'] })
  fs.rmSync(root, { recursive: true, force: true })
})

test('domain analysis: watcher metadata computes leaf work when partitions omit dependency arrays', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-watcher-leaf-'))
  const cache = path.join(root, '.codegraph')
  fs.mkdirSync(path.join(cache, 'generations'), { recursive: true })
  fs.mkdirSync(path.join(cache, 'partitions'))
  fs.writeFileSync(path.join(cache, 'CURRENT'), 'generation-b\n')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-a.json'), '{"partitions":{"src/unrelated.ts":"p1"},"sources":{"src/utils/plotSameSelectedItem.ts":"old","src/unrelated.ts":"same"}}')
  fs.writeFileSync(path.join(cache, 'generations', 'generation-b.json'), '{"partitions":{},"sources":{"src/utils/plotSameSelectedItem.ts":"new","src/unrelated.ts":"same"}}')
  fs.writeFileSync(path.join(cache, 'partitions', 'p1.json'), '{}')

  const metadata = benchmark.watcherMetadata(root, 'generation-a', 'leaf')

  assert.deepEqual(metadata, { generation: 'generation-b', status: 'validated', parsedFiles: ['src/utils/plotSameSelectedItem.ts'], validatedFiles: ['src/utils/plotSameSelectedItem.ts'] })
  fs.rmSync(root, { recursive: true, force: true })
})

test('domain analysis: cascade mutation preserves the preceding leaf mutation', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-sequence-'))
  fs.mkdirSync(path.join(temporaryRoot, 'src', 'utils'), { recursive: true })
  fs.mkdirSync(path.join(temporaryRoot, 'src', 'types'), { recursive: true })
  fs.writeFileSync(path.join(temporaryRoot, 'src', 'utils', 'plotSameSelectedItem.ts'), 'export const leaf = true\n')
  fs.writeFileSync(path.join(temporaryRoot, 'src', 'types', 'index.ts'), 'export type Root = string\n')

  benchmark.applyStateMutation(temporaryRoot, 'leaf')
  benchmark.applyStateMutation(temporaryRoot, 'cascade')

  assert.deepEqual(
    {
      leaf: fs.readFileSync(path.join(temporaryRoot, 'src', 'utils', 'plotSameSelectedItem.ts'), 'utf8'),
      cascade: fs.readFileSync(path.join(temporaryRoot, 'src', 'types', 'index.ts'), 'utf8'),
    },
    {
      leaf: 'export const leaf = true\n// codegraph performance benchmark\n',
      cascade: 'export type Root = string\n// codegraph performance benchmark\n',
    },
  )
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

test('equivalence partition: rejects an unknown mutation state', () => {
  assert.throws(() => benchmark.applyStateMutation('/tmp', 'indexed'), /unknown benchmark state/)
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

test('error guessing: missing required D&D fixtures abort before creating an index', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-fixtures-'))
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/codegraph.performance.mjs'), '--root', temporaryRoot, '--samples', '1'], { encoding: 'utf8' })

  assert.deepEqual({ status: result.status, mentionsFixture: /fixture|src\/query\/event\.ts/i.test(result.stderr), indexed: fs.existsSync(path.join(temporaryRoot, '.codegraph')) }, { status: 1, mentionsFixture: true, indexed: false })
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
})

test('error guessing: receipt comparison rejects one semantically drifting endpoint', () => {
  const expected = Object.fromEntries(benchmark.WORKLOADS.map(({ key }) => [key, { sha256: `${key}-stable` }]))
  const actual = structuredClone(expected)
  actual.callers.sha256 = 'callers-drifted'

  assert.throws(() => benchmark.assertReceiptsMatch(expected, actual), /callers.*drifted/i)
})

test('domain analysis: validates all seven operations in all three repository states', () => {
  assert.equal(benchmark.assertCompleteReport(completeReport), completeReport)
})

test('domain analysis: captureReport aggregates independent samples and update work maxima', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-report-'))
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
  const firstSweep = {
    refs: { ms: 10, sha256: 'refs' }, deps: { ms: 11, sha256: 'deps' }, callers: { ms: 12, sha256: 'callers' }, dead: { ms: 13, sha256: 'dead' },
    queryNamed: { ms: 14, sha256: 'queryNamed' }, queryCapped: { ms: 15, sha256: 'queryCapped' }, querySingle: { ms: 16, sha256: 'querySingle' },
  }
  const secondSweep = {
    refs: { ms: 20, sha256: 'refs' }, deps: { ms: 21, sha256: 'deps' }, callers: { ms: 22, sha256: 'callers' }, dead: { ms: 23, sha256: 'dead' },
    queryNamed: { ms: 24, sha256: 'queryNamed' }, queryCapped: { ms: 25, sha256: 'queryCapped' }, querySingle: { ms: 26, sha256: 'querySingle' },
  }
  const samples = [
    { root: '/mirror/one', sourceFiles: 863, sweeps: { indexed: firstSweep, leaf: firstSweep, cascade: firstSweep }, updates: { initialIndex: { ms: 100 }, leaf: { ms: 30, parsedFiles: 1, validatedFiles: 1 }, cascade: { ms: 40, parsedFiles: 2, validatedFiles: 10 }, fullReindex: { ms: 110 } } },
    { root: '/mirror/two', sourceFiles: 863, sweeps: { indexed: secondSweep, leaf: secondSweep, cascade: secondSweep }, updates: { initialIndex: { ms: 200 }, leaf: { ms: 35, parsedFiles: 2, validatedFiles: 2 }, cascade: { ms: 45, parsedFiles: 3, validatedFiles: 20 }, fullReindex: { ms: 210 } } },
  ]

  const report = await benchmark.captureReport({ root, samples: 2 }, { capture: async () => samples.shift() })

  assert.deepEqual(
    { refs: report.benchmarks.refs.indexed, initialIndex: report.updates.initialIndex, leaf: report.updates.leaf, cascade: report.updates.cascade, unchanged: report.correctness.originalRepositoryUnchanged },
    { refs: { n: 2, p50Ms: 10, p90Ms: 20 }, initialIndex: { n: 2, p50Ms: 100, p90Ms: 200 }, leaf: { n: 2, p50Ms: 30, p90Ms: 35, parsedFiles: 2, validatedFiles: 2 }, cascade: { n: 2, p50Ms: 40, p90Ms: 45, parsedFiles: 3, validatedFiles: 20 }, unchanged: true },
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('combinatorial analysis: rejects a report missing one operation-state pair', () => {
  const report = structuredClone(completeReport)
  delete report.benchmarks.callers.cascade
  assert.throws(() => benchmark.assertCompleteReport(report), /callers.*cascade|cascade.*callers/i)
})

test('domain analysis: rejects a report without cascade parsed-file work', () => {
  const report = structuredClone(completeReport)
  delete report.updates.cascade.parsedFiles
  assert.throws(() => benchmark.assertCompleteReport(report), /cascade.*parsed/i)
})

test('domain analysis: rejects a report without cascade validated-file work', () => {
  const report = structuredClone(completeReport)
  delete report.updates.cascade.validatedFiles
  assert.throws(() => benchmark.assertCompleteReport(report), /cascade.*validated/i)
})

test('domain analysis: rejects a report without one update timing', () => {
  const report = structuredClone(completeReport)
  delete report.updates.fullReindex
  assert.throws(() => benchmark.assertCompleteReport(report), /missing fullReindex/i)
})

test('error guessing: rejects output drift across update states', () => {
  const report = structuredClone(completeReport)
  report.correctness.consistent = false
  assert.throws(() => benchmark.assertCompleteReport(report), /consistent|drift/i)
})

test('error guessing: rejects mutation of the source repository', () => {
  const report = structuredClone(completeReport)
  report.correctness.originalRepositoryUnchanged = false
  assert.throws(() => benchmark.assertCompleteReport(report), /original.*unchanged|mutat/i)
})

test('error guessing: rejects an unclean MCP shutdown', () => {
  const report = structuredClone(completeReport)
  report.correctness.cleanShutdown = false
  assert.throws(() => benchmark.assertCompleteReport(report), /shutdown/i)
})

test('equivalence partition: renders one project-size and feature summary sentence first', () => {
  assert.match(benchmark.renderMarkdown(completeReport), /^CodeGraph was tested against the 863-source-file D&D Community and Marketplace project, covering all query endpoints, initial indexing, leaf updates, cascade updates, and full reindexing\./)
})

test('equivalence partition: serializes a complete schema-v2 report with a trailing newline', () => {
  assert.equal(benchmark.serializeReport(completeReport), `${JSON.stringify(completeReport, null, 2)}\n`)
})

test('combinatorial analysis: renders every operation and state as p50 / p90 milliseconds', () => {
  const markdown = benchmark.renderMarkdown(completeReport)
  assert.match(markdown, /\| References \| 1\.11 \/ 1\.91 ms \| 2\.12 \/ 2\.92 ms \| 3\.13 \/ 3\.93 ms \|/)
  assert.match(markdown, /\| Dependencies \| 4\.11 \/ 4\.91 ms \| 5\.12 \/ 5\.92 ms \| 6\.13 \/ 6\.93 ms \|/)
  assert.match(markdown, /\| Callers \| 7\.11 \/ 7\.91 ms \| 8\.12 \/ 8\.92 ms \| 9\.13 \/ 9\.93 ms \|/)
  assert.match(markdown, /\| Dead exports \| 10\.11 \/ 10\.91 ms \| 11\.12 \/ 11\.92 ms \| 12\.13 \/ 12\.93 ms \|/)
  assert.match(markdown, /\| Named-symbol query \| 13\.11 \/ 13\.91 ms \| 14\.12 \/ 14\.92 ms \| 15\.13 \/ 15\.93 ms \|/)
  assert.match(markdown, /\| Symbol list \(2,000 max\) \| 16\.11 \/ 16\.91 ms \| 17\.12 \/ 17\.92 ms \| 18\.13 \/ 18\.93 ms \|/)
  assert.match(markdown, /\| Single-symbol query \| 19\.11 \/ 19\.91 ms \| 20\.12 \/ 20\.92 ms \| 21\.13 \/ 21\.93 ms \|/)
})

test('domain analysis: renders update latency separately and exposes cascade work counts', () => {
  const markdown = benchmark.renderMarkdown(completeReport)
  assert.match(markdown, /\| CLI cold index \| 101\.10 \/ 109\.90 ms \|/)
  assert.match(markdown, /\| Leaf incremental update \| 12\.30 \/ 18\.70 ms \| 1 \| 1 \|/)
  assert.match(markdown, /\| Cascade incremental update \| 52\.40 \/ 68\.80 ms \| 37 \| 214 \|/)
  assert.match(markdown, /\| Full reindex \| 111\.10 \/ 119\.90 ms \|/)
})

test('domain analysis: Markdown does not mislabel the CLI build as a production-runtime initial index', () => {
  assert.doesNotMatch(benchmark.renderMarkdown(completeReport), /\| Initial index \|/)
})

test('error guessing: Markdown avoids instructional placeholder labels', () => {
  assert.doesNotMatch(benchmark.renderMarkdown(completeReport), /Thing being tested|Cold or warm/i)
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

test('error guessing: a failed cold build aborts before starting the MCP runtime', async () => {
  let starts = 0

  await assert.rejects(
    benchmark.captureSample('/source', {
      withMirror: async (_root, operation) => operation('/mirror'),
      coldBuild: async () => { throw new Error('cold build returned invalid JSON') },
      start: () => { starts += 1; return {} },
    }),
    /cold build returned invalid JSON/,
  )

  assert.equal(starts, 0)
})

test('domain analysis: runtime watcher readiness barrier occurs once after indexed queries and before leaf mutation timing', async () => {
  const events = []
  const mcp = {
    timed: async (method, params) => {
      if (method === 'initialize') { events.push('initialize'); return { message: { result: {} }, ms: 1 } }
      events.push(params.name)
      if (params.name === 'codegraph_refresh') return { message: { result: { content: [{ text: '{"generation":"g1"}' }] } }, ms: 1 }
      if (params.name === 'codegraph_index') return { message: { result: { content: [{ text: '{"generation":"g4","parsedFiles":[],"validatedFiles":[]}' }] } }, ms: 1 }
      const receipts = { codegraph_refs: 'src/query/event.ts: useSessionEvent', codegraph_deps: 'src/pages/game/GamePopoutShell.tsx', codegraph_callers: 'storyArcState.ts: fetchSessionStoryArcState', codegraph_dead: 'exports in src/query' }
      const text = params.name === 'codegraph_query'
        ? (params.arguments.query.limit === 1 || params.arguments.query.name ? 'useSessionEvent' : '{"name":"symbol"}')
        : receipts[params.name]
      return { message: { result: { content: [{ text }] } }, ms: 1 }
    },
    stop: async () => {},
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-scripted-'))
  fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'types'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'utils', 'plotSameSelectedItem.ts'), 'export const leaf = true\n')
  fs.writeFileSync(path.join(root, 'src', 'types', 'index.ts'), 'export type Root = string\n')

  const sample = await benchmark.captureSample(root, {
    withMirror: async (_root, operation) => operation(root),
    start: () => mcp,
    coldBuild: async () => { events.push('CLI cold index'); return { ms: 10, generation: 'g1', parsedFiles: 0, validatedFiles: 0 } },
    readMetadata: () => ({ status: 'validated' }),
    watcherUpdate: async ({ root: target, state, previousGeneration, readMetadata }) => {
      events.push(`${state} timed mutation`)
      readMetadata(target, previousGeneration)
      return state === 'leaf'
        ? ({ ms: 2, generation: 'g2', parsedFiles: 1, validatedFiles: 1 })
        : ({ ms: 3, generation: 'g3', parsedFiles: 1, validatedFiles: 2 })
    },
  })

  assert.deepEqual(
    {
      readinessCalls: events.filter((event) => event === 'codegraph_refresh').length,
      beforeReadiness: events.slice(0, events.indexOf('codegraph_refresh')),
      afterReadiness: events[events.indexOf('codegraph_refresh') + 1],
      initialCounts: [sample.updates.initialIndex.parsedFiles, sample.updates.initialIndex.validatedFiles],
    },
    {
      readinessCalls: 1,
      beforeReadiness: ['CLI cold index', 'initialize', 'codegraph_refs', 'codegraph_deps', 'codegraph_callers', 'codegraph_dead', 'codegraph_query', 'codegraph_query', 'codegraph_query'],
      afterReadiness: 'leaf timed mutation',
      initialCounts: [0, 0],
    },
  )
  fs.rmSync(root, { recursive: true, force: true })
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
