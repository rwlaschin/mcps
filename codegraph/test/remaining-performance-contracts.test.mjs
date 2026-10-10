import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import { ts } from '@ts-morph/common'

import { resolveCachedImport } from '../cached-binding-resolver.mjs'
import { FileLocalResolver, parseFile } from '../incremental-resolver.mjs'
import * as benchmark from '../scripts/codegraph.performance.mjs'
import { SemanticCheckerWorker } from '../semantic-checker-worker.mjs'
import { CodeGraphEngine } from '../tool-engine.mjs'

const partitionPool = () => new SharedArrayBuffer(4096 + 300 * 65536)

// Test-only preload observes real filesystem calls in every worker isolate.
const observeWorkerFilesystem = (context, root, operation) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fs-observation-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const preload = path.join(directory, 'observe.cjs')
  const log = path.join(directory, 'calls.jsonl')
  fs.writeFileSync(preload, String.raw`
const fs = require('node:fs')
const { threadId, workerData } = require('node:worker_threads')
const { syncBuiltinESMExports } = require('node:module')
const append = fs.appendFileSync.bind(fs)
const record = (entry) => append(process.env.CODEGRAPH_TEST_FS_LOG, JSON.stringify({ threadId, ...entry }) + '\n')
record({ loaded: true, semantic: workerData?.semanticChecker === true })
for (const method of ['readFileSync', 'readFile', 'openSync', 'open', 'existsSync', 'statSync', 'stat', 'lstatSync', 'lstat']) {
  const original = fs[method]
  fs[method] = function (file, ...args) {
    const target = file instanceof URL ? require('node:url').fileURLToPath(file) : typeof file === 'string' ? file : ''
    if (target.startsWith(process.env.CODEGRAPH_TEST_FS_ROOT + require('node:path').sep)) record({ method, file: target })
    return original.call(this, file, ...args)
  }
}
syncBuiltinESMExports()
const control = require('node:path').join(process.env.CODEGRAPH_TEST_FS_ROOT, '__observer_probe__')
fs.existsSync(control)
try { fs.readFileSync(control) } catch (error) { if (error.code !== 'ENOENT') throw error }
`)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { SemanticCheckerWorker } from './semantic-checker-worker.mjs'
const root = process.env.CODEGRAPH_TEST_FS_ROOT
const worker = new SemanticCheckerWorker()
const partitionPool = () => new SharedArrayBuffer(4096 + 300 * 65536)
try {
${operation}
process.stdout.write(JSON.stringify({ semanticTraversalSummary: result.semanticTraversalSummary }))
} finally { await worker.dispose() }
`], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`, CODEGRAPH_TEST_FS_LOG: log, CODEGRAPH_TEST_FS_ROOT: root, CODEGRAPH_DEBUG_POOL: '1' },
  })
  assert.equal(child.status, 0, child.stderr)
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(calls.some(({ semantic, threadId }) => semantic === true && threadId > 0), true, 'preload must execute in the semantic worker despite its explicit execArgv')
  const semanticThread = calls.find(({ semantic }) => semantic === true).threadId
  const control = path.join(root, '__observer_probe__')
  assert.equal(calls.some(({ threadId, method, file }) => threadId === semanticThread && file === control && method === 'existsSync'), true, 'observer must detect an actual existence probe')
  assert.equal(calls.some(({ threadId, method, file }) => threadId === semanticThread && file === control && method === 'readFileSync'), true, 'observer must detect an actual source read')
  return { calls: calls.filter(({ file }) => file !== control), ...JSON.parse(child.stdout) }
}

test('domain analysis: a cold four-file semantic batch dispatches four jobs through the retained worker', async (context) => {
  process.env.CODEGRAPH_DEBUG_POOL = '1'
  const { SemanticCheckerWorker } = await import('../semantic-checker-worker.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-three-workers-'))
  const worker = new SemanticCheckerWorker()
  context.after(async () => { await worker.dispose(); fs.rmSync(root, { recursive: true, force: true }) })

  const result = await worker.index({
    root,
    cacheDir: '.codegraph',
    generation: 'cold-four-file-generation',
    sources: [
      ['src/a.ts', 'export const a = 1\n'],
      ['src/b.ts', 'export const b = 2\n'],
      ['src/c.ts', 'export const c = 3\n'],
      ['src/d.ts', 'export const d = 4\n'],
    ],
    sourceBlobs: {
      'src/a.ts': 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402',
      'src/b.ts': '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b',
      'src/c.ts': '4a23bfb28bdb64187bd8410414aa18616f225b4c2c1835f0728430ae35914e93',
      'src/d.ts': '12a29a764bc468bb486e9442cf8fb6a578995a82090c568fc344a241dc3101f8',
    },
    partitionPool: partitionPool(),
  }, () => {})

  assert.deepEqual(
    { workersUsed: result.poolDiagnostics?.workersUsed, jobsDispatched: result.poolDiagnostics?.jobsDispatched },
    { workersUsed: 1, jobsDispatched: 4 },
  )
})

test('boundary analysis: a one-file semantic delta dispatches exactly one worker job', async (context) => {
  process.env.CODEGRAPH_DEBUG_POOL = '1'
  const { SemanticCheckerWorker } = await import('../semantic-checker-worker.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-one-job-'))
  const worker = new SemanticCheckerWorker()
  context.after(async () => { await worker.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.mkdirSync(path.join(root, '.codegraph', 'sources'), { recursive: true })

  await worker.index({
    root,
    cacheDir: '.codegraph',
    generation: 'one-job-base-generation',
    sources: [
      ['src/a.ts', 'export const a = 1\n'],
      ['src/b.ts', 'export const b = 2\n'],
    ],
    sourceBlobs: {
      'src/a.ts': 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402',
      'src/b.ts': '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b',
    },
    partitionPool: partitionPool(),
  }, () => {})

  const result = await worker.validate({
    revision: 1,
    root,
    cacheDir: '.codegraph',
    baseGeneration: 'one-job-base-generation',
    baseSourceBlobs: {
      'src/a.ts': 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402',
      'src/b.ts': '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b',
    },
    sourceDir: path.join(root, '.codegraph', 'sources'),
    changes: [{ type: 'change', path: 'src/a.ts', source: 'export const a = 10\n' }],
    partitionPool: partitionPool(),
  }, () => {})

  assert.equal(result.poolDiagnostics?.jobsDispatched, 1)
})

test('error guessing: an inline one-file semantic delta performs zero worker reads or existence probes against unchanged workspace source', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-no-unchanged-source-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.codegraph', 'sources'), { recursive: true })
  const observed = observeWorkerFilesystem(context, root, String.raw`
  await worker.index({
    root,
    cacheDir: '.codegraph',
    generation: 'no-unchanged-source-base',
    sources: [
      ['src/a.ts', 'export const a = 1\n'],
      ['src/b.ts', 'export const b = 2\n'],
    ],
    sourceBlobs: {
      'src/a.ts': 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402',
      'src/b.ts': '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b',
    },
    partitionPool: partitionPool(),
  }, () => {})

  const result = await worker.validate({
    revision: 1,
    root,
    cacheDir: '.codegraph',
    baseGeneration: 'no-unchanged-source-base',
    baseSourceBlobs: {
      'src/a.ts': 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402',
      'src/b.ts': '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b',
    },
    sourceDir: path.join(root, '.codegraph', 'sources'),
    changes: [{ type: 'change', path: 'src/a.ts', source: 'export const a = 10\n' }],
    partitionPool: partitionPool(),
  }, () => {})
`)
  assert.deepEqual(
    observed.calls.filter(({ file }) => file === path.join(root, 'src', 'b.ts')),
    [],
  )
})

test('state-transition analysis: two retained benchmark samples publish distinct mutations in generation order', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-semantic-prime-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src', 'types'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'types', 'index.ts'), 'export type Id = string\n')
  const events = []

  const [first, second] = await benchmark.captureLifecycle('/frozen/repository', {
    samples: 2,
    withMirror: async (_source, operation) => operation(root),
    start: () => ({
      timed: async (method, params) => {
        if (method === 'initialize') return { message: { result: {} }, ms: 1 }
        if (params.name === 'codegraph_index') return { message: { result: { content: [{ text: '{"generation":"g1","parsedFiles":["a.ts","b.ts","c.ts","d.ts"]}' }] } }, ms: 10 }
        if (params.name === 'codegraph_refresh') { events.push('semantic-refresh'); return { message: { result: { content: [{ text: '{}' }] } }, ms: 1 } }
        return { message: { result: { content: [{ text: 'src/query/event.ts useSessionEvent src/pages/game/storyArcState.ts fetchSessionStoryArcState export(s) {"name":"useSessionEvent","record":"metrics","cyclomatic":1}' }] } }, ms: 1 }
      },
      stop: async () => {},
    }),
    watcherUpdate: async ({ root: target, state, mutationIndex, previousGeneration }) => {
      assert.equal(state, 'update')
      benchmark.applyStateMutation(target, state, mutationIndex)
      const generation = mutationIndex === 1 ? 'g2' : 'g3'
      events.push(`${mutationIndex === 1 ? 'prime' : 'measured'}:${previousGeneration}->${generation}`)
      return { ms: mutationIndex === 1 ? 50 : 5, generation, parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] }
    },
    progress: () => {},
  })

  assert.deepEqual(
    { events, source: fs.readFileSync(path.join(root, 'src', 'types', 'index.ts'), 'utf8'), firstUpdate: first.updates.update, update: second.updates.update },
    {
      events: ['semantic-refresh', 'prime:g1->g2', 'measured:g2->g3'],
      source: 'export type Id = string\nexport type CodeGraphPerformanceSurface1 = Id\nexport type CodeGraphPerformanceSurface2 = Id\n',
      firstUpdate: { ms: 50, generation: 'g2', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] },
      update: { ms: 5, generation: 'g3', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] },
    },
  )
})

test('domain analysis: a cold in-memory semantic batch performs zero cache or workspace source reads and exactly one traversal per file', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-work-counters-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.codegraph', 'sources'), { recursive: true })
  const observed = observeWorkerFilesystem(context, root, String.raw`
  const result = await worker.index({
    root,
    cacheDir: '.codegraph',
    generation: 'work-counter-generation',
    sources: [
      ['src/a.ts', 'export const a = 1\n'],
      ['src/b.ts', 'export const b = 2\n'],
    ],
    sourceBlobs: {
      'src/a.ts': 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402',
      'src/b.ts': '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b',
    },
    partitionPool: partitionPool(),
  }, () => {})
`)
  assert.deepEqual(
    {
      cacheReads: observed.calls.filter(({ file, method }) => file?.startsWith(path.join(root, '.codegraph') + path.sep) && ['readFileSync', 'readFile', 'openSync', 'open'].includes(method)),
      workspaceSourceReads: observed.calls.filter(({ file, method }) => file?.startsWith(path.join(root, 'src') + path.sep) && ['readFileSync', 'readFile', 'openSync', 'open'].includes(method)),
      traversals: observed.semanticTraversalSummary,
    },
    { cacheReads: [], workspaceSourceReads: [], traversals: { completedFiles: 2, remainingFiles: 0, maximumTraversalsPerFile: 1 } },
  )
})

test('equivalence partition: provisional default-import resolution targets the semantic default export', async (context) => {
  const resolver = new FileLocalResolver('/repo')
  context.after(() => resolver.dispose())

  resolver.applyChanges([
    { type: 'add', path: 'src/target.ts', source: 'export default function target(){ return 1 }\n' },
    { type: 'add', path: 'src/caller.ts', source: "import target from './target'\nexport function caller(){ return target() }\n" },
  ])

  assert.deepEqual(
    resolver.snapshot().edges.map(({ fromFile, fromName, toFile, toName, call }) => ({ fromFile, fromName, toFile, toName, call })),
    [{ fromFile: 'src/caller.ts', fromName: 'caller', toFile: 'src/target.ts', toName: 'target', call: true }],
  )
})

test('hotpath domain analysis: provisional fact collection recursively enters a function body exactly once', () => {
  const source = 'export default function primary(){ const value = 1; return value }\n'
  const sourceFile = ts.createSourceFile('src/primary.ts', source, ts.ScriptTarget.Latest, true)
  const body = sourceFile.statements[0].body
  const statements = body.statements
  let recursivePasses = 0
  Object.defineProperty(body, 'statements', { configurable: true, enumerable: true, get() { recursivePasses += 1; return statements } })

  parseFile('src/primary.ts', source, sourceFile)

  assert.equal(recursivePasses, 1)
})

test('hotpath reuse: repeated cached imports build one binding index and one symbol index for their shared partition', () => {
  let bindingReads = 0
  let symbolReads = 0
  const partition = {
    get bindings() {
      bindingReads += 1
      return [
        { kind: 'symbol', name: 'first', target: 'first-id' },
        { kind: 'symbol', name: 'second', target: 'second-id' },
      ]
    },
    get symbols() {
      symbolReads += 1
      return [
        { id: 'first-id', file: 'src/library.ts', name: 'first', kind: 'function' },
        { id: 'second-id', file: 'src/library.ts', name: 'second', kind: 'function' },
      ]
    },
  }
  const files = new Map([['src/library.ts', partition]])

  const first = resolveCachedImport(files, 'src/consumer.ts', { specifier: './library', remote: 'first' })
  const second = resolveCachedImport(files, 'src/consumer.ts', { specifier: './library', remote: 'second' })

  assert.deepEqual(
    { targets: [first?.id, second?.id], bindingReads, symbolReads },
    { targets: ['first-id', 'second-id'], bindingReads: 1, symbolReads: 1 },
  )
})

test('cached binding indexes preserve direct default namespace re-export star static and cyclic resolution', () => {
  const symbol = (id, name, kind = 'function') => ({ id, file: 'src/library.ts', name, kind })
  const files = new Map([
    ['src/library.ts', {
      bindings: [
        { kind: 'symbol', name: 'direct', target: 'direct-id' },
        { kind: 'symbol', name: 'default', target: 'default-id' },
        { kind: 'symbol', name: 'Worker', target: 'worker-id' },
      ],
      symbols: [symbol('direct-id', 'direct'), symbol('default-id', 'primary'), symbol('worker-id', 'Worker', 'class'), symbol('run-id', 'Worker.run', 'method')],
    }],
    ['src/barrel.ts', {
      bindings: [
        { kind: 'reexport', name: 'relayed', specifier: './library', remote: 'direct' },
        { kind: 'namespace', name: 'space', specifier: './library' },
        { kind: 'star', specifier: './library' },
      ],
      symbols: [],
    }],
    ['src/cycle-a.ts', { bindings: [{ kind: 'star', specifier: './cycle-b' }], symbols: [] }],
    ['src/cycle-b.ts', { bindings: [{ kind: 'star', specifier: './cycle-a' }], symbols: [] }],
  ])
  const dependencies = new Set()
  const resolve = (specifier, remote, property = null, namespace = false) => resolveCachedImport(files, 'src/consumer.ts', { specifier, remote, namespace }, property, dependencies)

  assert.deepEqual(
    {
      direct: resolve('./library', 'direct')?.id,
      default: resolve('./library', 'default')?.id,
      namespace: resolve('./barrel', null, 'direct', true)?.id,
      reexport: resolve('./barrel', 'relayed')?.id,
      namespaceExport: resolve('./barrel', 'space', 'direct')?.id,
      star: resolve('./barrel', 'direct')?.id,
      staticProperty: resolve('./library', 'Worker', 'run')?.id,
      cycle: resolve('./cycle-a', 'missing'),
      retainedDependencies: ['src/library.ts', 'src/barrel.ts', 'src/cycle-a.ts', 'src/cycle-b.ts'].every((file) => dependencies.has(file)),
    },
    {
      direct: 'direct-id',
      default: 'default-id',
      namespace: 'direct-id',
      reexport: 'direct-id',
      namespaceExport: 'direct-id',
      star: 'direct-id',
      staticProperty: 'run-id',
      cycle: null,
      retainedDependencies: true,
    },
  )
})

test('transaction hotpath: provisional stage and commit return one work receipt without materializing the staged graph', async (context) => {
  const { createTypeScriptLanguageAnalyzer } = await import('../typescript-language-analyzer.mjs')
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', {
    sources: new Map([
      ['src/value.ts', 'export const value = 1\n'],
      ['src/other.ts', 'export const other = 1\n'],
    ]),
  })
  context.after(() => resolver.dispose())

  const staged = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const value = 2\n' }], 1)
  const stageMaterialized = staged.next.cached !== null
  const committed = resolver.commit(staged)

  assert.deepEqual(
    { stageMaterialized, stagedWork: staged.work, committed },
    {
      stageMaterialized: false,
      stagedWork: { type: 'work', mutationFile: 'src/value.ts', parsedFiles: ['src/value.ts'], resolvedFiles: ['src/value.ts'], reusedFiles: ['src/other.ts'], fullRebuild: false },
      committed: { type: 'work', mutationFile: 'src/value.ts', parsedFiles: ['src/value.ts'], resolvedFiles: ['src/value.ts'], reusedFiles: ['src/other.ts'], fullRebuild: false },
    },
  )
})

test('public API boundary: direct applyChanges still returns and retains the fully materialized graph', () => {
  const resolver = new FileLocalResolver('/repo', new Map([['src/value.ts', 'export const value = 1\n']]))

  const result = resolver.applyChanges([{ type: 'change', path: 'src/value.ts', source: 'export const renamed = 2\n' }])

  assert.deepEqual(
    { retained: result === resolver.cached, revision: result.revision, files: result.files, symbols: result.symbols.map(({ name }) => name) },
    { retained: true, revision: 1, files: ['src/value.ts'], symbols: ['renamed'] },
  )
})

test('legacy overlay dependency invalidation: a changed re-export rebuilds its unchanged importer while unrelated fragments remain reusable', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-legacy-overlay-dependency-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'alternate.ts'), 'export const value = 2\n')
  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { value } from './target'\n")
  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), "import { value } from './barrel'\nexport function read(){ return value }\n")
  fs.writeFileSync(path.join(root, 'src', 'unrelated.ts'), 'export const unrelated = 1\n')
  const checker = new SemanticCheckerWorker()
  const overlayRequests = []
  const engine = new CodeGraphEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    advanceGeneration: (expected, generation) => checker.advanceGeneration(expected, generation),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests.push(payload.staleFiles); return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }) })
  context.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  const built = await engine.build()
  const firstComplete = engine.readGeneration(built.generation)
  const firstPartitions = Object.fromEntries(Object.entries(firstComplete.partitions).map(([file, id]) => {
    const partition = engine.store.readPartition(id)
    return [file, engine.store.writePartition({ ...partition, edges: partition.edges.filter(({ call }) => call) })]
  }))
  const firstLegacy = engine.store.publish({ ...firstComplete, edgeCoverage: 'calls', partitions: firstPartitions, partitionHashes: firstPartitions })
  await engine.queryBatch({ type: 'refs', name: 'value', generation: firstLegacy.generation, resolved: true })
  overlayRequests.length = 0
  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { value } from './alternate'\n")
  const changed = await engine.incremental([{ type: 'change', path: 'src/barrel.ts' }])
  await changed.validation
  const secondComplete = engine.readGeneration()
  const secondPartitions = Object.fromEntries(Object.entries(secondComplete.partitions).map(([file, id]) => {
    const partition = engine.store.readPartition(id)
    return [file, engine.store.writePartition({ ...partition, edges: partition.edges.filter(({ call }) => call) })]
  }))
  const secondLegacy = engine.store.publish({ ...secondComplete, edgeCoverage: 'calls', partitions: secondPartitions, partitionHashes: secondPartitions })

  const rows = await engine.queryBatch({ type: 'refs', name: 'value', generation: secondLegacy.generation, resolved: true })

  assert.deepEqual(
    { staleFiles: overlayRequests, targets: rows.map(({ toSymbol }) => toSymbol.file) },
    { staleFiles: [['src/barrel.ts', 'src/importer.ts']], targets: ['src/alternate.ts'] },
  )
})

test('semantic profile report: main and worker CPU and heap plus trace and diagnostics are all present and parseable', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-artifact-report-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cpu = path.join(directory, 'semantic.cpuprofile')
  const heap = path.join(directory, 'semantic.heapprofile')
  const trace = path.join(directory, 'semantic.trace.json')
  const diagnosticLog = path.join(directory, 'semantic.log')
  const workerCpu = path.join(directory, 'semantic.worker-semantic.cpuprofile')
  const workerHeap = path.join(directory, 'semantic.worker-semantic.heapprofile')

  const [sample] = await benchmark.captureLifecycle('/frozen/repository', {
    profile: { cpu, heap, trace },
    diagnosticLog,
    withMirror: async (_source, operation) => operation('/private/tmp/codegraph-performance/project'),
    start: () => ({
      timed: async (method, params) => {
        if (method === 'initialize') return { message: { result: {} }, ms: 1 }
        if (params.name === 'codegraph_index') return { message: { result: { content: [{ text: '{"generation":"g1","parsedFiles":["a.ts","b.ts","c.ts","d.ts"],"validatedFiles":["a.ts","b.ts","c.ts","d.ts"]}' }] } }, ms: 10 }
        return { message: { result: { content: [{ text: 'src/query/event.ts useSessionEvent src/pages/game/storyArcState.ts fetchSessionStoryArcState export(s) {"name":"useSessionEvent","record":"metrics","cyclomatic":1}' }] } }, ms: 1 }
      },
      stop: async () => {
        fs.writeFileSync(cpu, JSON.stringify({ nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] }))
        fs.writeFileSync(heap, JSON.stringify({ head: { callFrame: {}, selfSize: 0, id: 1, children: [] } }))
        fs.writeFileSync(trace, JSON.stringify({ traceEvents: [] }))
        fs.writeFileSync(workerCpu, JSON.stringify({ nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] }))
        fs.writeFileSync(workerHeap, JSON.stringify({ head: { callFrame: {}, selfSize: 0, id: 1, children: [] } }))
        fs.writeFileSync(diagnosticLog, '{"event":"semantic-worker"}\n')
        return { main: { cpu }, workers: [{ label: 'semantic', cpu: workerCpu, heap: workerHeap }] }
      },
    }),
    watcherUpdate: async () => ({ ms: 5, generation: 'g2', parsedFiles: 1, validatedFiles: 1, parsedFileSet: ['src/types/index.ts'], validatedFileSet: ['src/types/index.ts'] }),
    progress: () => {},
  })

  assert.deepEqual(sample.artifacts, {
    cpu: { path: cpu, parseable: true },
    heap: { path: heap, parseable: true },
    trace: { path: trace, parseable: true },
    diagnosticLog: { path: diagnosticLog, parseable: true },
    workers: [{ label: 'semantic', cpu: { path: workerCpu, parseable: true }, heap: { path: workerHeap, parseable: true } }],
  })
  assert.notEqual(sample.artifacts.cpu.path, sample.artifacts.workers[0].cpu.path)
  for (const artifact of [sample.artifacts.cpu, sample.artifacts.workers[0].cpu]) {
    assert.equal(fs.existsSync(artifact.path), true)
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(artifact.path, 'utf8')))
  }
})
