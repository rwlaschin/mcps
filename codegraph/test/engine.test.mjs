import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { FileLocalResolver } from '../incremental-resolver.mjs'
import { SemanticCheckerWorker } from '../semantic-checker-worker.mjs'

class EngineFakeMmapAdapter {
  constructor() { this.files = new Map(); this.maps = []; this.unmaps = 0; this.closes = 0; this.flushes = 0 }
  open(filePath, capacity) { if (!this.files.has(filePath)) this.files.set(filePath, new Uint8Array(capacity)); return { filePath } }
  resize(handle, capacity) { const prior = this.files.get(handle.filePath); const next = new Uint8Array(capacity); next.set(prior.subarray(0, Math.min(prior.byteLength, capacity))); this.files.set(handle.filePath, next) }
  map(handle) { const mapping = this.files.get(handle.filePath).slice(); mapping.handle = handle; this.maps.push(mapping); return mapping }
  flush(mapping) { this.files.get(mapping.handle.filePath).set(mapping); this.flushes += 1 }
  unmap() { this.unmaps += 1 }
  close() { this.closes += 1 }
  corruptHeader() { const bytes = [...this.files.values()][0]; bytes[0] ^= 0xff }
}

const trackedEngines = new Set()
const trackedEngine = (root, options) => {
  const engine = new CodeGraphEngine(root, options)
  trackedEngines.add(engine)
  return engine
}

test.afterEach(async () => {
  const engines = [...trackedEngines]
  trackedEngines.clear()
  await Promise.all(engines.map((engine) => engine.disposed ? undefined : engine.dispose()))
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "export function a(){ return 1 }\n")
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a() }\n")
  return root
}

const canon = (g) => JSON.stringify({ files: g.files, symbols: g.symbols, edges: g.edges })

const manifestBytes = (engine) => JSON.stringify(engine.readGeneration())

test('incremental edit/add/delete/rename is equivalent to clean full build and reuses partitions', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  let result = await engine.build()
  const first = engine.readGeneration(result.generation)
  const aHash = first.partitionHashes['src/a.ts']
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")
  result = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  await result.validation
  assert.deepEqual(result.parsedFiles, ['src/b.ts'])
  assert.equal(engine.readGeneration().partitionHashes['src/a.ts'], aHash)
  let clean = trackedEngine(root, { cacheDir: '.clean-codegraph' })
  await clean.build()
  assert.equal(canon(engine.snapshot()), canon(clean.snapshot()))
  await clean.dispose()

  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export const c = b()\n")
  result = await engine.incremental([{ type: 'add', path: 'src/c.ts' }])
  await result.validation
  clean = trackedEngine(root, { cacheDir: '.clean-codegraph-2' }); await clean.build()
  assert.equal(canon(engine.snapshot()), canon(clean.snapshot()))
  await clean.dispose()

  fs.renameSync(path.join(root, 'src', 'a.ts'), path.join(root, 'src', 'renamed.ts'))
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './renamed'; export function b(){ return a()+2 }\n")
  result = await engine.incremental([{ type: 'unlink', path: 'src/a.ts' }, { type: 'add', path: 'src/renamed.ts' }, { type: 'change', path: 'src/b.ts' }])
  await result.validation
  clean = trackedEngine(root, { cacheDir: '.clean-codegraph-3' }); await clean.build()
  assert.equal(canon(engine.snapshot()), canon(clean.snapshot()))
  await clean.dispose()

  fs.unlinkSync(path.join(root, 'src', 'c.ts'))
  result = await engine.incremental([{ type: 'unlink', path: 'src/c.ts' }])
  await result.validation
  clean = trackedEngine(root, { cacheDir: '.clean-codegraph-4' }); await clean.build()
  assert.equal(canon(engine.snapshot()), canon(clean.snapshot()))
  await clean.dispose()
})

test('hotpath regression: one disk-backed file uses exactly one synchronous coordinator read', async () => {
  const root = fixture()
  const reads = []
  const engine = trackedEngine(root, { sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } } })
  await engine.build()
  reads.length = 0
  engine.policy.scan = () => { throw new Error('incremental policy scan') }
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")

  const result = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])

  assert.deepEqual({ parsedFiles: result.parsedFiles, reads }, { parsedFiles: ['src/b.ts'], reads: ['src/b.ts'] })
})

test('domain analysis: two disk-backed files use the parser pool without coordinator reads and publish one atomic provisional revision', async () => {
  const root = fixture()
  const coordinatorReads = []
  const parserRequests = []
  const parsedA = new FileLocalResolver(root, new Map([['src/a.ts', 'export function a(){ return 11 }\n']])).files.get('src/a.ts')
  const parsedB = new FileLocalResolver(root, new Map([['src/b.ts', "import { a } from './a'; export function b(){ return a()+22 }\n"]])).files.get('src/b.ts')
  const parserPool = {
    parse: async (request) => { parserRequests.push(request); return request.path === 'src/a.ts' ? { ...parsedA, source: undefined } : { ...parsedB, source: undefined } },
    snapshot: () => ({ workerCount: 2, queued: 0, inFlight: 0, latestRevisionByFile: {} }),
    dispose: async () => {},
  }
  const engine = trackedEngine(root, { parserPool, sourceReaderDeps: { readFile: async (file, encoding) => { coordinatorReads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } }, validationWorkerFactory: () => ({ validate: () => new Promise(() => {}), dispose: async () => {} }) })
  await engine.build()
  coordinatorReads.length = 0
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 11 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+22 }\n")

  const result = await engine.incremental([{ type: 'change', path: 'src/a.ts' }, { type: 'change', path: 'src/b.ts' }])

  assert.deepEqual(
    { coordinatorReads, parserRequests, parsedFiles: result.parsedFiles, revision: engine.provisionalSnapshot().revision, symbols: engine.provisionalSnapshot().symbols.map(({ name }) => name) },
    { coordinatorReads: [], parserRequests: [{ path: 'src/a.ts', fileId: 'src/a.ts', revision: 1 }, { path: 'src/b.ts', fileId: 'src/b.ts', revision: 1 }], parsedFiles: ['src/a.ts', 'src/b.ts'], revision: 1, symbols: ['a', 'b'] },
  )
  await engine.dispose()
})

test('domain analysis: consecutive incremental edits publish successive provisional revisions and validated generations', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")
  const first = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  await first.validation
  const firstGeneration = engine.readGeneration().generation
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+3 }\n")
  const second = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  await second.validation
  const secondGeneration = engine.readGeneration().generation

  assert.deepEqual({ initialGeneration: built.generation, firstGeneration, secondGeneration, revision: engine.provisionalSnapshot().revision, freshness: engine.provisionalSnapshot().freshness }, { initialGeneration: built.generation, firstGeneration, secondGeneration, revision: 2, freshness: 'provisional' })
  assert.notEqual(firstGeneration, built.generation)
  assert.notEqual(secondGeneration, firstGeneration)
})

test('domain analysis: adding a previously unresolved import returns the provisional changed file and validates to a clean-build-equivalent reverse closure', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'waiting.ts'), "import { later } from './later'; export function waiting(){ return later() }\n")
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'later.ts'), 'export function later(){ return 7 }\n')

  const result = await engine.incremental([{ type: 'add', path: 'src/later.ts' }])
  await result.validation
  const clean = trackedEngine(root, { cacheDir: '.clean-unresolved' })
  await clean.build()

  assert.deepEqual({ parsedFiles: result.parsedFiles, graph: canon(engine.snapshot()) }, { parsedFiles: ['src/later.ts'], graph: canon(clean.snapshot()) })
  await clean.dispose()
})

test('error guessing: a changed-source read failure preserves the prior CURRENT generation and provisional revision', async () => {
  const root = fixture()
  let rejectRead = false
  const engine = trackedEngine(root, { sourceReaderDeps: { readFile: async (file, encoding) => { if (rejectRead && file.endsWith(`${path.sep}b.ts`)) throw new Error('permission denied reading changed source'); return fsp.readFile(file, encoding) } } })
  const built = await engine.build()
  const before = manifestBytes(engine)
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(){ return 9 }\n')
  rejectRead = true

  await assert.rejects(engine.incremental([{ type: 'change', path: 'src/b.ts' }]), /permission denied reading changed source/)

  assert.deepEqual({ current: engine.readGeneration().generation, manifest: manifestBytes(engine), provisionalRevision: engine.provisionalSnapshot().revision }, { current: built.generation, manifest: before, provisionalRevision: 0 })
})

test('domain analysis: a path-only provisional change carries the parser-admitted digest into semantic validation', async () => {
  const root = fixture()
  let validationPayload
  const parsed = new FileLocalResolver(root, new Map([['src/b.ts', 'export function b(){ return 9 }\n']])).files.get('src/b.ts')
  const parserPool = { parse: async () => ({ ...parsed, source: undefined }), snapshot: () => ({ workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: {} }), dispose: async () => {} }
  const engine = trackedEngine(root, { parserPool, validationWorkerFactory: () => ({ validate: async (payload) => { validationPayload = payload; return { revision: payload.revision, sourceBlobs: payload.baseSourceBlobs, partitions: {} } }, dispose: async () => {} }) })
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(){ return 9 }\n')

  const result = await engine.applyFileChanges([{ type: 'change', path: 'src/b.ts', fileId: 'src/b.ts' }])
  await result.validation

  assert.deepEqual(validationPayload.changes, [{ type: 'change', path: 'src/b.ts', fileId: 'src/b.ts', expectedDigest: parsed.digest }])
  await engine.dispose()
})

test('error guessing: semantic validation rejects disk bytes changed after provisional parsing and preserves CURRENT', async () => {
  const root = fixture()
  let releaseParse
  const parsed = new FileLocalResolver(root, new Map([['src/b.ts', 'export function b(){ return 9 }\n']])).files.get('src/b.ts')
  const parserPool = { parse: async () => { await new Promise((resolve) => { releaseParse = resolve }); return { ...parsed, source: undefined } }, snapshot: () => ({ workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: {} }), dispose: async () => {} }
  const engine = trackedEngine(root, { parserPool })
  const built = await engine.build()
  const before = manifestBytes(engine)
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(){ return 9 }\n')
  const refreshing = engine.applyFileChanges([{ type: 'change', path: 'src/b.ts', fileId: 'src/b.ts' }])
  while (!releaseParse) await new Promise((resolve) => setImmediate(resolve))
  releaseParse()
  const refreshed = await refreshing
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(){ return 10 }\n')

  await assert.rejects(refreshed.validation, /digest|changed.*after|mismatch/i)

  assert.deepEqual({ current: engine.readGeneration().generation, manifest: manifestBytes(engine), revision: engine.provisionalSnapshot().revision }, { current: built.generation, manifest: before, revision: 1 })
  await engine.dispose()
})

test('error guessing: a background semantic validation failure leaves the provisional revision queryable and preserves prior CURRENT', async () => {
  const root = fixture()
  const failure = new Error('semantic validation failed')
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async () => { throw failure }, dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 9 }\n' }])
  await assert.rejects(refreshed.validation, (error) => error === failure)

  assert.deepEqual({ current: engine.readGeneration().generation, manifest: manifestBytes(engine), revision: engine.provisionalSnapshot().revision, freshness: engine.provisionalSnapshot().freshness }, { current: built.generation, manifest: before, revision: 1, freshness: 'provisional' })
})

test('error guessing: a background publish failure preserves prior CURRENT while leaving the provisional revision queryable', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  const before = manifestBytes(engine)
  engine.store.publish = () => { throw new Error('permission denied publishing generation') }

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 9 }\n' }])
  await assert.rejects(refreshed.validation, /permission denied publishing generation/)

  assert.deepEqual({ current: engine.readGeneration().generation, manifest: manifestBytes(engine), revision: engine.provisionalSnapshot().revision, freshness: engine.provisionalSnapshot().freshness }, { current: built.generation, manifest: before, revision: 1, freshness: 'provisional' })
})

test('domain analysis: unchanged source blob IDs are reused across a one-file incremental generation', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  const before = engine.readGeneration()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")

  await engine.incremental([{ type: 'change', path: 'src/b.ts' }])

  assert.deepEqual({ unchangedBefore: before.sources['src/a.ts'], unchangedAfter: engine.readGeneration().sources['src/a.ts'] }, { unchangedBefore: before.sources['src/a.ts'], unchangedAfter: before.sources['src/a.ts'] })
})

test('error guessing: a stale warm engine rehydrates after another engine advances CURRENT and remains clean-build equivalent', async () => {
  const root = fixture()
  const engineA = trackedEngine(root)
  const engineB = trackedEngine(root)
  await engineA.build()
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export const c = b()\n")
  const added = await engineB.incremental([{ type: 'add', path: 'src/c.ts' }])
  await added.validation
  await engineB.dispose()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")

  const changed = await engineA.incremental([{ type: 'change', path: 'src/b.ts' }])
  await changed.validation
  const clean = trackedEngine(root, { cacheDir: '.clean-stale-workspace' })
  await clean.build()

  assert.equal(canon(engineA.snapshot()), canon(clean.snapshot()))
  await clean.dispose()
})

test('error guessing: concurrent direct change incrementals serialize without losing either changed partition', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 11 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+22 }\n")

  await Promise.all([
    engine.incremental([{ type: 'change', path: 'src/a.ts' }]),
    engine.incremental([{ type: 'change', path: 'src/b.ts' }]),
  ])
  const clean = trackedEngine(root, { cacheDir: '.clean-concurrent-changes' })
  await clean.build()

  assert.equal(canon(engine.snapshot()), canon(clean.snapshot()))
  await clean.dispose()
})

test('error guessing: concurrent build and incremental operations retain clean equivalence and successful provisional and validation profiles', async () => {
  const root = fixture()
  const tracePath = path.join(root, 'concurrent-profile.json')
  const engine = trackedEngine(root, { profile: tracePath, sourceReaderDeps: { readFile: async (file, encoding) => { await new Promise((resolve) => setTimeout(resolve, 10)); return fsp.readFile(file, encoding) } } })
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")

  const [, changed] = await Promise.all([engine.build(), engine.incremental([{ type: 'change', path: 'src/b.ts' }])])
  await changed.validation
  const operations = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.filter((event) => ['codegraph.build', 'codegraph.provisional-refresh', 'codegraph.background-validation'].includes(event.name))
  const clean = trackedEngine(root, { cacheDir: '.clean-concurrent-profile' })
  await clean.build()

  assert.deepEqual(
    { graph: canon(engine.snapshot()), operationNames: operations.map((event) => event.name), statuses: operations.map((event) => event.args.status) },
    { graph: canon(clean.snapshot()), operationNames: ['codegraph.build', 'codegraph.build', 'codegraph.provisional-refresh', 'codegraph.background-validation'], statuses: ['ok', 'ok', 'ok', 'ok'] },
  )
  await clean.dispose()
})

test('error guessing: engine disposal waits for an in-flight reference overlay before clearing its registry', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  let releaseOverlay = () => {}
  let disposeSettled = false
  const pendingOverlay = new Promise((resolve) => { releaseOverlay = resolve })
  engine.overlayBuilds.set('in-flight-generation', pendingOverlay)

  const disposing = engine.dispose().then(() => { disposeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeOverlay = disposeSettled
  const registrySizeBeforeOverlay = engine.overlayBuilds.size
  releaseOverlay()
  await disposing

  assert.deepEqual(
    { settledBeforeOverlay, registrySizeBeforeOverlay, settledAfterOverlay: disposeSettled, registrySizeAfterOverlay: engine.overlayBuilds.size },
    { settledBeforeOverlay: false, registrySizeBeforeOverlay: 1, settledAfterOverlay: true, registrySizeAfterOverlay: 0 },
  )
})

test('domain analysis: latest queries observe a provisional revision while validated and pinned queries remain on the prior v3 generation', async () => {
  const root = fixture()
  const pending = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: (snapshot) => new Promise((resolve) => { pending.push({ snapshot, resolve }) }), dispose: async () => {} }) })
  const built = await engine.build()

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 9 }\n' }])
  const latest = []
  for await (const row of engine.query({ type: 'deps', name: 'b', consistency: 'latest' })) latest.push(row)
  const validated = []
  for await (const row of engine.query({ type: 'deps', name: 'b', consistency: 'validated' })) validated.push(row)
  const pinned = []
  for await (const row of engine.query({ type: 'deps', name: 'b', consistency: 'latest', generation: built.generation })) pinned.push(row)

  assert.deepEqual(
    { refresh: { revision: refreshed.revision, freshness: refreshed.freshness, coverage: refreshed.coverage, validatedGeneration: refreshed.validatedGeneration }, latestCalls: latest.length, validatedCalls: validated.length, pinnedCalls: pinned.length, workerRevision: pending[0].snapshot.revision },
    { refresh: { revision: 1, freshness: 'provisional', coverage: 'module-linked-syntax', validatedGeneration: built.generation }, latestCalls: 0, validatedCalls: 1, pinnedCalls: 1, workerRevision: 1 },
  )
})

test('error guessing: an active stale validation is discarded before its newer pending revision validates', async () => {
  const root = fixture()
  const pending = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: (snapshot) => new Promise((resolve) => { pending.push({ snapshot, resolve }) }), dispose: async () => {} }) })
  const built = await engine.build()
  const first = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 2 }\n' }])
  const second = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 3 }\n' }])

  pending[0].resolve(pending[0].snapshot)
  const firstResult = await first.validation
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    { workerRevisions: pending.map(({ snapshot }) => snapshot.revision), firstResult, generationAfterStaleResult: engine.readGeneration().generation, latestRevision: engine.provisionalSnapshot().revision },
    { workerRevisions: [1, 2], firstResult: null, generationAfterStaleResult: built.generation, latestRevision: 2 },
  )

  pending[1].resolve(pending[1].snapshot)
  const secondResult = await second.validation

  assert.deepEqual({ priorGeneration: built.generation, secondGeneration: secondResult.generation, finalGeneration: engine.readGeneration().generation, latestRevision: engine.provisionalSnapshot().revision }, { priorGeneration: built.generation, secondGeneration: secondResult.generation, finalGeneration: secondResult.generation, latestRevision: 2 })
})

test('boundary and concurrency: 120 rapid changes keep one active validation and replace one pending validation with revision 120', async () => {
  const root = fixture()
  const workerCalls = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: (snapshot) => new Promise((resolve) => { workerCalls.push({ snapshot, resolve }) }), dispose: async () => {} }) })
  await engine.build()
  const refreshes = []

  for (let revision = 1; revision <= 120; revision += 1) {
    refreshes.push(engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: `export function b(){ return ${revision} }\n` }]))
  }

  assert.deepEqual(
    { provisionalRevision: engine.provisionalSnapshot().revision, workerCallCountWhileStalled: workerCalls.length, activeWorkerRevision: workerCalls[0]?.snapshot.revision },
    { provisionalRevision: 120, workerCallCountWhileStalled: 1, activeWorkerRevision: 1 },
  )

  workerCalls[0].resolve(workerCalls[0].snapshot)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    { workerCallCountAfterRelease: workerCalls.length, validatedWorkerRevisions: workerCalls.map(({ snapshot }) => snapshot.revision), latestSource: workerCalls[1]?.snapshot.changes[0].source },
    { workerCallCountAfterRelease: 2, validatedWorkerRevisions: [1, 120], latestSource: 'export function b(){ return 120 }\n' },
  )

  workerCalls[1].resolve(workerCalls[1].snapshot)
  const validationResults = await Promise.race([
    Promise.all(refreshes.map(({ validation }) => validation)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('coalesced validation promises did not settle')), 100)),
  ])

  assert.deepEqual(
    { settledResultCount: validationResults.length, firstSupersededResult: validationResults[0], secondSupersededResult: validationResults[1], penultimateSupersededResult: validationResults[118], latestResult: validationResults[119], publishedGeneration: engine.readGeneration().generation, finalWorkerCallCount: workerCalls.length },
    { settledResultCount: 120, firstSupersededResult: null, secondSupersededResult: null, penultimateSupersededResult: null, latestResult: validationResults[119], publishedGeneration: validationResults[119].generation, finalWorkerCallCount: 2 },
  )
})

test('hotpath boundary: 120 coalesced edits materialize validation payloads only for active revision 1 and latest revision 120', async () => {
  const root = fixture()
  const materializedPayloads = []
  const workerCalls = []
  const engine = trackedEngine(root, {
    validationPayloadObserver: (payload) => { materializedPayloads.push(payload) },
    validationWorkerFactory: () => ({ validate: (payload) => new Promise((resolve) => { workerCalls.push({ payload, resolve }) }), dispose: async () => {} }),
  })
  const built = await engine.build()
  const refreshes = []

  for (let revision = 1; revision <= 120; revision += 1) {
    refreshes.push(engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: `export function b(){ return ${revision} }\n` }]))
  }

  assert.deepEqual(
    { provisionalRevision: engine.provisionalSnapshot().revision, materializedRevisionsWhileStalled: materializedPayloads.map(({ revision }) => revision), workerPayloadsWhileStalled: workerCalls.map(({ payload }) => ({ revision: payload.revision, changedFiles: payload.changedFiles, changes: payload.changes })) },
    { provisionalRevision: 120, materializedRevisionsWhileStalled: [1], workerPayloadsWhileStalled: [{ revision: 1, changedFiles: ['src/b.ts'], changes: [{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 1 }\n' }] }] },
  )

  workerCalls[0].resolve(workerCalls[0].payload)
  await refreshes[0].validation
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    { materializedRevisionsAfterRelease: materializedPayloads.map(({ revision }) => revision), workerPayloadsAfterRelease: workerCalls.map(({ payload }) => ({ revision: payload.revision, changedFiles: payload.changedFiles, changes: payload.changes })) },
    { materializedRevisionsAfterRelease: [1, 120], workerPayloadsAfterRelease: [{ revision: 1, changedFiles: ['src/b.ts'], changes: [{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 1 }\n' }] }, { revision: 120, changedFiles: ['src/b.ts'], changes: [{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 120 }\n' }] }] },
  )

  workerCalls[1].resolve(workerCalls[1].payload)
  const validationResults = await Promise.race([
    Promise.all(refreshes.map(({ validation }) => validation)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('lazily materialized validation promises did not settle')), 100)),
  ])

  assert.deepEqual(
    { priorGeneration: built.generation, settledResultCount: validationResults.length, firstResult: validationResults[0], penultimateResult: validationResults[118], latestGeneration: validationResults[119].generation, publishedGeneration: engine.readGeneration().generation, finalMaterializedRevisions: materializedPayloads.map(({ revision }) => revision), finalWorkerCallCount: workerCalls.length },
    { priorGeneration: built.generation, settledResultCount: 120, firstResult: null, penultimateResult: null, latestGeneration: validationResults[119].generation, publishedGeneration: validationResults[119].generation, finalMaterializedRevisions: [1, 120], finalWorkerCallCount: 2 },
  )
})

test('error guessing: background validation failure preserves the prior validated generation while provisional results remain honestly labeled', async () => {
  const root = fixture()
  const failure = new Error('validation worker failed')
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async () => { throw failure }, dispose: async () => {} }) })
  const built = await engine.build()

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 4 }\n' }])
  await assert.rejects(refreshed.validation, (error) => error === failure)

  assert.deepEqual({ generation: engine.readGeneration().generation, revision: engine.provisionalSnapshot().revision, freshness: engine.provisionalSnapshot().freshness, coverage: engine.provisionalSnapshot().coverage }, { generation: built.generation, revision: 1, freshness: 'provisional', coverage: 'module-linked-syntax' })
})

test('error guessing: engine disposal terminates the validation worker and rejects refresh after disposal', async () => {
  const root = fixture()
  let validationDisposed = 0
  let parserDisposed = 0
  const parserPool = { parse: async () => assert.fail('parser pool parse was not expected'), snapshot: () => ({ workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: {} }), dispose: async () => { parserDisposed += 1 } }
  const engine = trackedEngine(root, { parserPool, validationWorkerFactory: () => ({ validate: async (snapshot) => snapshot, dispose: async () => { validationDisposed += 1 } }) })
  await engine.build()

  await engine.dispose()

  assert.throws(() => engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 5 }\n' }]), /disposed|closed/i)
  assert.deepEqual({ validationDisposed, parserDisposed }, { validationDisposed: 1, parserDisposed: 1 })
})

test('hotpath architecture: applyChanges on an 855-file workspace stays under 5ms and schedules only changed files plus base blob references', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-855-fast-refresh-'))
  const sources = new Map()
  const baseSourceBlobs = {}
  for (let index = 0; index < 855; index += 1) {
    const file = `src/file-${String(index).padStart(3, '0')}.ts`
    sources.set(file, `export function file${String(index).padStart(3, '0')}(){ return ${index} }\n`)
    baseSourceBlobs[file] = `blob-${String(index).padStart(3, '0')}`
  }
  let validationPayload
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: (payload) => { validationPayload = payload; return new Promise(() => {}) }, dispose: async () => {} }) })
  engine.resolver = new FileLocalResolver(root, sources)
  engine.validatedGeneration = 'validated-generation'
  engine.validatedSourceBlobs = baseSourceBlobs
  for (let iteration = 0; iteration < 20; iteration += 1) engine.applyChanges([{ type: 'change', path: 'src/file-427.ts', source: iteration % 2 ? 'export function file427(){ return 1 }\n' : 'export function file427(){ return 2 }\n' }])
  const durations = []

  for (let iteration = 0; iteration < 120; iteration += 1) {
    const source = iteration % 2 ? 'export function file427(){ return 1 }\n' : 'export function file427(){ return 2 }\n'
    const started = performance.now()
    engine.applyChanges([{ type: 'change', path: 'src/file-427.ts', source }])
    durations.push(performance.now() - started)
  }
  const ordered = durations.toSorted((left, right) => left - right)
  const metrics = { p50: ordered[59], p95: ordered[113], p99: ordered[118], max: ordered[119] }

  const enforceFiveMs = process.env.CODEGRAPH_ENFORCE_FAST_REFRESH === '1'
  t.diagnostic(`CodeGraphEngine.applyChanges 855-file workspace hard target max<=5ms ${JSON.stringify({ ...metrics, enforced: enforceFiveMs, targetMet: metrics.max <= 5 })}`)
  assert.deepEqual(
    { changedFiles: validationPayload.changedFiles, baseSourceBlobCount: Object.keys(validationPayload.baseSourceBlobs ?? {}).length, carriesAllSourceTexts: Array.isArray(validationPayload.sources) },
    { changedFiles: ['src/file-427.ts'], baseSourceBlobCount: 855, carriesAllSourceTexts: false },
  )
  assert.equal(!enforceFiveMs || metrics.max <= 5, true, `isolated CodeGraphEngine.applyChanges max exceeded 5ms: ${JSON.stringify(metrics)}`)
})

test('error guessing: an unexpected semantic worker error rejects the current and future validation promptly and dispose settles', async () => {
  const worker = new SemanticCheckerWorker()
  const failure = new Error('semantic worker channel failed')
  const current = worker.validate({ revision: 1, root: '/repo', sources: [] })
  worker.worker.emit('error', failure)

  await assert.rejects(current, (error) => error === failure)
  await assert.rejects(Promise.race([worker.validate({ revision: 2, root: '/repo', sources: [] }), new Promise((_, reject) => setTimeout(() => reject(new Error('future validation did not reject promptly')), 100))]), /semantic worker channel failed|unavailable|closed|exited/i)
  await worker.dispose()
})

test('error guessing: an unexpected semantic worker exit rejects the current and future validation promptly and dispose settles', async () => {
  const worker = new SemanticCheckerWorker()
  const current = worker.validate({ revision: 1, root: '/repo', sources: [] })
  worker.worker.emit('exit', 17)

  await assert.rejects(current, /exited with code 17/i)
  await assert.rejects(Promise.race([worker.validate({ revision: 2, root: '/repo', sources: [] }), new Promise((_, reject) => setTimeout(() => reject(new Error('future validation did not reject promptly')), 100))]), /exited with code 17|unavailable|closed/i)
  await worker.dispose()
})

test('error guessing: an unexpected clean semantic worker exit rejects current and future validation promptly and dispose settles', async () => {
  const worker = new SemanticCheckerWorker()
  const current = worker.validate({ revision: 1, root: '/repo', sources: [] })
  worker.worker.emit('exit', 0)

  await assert.rejects(Promise.race([current, new Promise((_, reject) => setTimeout(() => reject(new Error('current validation did not reject after clean exit')), 100))]), /worker.*exit|unavailable|closed/i)
  await assert.rejects(Promise.race([worker.validate({ revision: 2, root: '/repo', sources: [] }), new Promise((_, reject) => setTimeout(() => reject(new Error('future validation did not reject after clean exit')), 100))]), /worker.*exit|unavailable|closed/i)
  await worker.dispose()
})

test('equivalence partition: semantic worker rejects traversal and non-SHA blob IDs before filesystem access', async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-blob-id-'))
  const worker = new SemanticCheckerWorker()

  await assert.rejects(worker.validate({ revision: 1, root: '/repo', sourceDir, baseSourceBlobs: { 'src/a.ts': '../outside' }, changes: [] }), /blob|sha|digest|traversal|invalid/i)
  await assert.rejects(worker.validate({ revision: 2, root: '/repo', sourceDir, baseSourceBlobs: { 'src/a.ts': 'not-a-sha256' }, changes: [] }), /blob|sha|digest|invalid/i)
  await worker.dispose()
})

test('error guessing: semantic worker rejects a source blob whose bytes do not match its SHA-256 filename', async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-blob-digest-'))
  const falseDigest = '0000000000000000000000000000000000000000000000000000000000000000'
  fs.writeFileSync(path.join(sourceDir, falseDigest), 'export const corrupted = true\n')
  const worker = new SemanticCheckerWorker()

  await assert.rejects(worker.validate({ revision: 1, root: '/repo', sourceDir, baseSourceBlobs: { 'src/a.ts': falseDigest }, changes: [] }), /digest|sha|hash|mismatch/i)
  await worker.dispose()
})

test('regression: unchanged cold reconcile hydrates latest provisional state and validated generation from CURRENT', async () => {
  const root = fixture()
  const builder = trackedEngine(root)
  const built = await builder.build()
  await builder.dispose()
  const cold = trackedEngine(root)

  await cold.reconcile()
  const latest = cold.pinQuery({ type: 'graph', consistency: 'latest' })
  const rows = []
  for await (const row of latest.rows) rows.push(row)

  assert.deepEqual({ metadata: latest.metadata, files: rows[0].files }, { metadata: { revision: 0, freshness: 'provisional', coverage: 'module-linked-syntax', validatedGeneration: built.generation }, files: ['src/a.ts', 'src/b.ts'] })
  await cold.dispose()
})

test('domain analysis: latest query rows retain one atomic revision and validated generation when refresh advances mid-stream', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (snapshot) => snapshot, dispose: async () => {} }) })
  const built = await engine.build()
  const rows = engine.query({ type: 'symbols', consistency: 'latest' })
  const first = await rows.next()

  engine.applyChanges([{ type: 'add', path: 'src/c.ts', source: 'export const c = 3\n' }])
  const second = await rows.next()

  assert.deepEqual(
    { first: { revision: first.value.revision, generation: first.value.validatedGeneration, freshness: first.value.freshness }, second: { revision: second.value.revision, generation: second.value.validatedGeneration, freshness: second.value.freshness } },
    { first: { revision: 0, generation: built.generation, freshness: 'provisional' }, second: { revision: 0, generation: built.generation, freshness: 'provisional' } },
  )
})

test('domain analysis: latest graph query returns complete provisional revision and validated-generation metadata', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (snapshot) => snapshot, dispose: async () => {} }) })
  const built = await engine.build()
  const rows = []

  for await (const row of engine.query({ type: 'graph', consistency: 'latest' })) rows.push(row)

  assert.deepEqual(
    { revision: rows[0].revision, freshness: rows[0].freshness, coverage: rows[0].coverage, validatedGeneration: rows[0].validatedGeneration, files: rows[0].files },
    { revision: 0, freshness: 'provisional', coverage: 'module-linked-syntax', validatedGeneration: built.generation, files: ['src/a.ts', 'src/b.ts'] },
  )
})

test('atomic generations support pinned reads and recover from an invalid CURRENT', async () => {
  const root = fixture(); const engine = trackedEngine(root)
  const one = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 9 }')
  const two = await engine.incremental([{ type: 'change', path: 'src/a.ts' }])
  await two.validation
  const twoGeneration = engine.readGeneration().generation
  assert.notEqual(one.generation, twoGeneration)
  assert.equal(engine.readGeneration(one.generation).generation, one.generation)
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'missing')
  const recovered = trackedEngine(root)
  assert.equal(recovered.readGeneration().generation, twoGeneration)
  await recovered.dispose()
})

test('stream query is cancellable and bounded', async () => {
  const root = fixture(); const engine = trackedEngine(root); await engine.build()
  const controller = new AbortController(); const rows = []
  for await (const row of engine.query({ type: 'symbols', limit: 10 }, { signal: controller.signal, maxQueue: 1 })) { rows.push(row); controller.abort() }
  assert.equal(rows.length, 1)
})

test('export surface changes return the provisional changed file and validate reverse dependency removal', async () => {
  const root = fixture(); const parsed = []
  const engine = trackedEngine(root, { instrument: (event) => parsed.push(event.file) })
  await engine.build(); parsed.length = 0
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function renamed(){ return 1 }')
  const result = await engine.incremental([{ type: 'change', path: 'src/a.ts' }])
  assert.deepEqual(result.parsedFiles, ['src/a.ts'])
  assert.deepEqual(parsed, [])
  assert.equal(engine.snapshot().edges.length, 0)
})

test('exported const declarations are indexed as exported variables', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exported-const-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const answer = 42\n')
  const engine = trackedEngine(root)

  await engine.build()

  assert.deepEqual(engine.snapshot().symbols.map(({ file, name, kind, exported }) => ({ file, name, kind, exported })), [
    { file: 'src/value.ts', name: 'answer', kind: 'variable', exported: true },
  ])
})

test('re-export aliases resolve consumer calls to the original declaration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-reexport-alias-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'original.ts'), 'export function original(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { original as aliased } from './original'\n")
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { aliased } from './barrel'; export function consume(){ return aliased() }\n")
  const engine = trackedEngine(root)

  await engine.build()
  const graph = engine.snapshot()
  const original = graph.symbols.find((symbol) => symbol.file === 'src/original.ts' && symbol.name === 'original')
  const consumer = graph.symbols.find((symbol) => symbol.file === 'src/consumer.ts' && symbol.name === 'consume')

  assert.deepEqual(graph.edges, [{ from: consumer.id, to: original.id, line: 1, call: true }])
})

test('same-named shadowed functions resolve calls to their lexical declarations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shadowing-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'shadow.ts'), 'function target(){ return 1 }\nexport function outer(){ function target(){ return 2 } return target() }\nexport function direct(){ return target() }\n')
  const engine = trackedEngine(root)

  await engine.build()
  const graph = engine.snapshot()
  const targets = graph.symbols.filter((symbol) => symbol.name === 'target').sort((a, b) => a.line - b.line)
  const outer = graph.symbols.find((symbol) => symbol.name === 'outer')
  const direct = graph.symbols.find((symbol) => symbol.name === 'direct')

  assert.deepEqual(graph.edges, [
    { from: direct.id, to: targets[0].id, line: 3, call: true },
    { from: outer.id, to: targets[1].id, line: 2, call: true },
  ].sort((a, b) => `${a.from}:${a.to}:${a.line}`.localeCompare(`${b.from}:${b.to}:${b.line}`)))
})

test('overload symbol IDs remain stable when implementation contents change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overloads-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'overload.ts'), 'export function parse(value: string): string\nexport function parse(value: number): number\nexport function parse(value: string | number){ return value }\n')
  const engine = trackedEngine(root)
  await engine.build()
  const before = engine.snapshot().symbols.filter((symbol) => symbol.name === 'parse').map((symbol) => symbol.id)

  fs.writeFileSync(path.join(root, 'src', 'overload.ts'), 'export function parse(value: string): string\nexport function parse(value: number): number\nexport function parse(value: string | number){ return typeof value === "number" ? value + 1 : value.trim() }\n')
  await engine.incremental([{ type: 'change', path: 'src/overload.ts' }])

  assert.deepEqual(engine.snapshot().symbols.filter((symbol) => symbol.name === 'parse').map((symbol) => symbol.id), before)
})

test('a query aborted before iteration emits no rows', async () => {
  const root = fixture(); const engine = trackedEngine(root); await engine.build()
  const controller = new AbortController(); controller.abort(); const rows = []

  for await (const row of engine.query({ type: 'symbols', limit: 10 }, { signal: controller.signal })) rows.push(row)

  assert.deepEqual(rows, [])
})

test('inserting an unrelated same-name declaration does not churn qualified IDs', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'scopes.ts'), 'export class A { same(){ return 1 } }\nexport class B { same(){ return 2 } }')
  const engine = trackedEngine(root); await engine.build()
  const before = new Map(engine.snapshot().symbols.filter((s) => s.name === 'same').map((s) => [s.qualifiedPath, s.id]))
  fs.writeFileSync(path.join(root, 'src', 'scopes.ts'), 'export class A { same(){ return 1 } }\nclass C { same(){ return 3 } }\nexport class B { same(){ return 2 } }')
  await engine.incremental([{ type: 'change', path: 'src/scopes.ts' }])
  const after = new Map(engine.snapshot().symbols.filter((s) => s.name === 'same').map((s) => [s.qualifiedPath, s.id]))
  assert.equal(after.get('class:A'), before.get('class:A'))
  assert.equal(after.get('class:B'), before.get('class:B'))
})

test('adding a previously unresolved module returns the provisional added file and validates its importer edge', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'missing-user.ts'), "import { later } from './later'; export const value = later()")
  const engine = trackedEngine(root); await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'later.ts'), 'export function later(){ return 4 }')
  const result = await engine.incremental([{ type: 'add', path: 'src/later.ts' }])
  assert.deepEqual(result.parsedFiles, ['src/later.ts'])
  const graph = engine.snapshot(); const later = graph.symbols.find((s) => s.name === 'later')
  assert.ok(graph.edges.some((edge) => edge.to === later.id))
})

test('domain analysis: build consumes one prefetched source snapshot while preserving the clean graph', async () => {
  const root = fixture()
  const reads = []
  const prefetched = trackedEngine(root, {
    cacheDir: '.prefetched-codegraph',
    sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file)); return fsp.readFile(file, encoding) } },
  })
  const clean = trackedEngine(root, { cacheDir: '.clean-codegraph' })

  const prefetchedResult = await prefetched.build()
  await clean.build()

  assert.deepEqual(
    { reads, parsedFiles: prefetchedResult.parsedFiles, graph: canon(prefetched.snapshot()) },
    { reads: ['src/a.ts', 'src/b.ts'], parsedFiles: ['src/a.ts', 'src/b.ts'], graph: canon(clean.snapshot()) },
  )
  await Promise.all([prefetched.dispose(), clean.dispose()])
})

test('error guessing: reconcile reads a changed source once and incremental reuses that same snapshot', async () => {
  const root = fixture()
  const reads = []
  const engine = trackedEngine(root, {
    sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file)); return fsp.readFile(file, encoding) } },
  })
  await engine.build()
  reads.length = 0
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 9 }\n')

  const result = await engine.reconcile()

  assert.deepEqual({ reads, parsedFiles: result.parsedFiles }, { reads: ['src/a.ts', 'src/b.ts'], parsedFiles: ['src/a.ts'] })
})

test('equivalence partition: disabled profiling performs async reads without touching the profiler clock', async () => {
  const root = fixture()
  let clockCalls = 0
  const engine = trackedEngine(root, {
    profileDeps: { now: () => { clockCalls += 1; return 1n } },
    sourceReaderDeps: { now: () => { throw new Error('disabled profiling observed read timing') }, readFile: fsp.readFile },
  })

  const result = await engine.build()

  assert.deepEqual({ parsedFiles: result.parsedFiles, clockCalls }, { parsedFiles: ['src/a.ts', 'src/b.ts'], clockCalls: 0 })
})

test('domain analysis: two provisional dependency changes validate the fan-in importer without duplicate or stale edges', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-id-fanin-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'left.ts'), 'export function left(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'right.ts'), 'export function right(){ return 2 }\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { left } from './left'; import { right } from './right'; export const total = left() + right()\n")
  const parsed = []
  const engine = trackedEngine(root, { instrument: (event) => parsed.push(event.file) })
  await engine.build()
  parsed.length = 0
  fs.writeFileSync(path.join(root, 'src', 'left.ts'), 'export function leftRenamed(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'right.ts'), 'export function rightRenamed(){ return 2 }\n')

  const result = await engine.incremental([{ type: 'change', path: 'src/left.ts' }, { type: 'change', path: 'src/right.ts' }])
  await result.validation
  const clean = trackedEngine(root, { cacheDir: '.clean-fanin' })
  await clean.build()

  assert.deepEqual({ parsedFiles: result.parsedFiles, instrumented: parsed, graph: canon(engine.snapshot()) }, { parsedFiles: ['src/left.ts', 'src/right.ts'], instrumented: [], graph: canon(clean.snapshot()) })
  await clean.dispose()
})

test('domain analysis: delete then new add preserves the public graph and does not persist internal file IDs', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  fs.unlinkSync(path.join(root, 'src', 'a.ts'))
  await engine.incremental([{ type: 'unlink', path: 'src/a.ts' }])
  fs.writeFileSync(path.join(root, 'src', 'replacement.ts'), 'export function replacement(){ return 3 }\n')

  await engine.incremental([{ type: 'add', path: 'src/replacement.ts' }])

  const manifest = engine.readGeneration()
  assert.deepEqual({ graphFiles: engine.snapshot().files, hasFileIds: Object.hasOwn(manifest, 'fileIds'), hasNextFileId: Object.hasOwn(manifest, 'nextFileId') }, { graphFiles: ['src/b.ts', 'src/replacement.ts'], hasFileIds: false, hasNextFileId: false })
})

test('domain analysis: numeric file IDs do not alter persisted partition symbol or edge shapes', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  const manifest = engine.readGeneration()
  const aPartition = engine.store.readPartition(manifest.partitions['src/a.ts'])

  assert.deepEqual({ manifestKeys: Object.keys(manifest).sort(), partitionFile: aPartition.file, symbolFile: aPartition.symbols[0].file, edgeKeys: Object.keys(engine.store.readPartition(manifest.partitions['src/b.ts']).edges[0]).sort() }, { manifestKeys: ['controlHashes', 'createdAt', 'edgeCoverage', 'generation', 'partitionHashes', 'partitions', 'root', 'sources', 'version'], partitionFile: 'src/a.ts', symbolFile: 'src/a.ts', edgeKeys: ['call', 'from', 'line', 'to'] })
})

test('domain analysis: incremental tsconfig change rebuilds and publishes the changed control hash', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))

  const incremented = await engine.incremental([{ type: 'change', path: 'tsconfig.json' }])
  const manifest = engine.readGeneration(incremented.generation)

  assert.deepEqual(
    { generationChanged: incremented.generation !== built.generation, tsconfigHash: manifest.controlHashes['tsconfig.json'], parsedFiles: incremented.parsedFiles },
    { generationChanged: true, tsconfigHash: 'aa704494dcde9431b2c044497ef8983aa284e5add1fb9b7f729730d9b93e796b', parsedFiles: ['src/a.ts', 'src/b.ts'] },
  )
})

test('error guessing: reconcile upgrades a legacy current manifest without control hashes', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifestPath = path.join(root, '.codegraph', 'generations', `${built.generation}.json`)
  const legacy = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  delete legacy.controlHashes
  fs.writeFileSync(manifestPath, JSON.stringify(legacy))

  const reconciled = await engine.reconcile()
  const current = engine.readGeneration(reconciled.generation)

  assert.deepEqual(
    { generationChanged: reconciled.generation !== built.generation, tsconfigHash: current.controlHashes['tsconfig.json'], edgeCoverage: reconciled.edgeCoverage },
    { generationChanged: true, tsconfigHash: 'b6074ef1d796c9bacd315a7d8933e7aedb7ebe1922532d6e5dec666d7e8573c5', edgeCoverage: 'calls' },
  )
})

test('equivalence partition: a v3 build persists an exact source snapshot and only call-complete base edges', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-base-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)

  const result = await engine.build()
  const manifest = engine.readGeneration(result.generation)
  const consumer = engine.store.readPartition(manifest.partitions['src/consumer.ts'])

  assert.deepEqual(
    { version: manifest.version, edgeCoverage: manifest.edgeCoverage, sourceFiles: Object.keys(manifest.sources).sort(), consumerSource: engine.store.readSource(manifest.sources['src/consumer.ts']), edgeKinds: consumer.edges.map((edge) => edge.call) },
    { version: 3, edgeCoverage: 'calls', sourceFiles: ['src/consumer.ts', 'src/value.ts'], consumerSource: "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n", edgeKinds: [true] },
  )
})

test('domain analysis: build incremental and unchanged reconcile report call-complete public coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-result-coverage-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export function value(){ return 41 }\n')
  const engine = trackedEngine(root)

  const built = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export function value(){ return 42 }\n')
  const incremented = await engine.incremental([{ type: 'change', path: 'src/value.ts' }])
  const reconciled = await engine.reconcile()

  assert.deepEqual(
    { build: built.edgeCoverage, incremental: incremented.edgeCoverage, unchangedReconcile: reconciled.edgeCoverage },
    { build: 'calls', incremental: 'calls', unchangedReconcile: 'calls' },
  )
})

test('domain analysis: refs enrich the requested generation from its source blobs after disk and CURRENT advance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-pinned-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const engine = trackedEngine(root)
  const old = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "export function read(){ return 0 }\n")
  await engine.incremental([{ type: 'change', path: 'src/consumer.ts' }])

  const rows = []
  for await (const row of engine.query({ type: 'refs', name: 'value', generation: old.generation })) rows.push(row)
  const overlay = engine.store.readOverlay(old.generation)

  assert.deepEqual({ rows: rows.map(({ call, line }) => ({ call, line })), coverage: overlay.edgeCoverage, generation: overlay.generation }, { rows: [{ call: false, line: 2 }], coverage: 'complete', generation: old.generation })
})

test('error guessing: concurrent cold refs coalesce into one overlay build and both receive the complete result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-coalesce-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  let overlayBuilds = 0
  const engine = trackedEngine(root, { instrument: (event) => { if (event.phase === 'reference-overlay') overlayBuilds += 1 } })
  await engine.build()

  const [left, right] = await Promise.all([
    (async () => { const rows = []; for await (const row of engine.query({ type: 'refs', name: 'value' })) rows.push(row); return rows })(),
    (async () => { const rows = []; for await (const row of engine.query({ type: 'refs', name: 'value' })) rows.push(row); return rows })(),
  ])

  assert.deepEqual({ overlayBuilds, left: left.map((edge) => edge.call), right: right.map((edge) => edge.call) }, { overlayBuilds: 1, left: [false], right: [false] })
})

test('error guessing: a cancelled cold refs query publishes no partial overlay and a retry returns every reference', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-cancel-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function first(){ return value }\nexport function second(){ return value }\n")
  const engine = trackedEngine(root)
  const result = await engine.build()
  const controller = new AbortController()
  controller.abort()
  const cancelled = []
  for await (const row of engine.query({ type: 'refs', name: 'value' }, { signal: controller.signal })) cancelled.push(row)

  const afterCancellation = engine.store.readOverlay(result.generation)
  const retried = []
  for await (const row of engine.query({ type: 'refs', name: 'value' })) retried.push(row)

  assert.deepEqual({ cancelled, afterCancellation, retried: retried.map(({ call, line }) => ({ call, line })) }, { cancelled: [], afterCancellation: null, retried: [{ call: false, line: 2 }, { call: false, line: 3 }] })
})

test('error guessing: overlay source failure rejects refs and leaves no readable partial cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-failure-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const engine = trackedEngine(root)
  const result = await engine.build()
  engine.store.readSource = () => { throw new Error('source blob unavailable') }

  let message
  try { for await (const ignored of engine.query({ type: 'refs', name: 'value' })) void ignored } catch (error) { message = error.message }

  assert.deepEqual({ message, overlay: engine.store.readOverlay(result.generation) }, { message: 'source blob unavailable', overlay: null })
})

test('combinatorial all-pairs: eager deps uses call coverage without creating a complete overlay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-deps-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)
  const result = await engine.build()

  const rows = []
  for await (const row of engine.query({ type: 'deps', name: 'call' })) rows.push(row)

  assert.deepEqual({ rows: rows.map(({ call, line }) => ({ call, line })), overlay: engine.store.readOverlay(result.generation) }, { rows: [{ call: true, line: 3 }], overlay: null })
})

test('domain analysis: the default graph query forces complete coverage and atomically caches it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-default-graph-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const engine = trackedEngine(root)
  const result = await engine.build()

  const rows = []
  for await (const row of engine.query({ type: 'graph' })) rows.push(row)

  assert.deepEqual({ coverage: rows[0].edgeCoverage, edgeKinds: rows[0].edges.map((edge) => edge.call), overlayCoverage: engine.store.readOverlay(result.generation).edgeCoverage }, { coverage: 'complete', edgeKinds: [false], overlayCoverage: 'complete' })
})

test('equivalence partition: a legacy v2 generation remains readable as fully covered without source blobs', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const result = await engine.build()
  const manifest = engine.readGeneration(result.generation)
  const legacy = engine.store.publish({ version: 2, root, partitions: manifest.partitions, partitionHashes: manifest.partitionHashes })

  const graph = await engine.snapshot(legacy.generation)

  assert.deepEqual({ generation: graph.generation, edgeCoverage: graph.edgeCoverage, edgeKinds: graph.edges.map((edge) => edge.call) }, { generation: legacy.generation, edgeCoverage: 'complete', edgeKinds: [true] })
})

test('hotpath equivalence partitions: second bounded validated symbols deps and refs queries perform zero graph-store reads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-view-warm-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)
  await engine.build()
  const reads = { generation: 0, partition: 0, overlay: 0 }
  const readGeneration = engine.store.readGeneration.bind(engine.store)
  const readPartition = engine.store.readPartition.bind(engine.store)
  const readOverlay = engine.store.readOverlay.bind(engine.store)
  engine.store.readGeneration = (...args) => { reads.generation += 1; return readGeneration(...args) }
  engine.store.readPartition = (...args) => { reads.partition += 1; return readPartition(...args) }
  engine.store.readOverlay = (...args) => { reads.overlay += 1; return readOverlay(...args) }
  for await (const ignored of engine.query({ type: 'symbols', name: 'value', limit: 200 })) void ignored
  for await (const ignored of engine.query({ type: 'deps', name: 'call', limit: 200 })) void ignored
  for await (const ignored of engine.query({ type: 'refs', name: 'value', limit: 200 })) void ignored
  reads.generation = 0
  reads.partition = 0
  reads.overlay = 0

  const symbols = []
  for await (const row of engine.query({ type: 'symbols', name: 'value', limit: 200 })) symbols.push(row)
  const deps = []
  for await (const row of engine.query({ type: 'deps', name: 'call', limit: 200 })) deps.push(row)
  const refs = []
  for await (const row of engine.query({ type: 'refs', name: 'value', limit: 200 })) refs.push(row)

  assert.deepEqual(
    { reads, symbols: symbols.map(({ name }) => name), deps: deps.map(({ call, line }) => ({ call, line })), refs: refs.map(({ call, line }) => ({ call, line })) },
    { reads: { generation: 0, partition: 0, overlay: 0 }, symbols: ['value'], deps: [{ call: true, line: 3 }], refs: [{ call: false, line: 2 }] },
  )
})

test('domain boundary: a warmed pinned generation remains correct and performs zero store reads after CURRENT advances', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const old = await engine.build()
  for await (const ignored of engine.query({ type: 'symbols', generation: old.generation, limit: 200 })) void ignored
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3\n')
  const advanced = await engine.incremental([{ type: 'add', path: 'src/c.ts' }])
  const reads = { generation: 0, partition: 0, overlay: 0 }
  const readGeneration = engine.store.readGeneration.bind(engine.store)
  const readPartition = engine.store.readPartition.bind(engine.store)
  const readOverlay = engine.store.readOverlay.bind(engine.store)
  engine.store.readGeneration = (...args) => { reads.generation += 1; return readGeneration(...args) }
  engine.store.readPartition = (...args) => { reads.partition += 1; return readPartition(...args) }
  engine.store.readOverlay = (...args) => { reads.overlay += 1; return readOverlay(...args) }

  const pinned = []
  for await (const row of engine.query({ type: 'symbols', generation: old.generation, limit: 200 })) pinned.push(row)

  assert.deepEqual(
    { currentAdvanced: advanced.generation !== old.generation, reads, names: pinned.map(({ name }) => name) },
    { currentAdvanced: true, reads: { generation: 0, partition: 0, overlay: 0 }, names: ['a', 'b'] },
  )
})

test('domain analysis: a new provisional revision invalidates only the provisional view and leaves the warmed validated view resident', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: () => new Promise(() => {}), dispose: async () => {} }) })
  const built = await engine.build()
  for await (const ignored of engine.query({ type: 'symbols', generation: built.generation, limit: 200 })) void ignored
  const before = []
  for await (const row of engine.query({ type: 'symbols', consistency: 'latest', limit: 200 })) before.push(row)
  engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function changed(){ return a() }\n" }])
  const after = []
  for await (const row of engine.query({ type: 'symbols', consistency: 'latest', limit: 200 })) after.push(row)
  const reads = { generation: 0, partition: 0, overlay: 0 }
  const readGeneration = engine.store.readGeneration.bind(engine.store)
  const readPartition = engine.store.readPartition.bind(engine.store)
  const readOverlay = engine.store.readOverlay.bind(engine.store)
  engine.store.readGeneration = (...args) => { reads.generation += 1; return readGeneration(...args) }
  engine.store.readPartition = (...args) => { reads.partition += 1; return readPartition(...args) }
  engine.store.readOverlay = (...args) => { reads.overlay += 1; return readOverlay(...args) }
  const validated = []
  for await (const row of engine.query({ type: 'symbols', generation: built.generation, limit: 200 })) validated.push(row)

  assert.deepEqual(
    { before: before.map(({ name }) => name), after: after.map(({ name }) => name), validated: validated.map(({ name }) => name), reads },
    { before: ['a', 'b'], after: ['a', 'changed'], validated: ['a', 'b'], reads: { generation: 0, partition: 0, overlay: 0 } },
  )
})

test('error guessing: warm cancellation stops after the emitted row while preserving the exact validated symbol shape', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  for await (const ignored of engine.query({ type: 'symbols', limit: 200 })) void ignored
  const controller = new AbortController()
  const rows = []

  for await (const row of engine.query({ type: 'symbols', limit: 200 }, { signal: controller.signal })) {
    rows.push(row)
    controller.abort()
  }

  assert.deepEqual(rows, [{ id: '3bdd027f2bd7f1dadf7f2e4a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }])
})

test('equivalence partition and boundary value: queryBatch preserves validated symbol order shape and a limit of two', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()

  const rows = await engine.queryBatch({ type: 'symbols', limit: 2 })

  assert.deepEqual(rows, [
    { id: '3bdd027f2bd7f1dadf7f2e4a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    { id: '6d1f36a6e18b5f8677635dc0', file: 'src/b.ts', name: 'b', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
  ])
})

test('error guessing: an already-aborted queryBatch returns no rows without reading a validated graph', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  const controller = new AbortController()
  controller.abort()
  engine.store.readGeneration = () => { throw new Error('cancelled batch read a generation') }

  const rows = await engine.queryBatch({ type: 'symbols', limit: 200 }, { signal: controller.signal })

  assert.deepEqual(rows, [])
})

test('combinatorial query type: queryBatch preserves the exact outgoing dependency row shape and order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-batch-deps-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)
  await engine.build()

  const rows = await engine.queryBatch({ type: 'deps', name: 'call', limit: 200 })

  assert.deepEqual(rows, [{ from: 'ccf900f6982fdacaccecb2b1', to: 'c7b4368079bc5ee3ea5256bc', line: 3, call: true }])
})

test('combinatorial query type: queryBatch preserves the exact incoming reference row shape and order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-batch-refs-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)
  await engine.build()

  const rows = await engine.queryBatch({ type: 'refs', name: 'value', limit: 200 })

  assert.deepEqual(rows, [{ from: 'c7b4368079bc5ee3ea5256bc', to: 'a00a474c40eb687e382aeffc', line: 2, call: false }])
})

test('equivalence partition: resolved dependency rows join exact source and target metadata without changing edge fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-resolved-deps-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)
  await engine.build()

  const rows = await engine.queryBatch({ type: 'deps', name: 'call', resolved: true, limit: 200 })

  assert.deepEqual(rows, [{
    from: 'ccf900f6982fdacaccecb2b1',
    to: 'c7b4368079bc5ee3ea5256bc',
    line: 3,
    call: true,
    fromSymbol: { id: 'ccf900f6982fdacaccecb2b1', name: 'call', file: 'src/consumer.ts', line: 3, kind: 'function' },
    toSymbol: { id: 'c7b4368079bc5ee3ea5256bc', name: 'read', file: 'src/consumer.ts', line: 2, kind: 'function' },
  }])
})

test('equivalence partition: resolved reference rows preserve incoming edge order and join exact endpoint metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-resolved-refs-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function zebra(){ return value }\nexport function alpha(){ return value }\n")
  const engine = trackedEngine(root)
  await engine.build()

  const rows = await engine.queryBatch({ type: 'refs', name: 'value', resolved: true, limit: 200 })

  assert.deepEqual(rows, [
    {
      from: 'bb0bd843b8025af737610d0d', to: 'a00a474c40eb687e382aeffc', line: 2, call: false,
      fromSymbol: { id: 'bb0bd843b8025af737610d0d', name: 'zebra', file: 'src/consumer.ts', line: 2, kind: 'function' },
      toSymbol: { id: 'a00a474c40eb687e382aeffc', name: 'value', file: 'src/value.ts', line: 1, kind: 'variable' },
    },
    {
      from: '99ce0a769cc7345555c06a00', to: 'a00a474c40eb687e382aeffc', line: 3, call: false,
      fromSymbol: { id: '99ce0a769cc7345555c06a00', name: 'alpha', file: 'src/consumer.ts', line: 3, kind: 'function' },
      toSymbol: { id: 'a00a474c40eb687e382aeffc', name: 'value', file: 'src/value.ts', line: 1, kind: 'variable' },
    },
  ])
})

test('equivalence partition: raw reference and dependency requests retain their legacy edge-only row shape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-raw-compatible-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const engine = trackedEngine(root)
  await engine.build()

  const deps = await engine.queryBatch({ type: 'deps', name: 'call', limit: 200 })
  const refs = await engine.queryBatch({ type: 'refs', name: 'value', limit: 200 })

  assert.deepEqual({ deps, refs }, {
    deps: [{ from: 'ccf900f6982fdacaccecb2b1', to: 'c7b4368079bc5ee3ea5256bc', line: 3, call: true }],
    refs: [{ from: 'c7b4368079bc5ee3ea5256bc', to: 'a00a474c40eb687e382aeffc', line: 2, call: false }],
  })
})

test('error guessing: resolved relationships with a dangling endpoint fail closed by omitting the corrupt edge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-resolved-dangling-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'only.ts'), 'export function source(){ return 1 }\n')
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifest = engine.readGeneration(built.generation)
  const partition = engine.store.readPartition(manifest.partitions['src/only.ts'])
  const corruptPartitionId = engine.store.writePartition({ ...partition, edges: [{ from: partition.symbols[0].id, to: 'missing-symbol-id', line: 1, call: true }] })
  const corrupt = engine.store.publish({ version: 2, root, partitions: { 'src/only.ts': corruptPartitionId }, partitionHashes: { 'src/only.ts': corruptPartitionId } })

  const rows = await engine.queryBatch({ type: 'deps', name: 'source', resolved: true, generation: corrupt.generation, limit: 200 })

  assert.deepEqual(rows, [])
})

test('domain analysis: warmed resolved rows stay pinned to one generation and perform zero graph, generation, partition, or overlay reads after CURRENT advances', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const old = await engine.build()
  await engine.queryBatch({ type: 'deps', name: 'b', resolved: true, generation: old.generation, limit: 200 })
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function changed(){ return a() }\n")
  const advanced = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  const reads = { generation: 0, partition: 0, overlay: 0, graph: 0 }
  engine.store.readGeneration = () => { reads.generation += 1; throw new Error('resolved query read generation storage') }
  engine.store.readPartition = () => { reads.partition += 1; throw new Error('resolved query read partition storage') }
  engine.store.readOverlay = () => { reads.overlay += 1; throw new Error('resolved query read overlay storage') }
  engine.snapshotComplete = async () => { reads.graph += 1; throw new Error('resolved query requested a complete graph') }

  const rows = await engine.queryBatch({ type: 'deps', name: 'b', resolved: true, generation: old.generation, limit: 200 })

  assert.deepEqual({ currentAdvanced: advanced.generation !== old.generation, reads, rows }, {
    currentAdvanced: true,
    reads: { generation: 0, partition: 0, overlay: 0, graph: 0 },
    rows: [{
      from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true,
      fromSymbol: { id: '6d1f36a6e18b5f8677635dc0', name: 'b', file: 'src/b.ts', line: 1, kind: 'function' },
      toSymbol: { id: '3bdd027f2bd7f1dadf7f2e4a', name: 'a', file: 'src/a.ts', line: 1, kind: 'function' },
    }],
  })
})

test('hotpath boundary: a primed validated query emitting exactly 200 rows completes in under 5ms', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-view-latency-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'symbols.ts'), Array.from({ length: 200 }, (_, index) => `export const symbol${String(index).padStart(3, '0')} = ${index}`).join('\n'))
  const engine = trackedEngine(root)
  await engine.build()
  for (let iteration = 0; iteration < 20; iteration += 1) await engine.queryBatch({ type: 'symbols', limit: 200 })
  const durations = []
  let rowCount = 0
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const started = performance.now()
    const rows = await engine.queryBatch({ type: 'symbols', limit: 200 })
    rowCount = rows.length
    durations.push(performance.now() - started)
  }
  const ordered = durations.toSorted((left, right) => left - right)
  const metrics = { p50: ordered[59], p95: ordered[113], p99: ordered[118], max: ordered[119] }
  const enforceFiveMs = process.env.CODEGRAPH_ENFORCE_FAST_REFRESH === '1'

  t.diagnostic(`CodeGraphEngine warm validated 200-row query hard target p99<5ms ${JSON.stringify({ ...metrics, enforced: enforceFiveMs, targetMet: metrics.p99 < 5 })}`)
  assert.equal(rowCount, 200)
  assert.equal(!enforceFiveMs || metrics.p99 < 5, true, `isolated warm validated query p99 exceeded 5ms: ${JSON.stringify(metrics)}`)
})

test('hotpath integration: a valid cold mapped complete page avoids generation partition and overlay reads', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const writer = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const built = await writer.build()
  await writer.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })
  await writer.dispose()
  const reader = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const reads = { generation: 0, partition: 0, overlay: 0 }
  reader.store.readGeneration = () => { reads.generation += 1; throw new Error('mapped hit read generation') }
  reader.store.readPartition = () => { reads.partition += 1; throw new Error('mapped hit read partition') }
  reader.store.readOverlay = () => { reads.overlay += 1; throw new Error('mapped hit read overlay') }

  const rows = await reader.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })

  assert.deepEqual(
    { reads, generation: rows[0].generation, edgeCoverage: rows[0].edgeCoverage, files: rows[0].files, symbolNames: rows[0].symbols.map(({ name }) => name), edgeCount: rows[0].edges.length },
    { reads: { generation: 0, partition: 0, overlay: 0 }, generation: built.generation, edgeCoverage: 'complete', files: ['src/a.ts', 'src/b.ts'], symbolNames: ['a', 'b'], edgeCount: 1 },
  )
})

test('domain analysis integration: a mapped page for the previous generation remains exact after CURRENT advances', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const writer = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const old = await writer.build()
  await writer.queryBatch({ type: 'symbols', generation: old.generation, limit: 200 })
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3\n')
  const current = await writer.incremental([{ type: 'add', path: 'src/c.ts' }])
  await writer.queryBatch({ type: 'symbols', generation: current.generation, limit: 200 })
  await writer.dispose()
  const reader = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  reader.store.readGeneration = () => { throw new Error('previous mapped generation read generation storage') }
  reader.store.readPartition = () => { throw new Error('previous mapped generation read partition storage') }

  const rows = await reader.queryBatch({ type: 'symbols', generation: old.generation, limit: 200 })

  assert.deepEqual(rows.map(({ name }) => name), ['a', 'b'])
})

test('combinatorial integration: a corrupt mapped page falls back with identical symbols deps refs graph resolved and raw output shapes', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const writer = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const built = await writer.build()
  await writer.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })
  await writer.dispose()
  adapter.corruptHeader()
  const reader = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })

  const symbols = await reader.queryBatch({ type: 'symbols', generation: built.generation, limit: 200 })
  const depsRaw = await reader.queryBatch({ type: 'deps', name: 'b', generation: built.generation, limit: 200 })
  const depsResolved = await reader.queryBatch({ type: 'deps', name: 'b', resolved: true, generation: built.generation, limit: 200 })
  const refsRaw = await reader.queryBatch({ type: 'refs', name: 'a', generation: built.generation, limit: 200 })
  const refsResolved = await reader.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: built.generation, limit: 200 })
  const graph = await reader.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })

  assert.deepEqual({ symbols, depsRaw, depsResolved, refsRaw, refsResolved, graph }, {
    symbols: [
      { id: '3bdd027f2bd7f1dadf7f2e4a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      { id: '6d1f36a6e18b5f8677635dc0', file: 'src/b.ts', name: 'b', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    ],
    depsRaw: [{ from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true }],
    depsResolved: [{
      from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true,
      fromSymbol: { id: '6d1f36a6e18b5f8677635dc0', name: 'b', file: 'src/b.ts', line: 1, kind: 'function' },
      toSymbol: { id: '3bdd027f2bd7f1dadf7f2e4a', name: 'a', file: 'src/a.ts', line: 1, kind: 'function' },
    }],
    refsRaw: [{ from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true }],
    refsResolved: [{
      from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true,
      fromSymbol: { id: '6d1f36a6e18b5f8677635dc0', name: 'b', file: 'src/b.ts', line: 1, kind: 'function' },
      toSymbol: { id: '3bdd027f2bd7f1dadf7f2e4a', name: 'a', file: 'src/a.ts', line: 1, kind: 'function' },
    }],
    graph: [{
      generation: built.generation, edgeCoverage: 'complete', files: ['src/a.ts', 'src/b.ts'],
      symbols: [
        { id: '3bdd027f2bd7f1dadf7f2e4a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: '6d1f36a6e18b5f8677635dc0', file: 'src/b.ts', name: 'b', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      ],
      edges: [{ from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true }],
    }],
  })
})

test('hotpath architecture: mapped symbols deps refs and graph queries use direct indexes without JSON parsing heap reconstruction or GraphStore reads', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const writer = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const built = await writer.build()
  await writer.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })
  await writer.dispose()
  let queryViewFactoryCalls = 0
  const reader = trackedEngine(root, {
    mmapQueryCache: { adapter, capacityBytes: 65536 },
    queryViewFactory: () => { queryViewFactoryCalls += 1; throw new Error('mapped hit reconstructed heap query indexes') },
  })
  const reads = { generation: 0, partition: 0, overlay: 0 }
  reader.store.readGeneration = () => { reads.generation += 1; throw new Error('mapped hit read generation') }
  reader.store.readPartition = () => { reads.partition += 1; throw new Error('mapped hit read partition') }
  reader.store.readOverlay = () => { reads.overlay += 1; throw new Error('mapped hit read overlay') }
  const originalParse = JSON.parse
  let jsonParseCalls = 0
  JSON.parse = () => { jsonParseCalls += 1; throw new Error('mapped hit parsed JSON') }
  let results
  try {
    results = {
      symbols: await reader.queryBatch({ type: 'symbols', name: 'a', generation: built.generation, limit: 200 }),
      depsRaw: await reader.queryBatch({ type: 'deps', name: 'b', generation: built.generation, limit: 200 }),
      depsResolved: await reader.queryBatch({ type: 'deps', name: 'b', resolved: true, generation: built.generation, limit: 200 }),
      refsRaw: await reader.queryBatch({ type: 'refs', name: 'a', generation: built.generation, limit: 200 }),
      refsResolved: await reader.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: built.generation, limit: 200 }),
      graph: await reader.queryBatch({ type: 'graph', generation: built.generation, limit: 200 }),
    }
  } finally {
    JSON.parse = originalParse
  }

  assert.deepEqual({
    reads, queryViewFactoryCalls, jsonParseCalls,
    symbolNames: results.symbols.map(({ name }) => name), depsRaw: results.depsRaw.length, depsResolved: results.depsResolved.length,
    refsRaw: results.refsRaw.length, refsResolved: results.refsResolved.length, graphCoverage: results.graph[0].edgeCoverage,
  }, {
    reads: { generation: 0, partition: 0, overlay: 0 }, queryViewFactoryCalls: 0, jsonParseCalls: 0,
    symbolNames: ['a'], depsRaw: 1, depsResolved: 1, refsRaw: 1, refsResolved: 1, graphCoverage: 'complete',
  })
})

test('hotpath regression: snapshotComplete returns a pinned complete mapped view without dereferencing graph materializing indexes reading GraphStore or republishing', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const writer = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const built = await writer.build()
  await writer.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })
  await writer.dispose()
  const reader = trackedEngine(root, {
    mmapQueryCache: { adapter, capacityBytes: 65536 },
    queryViewFactory: () => { throw new Error('snapshotComplete materialized heap query indexes') },
  })
  reader.mmapQueryCache.decodeObserver = ({ type }) => { if (type === 'graph') throw new Error('snapshotComplete dereferenced mapped graph') }
  reader.store.readGeneration = () => { throw new Error('snapshotComplete read generation storage') }
  reader.store.readPartition = () => { throw new Error('snapshotComplete read partition storage') }
  reader.store.readOverlay = () => { throw new Error('snapshotComplete read overlay storage') }
  const flushesBeforeSnapshot = adapter.flushes

  const view = await reader.snapshotComplete(built.generation)

  assert.deepEqual({ mapped: view.mapped, generation: view.generation, edgeCoverage: view.edgeCoverage, flushes: adapter.flushes }, {
    mapped: true, generation: built.generation, edgeCoverage: 'complete', flushes: flushesBeforeSnapshot,
  })
})

test('hotpath integration: a DnD-shaped mapped refs query returns the exact first resolved row without graph access heap reconstruction GraphStore reads or republishing', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const writer = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const built = await writer.build()
  await writer.queryBatch({ type: 'graph', generation: built.generation, limit: 200 })
  await writer.dispose()
  const reader = trackedEngine(root, {
    mmapQueryCache: { adapter, capacityBytes: 65536 },
    queryViewFactory: () => { throw new Error('mapped refs materialized heap query indexes') },
  })
  reader.mmapQueryCache.decodeObserver = ({ type }) => { if (type === 'graph') throw new Error('mapped refs dereferenced mapped graph') }
  reader.store.readGeneration = () => { throw new Error('mapped refs read generation storage') }
  reader.store.readPartition = () => { throw new Error('mapped refs read partition storage') }
  reader.store.readOverlay = () => { throw new Error('mapped refs read overlay storage') }

  const rows = await reader.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: built.generation, limit: 29 })

  assert.deepEqual(rows, [{
    from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true,
    fromSymbol: { id: '6d1f36a6e18b5f8677635dc0', name: 'b', file: 'src/b.ts', line: 1, kind: 'function' },
    toSymbol: { id: '3bdd027f2bd7f1dadf7f2e4a', name: 'a', file: 'src/a.ts', line: 1, kind: 'function' },
  }])
})
