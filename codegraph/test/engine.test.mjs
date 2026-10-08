import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { FileLocalResolver } from '../incremental-resolver.mjs'
import { SemanticCheckerWorker } from '../semantic-checker-worker.mjs'
import { contentHash, createSemanticProject, parsePartition, prepareSemanticProject } from '../parser.mjs'
import { openInternalPartition } from '../store.mjs'

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
  let engineOptions = options
  if (options?.validationWorkerFactory) {
    const factory = options.validationWorkerFactory
    engineOptions = { ...options, validationWorkerFactory: () => {
      const fake = factory()
      const semantic = new SemanticCheckerWorker()
      return {
        ...fake,
        index: fake.index?.bind(fake) ?? semantic.index.bind(semantic),
        hydrate: fake.hydrate?.bind(fake) ?? semantic.hydrate.bind(semantic),
        validate: fake.validate?.bind(fake) ?? semantic.validate.bind(semantic),
        advanceGeneration: fake.advanceGeneration?.bind(fake) ?? semantic.advanceGeneration.bind(semantic),
        referenceOverlay: fake.referenceOverlay?.bind(fake) ?? semantic.referenceOverlay.bind(semantic),
        dispose: async () => { await fake.dispose?.(); await semantic.dispose() },
      }
    } }
  }
  const engine = new CodeGraphEngine(root, engineOptions)
  trackedEngines.add(engine)
  return engine
}

test.afterEach(async () => {
  const engines = [...trackedEngines]
  trackedEngines.clear()
  await Promise.all(engines.map((engine) => engine.disposed ? undefined : engine.dispose()))
})

test('language metadata: initial TypeScript build publishes the descriptor cache key', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  assert.deepEqual(engine.readGeneration(built.generation).analyzers, { typescript: 'typescript-2' })
})

test('language metadata: TypeScript control change forced-full publication retains the descriptor cache key', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext' }, include: ['src'] }))
  const changed = await engine.incremental([{ type: 'change', path: 'tsconfig.json' }])
  assert.deepEqual(engine.readGeneration(changed.generation).analyzers, { typescript: 'typescript-2' })
})

test('language metadata: ordinary TypeScript incremental publication retains the descriptor cache key', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 2 }\n')
  const changed = await engine.incremental([{ type: 'change', path: 'src/a.ts' }])
  assert.deepEqual(engine.readGeneration(changed.generation).analyzers, { typescript: 'typescript-2' })
})

test('equivalence partitioning: incremental publication persists the sorted parsed and validated file receipts from a body edit', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 2 }\n')

  const changed = await engine.incremental([{ type: 'change', path: 'src/a.ts' }])
  await changed.validation

  assert.deepEqual(
    { parsedFiles: engine.readGeneration(changed.generation).parsedFiles, validatedFiles: engine.readGeneration(changed.generation).validatedFiles },
    { parsedFiles: ['src/a.ts'], validatedFiles: ['src/a.ts'] },
  )
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

const fullWorkerResult = (engine, payload) => {
  const sources = new Map(Object.entries(payload.baseSourceBlobs).map(([file, id]) => [file, engine.store.readSource(id)]))
  for (const change of payload.changes) {
    if (change.type === 'unlink') sources.delete(change.path)
    else sources.set(change.path, change.source ?? fs.readFileSync(path.join(payload.root, change.path), 'utf8'))
  }
  const context = prepareSemanticProject(createSemanticProject(payload.root, sources), payload.root)
  const known = new Set(sources.keys())
  const partitions = Object.fromEntries([...sources].map(([file, source]) => [file, parsePartition(file, source, known, context)]))
  const sourceBlobs = Object.fromEntries([...sources].map(([file, source]) => [file, engine.store.writeSource(source)]))
  const partitionReceipts = Object.entries(partitions).map(([file, partition]) => {
    const { internalPartition, internalFingerprint, ...symbolPartition } = partition
    const partitionId = engine.store.writePartition(symbolPartition)
    const internalPartitionId = engine.store.writeInternalPartition(internalPartition)
    const symbolLength = fs.statSync(path.join(engine.store.partitions, `${partitionId}.bin`)).size
    return { file, sourceHash: sourceBlobs[file], writer: 'worker', partitionId, internalPartitionId, serializedLength: symbolLength + internalPartition.byteLength, chunkCount: 0, symbolLength, internalLength: internalPartition.byteLength, symbolChunkCount: 0, internalChunkCount: 0, internalFingerprint }
  }).sort((left, right) => left.file.localeCompare(right.file))
  return { revision: payload.revision, mode: 'full', baseGeneration: payload.baseGeneration, sourceBlobs, partitionReceipts }
}

test('architecture boundary: importing the tool engine on the main thread loads neither the semantic parser nor the ts-morph wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tool-engine-import-'))
  const loaderPath = path.join(root, 'record-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/parser.mjs') || url.includes('/node_modules/ts-morph/dist/ts-morph.js')) process.stderr.write('FORBIDDEN ' + url + '\\n')
  return nextLoad(url, context)
}
`)

  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, '--input-type=module', '--eval', "await import('./tool-engine.mjs'); process.stdout.write('tool-engine-imported')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  })
  fs.rmSync(root, { recursive: true, force: true })

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, forbiddenLoads: result.stderr.split('\n').filter((line) => line.startsWith('FORBIDDEN ')) },
    { status: 0, stdout: 'tool-engine-imported', forbiddenLoads: [] },
  )
})

test('architecture boundary: importing the semantic checker client on the main thread loads neither the semantic parser nor the ts-morph wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-semantic-checker-import-'))
  const loaderPath = path.join(root, 'record-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/parser.mjs') || url.includes('/node_modules/ts-morph/dist/ts-morph.js')) process.stderr.write('FORBIDDEN ' + url + '\\n')
  return nextLoad(url, context)
}
`)

  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, '--input-type=module', '--eval', "await import('./semantic-checker-worker.mjs'); process.stdout.write('semantic-checker-imported')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  })
  fs.rmSync(root, { recursive: true, force: true })

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, forbiddenLoads: result.stderr.split('\n').filter((line) => line.startsWith('FORBIDDEN ')) },
    { status: 0, stdout: 'semantic-checker-imported', forbiddenLoads: [] },
  )
})

test('equivalence partition: only a semantic-checker worker imports the parser and ts-morph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-semantic-worker-import-'))
  const loaderPath = path.join(root, 'record-loader.mjs')
  const workerPath = path.join(root, 'import-worker.mjs')
  const driverPath = path.join(root, 'run-worker.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/parser.mjs')) process.stderr.write('PARSER_LOADED\\n')
  if (url.includes('/node_modules/ts-morph/dist/ts-morph.js')) process.stderr.write('TS_MORPH_LOADED\\n')
  return nextLoad(url, context)
}
`)
  fs.writeFileSync(workerPath, `
import { parentPort } from 'node:worker_threads'
await import(${JSON.stringify(new URL('../semantic-checker-worker.mjs', import.meta.url).href)})
parentPort.postMessage('imported')
`)
  fs.writeFileSync(driverPath, `
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
const worker = new Worker(${JSON.stringify(workerPath)}, { workerData: { semanticChecker: process.env.SEMANTIC_CHECKER === 'true' } })
await once(worker, 'message')
await worker.terminate()
process.stdout.write('imported')
`)

  const ordinary = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, driverPath], { encoding: 'utf8', env: { ...process.env, SEMANTIC_CHECKER: 'false' } })
  const semantic = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, driverPath], { encoding: 'utf8', env: { ...process.env, SEMANTIC_CHECKER: 'true' } })
  fs.rmSync(root, { recursive: true, force: true })

  assert.deepEqual(
    { ordinary: { status: ordinary.status, stdout: ordinary.stdout, imports: ordinary.stderr.trim().split('\n').filter(Boolean) }, semantic: { status: semantic.status, stdout: semantic.stdout, imports: semantic.stderr.trim().split('\n').filter(Boolean) } },
    { ordinary: { status: 0, stdout: 'imported', imports: [] }, semantic: { status: 0, stdout: 'imported', imports: ['PARSER_LOADED', 'TS_MORPH_LOADED'] } },
  )
})

test('boundary analysis: a fresh engine hydrates a persisted base and validates one changed leaf as a one-partition delta', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'leaf.ts'), 'export const leaf = 1\n')
  const builder = trackedEngine(root)
  await builder.build()
  await builder.dispose()
  fs.writeFileSync(path.join(root, 'src', 'leaf.ts'), 'export const leaf = 2\n')
  const cold = trackedEngine(root)
  let writes = 0
  const writePartition = cold.store.writePackedPartitionRange.bind(cold.store)
  cold.store.writePackedPartitionRange = (...args) => { writes += 1; return writePartition(...args) }

  const result = await cold.reconcile()
  await result.validation
  const clean = trackedEngine(root, { cacheDir: '.clean-cold-leaf-delta' })
  await clean.build()
  const actual = cold.readGeneration()
  const expected = clean.readGeneration()

  assert.deepEqual(
    {
      validationMode: result.validationMode,
      validatedFiles: result.validatedFiles,
      writes,
      graph: canon(cold.snapshot()),
      deterministicManifest: {
        version: actual.version,
        root: actual.root,
        edgeCoverage: actual.edgeCoverage,
        controlHashes: actual.controlHashes,
        sources: actual.sources,
        partitions: actual.partitions,
        partitionHashes: actual.partitionHashes,
      },
    },
    {
      validationMode: 'delta',
      validatedFiles: ['src/leaf.ts'],
      writes: 1,
      graph: canon(clean.snapshot()),
      deterministicManifest: {
        version: expected.version,
        root: expected.root,
        edgeCoverage: expected.edgeCoverage,
        controlHashes: expected.controlHashes,
        sources: expected.sources,
        partitions: expected.partitions,
        partitionHashes: expected.partitionHashes,
      },
    },
  )
})

test('domain analysis: restart reconcile reads parses and validates only the one changed source', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export function c(){ return b() }\n")
  const builder = trackedEngine(root)
  const built = await builder.build()
  const persisted = builder.readGeneration(built.generation)
  await builder.dispose()
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 2 }\n')
  const reads = []
  const restarted = trackedEngine(root, { sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } } })

  const result = await restarted.reconcile()
  await result.validation

  assert.deepEqual(
    {
      retainedDetectionFiles: Object.keys(persisted.sourceMetadata ?? {}).sort(),
      reads,
      parsedFiles: result.parsedFiles,
      validatedFiles: result.validatedFiles,
      validationMode: result.validationMode,
    },
    {
      retainedDetectionFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      reads: ['src/a.ts'],
      parsedFiles: ['src/a.ts'],
      validatedFiles: ['src/a.ts'],
      validationMode: 'delta',
    },
  )
})

test('boundary and state-transition analysis: restart no-change reconcile creates no worker and the next one-file mutation lazily creates exactly one', async () => {
  const root = fixture()
  const builder = trackedEngine(root)
  const built = await builder.build()
  const persisted = builder.readGeneration(built.generation)
  await builder.dispose()
  const reads = []
  let semanticWorkers = 0
  const restarted = trackedEngine(root, {
    sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } },
    validationWorkerFactory: () => { semanticWorkers += 1; return new SemanticCheckerWorker() },
  })

  const result = await restarted.reconcile()
  const unchangedState = {
    retainedDetectionFiles: Object.keys(persisted.sourceMetadata ?? {}).sort(),
    reads: [...reads],
    parsedFiles: result.parsedFiles,
    semanticWorkers,
  }
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")
  const changed = await restarted.incremental([{ type: 'change', path: 'src/b.ts' }])
  const validated = await changed.validation

  assert.deepEqual(
    {
      unchangedState,
      changedState: {
        reads,
        parsedFiles: changed.parsedFiles,
        validatedFiles: validated.validatedFiles,
        semanticWorkers,
      },
    },
    {
      unchangedState: {
        retainedDetectionFiles: ['src/a.ts', 'src/b.ts'],
        reads: [],
        parsedFiles: [],
        semanticWorkers: 0,
      },
      changedState: {
        reads: ['src/b.ts'],
        parsedFiles: ['src/b.ts'],
        validatedFiles: ['src/b.ts'],
        semanticWorkers: 1,
      },
    },
  )
})

test('boundary and state-transition analysis: restart reconcile reads parses and validates only one added source and patches detection metadata', async () => {
  const root = fixture()
  const builder = trackedEngine(root)
  await builder.build()
  await builder.dispose()
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export function c(){ return b() }\n")
  const reads = []
  const restarted = trackedEngine(root, { sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } } })

  const result = await restarted.reconcile()
  await result.validation

  assert.deepEqual(
    {
      reads,
      parsedFiles: result.parsedFiles,
      validatedFiles: result.validatedFiles,
      validationMode: result.validationMode,
      retainedDetectionFiles: Object.keys(restarted.readGeneration().sourceMetadata ?? {}).sort(),
    },
    {
      reads: ['src/c.ts'],
      parsedFiles: ['src/c.ts'],
      validatedFiles: ['src/c.ts'],
      validationMode: 'delta',
      retainedDetectionFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    },
  )
})

test('boundary and state-transition analysis: restart reconcile unlinks one source without reading or processing its survivor and patches detection metadata', async () => {
  const root = fixture()
  const builder = trackedEngine(root)
  await builder.build()
  await builder.dispose()
  fs.unlinkSync(path.join(root, 'src', 'a.ts'))
  const reads = []
  const restarted = trackedEngine(root, { sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } } })

  const result = await restarted.reconcile()
  await result.validation

  assert.deepEqual(
    {
      reads,
      parsedFiles: result.parsedFiles,
      validatedFiles: result.validatedFiles,
      validationMode: result.validationMode,
      retainedDetectionFiles: Object.keys(restarted.readGeneration().sourceMetadata ?? {}).sort(),
    },
    {
      reads: [],
      parsedFiles: [],
      validatedFiles: ['src/a.ts'],
      validationMode: 'delta',
      retainedDetectionFiles: ['src/b.ts'],
    },
  )
})

test('domain analysis: a single changed export validates only that file and never walks its converging dependents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-diamond-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export interface Value { id: string }\n')
  fs.writeFileSync(path.join(root, 'src', 'left.ts'), "export { Value } from './base'\n")
  fs.writeFileSync(path.join(root, 'src', 'right.ts'), "export { Value } from './base'\n")
  fs.writeFileSync(path.join(root, 'src', 'top.ts'), "import type { Value as Left } from './left'\nimport type { Value as Right } from './right'\nexport const top = (left: Left, right: Right) => left.id + right.id\n")
  const engine = trackedEngine(root)
  await engine.build()
  let writes = 0
  const writePartition = engine.store.writePackedPartitionRange.bind(engine.store)
  engine.store.writePackedPartitionRange = (...args) => { writes += 1; return writePartition(...args) }
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export interface Value { id: string; revision?: number }\n')

  const result = await engine.incremental([{ type: 'change', path: 'src/base.ts' }])
  const validation = await result.validation
  assert.deepEqual(
    { validationMode: validation.validationMode, parsedFiles: result.parsedFiles, validatedFiles: validation.validatedFiles, writes },
    { validationMode: 'delta', parsedFiles: ['src/base.ts'], validatedFiles: ['src/base.ts'], writes: 1 },
  )
})

test('equivalence partition and domain analysis: an unrelated unresolved stylesheet does not expand changed-file-only validation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-unrelated-unresolved-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'leaf.ts'), 'export const leaf = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'page.ts'), "import './missing.css'\nexport const page = 'ready'\n")
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'leaf.ts'), 'export const leaf = 2\n')

  const result = await engine.incremental([{ type: 'change', path: 'src/leaf.ts' }])
  const clean = trackedEngine(root, { cacheDir: '.clean-unrelated-unresolved' })
  await clean.build()

  assert.deepEqual(
    { validationMode: result.validationMode, validatedFiles: result.validatedFiles, graph: canon(engine.snapshot()) },
    { validationMode: 'delta', validatedFiles: ['src/leaf.ts'], graph: canon(clean.snapshot()) },
  )
})

test('boundary value and domain analysis: adding one unresolved candidate validates only the added file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-matching-unresolved-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'waiting.ts'), "import { later } from './later'\nexport const waiting = () => later()\n")
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'later.ts'), 'export const later = () => 7\n')

  const result = await engine.incremental([{ type: 'change', path: 'src/later.ts' }])
  const validation = await result.validation
  assert.deepEqual(
    { validationMode: validation.validationMode, parsedFiles: result.parsedFiles, validatedFiles: validation.validatedFiles },
    { validationMode: 'delta', parsedFiles: ['src/later.ts'], validatedFiles: ['src/later.ts'] },
  )
})

test('boundary analysis: unlinking one file parses no source and publishes only its tombstone receipt without dependent validation', async () => {
  const root = fixture()
  const closureObservations = []
  const engine = trackedEngine(root, { validationClosureObserver: (observation) => closureObservations.push(observation) })
  await engine.build()
  fs.unlinkSync(path.join(root, 'src', 'a.ts'))

  const result = await engine.incremental([{ type: 'unlink', path: 'src/a.ts' }])
  await result.validation

  assert.deepEqual(
    {
      validationMode: result.validationMode,
      parsedFiles: result.parsedFiles,
      validatedFiles: result.validatedFiles,
      partitionPresent: Object.hasOwn(engine.readGeneration().partitions, 'src/a.ts'),
      closureObservations,
    },
    {
      validationMode: 'delta',
      parsedFiles: [],
      validatedFiles: ['src/a.ts'],
      partitionPresent: false,
      closureObservations: [{ reverseClosureWalks: 0, importerIndexBuilds: 0, unresolvedIndexBuilds: 0 }],
    },
  )
})

test('equivalence partition: two simultaneous source edits use full validation and publish a complete clean-build-equivalent generation', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  let writes = 0
  const writePartition = engine.store.writePackedPartitionRange.bind(engine.store)
  engine.store.writePackedPartitionRange = (...args) => { writes += 1; return writePartition(...args) }
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 11 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+22 }\n")

  const result = await engine.incremental([{ type: 'change', path: 'src/a.ts' }, { type: 'change', path: 'src/b.ts' }])
  await result.validation
  const clean = trackedEngine(root, { cacheDir: '.clean-multiple-full' })
  await clean.build()

  assert.deepEqual(
    { validationMode: result.validationMode, validatedFiles: result.validatedFiles, writes, graph: canon(engine.snapshot()) },
    { validationMode: 'full', validatedFiles: ['src/a.ts', 'src/b.ts'], writes: 2, graph: canon(clean.snapshot()) },
  )
})

test('equivalence partition: an unknown semantic result mode is rejected before CURRENT changes', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => ({ revision: payload.revision, mode: 'surprise', baseGeneration: payload.baseGeneration, sourceBlobs: payload.baseSourceBlobs, partitions: {} }), dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 9 }\n' }])
  await assert.rejects(refreshed.validation, /mode|full|delta|unknown/i)

  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('error guessing: a delta for a stale base generation is rejected before CURRENT changes', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => ({ revision: payload.revision, mode: 'delta', baseGeneration: 'stale-generation', sourceBlobs: payload.baseSourceBlobs, partitions: {} }), dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 9 }\n' }])
  await assert.rejects(refreshed.validation, /base|generation|stale|mismatch/i)

  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('error guessing: an older worker receipt revision rejects instead of returning null or publishing', async () => {
  const root = fixture()
  let engine
  engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => {
    const complete = fullWorkerResult(engine, payload)
    return {
      ...complete,
      revision: 0,
      mode: 'delta',
      partitionReceipts: complete.partitionReceipts.filter(({ file }) => file === 'src/b.ts'),
    }
  }, dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const changed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+2 }\n" }])

  await assert.rejects(changed.validation, /revision|receipt|request|mismatch/i)
  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('error guessing: a newer worker receipt revision rejects instead of returning null or publishing', async () => {
  const root = fixture()
  let engine
  engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => {
    const complete = fullWorkerResult(engine, payload)
    return {
      ...complete,
      revision: 2,
      mode: 'delta',
      partitionReceipts: complete.partitionReceipts.filter(({ file }) => file === 'src/b.ts'),
    }
  }, dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const changed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+2 }\n" }])

  await assert.rejects(changed.validation, /revision|receipt|request|mismatch/i)
  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('error guessing: a delta containing an unknown partition key is rejected before CURRENT changes', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => ({ revision: payload.revision, mode: 'delta', baseGeneration: payload.baseGeneration, sourceBlobs: payload.baseSourceBlobs, partitions: { 'src/ghost.ts': { file: 'src/ghost.ts', sourceHash: 'ghost', symbols: [], edges: [], dependencies: [], unresolved: [] } } }), dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 9 }\n' }])
  await assert.rejects(refreshed.validation, /partition|unknown|membership|ghost/i)

  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('domain analysis: changing one global script into a module validates only that changed file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-script-module-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'global.ts'), 'function shared(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'use.ts'), 'const result = shared()\n')
  const engine = trackedEngine(root)
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'global.ts'), 'export function shared(){ return 1 }\n')

  const result = await engine.incremental([{ type: 'change', path: 'src/global.ts' }])
  const validation = await result.validation
  assert.deepEqual(
    { validationMode: validation.validationMode, parsedFiles: result.parsedFiles, validatedFiles: validation.validatedFiles },
    { validationMode: 'delta', parsedFiles: ['src/global.ts'], validatedFiles: ['src/global.ts'] },
  )
})

test('domain analysis: a delta cannot change an unchanged source blob while omitting that file partition', async () => {
  const root = fixture()
  let engine
  engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => { const base = engine.readGeneration(payload.baseGeneration); return { revision: payload.revision, mode: 'delta', baseGeneration: payload.baseGeneration, sourceBlobs: { ...payload.baseSourceBlobs, 'src/a.ts': engine.store.writeSource('export function a(){ return 999 }\n') }, partitions: { 'src/b.ts': engine.store.readPartition(base.partitions['src/b.ts']) } } }, dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a() }\n" }])
  await assert.rejects(refreshed.validation, /source|blob|partition|unchanged|missing|mismatch/i)

  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('error guessing: a failed delta partition write does not poison the following successful validation', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  await engine.build()
  const warmed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+1 }\n" }])
  const warmedValidation = await warmed.validation
  const writePartition = engine.store.writePackedPartitionRange.bind(engine.store)
  let failWrite = true
  engine.store.writePackedPartitionRange = (...args) => { if (failWrite) { failWrite = false; throw new Error('delta partition write failed') } return writePartition(...args) }

  const failed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+2 }\n" }])
  await assert.rejects(failed.validation, /delta partition write failed/)
  const recovered = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+3 }\n" }])
  const recoveredValidation = await recovered.validation
  const clean = trackedEngine(root, { cacheDir: '.clean-after-delta-write-failure' })
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+3 }\n")
  await clean.build()

  assert.deepEqual({ warmedMode: warmedValidation.validationMode, recoveredMode: recoveredValidation.validationMode, graph: canon(engine.snapshot()) }, { warmedMode: 'delta', recoveredMode: 'delta', graph: canon(clean.snapshot()) })
})

test('domain analysis: explicit base partitions replace a warm worker cache even when source blobs are unchanged', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifest = engine.readGeneration(built.generation)
  const worker = new SemanticCheckerWorker()
  const partitionPool = () => new SharedArrayBuffer(4096 + 300 * 65536)
  const unchangedA = engine.store.readSource(manifest.sources['src/a.ts'])
  await worker.validate({ revision: 1, root, cacheDir: '.codegraph', baseGeneration: built.generation, baseSourceBlobs: manifest.sources, basePartitionIds: manifest.partitions, partitionDir: engine.store.partitions, sourceDir: engine.store.sources, partitionPool: partitionPool(), changes: [{ type: 'change', path: 'src/a.ts', source: unchangedA }] }, () => {})
  const b = engine.store.readPartition(manifest.partitions['src/b.ts'])
  const replacementB = engine.store.writePartition({ ...b, dependencies: [] })

  const result = await worker.validate({ revision: 2, root, cacheDir: '.codegraph', baseGeneration: 'generation-with-new-control-context', baseSourceBlobs: manifest.sources, basePartitionIds: { ...manifest.partitions, 'src/b.ts': replacementB }, partitionDir: engine.store.partitions, sourceDir: engine.store.sources, partitionPool: partitionPool(), changes: [{ type: 'change', path: 'src/a.ts', source: unchangedA }] }, () => {})
  await worker.dispose()

  assert.deepEqual({ mode: result.mode, validatedFiles: result.partitionReceipts.map(({ file }) => file).sort() }, { mode: 'delta', validatedFiles: ['src/a.ts'] })
})

test('error guessing and domain analysis: an unhydrated public-surface delta uses retained partitions without reading dependent source content', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifest = engine.readGeneration(built.generation)
  const baseInternalFingerprints = Object.fromEntries(Object.entries(manifest.internalPartitions).map(([file, id]) => [file, openInternalPartition(engine.store.readInternalPartition(id)).compilerFingerprint]))
  const worker = new SemanticCheckerWorker()
  fs.unlinkSync(path.join(engine.store.sources, manifest.sources['src/b.ts']))

  const result = await worker.validate({
    revision: 1,
    root,
    cacheDir: '.codegraph',
    baseGeneration: built.generation,
    baseSourceBlobs: manifest.sources,
    basePartitionIds: manifest.partitions,
    baseInternalFingerprints,
    partitionDir: engine.store.partitions,
    sourceDir: engine.store.sources,
    partitionPool: new SharedArrayBuffer(4096 + 300 * 65536),
    changes: [{ type: 'change', path: 'src/a.ts', source: 'export function renamed(){ return 2 }\n' }],
  }, () => {})
  await worker.dispose()

  assert.deepEqual(
    { mode: result.mode, validatedFiles: result.partitionReceipts.map(({ file }) => file), tombstones: result.tombstones ?? [], internalRebuiltFiles: result.internalRebuiltFiles },
    { mode: 'delta', validatedFiles: ['src/a.ts'], tombstones: [], internalRebuiltFiles: ['src/a.ts'] },
  )
})

test('error guessing and boundary analysis: an unhydrated unlink uses retained partitions without reading any source content', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifest = engine.readGeneration(built.generation)
  const baseInternalFingerprints = Object.fromEntries(Object.entries(manifest.internalPartitions).map(([file, id]) => [file, openInternalPartition(engine.store.readInternalPartition(id)).compilerFingerprint]))
  const worker = new SemanticCheckerWorker()
  fs.unlinkSync(path.join(engine.store.sources, manifest.sources['src/a.ts']))
  fs.unlinkSync(path.join(engine.store.sources, manifest.sources['src/b.ts']))

  const result = await worker.validate({
    revision: 1,
    root,
    cacheDir: '.codegraph',
    baseGeneration: built.generation,
    baseSourceBlobs: manifest.sources,
    basePartitionIds: manifest.partitions,
    baseInternalFingerprints,
    partitionDir: engine.store.partitions,
    sourceDir: engine.store.sources,
    partitionPool: new SharedArrayBuffer(4096 + 300 * 65536),
    changes: [{ type: 'unlink', path: 'src/a.ts' }],
  }, () => {})
  await worker.dispose()

  assert.deepEqual(
    { mode: result.mode, validatedFiles: result.partitionReceipts.map(({ file }) => file), tombstones: result.tombstones, internalRebuiltFiles: result.internalRebuiltFiles },
    { mode: 'delta', validatedFiles: [], tombstones: ['src/a.ts'], internalRebuiltFiles: [] },
  )
})

test('domain and state-transition analysis: one unhydrated worker processes sequential change change unlink requests only at each requested path', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export function c(){ return b() }\n")
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifest = engine.readGeneration(built.generation)
  const baseInternalFingerprints = Object.fromEntries(Object.entries(manifest.internalPartitions).map(([file, id]) => [file, openInternalPartition(engine.store.readInternalPartition(id)).compilerFingerprint]))
  const worker = new SemanticCheckerWorker()
  for (const sourceId of new Set(Object.values(manifest.sources))) fs.unlinkSync(path.join(engine.store.sources, sourceId))
  const partitionPool = () => new SharedArrayBuffer(4096 + 300 * 65536)

  const first = await worker.validate({
    revision: 1,
    root,
    cacheDir: '.codegraph',
    baseGeneration: built.generation,
    baseSourceBlobs: manifest.sources,
    basePartitionIds: manifest.partitions,
    baseInternalFingerprints,
    partitionDir: engine.store.partitions,
    sourceDir: engine.store.sources,
    partitionPool: partitionPool(),
    changes: [{ type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' }],
  }, () => {})
  const second = await worker.validate({
    revision: 2,
    root,
    cacheDir: '.codegraph',
    baseGeneration: built.generation,
    baseSourceBlobs: first.sourceBlobs,
    partitionDir: engine.store.partitions,
    sourceDir: engine.store.sources,
    partitionPool: partitionPool(),
    changes: [{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+2 }\n" }],
  }, () => {})
  const third = await worker.validate({
    revision: 3,
    root,
    cacheDir: '.codegraph',
    baseGeneration: built.generation,
    baseSourceBlobs: second.sourceBlobs,
    partitionDir: engine.store.partitions,
    sourceDir: engine.store.sources,
    partitionPool: partitionPool(),
    changes: [{ type: 'unlink', path: 'src/c.ts' }],
  }, () => {})
  await worker.dispose()

  assert.deepEqual(
    [first, second, third].map((result) => ({
      mode: result.mode,
      validatedFiles: result.partitionReceipts.map(({ file }) => file),
      tombstones: result.tombstones ?? [],
      internalBuildCount: result.internalBuildCount,
      internalRebuiltFiles: result.internalRebuiltFiles,
    })),
    [
      { mode: 'delta', validatedFiles: ['src/a.ts'], tombstones: [], internalBuildCount: 1, internalRebuiltFiles: ['src/a.ts'] },
      { mode: 'delta', validatedFiles: ['src/b.ts'], tombstones: [], internalBuildCount: 1, internalRebuiltFiles: ['src/b.ts'] },
      { mode: 'delta', validatedFiles: [], tombstones: ['src/c.ts'], internalBuildCount: 0, internalRebuiltFiles: [] },
    ],
  )
})

test('domain analysis: a delta cannot replace an unchanged dependent blob and partition together', async () => {
  const root = fixture()
  let engine
  engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => { const complete = fullWorkerResult(engine, { ...payload, changes: [...payload.changes, { type: 'change', path: 'src/a.ts', source: 'export function a(){ return 999 }\n' }] }); return { ...complete, mode: 'delta' } }, dispose: async () => {} }) })
  const built = await engine.build()
  const before = manifestBytes(engine)

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+2 }\n" }])
  await assert.rejects(refreshed.validation, /unchanged|source|blob|partition|extra/i)

  assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
})

test('domain analysis: consecutive single-file public-surface deltas never walk or build dependent closure indexes', async () => {
  const root = fixture()
  const closureObservations = []
  let engine
  engine = trackedEngine(root, {
    validationClosureObserver: (observation) => closureObservations.push(observation),
    validationWorkerFactory: () => ({ validate: async (payload) => {
      const complete = fullWorkerResult(engine, payload)
      return {
        ...complete,
        mode: 'delta',
        partitionReceipts: complete.partitionReceipts.filter(({ file }) => file === 'src/a.ts'),
      }
    }, dispose: async () => {} }),
  })
  await engine.build()

  const first = engine.applyChanges([{ type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\nexport const firstSurface = 1\n' }])
  const firstValidation = await first.validation
  const firstGraph = engine.snapshot()

  const second = engine.applyChanges([{ type: 'change', path: 'src/a.ts', source: "export function a(){ return 3 }\nexport const secondSurface = 'changed'\n" }])
  const secondValidation = await second.validation
  const secondGraph = engine.snapshot()

  assert.deepEqual({
    closureObservations,
    firstValidatedFiles: firstValidation.validatedFiles,
    firstReferences: firstGraph.edges.map(({ from, to, line, call }) => ({
      fromFile: firstGraph.symbols.find(({ id }) => id === from)?.file,
      fromName: firstGraph.symbols.find(({ id }) => id === from)?.name,
      toFile: firstGraph.symbols.find(({ id }) => id === to)?.file,
      toName: firstGraph.symbols.find(({ id }) => id === to)?.name,
      line,
      call,
    })),
    secondValidatedFiles: secondValidation.validatedFiles,
    secondReferences: secondGraph.edges.map(({ from, to, line, call }) => ({
      fromFile: secondGraph.symbols.find(({ id }) => id === from)?.file,
      fromName: secondGraph.symbols.find(({ id }) => id === from)?.name,
      toFile: secondGraph.symbols.find(({ id }) => id === to)?.file,
      toName: secondGraph.symbols.find(({ id }) => id === to)?.name,
      line,
      call,
    })),
  }, {
    closureObservations: [
      { reverseClosureWalks: 0, importerIndexBuilds: 0, unresolvedIndexBuilds: 0 },
      { reverseClosureWalks: 0, importerIndexBuilds: 0, unresolvedIndexBuilds: 0 },
    ],
    firstValidatedFiles: ['src/a.ts'],
    firstReferences: [{ fromFile: 'src/b.ts', fromName: 'b', toFile: 'src/a.ts', toName: 'a', line: 1, call: true }],
    secondValidatedFiles: ['src/a.ts'],
    secondReferences: [{ fromFile: 'src/b.ts', fromName: 'b', toFile: 'src/a.ts', toName: 'a', line: 1, call: true }],
  })
})

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

  assert.deepEqual({ initialGeneration: built.generation, firstGeneration, secondGeneration, revision: engine.provisionalSnapshot().revision, freshness: engine.provisionalSnapshot().freshness }, { initialGeneration: built.generation, firstGeneration, secondGeneration, revision: 2, freshness: 'validated' })
  assert.notEqual(firstGeneration, built.generation)
  assert.notEqual(secondGeneration, firstGeneration)
})

test('domain analysis: adding a previously unresolved import validates only the added file and matches a clean build', async () => {
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

test('changed-file validation starts without a main parse while the prior validated query stays available', { timeout: 30_000 }, async () => {
  const root = fixture()
  const parsedA = new FileLocalResolver(root, new Map([['src/a.ts', 'export function a(){ return 2 }\n']])).files.get('src/a.ts')
  const parsedB = new FileLocalResolver(root, new Map([['src/b.ts', "import { a } from './a'; export function b(){ return a()+2 }\n"]])).files.get('src/b.ts')
  const parserCalls = []
  const parserPool = {
    parse: async (request) => { parserCalls.push(request.path); return request.path === 'src/a.ts' ? { ...parsedA, source: undefined } : { ...parsedB, source: undefined } },
    snapshot: () => ({ workerCount: 2, queued: 0, inFlight: 0, latestRevisionByFile: {} }),
    dispose: async () => {},
  }
  const checker = new SemanticCheckerWorker()
  let validationStarted = false
  let releaseValidation
  const engine = trackedEngine(root, { cacheDir: '.worker-first-change', parserPool, validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: async (payload, onProgress) => { validationStarted = true; await new Promise((resolve) => { releaseValidation = resolve }); return checker.validate(payload, onProgress) },
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 2 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")

  const changing = engine.incremental([{ type: 'change', path: 'src/a.ts' }, { type: 'change', path: 'src/b.ts' }])
  while (!validationStarted) await new Promise((resolve) => setImmediate(resolve))
  const priorQuery = await Promise.race([
    engine.queryBatch({ type: 'symbols', name: 'a', generation: built.generation }).then((rows) => ({ status: 'ready', rows })),
    new Promise((resolve) => setImmediate(() => resolve({ status: 'blocked', rows: [] }))),
  ])
  releaseValidation()
  const changed = await changing
  await changed.validation

  assert.deepEqual({ parserCalls, priorQuery: { status: priorQuery.status, rows: priorQuery.rows.map(({ name, file, line }) => ({ name, file, line })) }, currentGeneration: engine.readGeneration().generation, changedGeneration: changed.generation }, {
    parserCalls: [],
    priorQuery: { status: 'ready', rows: [{ name: 'a', file: 'src/a.ts', line: 1 }] },
    currentGeneration: changed.generation,
    changedGeneration: changed.generation,
  })
})

test('error guessing: an active stale validation is discarded before its newer pending revision validates', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const pending = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    validate: (snapshot, onProgress) => new Promise((resolve, reject) => { pending.push({ snapshot, release: () => checker.validate(snapshot, onProgress).then(resolve, reject) }) }),
    dispose: async () => { for (const request of pending) request.release(); await checker.dispose() },
  }) })
  const built = await engine.build()
  const first = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 2 }\n' }])
  const second = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 3 }\n' }])

  pending[0].release()
  const firstResult = await first.validation
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    { workerRevisions: pending.map(({ snapshot }) => snapshot.revision), firstResult, generationAfterStaleResult: engine.readGeneration().generation, latestRevision: engine.provisionalSnapshot().revision },
    { workerRevisions: [1, 2], firstResult: null, generationAfterStaleResult: built.generation, latestRevision: 2 },
  )

  pending[1].release()
  const secondResult = await second.validation

  assert.deepEqual({ priorGeneration: built.generation, secondGeneration: secondResult.generation, finalGeneration: engine.readGeneration().generation, latestRevision: engine.provisionalSnapshot().revision }, { priorGeneration: built.generation, secondGeneration: secondResult.generation, finalGeneration: secondResult.generation, latestRevision: 2 })
})

test('boundary and concurrency: 120 rapid changes keep one active validation and replace one pending validation with revision 120', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const workerCalls = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    validate: (snapshot, onProgress) => new Promise((resolve, reject) => { workerCalls.push({ snapshot, release: () => checker.validate(snapshot, onProgress).then(resolve, reject) }) }),
    dispose: async () => { for (const request of workerCalls) request.release(); await checker.dispose() },
  }) })
  await engine.build()
  const refreshes = []

  for (let revision = 1; revision <= 120; revision += 1) {
    refreshes.push(engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: `export function b(){ return ${revision} }\n` }]))
  }

  assert.deepEqual(
    { provisionalRevision: engine.provisionalSnapshot().revision, workerCallCountWhileStalled: workerCalls.length, activeWorkerRevision: workerCalls[0]?.snapshot.revision },
    { provisionalRevision: 120, workerCallCountWhileStalled: 1, activeWorkerRevision: 1 },
  )

  workerCalls[0].release()
  while (workerCalls.length < 2) await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    { workerCallCountAfterRelease: workerCalls.length, validatedWorkerRevisions: workerCalls.map(({ snapshot }) => snapshot.revision), latestSource: workerCalls[1]?.snapshot.changes[0].source },
    { workerCallCountAfterRelease: 2, validatedWorkerRevisions: [1, 120], latestSource: 'export function b(){ return 120 }\n' },
  )

  workerCalls[1].release()
  let rejectDeadline
  const deadline = new Promise((_, reject) => { rejectDeadline = setTimeout(() => reject(new Error('coalesced validation promises did not settle')), 30_000) })
  const validationResults = await Promise.race([Promise.all(refreshes.map(({ validation }) => validation)), deadline])
  clearTimeout(rejectDeadline)

  assert.deepEqual(
    { settledResultCount: validationResults.length, firstSupersededResult: validationResults[0], secondSupersededResult: validationResults[1], penultimateSupersededResult: validationResults[118], latestResult: validationResults[119], publishedGeneration: engine.readGeneration().generation, finalWorkerCallCount: workerCalls.length },
    { settledResultCount: 120, firstSupersededResult: null, secondSupersededResult: null, penultimateSupersededResult: null, latestResult: validationResults[119], publishedGeneration: validationResults[119].generation, finalWorkerCallCount: 2 },
  )
})

test('hotpath boundary: 120 coalesced edits materialize validation payloads only for active revision 1 and latest revision 120', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const materializedPayloads = []
  const workerCalls = []
  const engine = trackedEngine(root, {
    validationPayloadObserver: (payload) => { materializedPayloads.push(payload) },
    validationWorkerFactory: () => ({
      validate: (payload, onProgress) => new Promise((resolve, reject) => { workerCalls.push({ payload, release: () => checker.validate(payload, onProgress).then(resolve, reject) }) }),
      dispose: async () => { for (const request of workerCalls) request.release(); await checker.dispose() },
    }),
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

  workerCalls[0].release()
  await refreshes[0].validation
  while (workerCalls.length < 2) await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    { materializedRevisionsAfterRelease: materializedPayloads.map(({ revision }) => revision), workerPayloadsAfterRelease: workerCalls.map(({ payload }) => ({ revision: payload.revision, changedFiles: payload.changedFiles, changes: payload.changes })) },
    { materializedRevisionsAfterRelease: [1, 120], workerPayloadsAfterRelease: [{ revision: 1, changedFiles: ['src/b.ts'], changes: [{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 1 }\n' }] }, { revision: 120, changedFiles: ['src/b.ts'], changes: [{ type: 'change', path: 'src/b.ts', source: 'export function b(){ return 120 }\n' }] }] },
  )

  workerCalls[1].release()
  let rejectDeadline
  const deadline = new Promise((_, reject) => { rejectDeadline = setTimeout(() => reject(new Error('lazily materialized validation promises did not settle')), 30_000) })
  const validationResults = await Promise.race([Promise.all(refreshes.map(({ validation }) => validation)), deadline])
  clearTimeout(rejectDeadline)

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

test('regression: unchanged cold reconcile hydrates latest validated generation from CURRENT', async () => {
  const root = fixture()
  const builder = trackedEngine(root)
  const built = await builder.build()
  await builder.dispose()
  const cold = trackedEngine(root)

  await cold.reconcile()
  const latest = cold.pinQuery({ type: 'graph', consistency: 'latest' })
  const rows = []
  for await (const row of latest.rows) rows.push(row)

  assert.deepEqual({ metadata: latest.metadata, files: rows[0].files }, { metadata: { revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration: built.generation }, files: ['src/a.ts', 'src/b.ts'] })
  await cold.dispose()
})

test('domain analysis: latest query rows retain one atomic revision and validated generation when refresh advances mid-stream', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => fullWorkerResult(engine, payload), dispose: async () => {} }) })
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

test('export surface changes keep the old validated graph before background validation and publish dependency removal afterward', async () => {
  const root = fixture(); const parsed = []
  const engine = trackedEngine(root, { instrument: (event) => parsed.push(event.file) })
  await engine.build(); parsed.length = 0
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function renamed(){ return 1 }')
  const result = await engine.incremental([{ type: 'change', path: 'src/a.ts' }])
  assert.deepEqual(result.parsedFiles, ['src/a.ts'])
  assert.deepEqual(parsed, [])
  assert.equal(engine.snapshot().edges.length, 1)
  await result.validation
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

  assert.deepEqual({ manifestKeys: Object.keys(manifest).sort(), partitionFile: aPartition.file, symbolFile: aPartition.symbols[0].file, edgeKeys: Object.keys(engine.store.readPartition(manifest.partitions['src/b.ts']).edges[0]).sort() }, { manifestKeys: ['controlHashes', 'createdAt', 'edgeCoverage', 'generation', 'internalPartitions', 'partitionHashes', 'partitions', 'root', 'sources', 'version'], partitionFile: 'src/a.ts', symbolFile: 'src/a.ts', edgeKeys: ['call', 'from', 'line', 'to'] })
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

test('equivalence partition: a v3 build persists complete base edges and its first graph query starts no overlay work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-base-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n")
  const checker = new SemanticCheckerWorker()
  let overlayRequests = 0
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests += 1; return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }) })

  const result = await engine.build()
  const manifest = engine.readGeneration(result.generation)
  const consumer = engine.store.readPartition(manifest.partitions['src/consumer.ts'])
  const rows = await engine.queryBatch({ type: 'graph' })

  assert.deepEqual(
    { version: manifest.version, edgeCoverage: manifest.edgeCoverage, sourceFiles: Object.keys(manifest.sources).sort(), consumerSource: engine.store.readSource(manifest.sources['src/consumer.ts']), partitionEdgeKinds: consumer.edges.map((edge) => edge.call), queryEdgeKinds: rows[0].edges.map((edge) => edge.call), overlayRequests },
    { version: 3, edgeCoverage: 'complete', sourceFiles: ['src/consumer.ts', 'src/value.ts'], consumerSource: "import { value } from './value'\nexport function read(){ return value }\nexport function call(){ return read() }\n", partitionEdgeKinds: [false, true], queryEdgeKinds: [false, true], overlayRequests: 0 },
  )
})

test('domain analysis: build incremental and unchanged reconcile report complete public coverage', async () => {
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
    { build: 'complete', incremental: 'complete', unchangedReconcile: 'complete' },
  )
})

test('domain analysis: pinned complete refs stay queryable after CURRENT advances without source-dependent overlay work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-pinned-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const checker = new SemanticCheckerWorker()
  let overlayRequests = 0
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests += 1; return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }) })
  const old = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "export function read(){ return 0 }\n")
  await engine.incremental([{ type: 'change', path: 'src/consumer.ts' }])

  const rows = []
  for await (const row of engine.query({ type: 'refs', name: 'value', generation: old.generation })) rows.push(row)
  const overlay = engine.store.readOverlay(old.generation)

  assert.deepEqual({ rows: rows.map(({ call, line }) => ({ call, line })), overlay, overlayRequests }, { rows: [{ call: false, line: 2 }], overlay: null, overlayRequests: 0 })
})

test('domain analysis: a target-only change keeps complete importer references without overlay refresh or source rereads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-warm-overlay-cascade-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export interface Value { id: string }\n')
  fs.writeFileSync(path.join(root, 'src', 'left.ts'), "import type { Value } from './value'\nexport const left = (value: Value) => value.id\n")
  fs.writeFileSync(path.join(root, 'src', 'right.ts'), "import type { Value } from './value'\nexport const right = (value: Value) => value.id\n")
  fs.writeFileSync(path.join(root, 'src', 'unrelated.ts'), 'export const unrelated = 1\n')
  const checker = new SemanticCheckerWorker()
  const overlayRequests = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests.push(payload.staleFiles); return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }) })
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export interface Value { id: string; revision?: number }\n')
  const changed = await engine.incremental([{ type: 'change', path: 'src/value.ts' }])
  await changed.validation
  let sourceReads = 0
  const readSource = engine.store.readSource.bind(engine.store)
  engine.store.readSource = (...args) => { sourceReads += 1; return readSource(...args) }

  const rows = await engine.queryBatch({ type: 'refs', name: 'Value', resolved: true })

  assert.deepEqual(
    {
      requestCount: overlayRequests.length,
      staleFiles: overlayRequests,
      sourceReads,
      parsedFiles: changed.parsedFiles,
      validatedFiles: changed.validatedFiles,
      rows: rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })).toSorted((left, right) => left.fromFile.localeCompare(right.fromFile)),
    },
    {
      requestCount: 0,
      staleFiles: [],
      sourceReads: 0,
      parsedFiles: ['src/value.ts'],
      validatedFiles: ['src/value.ts'],
      rows: [
        { fromFile: 'src/left.ts', toFile: 'src/value.ts', line: 2, call: false },
        { fromFile: 'src/right.ts', toFile: 'src/value.ts', line: 2, call: false },
      ],
    },
  )
})

test('domain analysis: one retained leaf update preserves exact clean-build call and reference results without overlay work', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'unchanged.ts'), 'export const unchanged = 1\n')
  const checker = new SemanticCheckerWorker()
  let overlayRequests = 0
  const reads = []
  const retained = trackedEngine(root, { cacheDir: '.parse-once-retained', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests += 1; return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }), sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } } })
  const clean = trackedEngine(root, { cacheDir: '.parse-once-clean' })
  await retained.build()
  reads.length = 0
  overlayRequests = 0
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ const selected = a; return a()+selected() }\n")

  const changed = await retained.incremental([{ type: 'change', path: 'src/b.ts' }])
  await changed.validation
  const cleanBuild = await clean.build()
  const retainedCalls = await retained.queryBatch({ type: 'deps', name: 'b', resolved: true })
  const cleanCalls = await clean.queryBatch({ type: 'deps', name: 'b', resolved: true, generation: cleanBuild.generation })
  const retainedRefs = await retained.queryBatch({ type: 'refs', name: 'a', resolved: true })
  const cleanRefs = await clean.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: cleanBuild.generation })

  assert.deepEqual(
    {
      overlayRequests,
      reads,
      parsedFiles: changed.parsedFiles,
      validatedFiles: changed.validatedFiles,
      overlay: retained.store.readOverlay(retained.readGeneration().generation),
      retainedCalls: retainedCalls.map(({ fromSymbol, toSymbol, line, call }) => ({ from: `${fromSymbol.file}:${fromSymbol.name}`, to: `${toSymbol.file}:${toSymbol.name}`, line, call })),
      cleanCalls: cleanCalls.map(({ fromSymbol, toSymbol, line, call }) => ({ from: `${fromSymbol.file}:${fromSymbol.name}`, to: `${toSymbol.file}:${toSymbol.name}`, line, call })),
      retainedRefs: retainedRefs.map(({ fromSymbol, toSymbol, line, call }) => ({ from: `${fromSymbol.file}:${fromSymbol.name}`, to: `${toSymbol.file}:${toSymbol.name}`, line, call })),
      cleanRefs: cleanRefs.map(({ fromSymbol, toSymbol, line, call }) => ({ from: `${fromSymbol.file}:${fromSymbol.name}`, to: `${toSymbol.file}:${toSymbol.name}`, line, call })),
    },
    {
      overlayRequests: 0,
      reads: ['src/b.ts'],
      parsedFiles: ['src/b.ts'],
      validatedFiles: ['src/b.ts'],
      overlay: null,
      retainedCalls: [{ from: 'src/b.ts:b', to: 'src/a.ts:a', line: 1, call: true }, { from: 'src/b.ts:b', to: 'src/b.ts:selected', line: 1, call: true }],
      cleanCalls: [{ from: 'src/b.ts:b', to: 'src/a.ts:a', line: 1, call: true }, { from: 'src/b.ts:b', to: 'src/b.ts:selected', line: 1, call: true }],
      retainedRefs: [{ from: 'src/b.ts:b', to: 'src/a.ts:a', line: 1, call: true }, { from: 'src/b.ts:selected', to: 'src/a.ts:a', line: 1, call: false }],
      cleanRefs: [{ from: 'src/b.ts:b', to: 'src/a.ts:a', line: 1, call: true }, { from: 'src/b.ts:selected', to: 'src/a.ts:a', line: 1, call: false }],
    },
  )
})

test('all-pairs parity: complete generations resolve aliases re-exports namespace and default imports identically after a single-file change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-parity-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export default function primary(){ return 1 }\nexport const named = 2\n')
  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { default, default as alias, named as renamed } from './base'\nexport * as space from './base'\n")
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import primary, { alias, renamed, space } from './barrel'\nimport * as namespace from './barrel'\nexport const consume = () => primary() + alias() + renamed + space.named + namespace.renamed\n")
  fs.writeFileSync(path.join(root, 'src', 'donor.ts'), 'export const donor = 3\nexport const readDonor = () => donor\n')
  const warmChecker = new SemanticCheckerWorker()
  let overlayRequests = 0
  const warm = trackedEngine(root, { cacheDir: '.warm-parity', validationWorkerFactory: () => ({
    index: (payload, onProgress) => warmChecker.index(payload, onProgress),
    hydrate: (payload) => warmChecker.hydrate(payload),
    validate: (payload, onProgress) => warmChecker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests += 1; return warmChecker.referenceOverlay(payload) },
    dispose: () => warmChecker.dispose(),
  }) })
  const checker = new SemanticCheckerWorker()
  const comparisonWorker = {
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: async () => { throw new Error('complete generation requested an overlay') },
    dispose: () => checker.dispose(),
  }
  const fallback = trackedEngine(root, { cacheDir: '.fallback-parity', validationWorkerFactory: () => comparisonWorker })
  await warm.build()
  await fallback.build()
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export default function primary(){ return 10 }\nexport const named = 20\nexport const added = 30\n')
  const warmChange = await warm.incremental([{ type: 'change', path: 'src/base.ts' }])
  const fallbackChange = await fallback.incremental([{ type: 'change', path: 'src/base.ts' }])
  await warmChange.validation
  await fallbackChange.validation

  const warmRows = await warm.queryBatch({ type: 'refs', resolved: true })
  const fallbackRows = await fallback.queryBatch({ type: 'refs', resolved: true })
  const normalizeRows = (rows) => rows.map(({ fromSymbol, toSymbol, line, call }) => ({ from: `${fromSymbol.file}:${fromSymbol.name}`, to: `${toSymbol.file}:${toSymbol.name}`, line, call })).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

  assert.deepEqual(
    {
      rows: normalizeRows(warmRows),
      overlayRequests,
      warmOverlay: warm.store.readOverlay(warm.readGeneration().generation),
      comparisonOverlay: fallback.store.readOverlay(fallback.readGeneration().generation),
    },
    {
      rows: normalizeRows(fallbackRows),
      overlayRequests: 0,
      warmOverlay: null,
      comparisonOverlay: null,
    },
  )
})

test('domain boundary: a historical refs query bypasses the warm worker and uses the persisted generation sources', async () => {
  const root = fixture()
  let engine
  let overlayRequests = 0
  const worker = {
    validate: async (payload) => fullWorkerResult(engine, payload),
    referenceOverlay: async () => { overlayRequests += 1; throw new Error('historical query reached warm worker') },
    dispose: async () => {},
  }
  engine = trackedEngine(root, { validationWorkerFactory: () => worker })
  const old = await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(){ return 2 }\n')
  const changed = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  await changed.validation

  const rows = await engine.queryBatch({ type: 'refs', name: 'a', generation: old.generation, resolved: true })

  assert.deepEqual({ overlayRequests, rows: rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })) }, { overlayRequests: 0, rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', line: 1, call: true }] })
})

test('error guessing: concurrent cold refs read the complete generation without building an overlay', async () => {
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

  assert.deepEqual({ overlayBuilds, left: left.map((edge) => edge.call), right: right.map((edge) => edge.call) }, { overlayBuilds: 0, left: [false], right: [false] })
})

test('error guessing: a cancelled cold refs query leaves complete storage unchanged and a retry returns every reference', async () => {
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

test('error guessing: complete refs do not reread unavailable source blobs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-failure-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const engine = trackedEngine(root)
  const result = await engine.build()
  engine.store.readSource = () => { throw new Error('source blob unavailable') }

  const rows = []
  for await (const row of engine.query({ type: 'refs', name: 'value' })) rows.push(row)

  assert.deepEqual({ rows: rows.map(({ call, line }) => ({ call, line })), overlay: engine.store.readOverlay(result.generation) }, { rows: [{ call: false, line: 2 }], overlay: null })
})

test('combinatorial all-pairs: complete deps returns call edges without creating an overlay', async () => {
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

test('domain analysis: the default graph query reads complete generation coverage without an overlay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-default-graph-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const engine = trackedEngine(root)
  const result = await engine.build()

  const rows = []
  for await (const row of engine.query({ type: 'graph' })) rows.push(row)

  assert.deepEqual({ coverage: rows[0].edgeCoverage, edgeKinds: rows[0].edges.map((edge) => edge.call), overlay: engine.store.readOverlay(result.generation) }, { coverage: 'complete', edgeKinds: [false], overlay: null })
})

test('domain and state-transition analysis: deleting and re-adding one exported target retains its cached importer partition and repairs its dangling call', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const overlayRequests = []
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => { overlayRequests.push(payload.staleFiles); return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  const beforeRows = []
  for await (const row of engine.query({ type: 'graph' })) beforeRows.push(row)
  const beforeManifest = engine.readGeneration(built.generation)
  const missingTargetId = beforeRows[0].symbols.find(({ file, name }) => file === 'src/a.ts' && name === 'a').id
  const importerPartitionId = beforeManifest.partitions['src/b.ts']
  overlayRequests.length = 0
  fs.unlinkSync(path.join(root, 'src', 'a.ts'))

  const result = await engine.reconcile()
  await result.validation
  const afterRows = []
  for await (const row of engine.query({ type: 'graph' })) afterRows.push(row)
  const afterManifest = engine.readGeneration()
  const deleteState = {
    parsedFiles: result.parsedFiles,
    validatedFiles: result.validatedFiles,
    importerPartitionReused: afterManifest.partitions['src/b.ts'] === importerPartitionId,
    overlay: engine.store.readOverlay(afterManifest.generation),
    overlayRequests: [...overlayRequests],
    resolvedEdges: afterRows[0].edges,
    unresolvedEdges: afterRows[0].unresolvedEdges,
  }
  overlayRequests.length = 0
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const repaired = await engine.reconcile()
  await repaired.validation
  const repairedRows = []
  for await (const row of engine.query({ type: 'graph' })) repairedRows.push(row)
  const repairedManifest = engine.readGeneration()

  assert.deepEqual(
    {
      deleteState,
      repairState: {
        parsedFiles: repaired.parsedFiles,
        validatedFiles: repaired.validatedFiles,
        importerPartitionReused: repairedManifest.partitions['src/b.ts'] === importerPartitionId,
        overlay: engine.store.readOverlay(repairedManifest.generation),
        overlayRequests,
        resolvedTargets: repairedRows[0].edges.map(({ to }) => to),
        unresolvedEdges: repairedRows[0].unresolvedEdges,
      },
    },
    {
      deleteState: {
        parsedFiles: [],
        validatedFiles: ['src/a.ts'],
        importerPartitionReused: true,
        overlay: null,
        overlayRequests: [],
        resolvedEdges: [],
        unresolvedEdges: [{
          from: beforeRows[0].symbols.find(({ file, name }) => file === 'src/b.ts' && name === 'b').id,
          to: missingTargetId,
          line: 1,
          reason: 'dangling-symbol-target',
        }],
      },
      repairState: {
        parsedFiles: ['src/a.ts'],
        validatedFiles: ['src/a.ts'],
        importerPartitionReused: true,
        overlay: null,
        overlayRequests: [],
        resolvedTargets: [missingTargetId],
        unresolvedEdges: [],
      },
    },
  )
})

test('persistence boundary: a reopened cached complete graph retains user-visible dangling edges', async () => {
  const root = fixture()
  const writer = trackedEngine(root)
  await writer.build()
  const baselineRows = []
  for await (const row of writer.query({ type: 'graph' })) baselineRows.push(row)
  const missingTargetId = baselineRows[0].symbols.find(({ file, name }) => file === 'src/a.ts' && name === 'a').id
  const importerId = baselineRows[0].symbols.find(({ file, name }) => file === 'src/b.ts' && name === 'b').id
  fs.unlinkSync(path.join(root, 'src', 'a.ts'))
  const deleted = await writer.reconcile()
  await deleted.validation
  const publishedRows = []
  for await (const row of writer.query({ type: 'graph' })) publishedRows.push(row)
  await writer.dispose()
  const reopened = trackedEngine(root)

  const reopenedRows = []
  for await (const row of reopened.query({ type: 'graph' })) reopenedRows.push(row)

  assert.deepEqual(
    { published: publishedRows[0].unresolvedEdges, reopened: reopenedRows[0].unresolvedEdges },
    {
      published: [{ from: importerId, to: missingTargetId, line: 1, reason: 'dangling-symbol-target' }],
      reopened: [{ from: importerId, to: missingTargetId, line: 1, reason: 'dangling-symbol-target' }],
    },
  )
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
  const validated = await advanced.validation
  const reads = { generation: 0, partition: 0, overlay: 0, graph: 0 }
  engine.store.readGeneration = () => { reads.generation += 1; throw new Error('resolved query read generation storage') }
  engine.store.readPartition = () => { reads.partition += 1; throw new Error('resolved query read partition storage') }
  engine.store.readOverlay = () => { reads.overlay += 1; throw new Error('resolved query read overlay storage') }
  engine.snapshotComplete = async () => { reads.graph += 1; throw new Error('resolved query requested a complete graph') }

  const rows = await engine.queryBatch({ type: 'deps', name: 'b', resolved: true, generation: old.generation, limit: 200 })

  assert.deepEqual({ currentAdvanced: validated.generation !== old.generation, reads, rows }, {
    currentAdvanced: true,
    reads: { generation: 0, partition: 0, overlay: 0, graph: 0 },
    rows: [{
      from: '6d1f36a6e18b5f8677635dc0', to: '3bdd027f2bd7f1dadf7f2e4a', line: 1, call: true,
      fromSymbol: { id: '6d1f36a6e18b5f8677635dc0', name: 'b', file: 'src/b.ts', line: 1, kind: 'function' },
      toSymbol: { id: '3bdd027f2bd7f1dadf7f2e4a', name: 'a', file: 'src/a.ts', line: 1, kind: 'function' },
    }],
  })
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

test('boundary value: remembering a third validated generation releases the oldest mapped-page lease', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { mmapQueryCache: { adapter: null } })
  const releases = { 'mapped-generation-1': 0, 'mapped-generation-2': 0 }
  engine.mmapQueryCache = {
    acquire: ({ generation }) => {
      if (!(generation in releases)) return null
      const release = () => { releases[generation] += 1 }
      return { value: { mappedView: {
        mapped: true,
        generation,
        edgeCoverage: 'calls',
        graph: { generation, edgeCoverage: 'calls', files: [], symbols: [], edges: [] },
        matchingSymbols: () => [],
        release,
      } }, release }
    },
    publish: () => true,
    dispose: () => {},
  }
  await engine.queryBatch({ type: 'symbols', generation: 'mapped-generation-1' })
  await engine.queryBatch({ type: 'symbols', generation: 'mapped-generation-2' })

  const built = await engine.build()
  await engine.queryBatch({ type: 'symbols', generation: built.generation })

  assert.deepEqual({ ...releases }, { 'mapped-generation-1': 1, 'mapped-generation-2': 0 })
})

test('error guessing: disposing an engine releases its remaining mapped-page lease exactly once', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { mmapQueryCache: { adapter: null } })
  let releases = 0
  const release = () => { releases += 1 }
  engine.mmapQueryCache = {
    acquire: () => ({ value: { mappedView: {
      mapped: true,
      generation: 'mapped-generation-1',
      edgeCoverage: 'calls',
      graph: { generation: 'mapped-generation-1', edgeCoverage: 'calls', files: [], symbols: [], edges: [] },
      matchingSymbols: () => [],
      release,
    } }, release }),
    dispose: () => {},
  }
  await engine.queryBatch({ type: 'symbols', generation: 'mapped-generation-1' })

  await engine.dispose()

  assert.equal(releases, 1)
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

test('mapped-cache regression: a comment-only delta reuses the complete query page without re-encoding it on first refs', async () => {
  const root = fixture()
  const adapter = new EngineFakeMmapAdapter()
  const engine = trackedEngine(root, { mmapQueryCache: { adapter, capacityBytes: 65536 } })
  const built = await engine.build()
  const before = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: built.generation })
  adapter.flushes = 0
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a() } // comment only\n")

  const changed = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  await changed.validation
  const flushesAfterPublication = adapter.flushes
  const after = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: changed.generation })

  assert.deepEqual({
    generationAdvanced: changed.generation !== built.generation,
    publicationCacheUpdated: flushesAfterPublication > 0,
    firstRefsAddedFlushes: adapter.flushes - flushesAfterPublication,
    before: before.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })),
    after: after.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })),
  }, {
    generationAdvanced: true,
    publicationCacheUpdated: true,
    firstRefsAddedFlushes: 0,
    before: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', line: 1, call: true }],
    after: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', line: 1, call: true }],
  })
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

// Pairwise lifecycle coverage matrix (each row is its own reported test):
// first build/none/success/publication success; first build/none/rejection/source write;
// first build/advanced/malformed/manifest failure; first build/advanced/exit/CURRENT failure;
// persisted reconcile/current/success/publication success; persisted reconcile/current/rejection/manifest failure;
// persisted reconcile/advanced/malformed/source write; persisted reconcile/advanced/exit/CURRENT failure.
// Existing publication, stale-generation, worker-exit, and dispose tests cover the paired failure rows;
// the ownership tests below cover success, rejection/retry, malformed membership, and retained delta state.

test('worker ownership: a persistent clean build indexes once in the worker, retains no main workspace, and validates the next leaf as a hydrated delta', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const requests = { index: [], hydrate: [], validate: [] }
  const worker = {
    index: async (payload, onProgress) => { requests.index.push(payload); return checker.index(payload, onProgress) },
    hydrate: async (payload) => { requests.hydrate.push(payload); return checker.hydrate(payload) },
    validate: async (payload) => { requests.validate.push(payload); return checker.validate(payload) },
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }
  const persistent = trackedEngine(root, { cacheDir: '.persistent', validationWorkerFactory: () => worker })
  const local = trackedEngine(root, { cacheDir: '.local' })

  const persistentBuild = await persistent.build()
  const localBuild = await local.build()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")
  const changed = await persistent.incremental([{ type: 'change', path: 'src/b.ts' }])
  await changed.validation

  assert.deepEqual({
    indexRequests: requests.index.length,
    hydrateRequests: requests.hydrate.length,
    indexSources: requests.index[0]?.sources.map(([file]) => file),
    retainedWorkspace: persistent.workspace !== null,
    graph: canon(persistent.snapshot(persistentBuild.generation)),
    localGraph: canon(local.snapshot(localBuild.generation)),
    validationMode: changed.validationMode,
    validationFiles: changed.validatedFiles,
    validationHasBasePartitionIds: Object.hasOwn(requests.validate[0] ?? {}, 'basePartitionIds'),
    validationHasPartitionDir: Object.hasOwn(requests.validate[0] ?? {}, 'partitionDir'),
  }, {
    indexRequests: 1,
    hydrateRequests: 0,
    indexSources: ['src/a.ts', 'src/b.ts'],
    retainedWorkspace: false,
    graph: canon(local.snapshot(localBuild.generation)),
    localGraph: canon(local.snapshot(localBuild.generation)),
    validationMode: 'delta',
    validationFiles: ['src/b.ts'],
    validationHasBasePartitionIds: false,
    validationHasPartitionDir: false,
  })
})

test('shared-pool protocol: an injected retained worker cold build streams durable partitions and remains graph and query equivalent', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const protocol = { sharedPool: false, progressCallback: false, receipts: [] }
  const worker = {
    index: async (payload, onProgress) => {
      protocol.sharedPool = payload.partitionPool instanceof SharedArrayBuffer
      protocol.progressCallback = typeof onProgress === 'function'
      const result = await checker.index(payload, onProgress)
      protocol.receipts = result.partitionReceipts?.map(({ file, writer }) => ({ file, writer })) ?? []
      return result
    },
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }
  const retained = trackedEngine(root, { cacheDir: '.injected-retained', validationWorkerFactory: () => worker })
  const clean = trackedEngine(root, { cacheDir: '.injected-clean' })

  const retainedBuild = await retained.build()
  const cleanBuild = await clean.build()
  const retainedGraph = await retained.snapshot(retainedBuild.generation)
  const cleanGraph = await clean.snapshot(cleanBuild.generation)
  const rows = await retained.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: retainedBuild.generation })

  assert.deepEqual(
    {
      protocol,
      parsedFiles: retainedBuild.parsedFiles,
      graph: canon(retainedGraph),
      cleanGraph: canon(cleanGraph),
      rows: rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })),
    },
    {
      protocol: { sharedPool: true, progressCallback: true, receipts: [{ file: 'src/a.ts', writer: 'engine' }, { file: 'src/b.ts', writer: 'engine' }] },
      parsedFiles: ['src/a.ts', 'src/b.ts'],
      graph: canon(cleanGraph),
      cleanGraph: canon(cleanGraph),
      rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', line: 1, call: true }],
    },
  )
})

test('shared-pool message handoff: cold descriptors expose complete journal ranges and advance FIFO consumption', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let handoff = null
  const engine = trackedEngine(root, { cacheDir: '.cold-message-handoff', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, (progress) => {
      const metadata = new Int32Array(payload.partitionPool, 0, 1024)
      const bytes = new Uint8Array(payload.partitionPool, 4096)
      const readBefore = metadata[2]
      const completeBeforeMessage = progress.partitions.every(({ offset, length }) => new DataView(payload.partitionPool, 4096 + offset - 2, 2).getUint16(0, true) > 0 && bytes.subarray(offset, offset + length).some((byte) => byte !== 0))
      onProgress(progress)
      handoff ??= { completeBeforeMessage, countersAdvanced: metadata[2] === readBefore + progress.partitions.length }
    }),
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  const built = await engine.build()

  assert.deepEqual({ handoff, publicationMatchesBuild: engine.readGeneration().generation === built.generation }, { handoff: { completeBeforeMessage: true, countersAdvanced: true }, publicationMatchesBuild: true })
})

test('shared validation message handoff: delta descriptors expose complete journal ranges and advance FIFO consumption', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let handoff = null
  let observeValidation = false
  const engine = trackedEngine(root, { cacheDir: '.delta-message-handoff', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, (progress) => {
      if (!observeValidation) return onProgress(progress)
      const metadata = new Int32Array(payload.partitionPool, 0, 1024)
      const bytes = new Uint8Array(payload.partitionPool, 4096)
      const readBefore = metadata[2]
      const completeBeforeMessage = progress.partitions.every(({ offset, length }) => new DataView(payload.partitionPool, 4096 + offset - 2, 2).getUint16(0, true) > 0 && bytes.subarray(offset, offset + length).some((byte) => byte !== 0))
      onProgress(progress)
      handoff ??= { completeBeforeMessage, countersAdvanced: metadata[2] === readBefore + progress.partitions.length }
    }),
    referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  observeValidation = true
  const changed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+1 }\n" }])
  const validated = await changed.validation

  assert.deepEqual({ handoff, generationChanged: validated.generation !== built.generation, publicationMatchesValidation: engine.readGeneration().generation === validated.generation }, { handoff: { completeBeforeMessage: true, countersAdvanced: true }, generationChanged: true, publicationMatchesValidation: true })
})

test('shared-pool concurrency: a completed partition batch arrives before remaining parsing while publication waits for every durable receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-overlap-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  for (const suffix of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16']) fs.writeFileSync(path.join(root, 'src', `use${suffix}.ts`), `import { a } from './a'; export function use${suffix}(){ return a() }\n`)
  const checker = new SemanticCheckerWorker()
  const batchSizes = []
  let firstBatchFiles = null
  let currentAtFirstBatch = null
  let firstBatchTraversalSummary = null
  let finalTraversalSummary = null
  let receipts = []
  const retained = trackedEngine(root, { cacheDir: '.batched-retained', validationWorkerFactory: () => ({
    index: async (payload, onProgress) => {
      const result = await checker.index(payload, (progress) => {
        batchSizes.push(progress.partitions.length)
        if (firstBatchFiles === null) {
          firstBatchFiles = progress.partitions.map(({ file }) => file)
          currentAtFirstBatch = fs.existsSync(path.join(root, '.batched-retained', 'CURRENT'))
          firstBatchTraversalSummary = progress.semanticTraversalSummary
        }
        return onProgress(progress)
      })
      receipts = result.partitionReceipts.map(({ file, writer }) => ({ file, writer }))
      finalTraversalSummary = result.semanticTraversalSummary
      return result
    },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  const clean = trackedEngine(root, { cacheDir: '.batched-clean' })

  const retainedBuild = await retained.build()
  const cleanBuild = await clean.build()
  const retainedManifest = retained.readGeneration(retainedBuild.generation)
  const cleanManifest = clean.readGeneration(cleanBuild.generation)
  const rows = await retained.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: retainedBuild.generation })

  assert.deepEqual({
    boundedBatches: batchSizes.every((size) => size <= 8),
    coalescedBatch: batchSizes.some((size) => size > 1),
    firstBatchCompletedBeforeAllFiles: firstBatchFiles.length < 17,
    currentAtFirstBatch,
    firstBatchTraversalCompletedBeforeAllFiles: firstBatchTraversalSummary.completedFiles < 17 && firstBatchTraversalSummary.remainingFiles > 0,
    firstBatchMaximumTraversalsPerFile: firstBatchTraversalSummary.maximumTraversalsPerFile,
    finalTraversalSummary,
    receipts,
    parsedFiles: retainedBuild.parsedFiles,
    partitionIdsMatch: JSON.stringify(retainedManifest.partitions) === JSON.stringify(cleanManifest.partitions),
    internalIdsMatch: JSON.stringify(retainedManifest.internalPartitions) === JSON.stringify(cleanManifest.internalPartitions),
    refFiles: rows.map(({ fromSymbol }) => fromSymbol.file),
  }, {
    boundedBatches: true,
    coalescedBatch: true,
    firstBatchCompletedBeforeAllFiles: true,
    currentAtFirstBatch: false,
    firstBatchTraversalCompletedBeforeAllFiles: true,
    firstBatchMaximumTraversalsPerFile: 1,
    finalTraversalSummary: { completedFiles: 17, remainingFiles: 0, maximumTraversalsPerFile: 1 },
    receipts: [{ file: 'src/a.ts', writer: 'engine' }, { file: 'src/use01.ts', writer: 'engine' }, { file: 'src/use02.ts', writer: 'engine' }, { file: 'src/use03.ts', writer: 'engine' }, { file: 'src/use04.ts', writer: 'engine' }, { file: 'src/use05.ts', writer: 'engine' }, { file: 'src/use06.ts', writer: 'engine' }, { file: 'src/use07.ts', writer: 'engine' }, { file: 'src/use08.ts', writer: 'engine' }, { file: 'src/use09.ts', writer: 'engine' }, { file: 'src/use10.ts', writer: 'engine' }, { file: 'src/use11.ts', writer: 'engine' }, { file: 'src/use12.ts', writer: 'engine' }, { file: 'src/use13.ts', writer: 'engine' }, { file: 'src/use14.ts', writer: 'engine' }, { file: 'src/use15.ts', writer: 'engine' }, { file: 'src/use16.ts', writer: 'engine' }],
    parsedFiles: ['src/a.ts', 'src/use01.ts', 'src/use02.ts', 'src/use03.ts', 'src/use04.ts', 'src/use05.ts', 'src/use06.ts', 'src/use07.ts', 'src/use08.ts', 'src/use09.ts', 'src/use10.ts', 'src/use11.ts', 'src/use12.ts', 'src/use13.ts', 'src/use14.ts', 'src/use15.ts', 'src/use16.ts'],
    partitionIdsMatch: true,
    internalIdsMatch: true,
    refFiles: ['src/use06.ts', 'src/use16.ts', 'src/use03.ts', 'src/use12.ts', 'src/use04.ts', 'src/use09.ts', 'src/use11.ts', 'src/use05.ts', 'src/use10.ts', 'src/use01.ts', 'src/use15.ts', 'src/use14.ts', 'src/use02.ts', 'src/use13.ts', 'src/use07.ts', 'src/use08.ts'],
  })
})

test('shared validation batching: five changed files publish coalesced progress in batches of at most eight chunks before generation publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-validation-batches-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a() }\n")
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { a } from './a'; export function c(){ return a() }\n")
  fs.writeFileSync(path.join(root, 'src', 'd.ts'), "import { a } from './a'; export function d(){ return a() }\n")
  fs.writeFileSync(path.join(root, 'src', 'e.ts'), "import { a } from './a'; export function e(){ return a() }\n")
  const checker = new SemanticCheckerWorker()
  const batchSizes = []
  const publicationStates = []
  let observeValidation = false
  const engine = trackedEngine(root, { cacheDir: '.validation-batches', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, (progress) => {
      if (observeValidation) {
        batchSizes.push(progress.partitions.length)
        publicationStates.push(engine.readGeneration().generation)
      }
      return onProgress(progress)
    }),
    referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  observeValidation = true
  const changed = engine.applyChanges([
    { type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' },
    { type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+1 }\n" },
    { type: 'change', path: 'src/c.ts', source: "import { a } from './a'; export function c(){ return a()+1 }\n" },
    { type: 'change', path: 'src/d.ts', source: "import { a } from './a'; export function d(){ return a()+1 }\n" },
    { type: 'change', path: 'src/e.ts', source: "import { a } from './a'; export function e(){ return a()+1 }\n" },
  ])
  const validated = await changed.validation

  assert.deepEqual({ boundedBatches: batchSizes.every((size) => size <= 8), coalescedBatch: batchSizes.some((size) => size > 1), generationStayedOldDuringProgress: publicationStates.every((generation) => generation === built.generation), generationPublishedAfterValidation: engine.readGeneration().generation === validated.generation }, { boundedBatches: true, coalescedBatch: true, generationStayedOldDuringProgress: true, generationPublishedAfterValidation: true })
})

test('time-based shared progress: a slow small-partition sequence reports a partial batch before the slot limit and before publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-timed-progress-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), `import { a } from './a'; export function b(){ a(); let value = 0; ${'value += 1;'.repeat(4000)} return value }\n`)
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { a } from './a'; export function c(){ return a() }\n")
  const checker = new SemanticCheckerWorker()
  let firstProgress = null
  const retained = trackedEngine(root, { cacheDir: '.timed-retained', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, (progress) => {
      firstProgress ??= {
        chunkCount: progress.partitions.length,
        files: progress.partitions.map(({ file }) => file),
        currentExists: fs.existsSync(path.join(root, '.timed-retained', 'CURRENT')),
      }
      return onProgress(progress)
    }),
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  const built = await retained.build()
  const clean = trackedEngine(root, { cacheDir: '.timed-clean' })
  const cleanBuild = await clean.build()
  const retainedManifest = retained.readGeneration(built.generation)
  const cleanManifest = clean.readGeneration(cleanBuild.generation)
  const rows = await retained.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: built.generation })

  assert.deepEqual({ firstProgress: { files: firstProgress.files, currentExists: firstProgress.currentExists }, parsedFiles: built.parsedFiles, partitionIdsMatch: JSON.stringify(retainedManifest.partitions) === JSON.stringify(cleanManifest.partitions), internalIdsMatch: JSON.stringify(retainedManifest.internalPartitions) === JSON.stringify(cleanManifest.internalPartitions), refFiles: rows.map(({ fromSymbol }) => fromSymbol.file).sort() }, {
    firstProgress: { files: ['src/a.ts'], currentExists: false },
    parsedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    partitionIdsMatch: true,
    internalIdsMatch: true,
    refFiles: ['src/b.ts', 'src/c.ts'],
  })
})

test('shared-pool boundary: an oversized partition crosses the 64 KiB boundary without falling back to worker persistence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oversized-shared-partition-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), `import { a } from './a'; export function b(){ a(); let value = 0; ${'value += 1;'.repeat(4000)} return value }\n`)
  const checker = new SemanticCheckerWorker()
  let oversizedReceipt = null
  const retained = trackedEngine(root, { cacheDir: '.oversized-retained', validationWorkerFactory: () => ({
    index: async (payload, onProgress) => {
      const result = await checker.index(payload, onProgress)
      oversizedReceipt = result.partitionReceipts.find(({ file }) => file === 'src/b.ts')
      return result
    },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  const clean = trackedEngine(root, { cacheDir: '.oversized-clean' })

  const retainedBuild = await retained.build()
  const cleanBuild = await clean.build()
  const retainedManifest = retained.readGeneration(retainedBuild.generation)
  const cleanManifest = clean.readGeneration(cleanBuild.generation)
  const rows = await retained.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: retainedBuild.generation })

  assert.deepEqual({
    crossed64KiB: oversizedReceipt.serializedLength > 65536,
    transportWriter: oversizedReceipt.writer,
    partitionIdMatches: retainedManifest.partitions['src/b.ts'] === cleanManifest.partitions['src/b.ts'],
    internalIdMatches: retainedManifest.internalPartitions['src/b.ts'] === cleanManifest.internalPartitions['src/b.ts'],
    rows: rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })),
  }, {
    crossed64KiB: true,
    transportWriter: 'engine',
    partitionIdMatches: true,
    internalIdMatches: true,
    rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', line: 1, call: true }],
  })
})

test('shared-pool boundary: a small partition retains the existing engine-owned fast path', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let smallReceipts = null
  const engine = trackedEngine(root, { cacheDir: '.small-shared-partition', validationWorkerFactory: () => ({
    index: async (payload, onProgress) => {
      const result = await checker.index(payload, onProgress)
      smallReceipts = result.partitionReceipts.map(({ file, writer, serializedLength }) => ({ file, writer, serializedLength }))
      return result
    },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  await engine.build()

  assert.deepEqual(smallReceipts.map(({ file, writer, serializedLength }) => ({ file, below64KiB: serializedLength < 65536, writer })), [{ file: 'src/a.ts', below64KiB: true, writer: 'engine' }, { file: 'src/b.ts', below64KiB: true, writer: 'engine' }])
})

test('shared delta transport: a gated one-file validation streams an engine-owned receipt and publishes only after commit', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let releaseValidation
  let protocol = null
  const engine = trackedEngine(root, { cacheDir: '.shared-delta-small', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: async (payload, onProgress) => {
      const result = await checker.validate(payload, onProgress)
      protocol = {
        sharedPool: payload.partitionPool instanceof SharedArrayBuffer,
        progressCallback: typeof onProgress === 'function',
        returnedPartitions: Object.hasOwn(result, 'partitions'),
        receipts: result.partitionReceipts?.map(({ file, writer }) => ({ file, writer })) ?? null,
      }
      await new Promise((resolve) => { releaseValidation = resolve })
      return result
    },
    referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  const changed = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: "import { a } from './a'; export function b(){ return a()+1 }\n" }])
  while (!releaseValidation) await new Promise((resolve) => setImmediate(resolve))
  const generationWhilePrepared = engine.readGeneration().generation
  releaseValidation()
  const validated = await changed.validation
  const rows = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: validated.generation })

  assert.deepEqual({ protocol, generationWhilePrepared, originalGeneration: built.generation, rows: rows.map(({ fromSymbol, toSymbol, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, call })) }, {
    protocol: { sharedPool: true, progressCallback: true, returnedPartitions: false, receipts: [{ file: 'src/b.ts', writer: 'engine' }] },
    generationWhilePrepared: built.generation,
    originalGeneration: built.generation,
    rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', call: true }],
  })
})

test('hotpath contract: a hydrated one-file change sends and publishes only its sparse semantic delta', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const changedSource = "import { a } from './a'; export function b(){ return a()+1 }\n"
  const changedHash = contentHash(changedSource)
  const expectedDigest = contentHash(`src/b.ts\0${changedSource}`)
  const workCounters = {
    sourceMembershipCopied: 0,
    basePartitionsOpened: 0,
    changedPartitionsWritten: 1,
    dependentSourcesRead: 0,
    repositoryRecordsMaterialized: 0,
    repositorySizedContainersAllocated: 0,
  }
  let request
  let workerReceipt
  const engine = trackedEngine(root, { cacheDir: '.sparse-semantic-delta', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: async (payload, onProgress) => {
      request = payload
      const result = await checker.validate(payload, onProgress)
      workerReceipt = {
        revision: result.revision,
        mode: result.mode,
        baseGeneration: result.baseGeneration,
        sourceBlobs: { 'src/b.ts': result.sourceBlobs['src/b.ts'] },
        partitionReceipts: result.partitionReceipts,
        tombstones: result.tombstones ?? [],
        edgePatches: result.edgePatches ?? [],
        workCounters: result.workCounters,
      }
      return workerReceipt
    },
    advanceGeneration: (...args) => checker.advanceGeneration(...args),
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()

  const submitted = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: changedSource }])
  const published = await submitted.validation
  const { partitionPool, partitionPoolDebugId, ...requestFields } = request

  assert.deepEqual({
    request: requestFields,
    requestUsesSharedPartitionPool: partitionPool instanceof SharedArrayBuffer,
    requestDebugIdType: partitionPoolDebugId === undefined ? 'absent' : typeof partitionPoolDebugId,
    workerReceipt: {
      revision: workerReceipt.revision,
      mode: workerReceipt.mode,
      baseGeneration: workerReceipt.baseGeneration,
      sourceBlobs: workerReceipt.sourceBlobs,
      partitionFiles: workerReceipt.partitionReceipts.map(({ file }) => file),
      tombstones: workerReceipt.tombstones,
      edgePatches: workerReceipt.edgePatches,
      workCounters: workerReceipt.workCounters,
    },
    published: {
      parsedFiles: published.parsedFiles,
      validatedFiles: published.validatedFiles,
      workCounters: published.workCounters,
    },
  }, {
    request: {
      revision: 1,
      root,
      cacheDir: '.sparse-semantic-delta',
      baseGeneration: built.generation,
      changes: [{ type: 'change', path: 'src/b.ts', source: changedSource, expectedDigest }],
      sourceDir: path.join(root, '.sparse-semantic-delta', 'sources'),
    },
    requestUsesSharedPartitionPool: true,
    requestDebugIdType: 'absent',
    workerReceipt: {
      revision: 1,
      mode: 'delta',
      baseGeneration: built.generation,
      sourceBlobs: { 'src/b.ts': changedHash },
      partitionFiles: ['src/b.ts'],
      tombstones: [],
      edgePatches: [],
      workCounters,
    },
    published: {
      parsedFiles: ['src/b.ts'],
      validatedFiles: ['src/b.ts'],
      workCounters,
    },
  })
})

test('error guessing: two sequential hydrated one-file changes advance the worker generation without widening either sparse request', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  const firstSource = "import { a } from './a'; export function b(){ return a()+1 }\n"
  const secondSource = "import { a } from './a'; export function b(){ return a()+2 }\n"
  const requests = []
  const engine = trackedEngine(root, { cacheDir: '.sequential-sparse-semantic-delta', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => { requests.push(payload); return checker.validate(payload, onProgress) },
    advanceGeneration: (...args) => checker.advanceGeneration(...args),
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()

  const firstSubmitted = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: firstSource }])
  const firstPublished = await firstSubmitted.validation
  const secondSubmitted = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: secondSource }])
  const secondPublished = await secondSubmitted.validation
  const { partitionPool: firstPool, partitionPoolDebugId: firstDebugId, ...firstRequest } = requests[0]
  const { partitionPool: secondPool, partitionPoolDebugId: secondDebugId, ...secondRequest } = requests[1]

  assert.deepEqual({
    firstRequest,
    secondRequest,
    pools: [firstPool instanceof SharedArrayBuffer, secondPool instanceof SharedArrayBuffer],
    debugIds: [firstDebugId === undefined, secondDebugId === undefined],
    published: [
      { parsedFiles: firstPublished.parsedFiles, validatedFiles: firstPublished.validatedFiles, workCounters: firstPublished.workCounters },
      { parsedFiles: secondPublished.parsedFiles, validatedFiles: secondPublished.validatedFiles, workCounters: secondPublished.workCounters },
    ],
  }, {
    firstRequest: {
      revision: 1,
      root,
      cacheDir: '.sequential-sparse-semantic-delta',
      baseGeneration: built.generation,
      changes: [{ type: 'change', path: 'src/b.ts', source: firstSource, expectedDigest: 'ff4af09b9988388eca704b188fa6fb52f3936d565c9eb509434f50afbc7b7683' }],
      sourceDir: path.join(root, '.sequential-sparse-semantic-delta', 'sources'),
    },
    secondRequest: {
      revision: 2,
      root,
      cacheDir: '.sequential-sparse-semantic-delta',
      baseGeneration: firstPublished.generation,
      changes: [{ type: 'change', path: 'src/b.ts', source: secondSource, expectedDigest: '53596b5ee4a853889fde217c6198b2960e9b37e5ccf93f5e47e30ad6f0c4df4a' }],
      sourceDir: path.join(root, '.sequential-sparse-semantic-delta', 'sources'),
    },
    pools: [true, true],
    debugIds: [true, true],
    published: [
      { parsedFiles: ['src/b.ts'], validatedFiles: ['src/b.ts'], workCounters: { sourceMembershipCopied: 0, basePartitionsOpened: 0, changedPartitionsWritten: 1, dependentSourcesRead: 0, repositoryRecordsMaterialized: 0, repositorySizedContainersAllocated: 0 } },
      { parsedFiles: ['src/b.ts'], validatedFiles: ['src/b.ts'], workCounters: { sourceMembershipCopied: 0, basePartitionsOpened: 0, changedPartitionsWritten: 1, dependentSourcesRead: 0, repositoryRecordsMaterialized: 0, repositorySizedContainersAllocated: 0 } },
    ],
  })
})

test('compatibility: publishing a version-3 generation writes only its manifest advances CURRENT and remains readable', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { cacheDir: '.generation-v3-publication' })
  const built = await engine.build()
  const complete = engine.readGeneration(built.generation)

  const published = engine.store.publish({ ...complete, version: 3 })
  const manifestPath = path.join(engine.store.generations, `${published.generation}.json`)
  const summaryPath = path.join(engine.store.generations, `${published.generation}.summary`)
  const read = engine.store.readGeneration()

  assert.deepEqual({
    manifestExists: fs.existsSync(manifestPath),
    manifestGeneration: JSON.parse(fs.readFileSync(manifestPath, 'utf8')).generation,
    summaryExists: fs.existsSync(summaryPath),
    currentFile: fs.readFileSync(path.join(root, '.generation-v3-publication', 'CURRENT'), 'utf8'),
    currentRead: read.generation,
    currentVersion: read.version,
  }, {
    manifestExists: true,
    manifestGeneration: published.generation,
    summaryExists: false,
    currentFile: published.generation,
    currentRead: published.generation,
    currentVersion: 3,
  })
})

test('shared delta boundary: an oversized validation uses one variable journal record and matches clean partition internal and query output', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let protocol = null
  const engine = trackedEngine(root, { cacheDir: '.shared-delta-oversized', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: async (payload, onProgress) => {
      const result = await checker.validate(payload, onProgress)
      const receipt = result.partitionReceipts?.find(({ file }) => file === 'src/b.ts')
      protocol = { sharedPool: payload.partitionPool instanceof SharedArrayBuffer, progressCallback: typeof onProgress === 'function', returnedPartitions: Object.hasOwn(result, 'partitions'), writer: receipt?.writer, chunkCount: receipt?.chunkCount }
      return result
    },
    referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  await engine.build()
  const source = `import { a } from './a'; export function b(){ a(); let value = 0; ${'value += 1;'.repeat(4000)} return value }\n`
  const submitted = await engine.incremental([{ type: 'change', path: 'src/b.ts', source }])
  const changed = await submitted.validation
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), source)
  const clean = trackedEngine(root, { cacheDir: '.shared-delta-oversized-clean' })
  const cleanBuild = await clean.build()
  const actualManifest = engine.readGeneration(changed.generation)
  const cleanManifest = clean.readGeneration(cleanBuild.generation)
  const rows = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: changed.generation })

  assert.deepEqual({
    protocol: { sharedPool: protocol?.sharedPool, progressCallback: protocol?.progressCallback, returnedPartitions: protocol?.returnedPartitions, writer: protocol?.writer, multipleChunks: protocol?.chunkCount > 1 },
    partitionIdMatches: actualManifest.partitions['src/b.ts'] === cleanManifest.partitions['src/b.ts'],
    internalIdMatches: actualManifest.internalPartitions['src/b.ts'] === cleanManifest.internalPartitions['src/b.ts'],
    rows: rows.map(({ fromSymbol, toSymbol, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, call })),
  }, {
    protocol: { sharedPool: true, progressCallback: true, returnedPartitions: false, writer: 'engine', multipleChunks: false },
    partitionIdMatches: true,
    internalIdMatches: true,
    rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', call: true }],
  })
})

test('shared delta persistence: validated transport bytes are persisted once without object re-encoding before atomic publication', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { cacheDir: '.delta-byte-persist' })
  const built = await engine.build()
  const Store = engine.store.constructor
  const writePartition = Store.prototype.writePartition
  const writePartitionBytes = Store.prototype.writePackedPartitionRange
  let objectWrites = 0
  let byteWrites = 0
  let currentDuringByteWrite = null
  Store.prototype.writePartition = function (...args) { objectWrites += 1; return writePartition.apply(this, args) }
  Store.prototype.writePackedPartitionRange = function (...args) {
    byteWrites += 1
    currentDuringByteWrite = this.readGeneration().generation
    return writePartitionBytes.apply(this, args)
  }
  const source = "import { a } from './a'; export function b(){ return a()+7 }\n"
  let changed
  try {
    const submitted = await engine.incremental([{ type: 'change', path: 'src/b.ts', source }])
    changed = await submitted.validation
  } finally {
    Store.prototype.writePartition = writePartition
    Store.prototype.writePackedPartitionRange = writePartitionBytes
  }
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), source)
  const clean = trackedEngine(root, { cacheDir: '.delta-byte-persist-clean' })
  const cleanBuild = await clean.build()
  const changedManifest = engine.readGeneration(changed.generation)
  const cleanManifest = clean.readGeneration(cleanBuild.generation)
  const changedBytes = fs.readFileSync(path.join(root, '.delta-byte-persist', 'partitions', `${changedManifest.partitions['src/b.ts']}.bin`))
  const cleanBytes = fs.readFileSync(path.join(root, '.delta-byte-persist-clean', 'partitions', `${cleanManifest.partitions['src/b.ts']}.bin`))

  assert.deepEqual({ objectWrites, byteWrites, currentDuringByteWrite, originalGeneration: built.generation, publishedGeneration: engine.readGeneration().generation, changedGeneration: changed.generation, partitionIdMatches: changedManifest.partitions['src/b.ts'] === cleanManifest.partitions['src/b.ts'], partitionBytesMatch: changedBytes.equals(cleanBytes), internalIdMatches: changedManifest.internalPartitions['src/b.ts'] === cleanManifest.internalPartitions['src/b.ts'] }, {
    objectWrites: 0,
    byteWrites: 1,
    currentDuringByteWrite: built.generation,
    originalGeneration: built.generation,
    publishedGeneration: changed.generation,
    changedGeneration: changed.generation,
    partitionIdMatches: true,
    partitionBytesMatch: true,
    internalIdMatches: true,
  })
})

test('worker ownership: persistent reconcile hydrates exactly once and the first edit uses the adopted worker state', async () => {
  const root = fixture()
  const builder = trackedEngine(root, { cacheDir: '.persisted' })
  await builder.build()
  await builder.dispose()
  const checker = new SemanticCheckerWorker()
  const requests = { index: 0, hydrate: [], validate: [] }
  const worker = {
    index: async (payload) => { requests.index += 1; return checker.index(payload) },
    hydrate: async (payload) => { requests.hydrate.push(payload); return checker.hydrate(payload) },
    validate: async (payload) => { requests.validate.push(payload); return checker.validate(payload) },
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }
  const engine = trackedEngine(root, { cacheDir: '.persisted', validationWorkerFactory: () => worker })

  const reconciled = await engine.reconcile()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+3 }\n")
  const changed = await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  await changed.validation

  assert.deepEqual({ indexRequests: requests.index, hydrateRequests: requests.hydrate.length, hydrateSources: requests.hydrate[0]?.sources.map(([file]) => file), retainedWorkspace: engine.workspace !== null, reusedFiles: reconciled.reusedFiles, validationMode: changed.validationMode, validationFiles: changed.validatedFiles, validationHasBasePartitionIds: Object.hasOwn(requests.validate[0] ?? {}, 'basePartitionIds') }, { indexRequests: 0, hydrateRequests: 1, hydrateSources: ['src/a.ts', 'src/b.ts'], retainedWorkspace: false, reusedFiles: ['src/a.ts', 'src/b.ts'], validationMode: 'delta', validationFiles: ['src/b.ts'], validationHasBasePartitionIds: false })
})

test('worker ownership boundary: a default short-lived engine never calls worker index or hydrate', async () => {
  const root = fixture()
  let indexRequests = 0
  let hydrateRequests = 0
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ index: async () => { indexRequests += 1; throw new Error('unexpected index') }, hydrate: async () => { hydrateRequests += 1; throw new Error('unexpected hydrate') }, validate: async () => { throw new Error('unexpected validate') }, dispose: async () => {} }) })

  const built = await engine.build()
  const reconciled = await engine.reconcile()

  assert.deepEqual({ indexRequests, hydrateRequests, buildFiles: Object.keys(engine.readGeneration(built.generation).sources), reconciledGeneration: reconciled.generation, retainedWorkspace: engine.workspace !== null }, { indexRequests: 0, hydrateRequests: 0, buildFiles: ['src/a.ts', 'src/b.ts'], reconciledGeneration: built.generation, retainedWorkspace: true })
})

test('worker ownership error guessing: a rejected first index preserves absent CURRENT and a retry starts a fresh successful index', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let attempts = 0
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: async (payload, onProgress) => { attempts += 1; if (attempts === 1) throw new Error('worker index rejected'); return checker.index(payload, onProgress) },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  await assert.rejects(engine.build(), /worker index rejected/)
  const currentAfterFailure = fs.existsSync(path.join(root, '.codegraph', 'CURRENT'))
  const built = await engine.build()

  assert.deepEqual({ attempts, currentAfterFailure, currentAfterRetry: engine.readGeneration().generation, builtGeneration: built.generation, retainedWorkspace: engine.workspace !== null }, { attempts: 2, currentAfterFailure: false, currentAfterRetry: built.generation, builtGeneration: built.generation, retainedWorkspace: false })
})

test('worker ownership equivalence partition: malformed index source membership cannot publish CURRENT', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ index: async () => ({ mode: 'full', sourceBlobs: {}, partitions: {} }), dispose: async () => {} }) })

  await assert.rejects(engine.build(), /membership|source|malformed/i)

  assert.equal(fs.existsSync(path.join(root, '.codegraph', 'CURRENT')), false)
})

test('worker ownership durability: an existing wrong-file worker receipt cannot publish a cold mixed-ownership generation', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let engine
  engine = trackedEngine(root, { cacheDir: '.wrong-worker-receipt', validationWorkerFactory: () => ({
    index: async (payload, onProgress) => {
      const result = await checker.index(payload, (progress) => {
        const mainChunks = progress.chunks.filter(({ file }) => file === 'src/a.ts')
        const rejectedChunks = progress.chunks.filter(({ file }) => file === 'src/b.ts')
        if (mainChunks.length) onProgress({ ...progress, chunks: mainChunks })
        for (const { slot } of rejectedChunks) {
          const metadata = new Int32Array(payload.partitionPool, 0, 1024)
          const boundary = Atomics.load(metadata, 3)
          Atomics.store(metadata, 4 + boundary, slot)
          Atomics.store(metadata, 304 + slot, 0)
          Atomics.store(metadata, 3, boundary + 1)
          Atomics.add(metadata, 1, 1)
          Atomics.notify(metadata, 1, 1)
        }
      })
      const partitionId = fs.readdirSync(engine.store.partitions).find((name) => name.endsWith('.json')).slice(0, -5)
      const internalPartitionId = fs.readdirSync(engine.store.internalPartitions).find((name) => name.endsWith('.bin')).slice(0, -4)
      result.partitionReceipts = result.partitionReceipts.map((receipt) => receipt.file === 'src/b.ts' ? { ...receipt, writer: 'worker', partitionId, internalPartitionId, chunkCount: 0, symbolChunkCount: 0, internalChunkCount: 0 } : receipt)
      return result
    },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  const outcome = await engine.build().then(() => ({ rejected: false, durableMismatch: false }), (error) => ({ rejected: true, durableMismatch: /file|source|fingerprint|receipt|durable|mismatch/i.test(error.message) }))

  assert.deepEqual({ outcome, currentExists: fs.existsSync(path.join(root, '.wrong-worker-receipt', 'CURRENT')) }, { outcome: { rejected: true, durableMismatch: true }, currentExists: false })
})

test('worker protocol boundary: an unknown request type rejects instead of falling through to validation', async () => {
  const worker = new Worker(new URL('../semantic-checker-worker.mjs', import.meta.url), { workerData: { semanticChecker: true } })
  const response = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  worker.postMessage({ id: 91, type: 'not-a-semantic-operation', payload: {} })

  const message = await response
  await worker.terminate()

  assert.deepEqual({ id: message.id, hasResult: Object.hasOwn(message, 'result'), errorMatches: /unknown|unsupported/i.test(message.error?.message ?? message.error ?? '') }, { id: 91, hasResult: false, errorMatches: true })
})

test('worker index boundary: an empty project returns exact empty source and partition membership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-index-empty-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  const checker = new SemanticCheckerWorker()
  let result
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: async (payload, onProgress) => { result = await checker.index(payload, onProgress); return result },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  const built = await engine.build()

  assert.deepEqual({ mode: result.mode, sourceBlobs: result.sourceBlobs, receipts: result.partitionReceipts, parsedFiles: built.parsedFiles }, { mode: 'full', sourceBlobs: {}, receipts: [], parsedFiles: [] })
})

test('shared transport exhaustion: a full pool completes with non-overlapping worker persistence and atomic clean-build parity', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-full-pool-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  for (let value = 1; value <= 301; value += 1) fs.writeFileSync(path.join(root, 'src', `f${String(value).padStart(3, '0')}.ts`), `export const f${String(value).padStart(3, '0')} = ${value}\n`)
  const checker = new SemanticCheckerWorker()
  const heldProgress = []
  let forwarding = false
  let workerCompletedBeforeRestore = false
  let currentBeforeRestore = null
  let receipts = []
  let engine
  engine = trackedEngine(root, { cacheDir: '.full-pool-retained', validationWorkerFactory: () => ({
    index: async (payload, onProgress) => {
      const request = checker.index(payload, (progress) => forwarding ? onProgress(progress) : heldProgress.push(progress))
      let expired = false
      let expire
      const deadline = new Promise((resolve) => { expire = setTimeout(() => { expired = true; resolve(null) }, 10_000) })
      const early = await Promise.race([request, deadline])
      clearTimeout(expire)
      workerCompletedBeforeRestore = !expired
      currentBeforeRestore = fs.existsSync(path.join(root, '.full-pool-retained', 'CURRENT'))
      forwarding = true
      for (const progress of heldProgress) onProgress(progress)
      const result = early ?? await request
      receipts = result.partitionReceipts
      return result
    },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })
  const writePartitionBytes = engine.store.writePackedPartitionRange.bind(engine.store)
  const mainWriteIds = []
  engine.store.writePackedPartitionRange = (...args) => { const id = writePartitionBytes(...args); mainWriteIds.push(id); return id }

  const built = await engine.build()
  const clean = trackedEngine(root, { cacheDir: '.full-pool-clean' })
  const cleanBuild = await clean.build()
  const manifest = engine.readGeneration(built.generation)
  const cleanManifest = clean.readGeneration(cleanBuild.generation)
  const rows = await engine.queryBatch({ type: 'symbols', name: 'f301', generation: built.generation })
  const cleanRows = await clean.queryBatch({ type: 'symbols', name: 'f301', generation: cleanBuild.generation })
  const workerReceiptIds = receipts.filter(({ writer }) => writer === 'worker').map(({ partitionId }) => partitionId)

  assert.deepEqual({ workerCompletedBeforeRestore, multipleProgressBatchesBeforeRestore: heldProgress.length > 1, currentBeforeRestore, receiptCount: receipts.length, receiptWriters: [...new Set(receipts.map(({ writer }) => writer))].sort(), duplicateMainWrites: mainWriteIds.length !== new Set(mainWriteIds).size, mainRewroteWorkerPartition: workerReceiptIds.some((id) => mainWriteIds.includes(id)), publishedGeneration: engine.readGeneration().generation, builtGeneration: built.generation, partitionIdsMatch: JSON.stringify(manifest.partitions) === JSON.stringify(cleanManifest.partitions), internalIdsMatch: JSON.stringify(manifest.internalPartitions) === JSON.stringify(cleanManifest.internalPartitions), rows, cleanRows }, {
    workerCompletedBeforeRestore: true,
    multipleProgressBatchesBeforeRestore: true,
    currentBeforeRestore: false,
    receiptCount: 301,
    receiptWriters: ['engine', 'worker'],
    duplicateMainWrites: false,
    mainRewroteWorkerPartition: false,
    publishedGeneration: built.generation,
    builtGeneration: built.generation,
    partitionIdsMatch: true,
    internalIdsMatch: true,
    rows: cleanRows,
    cleanRows,
  })
})

test('worker index boundary: a one-file project returns that exact source and partition membership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-index-one-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  fs.mkdirSync(path.join(root, 'src'))
  const source = 'export const one = 1\n'
  fs.writeFileSync(path.join(root, 'src', 'one.ts'), source)
  const hash = contentHash(source)
  const checker = new SemanticCheckerWorker()
  let result
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: async (payload, onProgress) => { result = await checker.index(payload, onProgress); return result },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  const built = await engine.build()

  assert.deepEqual({ mode: result.mode, sourceFiles: Object.keys(result.sourceBlobs), sourceHash: result.sourceBlobs['src/one.ts'], receiptFiles: result.partitionReceipts.map(({ file }) => file), parsedFiles: built.parsedFiles, graphFiles: engine.snapshot().files }, { mode: 'full', sourceFiles: ['src/one.ts'], sourceHash: hash, receiptFiles: ['src/one.ts'], parsedFiles: ['src/one.ts'], graphFiles: ['src/one.ts'] })
})

test('worker index boundary: many files preserve exact source and partition membership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-index-many-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  fs.mkdirSync(path.join(root, 'src'))
  const a = 'export function a(){ return 1 }\n'
  const b = "import { a } from './a'; export function b(){ return a() }\n"
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), a)
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), b)
  const checker = new SemanticCheckerWorker()
  let result
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: async (payload, onProgress) => { result = await checker.index(payload, onProgress); return result },
    hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose(),
  }) })

  const built = await engine.build()

  assert.deepEqual({ sourceFiles: Object.keys(result.sourceBlobs), receiptFiles: result.partitionReceipts.map(({ file }) => file), parsedFiles: built.parsedFiles, graphFiles: engine.snapshot().files, edgeCount: engine.snapshot().edges.length }, { sourceFiles: ['src/a.ts', 'src/b.ts'], receiptFiles: ['src/a.ts', 'src/b.ts'], parsedFiles: ['src/a.ts', 'src/b.ts'], graphFiles: ['src/a.ts', 'src/b.ts'], edgeCount: 1 })
})

test('worker index invalid partition: duplicate source membership rejects before readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-index-duplicate-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  const source = 'export const a = 1\n'
  const worker = new SemanticCheckerWorker()

  await assert.rejects(worker.index({ root, sources: [['a.ts', source], ['a.ts', source]], sourceBlobs: { 'a.ts': contentHash(source) } }), /duplicate|membership/i)
  await worker.dispose()
})

test('worker hydrate invalid partition: a partition source hash mismatch rejects before readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-hydrate-mismatch-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  const source = 'export const a = 1\n'
  const worker = new SemanticCheckerWorker()

  await assert.rejects(worker.hydrate({ root, sources: [['a.ts', source]], sourceBlobs: { 'a.ts': contentHash(source) }, partitions: { 'a.ts': { file: 'a.ts', sourceHash: '0'.repeat(64), symbols: [], edges: [], dependencies: [], unresolved: [] } } }), /hash|partition|mismatch/i)
  await worker.dispose()
})

test('worker ownership atomicity: a prepared index is invisible until publication and a failed publish forces a fresh worker index', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let releaseIndex
  let indexRequests = 0
  let overlayRequests = 0
  const worker = {
    index: async (payload, onProgress) => {
      indexRequests += 1
      if (indexRequests === 1) await new Promise((resolve) => { releaseIndex = resolve })
      return checker.index(payload, onProgress)
    },
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: async (payload) => { overlayRequests += 1; return checker.referenceOverlay(payload) },
    dispose: () => checker.dispose(),
  }
  const engine = trackedEngine(root, { validationWorkerFactory: () => worker })
  const publish = engine.store.publish.bind(engine.store)
  engine.store.publish = () => { throw new Error('CURRENT publication failed') }

  const firstBuild = engine.build()
  while (!releaseIndex) await new Promise((resolve) => setImmediate(resolve))
  const concurrentQuery = engine.queryBatch({ type: 'refs', name: 'a', resolved: true }).then(() => 'published', () => 'unavailable')
  releaseIndex()
  await assert.rejects(firstBuild, /publication failed/)
  const queryWhilePrepared = await concurrentQuery
  const currentAfterFailure = fs.existsSync(path.join(root, '.codegraph', 'CURRENT'))
  engine.store.publish = publish

  const built = await engine.build()
  const rows = await engine.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: built.generation })

  assert.deepEqual({ queryWhilePrepared, currentAfterFailure, indexRequests, overlayRequests, rows: rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })), mainThreadWorkspaceAbsent: engine.workspace === undefined }, { queryWhilePrepared: 'unavailable', currentAfterFailure: false, indexRequests: 2, overlayRequests: 0, rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', line: 1, call: true }], mainThreadWorkspaceAbsent: true })
})

test('worker ownership recovery: failed persisted hydration preserves CURRENT and read queries then retries hydration without a main workspace', async () => {
  const root = fixture()
  const builder = trackedEngine(root, { cacheDir: '.hydrate-retry' })
  const built = await builder.build()
  const currentPath = path.join(root, '.hydrate-retry', 'CURRENT')
  const currentBefore = fs.readFileSync(currentPath)
  await builder.dispose()
  const checker = new SemanticCheckerWorker()
  let hydrateRequests = 0
  const worker = {
    index: (payload) => checker.index(payload),
    hydrate: async (payload) => { hydrateRequests += 1; if (hydrateRequests === 1) throw new Error('worker hydrate rejected'); return checker.hydrate(payload) },
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }
  const engine = trackedEngine(root, { cacheDir: '.hydrate-retry', validationWorkerFactory: () => worker })

  await assert.rejects(engine.reconcile(), /hydrate rejected/)
  const rowsAfterFailure = await engine.queryBatch({ type: 'symbols', name: 'a', generation: built.generation })
  const currentAfterFailure = fs.readFileSync(currentPath)
  const retried = await engine.reconcile()

  assert.deepEqual({ hydrateRequests, currentUnchanged: currentAfterFailure.equals(currentBefore), rowsAfterFailure: rowsAfterFailure.map(({ name, file, line }) => ({ name, file, line })), retryGeneration: retried.generation, retainedWorkspace: engine.workspace !== null }, { hydrateRequests: 2, currentUnchanged: true, rowsAfterFailure: [{ name: 'a', file: 'src/a.ts', line: 1 }], retryGeneration: built.generation, retainedWorkspace: false })
})

test('worker ownership storage boundary: a fresh persistent build never rereads partitions returned by worker index', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let partitionReads = 0
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({ index: (payload, onProgress) => checker.index(payload, onProgress), hydrate: (payload) => checker.hydrate(payload), validate: (payload, onProgress) => checker.validate(payload, onProgress), referenceOverlay: (payload) => checker.referenceOverlay(payload), dispose: () => checker.dispose() }) })
  const readPartition = engine.store.readPartition.bind(engine.store)
  engine.store.readPartition = (...args) => { partitionReads += 1; return readPartition(...args) }

  const built = await engine.build()

  assert.deepEqual({ partitionReads, generation: engine.readGeneration().generation, builtGeneration: built.generation, retainedWorkspace: engine.workspace !== null }, { partitionReads: 0, generation: built.generation, builtGeneration: built.generation, retainedWorkspace: false })
})

test('internal publication contract: one validated generation atomically identifies symbol and internal partitions for every file', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const built = await engine.build()
  const manifest = engine.readGeneration(built.generation)
  assert.deepEqual(Object.keys(manifest.internalPartitions).sort(), Object.keys(manifest.partitions).sort())
})

test('internal reuse contract: a no-change reconcile preserves each content-addressed internal partition ID', async () => {
  const root = fixture()
  const engine = trackedEngine(root)
  const first = await engine.build()
  const before = engine.readGeneration(first.generation).internalPartitions
  const second = await engine.reconcile()
  const after = engine.readGeneration(second.generation).internalPartitions
  assert.deepEqual(after, before)
})

test('changed-only validation reuses every dependent internal partition and builds only the changed source CFG', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export function c(){ return b() }\n")
  fs.writeFileSync(path.join(root, 'src', 'd.ts'), "import { c } from './c'; export function d(){ return c() }\n")
  fs.writeFileSync(path.join(root, 'src', 'e.ts'), "import { d } from './d'; export function e(){ return d() }\n")
  const checker = new SemanticCheckerWorker()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  const before = engine.readGeneration(built.generation)

  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "export function a(){ const value = 2; return value }\n")
  const result = await engine.reconcile()
  const clean = trackedEngine(root, { cacheDir: '.clean-unchanged-export-surface' })
  await clean.build()

  assert.deepEqual(
    {
      validationMode: result.validationMode,
      validatedFiles: result.validatedFiles,
      internalBuildCount: result.internalBuildCount,
      internalRebuiltFiles: result.internalRebuiltFiles,
      internalReusedFiles: result.internalReusedFiles,
      dependentInternalPartitionsRetained: ['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'].map((file) => engine.readGeneration().internalPartitions[file] === before.internalPartitions[file]),
      graph: canon(engine.snapshot()),
    },
    {
      validationMode: 'delta',
      validatedFiles: ['src/a.ts'],
      internalBuildCount: 1,
      internalRebuiltFiles: ['src/a.ts'],
      internalReusedFiles: [],
      dependentInternalPartitionsRetained: [true, true, true, true],
      graph: canon(clean.snapshot()),
    },
  )
})

test('domain analysis: a body edit changing an inferred exported return type validates only the changed file', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b'; export function c(){ return b() }\n")
  const checker = new SemanticCheckerWorker()
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: (payload, onProgress) => checker.validate(payload, onProgress),
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  const before = engine.readGeneration(built.generation)
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "export function a(){ return 'one' }\n")

  const result = await engine.reconcile()
  await result.validation

  assert.deepEqual(
    {
      validatedFiles: result.validatedFiles,
      retainedDependentPartitions: ['src/b.ts', 'src/c.ts'].map((file) => engine.readGeneration().partitions[file] === before.partitions[file]),
    },
    {
      validatedFiles: ['src/a.ts'],
      retainedDependentPartitions: [true, true],
    },
  )
})

test('removing an exported symbol rebuilds only its owner and retains the importer as a dangling edge', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let traversalSummary = null
  const engine = trackedEngine(root, { validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: async (payload, onProgress) => {
      const result = await checker.validate(payload, onProgress)
      traversalSummary = result.semanticTraversalSummary
      return result
    },
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  const beforeManifest = engine.readGeneration(built.generation)
  const before = beforeManifest.internalPartitions
  const missingTargetId = engine.snapshot().symbols.find(({ file, name }) => file === 'src/a.ts' && name === 'a').id
  const importerId = engine.snapshot().symbols.find(({ file, name }) => file === 'src/b.ts' && name === 'b').id

  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function renamed(){ return 1 }\n')
  const result = await engine.reconcile()
  await result.validation
  const after = engine.readGeneration(result.generation).internalPartitions
  const rows = await engine.queryBatch({ type: 'refs', name: 'renamed', resolved: true, generation: result.generation })

  assert.deepEqual(
    {
      validatedFiles: result.validatedFiles,
      internalBuildCount: result.internalBuildCount,
      internalRebuiltFiles: result.internalRebuiltFiles,
      changedIds: ['src/a.ts', 'src/b.ts'].map((file) => after[file] !== before[file]),
      traversalSummary,
      importerPartitionRetained: engine.readGeneration(result.generation).partitions['src/b.ts'] === beforeManifest.partitions['src/b.ts'],
      unresolvedEdges: engine.snapshot().unresolvedEdges,
      rows,
    },
    {
      validatedFiles: ['src/a.ts'],
      internalBuildCount: 1,
      internalRebuiltFiles: ['src/a.ts'],
      changedIds: [true, false],
      traversalSummary: { completedFiles: 1, remainingFiles: 0, maximumTraversalsPerFile: 1 },
      importerPartitionRetained: true,
      unresolvedEdges: [{
        from: importerId,
        to: missingTargetId,
        line: 1,
        reason: 'dangling-symbol-target',
      }],
      rows: [],
    },
  )
})

test('compatibility: a retained build in an outside-root cache remains queryable after reopen', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-outside-cache-project-'))
  const cacheDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-outside-cache-store-')), 'index')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'answer.ts'), 'export function answer(){ return 42 }\n')
  fs.writeFileSync(path.join(root, 'src', 'useAnswer.ts'), "import { answer } from './answer'; export function useAnswer(){ return answer() }\n")
  const builder = trackedEngine(root, { cacheDir })

  const built = await builder.build()
  await builder.dispose()
  const reopened = trackedEngine(root, { cacheDir })
  const rows = await reopened.queryBatch({ type: 'refs', name: 'answer', resolved: true, generation: built.generation })

  assert.deepEqual(rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })), [{ fromFile: 'src/useAnswer.ts', toFile: 'src/answer.ts', line: 1, call: true }])
})

test('worker reopen: the first disk-backed update publishes through semantic validation', async () => {
  const root = fixture()
  const builder = trackedEngine(root, { cacheDir: '.retained-reopen-update' })
  await builder.build()
  await builder.dispose()
  const reopened = trackedEngine(root, { cacheDir: '.retained-reopen-update' })
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+4 }\n")

  const submitted = await reopened.applyFileChanges([{ type: 'change', path: 'src/b.ts' }])
  const accepted = await submitted.validation
  const rows = await reopened.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: accepted.generation })

  assert.deepEqual({ currentGeneration: reopened.readGeneration().generation, acceptedGeneration: accepted.generation, rows: rows.map(({ fromSymbol, toSymbol, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, call })) }, {
    currentGeneration: accepted.generation,
    acceptedGeneration: accepted.generation,
    rows: [{ fromFile: 'src/b.ts', toFile: 'src/a.ts', call: true }],
  })
})

test('error guessing: a reopened changed consumer reads parses and validates only itself while retaining imported call and alias-reference edges', async () => {
  const root = fixture()
  const builder = trackedEngine(root, { cacheDir: '.retained-reopen-import-edges' })
  await builder.build()
  await builder.dispose()
  const reads = []
  const reopened = trackedEngine(root, { cacheDir: '.retained-reopen-import-edges', sourceReaderDeps: { readFile: async (file, encoding) => { reads.push(path.relative(root, file).split(path.sep).join('/')); return fsp.readFile(file, encoding) } } })
  const clean = trackedEngine(root, { cacheDir: '.retained-reopen-import-edges-clean' })
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ const selected=a; return a()+selected() }\n")

  const submitted = await reopened.applyFileChanges([{ type: 'change', path: 'src/b.ts' }])
  const accepted = await submitted.validation
  const cleanBuild = await clean.build()
  const retainedRows = await reopened.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: accepted.generation })
  const cleanRows = await clean.queryBatch({ type: 'refs', name: 'a', resolved: true, generation: cleanBuild.generation })
  const normalize = (rows) => rows.map(({ fromSymbol, toSymbol, call }) => ({ from: `${fromSymbol.file}:${fromSymbol.name}`, to: `${toSymbol.file}:${toSymbol.name}`, call }))

  assert.deepEqual(
    { reads, parsedFiles: accepted.parsedFiles, validatedFiles: accepted.validatedFiles, retained: normalize(retainedRows), clean: normalize(cleanRows) },
    {
      reads: ['src/b.ts'],
      parsedFiles: ['src/b.ts'],
      validatedFiles: ['src/b.ts'],
      retained: [{ from: 'src/b.ts:b', to: 'src/a.ts:a', call: true }, { from: 'src/b.ts:selected', to: 'src/a.ts:a', call: false }],
      clean: [{ from: 'src/b.ts:b', to: 'src/a.ts:a', call: true }, { from: 'src/b.ts:selected', to: 'src/a.ts:a', call: false }],
    },
  )
})

test('combinatorial all-pairs: a changed consumer resolves cached default named alias namespace and re-export routes like a clean build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-retained-binding-routes-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export default function primary(){ return 1 }\nexport const named = 2\n')
  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { default, default as alias, named as renamed } from './base'\nexport * as space from './base'\n")
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import primary, { alias, renamed, space } from './barrel'\nimport * as namespace from './barrel'\nexport const consume = () => primary() + alias() + renamed + space.named + namespace.renamed\n")
  const retained = trackedEngine(root, { cacheDir: '.retained-binding-routes' })
  const clean = trackedEngine(root, { cacheDir: '.retained-binding-routes-clean' })
  await retained.build()
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import primary, { alias, renamed, space } from './barrel'\nimport * as namespace from './barrel'\nexport const consume = () => primary() + alias() + renamed + space.named + namespace.renamed + 1\n")

  const changed = await retained.incremental([{ type: 'change', path: 'src/consumer.ts' }])
  await changed.validation
  const cleanBuild = await clean.build()
  const retainedRows = await retained.queryBatch({ type: 'deps', name: 'consume', resolved: true, generation: changed.generation })
  const cleanRows = await clean.queryBatch({ type: 'deps', name: 'consume', resolved: true, generation: cleanBuild.generation })
  const normalize = (rows) => rows.map(({ toSymbol, call }) => ({ file: toSymbol.file, name: toSymbol.name, call })).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

  assert.deepEqual(
    { parsedFiles: changed.parsedFiles, validatedFiles: changed.validatedFiles, retained: normalize(retainedRows), clean: normalize(cleanRows) },
    {
      parsedFiles: ['src/consumer.ts'],
      validatedFiles: ['src/consumer.ts'],
      retained: [
        { file: 'src/base.ts', name: 'named', call: false },
        { file: 'src/base.ts', name: 'named', call: false },
        { file: 'src/base.ts', name: 'named', call: false },
        { file: 'src/base.ts', name: 'primary', call: true },
        { file: 'src/base.ts', name: 'primary', call: true },
      ],
      clean: [
        { file: 'src/base.ts', name: 'named', call: false },
        { file: 'src/base.ts', name: 'named', call: false },
        { file: 'src/base.ts', name: 'named', call: false },
        { file: 'src/base.ts', name: 'primary', call: true },
        { file: 'src/base.ts', name: 'primary', call: true },
      ],
    },
  )
})

test('retained pending update: latest mapped rows remain on the validated generation and report validated metadata', async () => {
  const root = fixture()
  const checker = new SemanticCheckerWorker()
  let releaseValidation
  const engine = trackedEngine(root, { cacheDir: '.retained-pending-metadata', validationWorkerFactory: () => ({
    index: (payload, onProgress) => checker.index(payload, onProgress),
    hydrate: (payload) => checker.hydrate(payload),
    validate: async (payload, onProgress) => { await new Promise((resolve) => { releaseValidation = resolve }); return checker.validate(payload, onProgress) },
    referenceOverlay: (payload) => checker.referenceOverlay(payload),
    dispose: () => checker.dispose(),
  }) })
  const built = await engine.build()
  const pending = engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function changed(){ return 9 }\n' }])
  while (!releaseValidation) await new Promise((resolve) => setImmediate(resolve))

  const latest = engine.pinQuery({ type: 'symbols', consistency: 'latest' })
  const rows = []
  for await (const row of latest.rows) rows.push(row)
  releaseValidation()
  await pending.validation

  assert.deepEqual({ metadata: latest.metadata, names: rows.map(({ name }) => name) }, {
    metadata: { revision: null, freshness: 'validated', coverage: 'calls', validatedGeneration: built.generation },
    names: ['a', 'b'],
  })
})

test('retained revision boundary: applyChanges and applyFileChanges reject the same stale base revision', async () => {
  const root = fixture()
  const engine = trackedEngine(root, { cacheDir: '.retained-stale-revision' })
  await engine.build()

  assert.throws(() => engine.applyChanges([{ type: 'change', path: 'src/b.ts', source: 'export function changed(){ return 3 }\n' }], { baseRevision: 1 }), /stale base revision 1; latest is 0/)
  await assert.rejects(engine.applyFileChanges([{ type: 'change', path: 'src/b.ts' }], { baseRevision: 1 }), /stale base revision 1; latest is 0/)
})

test('equivalence partitioning and boundary analysis: malformed public change requests reject without advancing revision or CURRENT', async (t) => {
  await t.test('source-backed applyChanges rejects an unknown change type', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    assert.throws(() => engine.applyChanges([{ type: 'replace', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' }]), /type|change|add|unlink|unknown/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })

  await t.test('source-backed applyChanges rejects an empty path', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    assert.throws(() => engine.applyChanges([{ type: 'change', path: '', source: 'export const invalid = true\n' }]), /path|empty|relative/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })

  await t.test('source-backed applyChanges rejects an absolute path', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    assert.throws(() => engine.applyChanges([{ type: 'change', path: '/tmp/outside.ts', source: 'export const invalid = true\n' }]), /path|absolute|relative|escape/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })

  await t.test('source-backed applyChanges rejects an escaping path', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    assert.throws(() => engine.applyChanges([{ type: 'change', path: '../outside.ts', source: 'export const invalid = true\n' }]), /path|relative|escape|outside/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })

  await t.test('source-backed applyChanges rejects missing source text', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    assert.throws(() => engine.applyChanges([{ type: 'change', path: 'src/a.ts' }]), /source|string|required/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })

  await t.test('source-backed applyChanges rejects non-string source text', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    assert.throws(() => engine.applyChanges([{ type: 'add', path: 'src/c.ts', source: 42 }]), /source|string|required/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })

  await t.test('disk-backed applyFileChanges rejects supplied source text', async () => {
    const root = fixture()
    const engine = trackedEngine(root)
    const built = await engine.build()
    await assert.rejects(engine.applyFileChanges([{ type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' }]), /disk|source|must not include/i)
    assert.deepEqual({ revision: engine.provisionalSnapshot().revision, generation: engine.readGeneration().generation }, { revision: 0, generation: built.generation })
  })
})

test('domain and error-guessing analysis: malformed delta partition and tombstone receipts reject without publishing', async (t) => {
  const runMalformedReceipt = async ({ change, receiptFiles, tombstones }) => {
    const root = fixture()
    let engine
    engine = trackedEngine(root, { validationWorkerFactory: () => ({ validate: async (payload) => {
      const complete = fullWorkerResult(engine, change.type === 'unlink' && receiptFiles.length ? { ...payload, changes: [] } : payload)
      const sourceBlobs = { ...complete.sourceBlobs }
      if (change.type === 'unlink') delete sourceBlobs[change.path]
      return {
        ...complete,
        mode: 'delta',
        sourceBlobs,
        partitionReceipts: complete.partitionReceipts.filter(({ file }) => receiptFiles.includes(file)),
        tombstones,
      }
    }, dispose: async () => {} }) })
    const built = await engine.build()
    const before = manifestBytes(engine)
    const result = engine.applyChanges([change])
    await assert.rejects(result.validation, /partition|tombstone|changed|unknown|unexpected|mismatch|membership/i)
    assert.deepEqual({ generation: engine.readGeneration().generation, manifest: manifestBytes(engine) }, { generation: built.generation, manifest: before })
  }

  await t.test('a mismatched tombstone for another known file rejects', () => runMalformedReceipt({
    change: { type: 'unlink', path: 'src/a.ts' },
    receiptFiles: [],
    tombstones: ['src/b.ts'],
  }))

  await t.test('an extra unknown tombstone rejects', () => runMalformedReceipt({
    change: { type: 'unlink', path: 'src/a.ts' },
    receiptFiles: [],
    tombstones: ['src/a.ts', 'src/ghost.ts'],
  }))

  await t.test('multiple tombstones reject a one-file unlink', () => runMalformedReceipt({
    change: { type: 'unlink', path: 'src/a.ts' },
    receiptFiles: [],
    tombstones: ['src/a.ts', 'src/b.ts'],
  }))

  await t.test('a changed partition mixed with a tombstone rejects', () => runMalformedReceipt({
    change: { type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' },
    receiptFiles: ['src/a.ts'],
    tombstones: ['src/a.ts'],
  }))

  await t.test('a tombstone for a changed file rejects', () => runMalformedReceipt({
    change: { type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' },
    receiptFiles: [],
    tombstones: ['src/a.ts'],
  }))

  await t.test('a tombstone for an added file rejects', () => runMalformedReceipt({
    change: { type: 'add', path: 'src/c.ts', source: 'export const c = 3\n' },
    receiptFiles: [],
    tombstones: ['src/c.ts'],
  }))

  await t.test('a partition receipt for an unlinked file rejects', () => runMalformedReceipt({
    change: { type: 'unlink', path: 'src/a.ts' },
    receiptFiles: ['src/a.ts'],
    tombstones: [],
  }))

  await t.test('an unknown partition path rejects', () => runMalformedReceipt({
    change: { type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' },
    receiptFiles: ['src/b.ts'],
    tombstones: [],
  }))
})

test('compatibility: concurrent retained cold builds leave one readable equivalent graph', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-concurrent-cold-project-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'answer.ts'), 'export function answer(){ return 42 }\n')
  fs.writeFileSync(path.join(root, 'src', 'useAnswer.ts'), "import { answer } from './answer'; export function useAnswer(){ return answer() }\n")
  const first = trackedEngine(root, {  })
  const second = trackedEngine(root, {  })

  await Promise.all([first.build(), second.build()])
  await Promise.all([first.dispose(), second.dispose()])
  const reopened = trackedEngine(root, {  })
  const rows = await reopened.queryBatch({ type: 'refs', name: 'answer', resolved: true })

  assert.deepEqual(rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })), [{ fromFile: 'src/useAnswer.ts', toFile: 'src/answer.ts', line: 1, call: true }])
})

test('shared cold persistence compatibility: a real retained build with many sources and one oversized partition remains clean-build equivalent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-cold-success-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'answer.ts'), 'export function answer(){ return 42 }\n')
  fs.writeFileSync(path.join(root, 'src', 'useAnswer.ts'), "import { answer } from './answer'; export function useAnswer(){ return answer() }\n")
  fs.writeFileSync(path.join(root, 'src', 'f01.ts'), 'export const f01 = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'f02.ts'), 'export const f02 = 2\n')
  fs.writeFileSync(path.join(root, 'src', 'f03.ts'), 'export const f03 = 3\n')
  fs.writeFileSync(path.join(root, 'src', 'f04.ts'), 'export const f04 = 4\n')
  fs.writeFileSync(path.join(root, 'src', 'f05.ts'), 'export const f05 = 5\n')
  fs.writeFileSync(path.join(root, 'src', 'f06.ts'), 'export const f06 = 6\n')
  fs.writeFileSync(path.join(root, 'src', 'f07.ts'), 'export const f07 = 7\n')
  fs.writeFileSync(path.join(root, 'src', 'f08.ts'), 'export const f08 = 8\n')
  fs.writeFileSync(path.join(root, 'src', 'f09.ts'), 'export const f09 = 9\n')
  fs.writeFileSync(path.join(root, 'src', 'f10.ts'), 'export const f10 = 10\n')
  fs.writeFileSync(path.join(root, 'src', 'f11.ts'), 'export const f11 = 11\n')
  fs.writeFileSync(path.join(root, 'src', 'f12.ts'), 'export const f12 = 12\n')
  fs.writeFileSync(path.join(root, 'src', 'f13.ts'), 'export const f13 = 13\n')
  fs.writeFileSync(path.join(root, 'src', 'f14.ts'), 'export const f14 = 14\n')
  fs.writeFileSync(path.join(root, 'src', 'f15.ts'), 'export const f15 = 15\n')
  fs.writeFileSync(path.join(root, 'src', 'f16.ts'), 'export const f16 = 16\n')
  fs.writeFileSync(path.join(root, 'src', 'f17.ts'), 'export const f17 = 17\n')
  fs.writeFileSync(path.join(root, 'src', 'f18.ts'), 'export const f18 = 18\n')
  fs.writeFileSync(path.join(root, 'src', 'oversized.ts'), `export const oversized${'x'.repeat(70_000)} = 1\n`)
  const retained = trackedEngine(root, { cacheDir: '.shared-retained' })
  const clean = trackedEngine(root, { cacheDir: '.shared-clean' })

  const retainedBuild = await retained.build()
  const cleanBuild = await clean.build()
  const retainedGraph = await retained.snapshot(retainedBuild.generation)
  const cleanGraph = await clean.snapshot(cleanBuild.generation)
  const rows = await retained.queryBatch({ type: 'refs', name: 'answer', resolved: true, generation: retainedBuild.generation })

  assert.deepEqual(
    { graph: canon(retainedGraph), expectedGraph: canon(cleanGraph), rows: rows.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })) },
    { graph: canon(cleanGraph), expectedGraph: canon(cleanGraph), rows: [{ fromFile: 'src/useAnswer.ts', toFile: 'src/answer.ts', line: 1, call: true }] },
  )
})

test('shared cold persistence failure: a real retained build rejects promptly and preserves the prior published graph', { timeout: 10_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-cold-failure-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'answer.ts'), 'export function answer(){ return 42 }\n')
  fs.writeFileSync(path.join(root, 'src', 'useAnswer.ts'), "import { answer } from './answer'; export function useAnswer(){ return answer() }\n")
  fs.writeFileSync(path.join(root, 'src', 'f01.ts'), 'export const f01 = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'f02.ts'), 'export const f02 = 2\n')
  fs.writeFileSync(path.join(root, 'src', 'f03.ts'), 'export const f03 = 3\n')
  fs.writeFileSync(path.join(root, 'src', 'f04.ts'), 'export const f04 = 4\n')
  fs.writeFileSync(path.join(root, 'src', 'f05.ts'), 'export const f05 = 5\n')
  fs.writeFileSync(path.join(root, 'src', 'f06.ts'), 'export const f06 = 6\n')
  fs.writeFileSync(path.join(root, 'src', 'f07.ts'), 'export const f07 = 7\n')
  fs.writeFileSync(path.join(root, 'src', 'f08.ts'), 'export const f08 = 8\n')
  fs.writeFileSync(path.join(root, 'src', 'f09.ts'), 'export const f09 = 9\n')
  fs.writeFileSync(path.join(root, 'src', 'f10.ts'), 'export const f10 = 10\n')
  fs.writeFileSync(path.join(root, 'src', 'f11.ts'), 'export const f11 = 11\n')
  fs.writeFileSync(path.join(root, 'src', 'f12.ts'), 'export const f12 = 12\n')
  fs.writeFileSync(path.join(root, 'src', 'f13.ts'), 'export const f13 = 13\n')
  fs.writeFileSync(path.join(root, 'src', 'f14.ts'), 'export const f14 = 14\n')
  fs.writeFileSync(path.join(root, 'src', 'f15.ts'), 'export const f15 = 15\n')
  fs.writeFileSync(path.join(root, 'src', 'f16.ts'), 'export const f16 = 16\n')
  fs.writeFileSync(path.join(root, 'src', 'f17.ts'), 'export const f17 = 17\n')
  fs.writeFileSync(path.join(root, 'src', 'f18.ts'), 'export const f18 = 18\n')
  const engine = trackedEngine(root, {  })
  const first = await engine.build()
  const currentPath = path.join(root, '.codegraph', 'CURRENT')
  const currentBefore = fs.readFileSync(currentPath)
  const rowsBefore = await engine.queryBatch({ type: 'refs', name: 'answer', resolved: true, generation: first.generation })
  engine.store.writePackedPartitionRange = () => { throw new Error('forced main persistence failure') }
  fs.writeFileSync(path.join(root, 'src', 'answer.ts'), 'export function answer(){ return 43 }\n')

  const failure = await Promise.race([
    engine.build().then(() => 'unexpected success', (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('timed out waiting for rejection'), 2_000)),
  ])
  const currentAfter = fs.readFileSync(currentPath)
  const rowsAfter = await engine.queryBatch({ type: 'refs', name: 'answer', resolved: true, generation: first.generation })

  assert.deepEqual(
    { failure, currentUnchanged: currentAfter.equals(currentBefore), rowsBefore: rowsBefore.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })), rowsAfter: rowsAfter.map(({ fromSymbol, toSymbol, line, call }) => ({ fromFile: fromSymbol.file, toFile: toSymbol.file, line, call })) },
    { failure: 'forced main persistence failure', currentUnchanged: true, rowsBefore: [{ fromFile: 'src/useAnswer.ts', toFile: 'src/answer.ts', line: 1, call: true }], rowsAfter: [{ fromFile: 'src/useAnswer.ts', toFile: 'src/answer.ts', line: 1, call: true }] },
  )
})
