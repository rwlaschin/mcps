import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createTraceProfiler } from '../trace-profile.mjs'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { createSemanticProject, parsePartition, prepareSemanticProject } from '../parser.mjs'
import { decodeInternalPartition } from '../internal-graph.mjs'

const fullWorkerResult = (engine, payload) => {
  const sources = new Map(Object.entries(payload.baseSourceBlobs).map(([file, id]) => [file, engine.store.readSource(id)]))
  for (const change of payload.changes) sources.set(change.path, change.source)
  const context = prepareSemanticProject(createSemanticProject(payload.root, sources), payload.root)
  const known = new Set(sources.keys())
  return {
    revision: payload.revision,
    mode: 'full',
    baseGeneration: payload.baseGeneration,
    sourceBlobs: Object.fromEntries([...sources].map(([file, source]) => [file, engine.store.writeSource(source)])),
    partitions: Object.fromEntries([...sources].map(([file, source]) => [file, parsePartition(file, source, known, context)])),
  }
}

test('equivalence partition: an absent profile path creates no profiler and touches neither clock nor filesystem', () => {
  let clockCalls = 0
  let writeCalls = 0

  const profiler = createTraceProfiler(undefined, {
    now: () => { clockCalls += 1; return 1n },
    writeFile: () => { writeCalls += 1 },
  })

  assert.deepEqual({ profiler, clockCalls, writeCalls }, { profiler: null, clockCalls: 0, writeCalls: 0 })
})

test('boundary values: a zero-duration phase is emitted as an analyzer-compatible complete event with integer microseconds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trace-zero-'))
  const destination = path.join(root, 'profile.json')
  const profiler = createTraceProfiler(destination, { now: () => 1234567890n })

  const token = profiler.begin('scan', { files: 0 })
  profiler.end(token)
  await profiler.write()

  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), {
    traceEvents: [{ name: 'scan', cat: 'codegraph', ph: 'X', ts: 1234567, dur: 0, pid: process.pid, tid: 0, args: { files: 0 } }],
  })
})

test('boundary values: sub-microsecond timestamps and durations are represented by integer microseconds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trace-rounding-'))
  const destination = path.join(root, 'profile.json')
  const readings = [1000500n, 1001499n]
  const profiler = createTraceProfiler(destination, { now: () => readings.shift() })

  const token = profiler.begin('parse')
  profiler.end(token)
  await profiler.write()

  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')).traceEvents[0], {
    name: 'parse', cat: 'codegraph', ph: 'X', ts: 1000, dur: 0, pid: process.pid, tid: 0,
  })
})

test('error guessing: trace output is atomically renamed over an existing destination without leaving a temporary sibling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trace-atomic-'))
  const destination = path.join(root, 'profile.json')
  fs.writeFileSync(destination, 'old profile')
  const readings = [1000000n, 2000000n]
  const profiler = createTraceProfiler(destination, { now: () => readings.shift() })

  const token = profiler.begin('codegraph.build')
  profiler.end(token)
  await profiler.write()

  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')).traceEvents[0], {
    name: 'codegraph.build', cat: 'codegraph', ph: 'X', ts: 1000, dur: 1000, pid: process.pid, tid: 0,
  })
  assert.deepEqual(fs.readdirSync(root), ['profile.json'])
})

test('domain analysis: profiling a build preserves graph identity and existing per-file instrumentation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-build-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const tracePath = path.join(root, 'build-profile.json')
  const instrumented = []
  const plain = new CodeGraphEngine(root, { cacheDir: '.plain-codegraph' })
  const profiled = new CodeGraphEngine(root, { cacheDir: '.profiled-codegraph', profile: tracePath, instrument: (event) => instrumented.push(event) })

  const plainResult = await plain.build()
  const profiledResult = await profiled.build()
  const plainGraph = plain.snapshot()
  const profiledGraph = profiled.snapshot()
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'))

  assert.deepEqual(
    { graph: { files: profiledGraph.files, symbols: profiledGraph.symbols, edges: profiledGraph.edges }, result: { parsedFiles: profiledResult.parsedFiles, reusedFiles: profiledResult.reusedFiles }, instrumented, descriptor: profiledResult.profile, phases: trace.traceEvents.map((event) => event.name).filter((name) => ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'].includes(name)) },
    { graph: { files: plainGraph.files, symbols: plainGraph.symbols, edges: plainGraph.edges }, result: { parsedFiles: plainResult.parsedFiles, reusedFiles: plainResult.reusedFiles }, instrumented: [{ phase: 'parse', file: 'src/a.ts' }], descriptor: { path: tracePath, format: 'chrome-trace-event' }, phases: ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'] },
  )
})

test('error guessing: profile write failure reports the error without invalidating a successful graph build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-failure-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath, profileDeps: { rename: async () => { throw new Error('permission denied during atomic rename') } } })

  const result = await engine.build()

  assert.deepEqual(
    { parsedFiles: result.parsedFiles, files: engine.snapshot().files, profile: result.profile },
    { parsedFiles: ['src/a.ts'], files: ['src/a.ts'], profile: { path: tracePath, format: 'chrome-trace-event', error: 'permission denied during atomic rename' } },
  )
})

test('combinatorial all-pairs: build, incremental, and reconcile accept --profile and return matching descriptors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-cli-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const buildPath = path.join(root, 'build.json')
  const incrementalPath = path.join(root, 'incremental.json')
  const reconcilePath = path.join(root, 'reconcile.json')

  const build = JSON.parse(execFileSync(process.execPath, ['tool.mjs', 'build', '--root', root, '--profile', buildPath], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' }).trim())
  const incremental = JSON.parse(execFileSync(process.execPath, ['tool.mjs', 'incremental', '[]', '--root', root, '--profile', incrementalPath], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' }).trim())
  const reconcile = JSON.parse(execFileSync(process.execPath, ['tool.mjs', 'reconcile', '--root', root, '--profile', reconcilePath], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' }).trim())

  assert.deepEqual(
    { descriptors: [build.profile, incremental.profile, reconcile.profile], files: [fs.existsSync(buildPath), fs.existsSync(incrementalPath), fs.existsSync(reconcilePath)] },
    { descriptors: [{ path: buildPath, format: 'chrome-trace-event' }, { path: incrementalPath, format: 'chrome-trace-event' }, { path: reconcilePath, format: 'chrome-trace-event' }], files: [true, true, true] },
  )
})

test('equivalence partition: --profile without a file is rejected instead of writing to an unintended path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-missing-path-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')

  const result = spawnSync(process.execPath, ['tool.mjs', 'build', '--root', root, '--profile'], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' })

  assert.deepEqual(
    { status: result.status, stderr: result.stderr },
    { status: 1, stderr: 'codegraph: --profile requires a file path\n' },
  )
})

test('domain analysis: the root build event reports aggregate IO and reuse counters with nonnegative values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-counters-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  await engine.build()
  const rootEvent = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.find((event) => event.name === 'codegraph.build')

  assert.deepEqual(
    {
      filesRead: rootEvent.args.filesRead,
      bytesRead: rootEvent.args.bytesRead,
      readMsIsNonnegative: rootEvent.args.readMs >= 0,
      readMsIsFinite: Number.isFinite(rootEvent.args.readMs),
      filesParsed: rootEvent.args.filesParsed,
      filesReused: rootEvent.args.filesReused,
      readConcurrency: rootEvent.args.readConcurrency,
      peakReads: rootEvent.args.peakReads,
      phases: JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.map((event) => event.name).filter((name) => ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'].includes(name)),
    },
    { filesRead: 1, bytesRead: 32, readMsIsNonnegative: true, readMsIsFinite: true, filesParsed: 1, filesReused: 0, readConcurrency: 16, peakReads: 1, phases: ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'] },
  )
})

test('boundary value: configured read concurrency is reported by the profile while peak reads stays bounded by file count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-read-concurrency-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2\n')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath, readConcurrency: 1 })

  await engine.build()
  const rootEvent = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.find((event) => event.name === 'codegraph.build')

  assert.deepEqual({ readConcurrency: rootEvent.args.readConcurrency, peakReads: rootEvent.args.peakReads }, { readConcurrency: 1, peakReads: 1 })
})

test('equivalence partition: a relative profile path resolves against the indexed repository root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-relative-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const engine = new CodeGraphEngine(root, { profile: 'profiles/build.json' })

  const result = await engine.build()

  assert.deepEqual(
    { descriptor: result.profile, existsUnderRoot: fs.existsSync(path.join(root, 'profiles', 'build.json')), existsUnderProcessDirectory: fs.existsSync(path.resolve('profiles/build.json')) },
    { descriptor: { path: path.join(root, 'profiles', 'build.json'), format: 'chrome-trace-event' }, existsUnderRoot: true, existsUnderProcessDirectory: false },
  )
})

test('boundary and permission analysis: profiling creates a missing parent directory and restricts a new trace file to mode 0600', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-mode-'))
  const destination = path.join(root, 'missing', 'nested', 'profile.json')
  const readings = [1000000n, 2000000n]
  const profiler = createTraceProfiler(destination, { now: () => readings.shift() })

  const token = profiler.begin('codegraph.build')
  profiler.end(token)
  await profiler.write()

  assert.deepEqual(
    { isDirectory: fs.statSync(path.dirname(destination)).isDirectory(), mode: fs.statSync(destination).mode & 0o777 },
    { isDirectory: true, mode: 0o600 },
  )
})

test('error guessing: a failed build best-effort writes an error trace and rethrows the original error object', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-build-error-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const tracePath = path.join(root, 'failed-build.json')
  const original = new Error('instrumentation forced build failure')
  const engine = new CodeGraphEngine(root, { profile: tracePath, instrument: () => { throw original } })

  let caught
  try { await engine.build() } catch (error) { caught = error }
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'))
  const rootEvent = trace.traceEvents.find((event) => event.name === 'codegraph.build')

  assert.deepEqual(
    { sameErrorObject: caught === original, status: rootEvent.args.status, error: rootEvent.args.error },
    { sameErrorObject: true, status: 'error', error: 'instrumentation forced build failure' },
  )
})

test('regression: profiling preserves reconcile fallback to a successful build when no generation can be read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-reconcile-fallback-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const tracePath = path.join(root, 'reconcile-fallback.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  const result = await engine.reconcile()
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'))

  assert.deepEqual(
    {
      parsedFiles: result.parsedFiles,
      reusedFiles: result.reusedFiles,
      indexedFiles: engine.snapshot().files,
      profile: result.profile,
      operations: trace.traceEvents.filter((event) => event.name.startsWith('codegraph.')).map((event) => ({ name: event.name, status: event.args.status })),
    },
    {
      parsedFiles: ['src/a.ts'],
      reusedFiles: [],
      indexedFiles: ['src/a.ts'],
      profile: { path: tracePath, format: 'chrome-trace-event' },
      operations: [{ name: 'codegraph.reconcile', status: 'error' }, { name: 'codegraph.build', status: 'ok' }],
    },
  )
})

test('combinatorial all-pairs: only major outer events sample memory and report integer before after and delta fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-memory-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  const tracePath = path.join(root, 'profile.json')
  let memoryCalls = 0
  const engine = new CodeGraphEngine(root, { profile: tracePath, profileDeps: { memoryUsage: () => {
    memoryCalls += 1
    return { rss: memoryCalls, heapUsed: memoryCalls + 10, heapTotal: memoryCalls + 20, external: memoryCalls + 30, arrayBuffers: memoryCalls + 40 }
  } } })

  await engine.build()
  const events = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents
  const major = events.filter((event) => ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'].includes(event.name))
  const detailed = events.filter((event) => event.args?.file)

  assert.deepEqual({ memoryCalls, major: major.map((event) => ({ name: event.name, memory: Object.fromEntries(Object.entries(event.args ?? {}).filter(([key]) => /^(rss|heapUsed|heapTotal|external|arrayBuffers)(Before|After|Delta)$/.test(key))) })), detailedHaveMemory: detailed.some((event) => Object.keys(event.args).some((key) => /^(rss|heapUsed|heapTotal|external|arrayBuffers)(Before|After|Delta)$/.test(key))) }, {
    memoryCalls: 12,
    major: [
      { name: 'codegraph.build', memory: { rssBefore: 1, heapUsedBefore: 11, heapTotalBefore: 21, externalBefore: 31, arrayBuffersBefore: 41, rssAfter: 12, rssDelta: 11, heapUsedAfter: 22, heapUsedDelta: 11, heapTotalAfter: 32, heapTotalDelta: 11, externalAfter: 42, externalDelta: 11, arrayBuffersAfter: 52, arrayBuffersDelta: 11 } },
      { name: 'scan', memory: { rssBefore: 2, heapUsedBefore: 12, heapTotalBefore: 22, externalBefore: 32, arrayBuffersBefore: 42, rssAfter: 3, rssDelta: 1, heapUsedAfter: 13, heapUsedDelta: 1, heapTotalAfter: 23, heapTotalDelta: 1, externalAfter: 33, externalDelta: 1, arrayBuffersAfter: 43, arrayBuffersDelta: 1 } },
      { name: 'read-sources', memory: { rssBefore: 4, heapUsedBefore: 14, heapTotalBefore: 24, externalBefore: 34, arrayBuffersBefore: 44, rssAfter: 5, rssDelta: 1, heapUsedAfter: 15, heapUsedDelta: 1, heapTotalAfter: 25, heapTotalDelta: 1, externalAfter: 35, externalDelta: 1, arrayBuffersAfter: 45, arrayBuffersDelta: 1 } },
      { name: 'semantic-project', memory: { rssBefore: 6, heapUsedBefore: 16, heapTotalBefore: 26, externalBefore: 36, arrayBuffersBefore: 46, rssAfter: 7, rssDelta: 1, heapUsedAfter: 17, heapUsedDelta: 1, heapTotalAfter: 27, heapTotalDelta: 1, externalAfter: 37, externalDelta: 1, arrayBuffersAfter: 47, arrayBuffersDelta: 1 } },
      { name: 'parse-index', memory: { rssBefore: 8, heapUsedBefore: 18, heapTotalBefore: 28, externalBefore: 38, arrayBuffersBefore: 48, rssAfter: 9, rssDelta: 1, heapUsedAfter: 19, heapUsedDelta: 1, heapTotalAfter: 29, heapTotalDelta: 1, externalAfter: 39, externalDelta: 1, arrayBuffersAfter: 49, arrayBuffersDelta: 1 } },
      { name: 'publish', memory: { rssBefore: 10, heapUsedBefore: 20, heapTotalBefore: 30, externalBefore: 40, arrayBuffersBefore: 50, rssAfter: 11, rssDelta: 1, heapUsedAfter: 21, heapUsedDelta: 1, heapTotalAfter: 31, heapTotalDelta: 1, externalAfter: 41, externalDelta: 1, arrayBuffersAfter: 51, arrayBuffersDelta: 1 } },
    ],
    detailedHaveMemory: false,
  })
})

test('equivalence partition and hotpath regression: disabled profiling touches neither clock nor memory while preserving graph behavior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-disabled-detail-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  let clockCalls = 0
  let memoryCalls = 0
  const engine = new CodeGraphEngine(root, { profileDeps: { now: () => { clockCalls += 1; return 1n }, memoryUsage: () => { memoryCalls += 1; return { rss: 1, heapUsed: 1, heapTotal: 1, external: 1, arrayBuffers: 1 } } } })

  const result = await engine.build()

  assert.deepEqual({ parsedFiles: result.parsedFiles, files: engine.snapshot().files, symbols: engine.snapshot().symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), clockCalls, memoryCalls }, { parsedFiles: ['src/a.ts'], files: ['src/a.ts'], symbols: [{ name: 'a', kind: 'function', exported: true }], clockCalls: 0, memoryCalls: 0 })
})

test('equivalence partition and hotpath regression: disabling identifier profiling preserves resolver output without clock sampling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-identifier-disabled-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'dependency.ts'), 'export const dependency = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'subject.ts'), "import { dependency } from './dependency'\nexport function subject(){ return dependency }\n")
  let clockCalls = 0
  const engine = new CodeGraphEngine(root, { profileDeps: { now: () => { clockCalls += 1; return 1n } } })

  await engine.build()

  assert.deepEqual({ clockCalls, symbols: engine.snapshot().symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), edges: engine.snapshot().edges.map(({ line, call }) => ({ line, call })) }, {
    clockCalls: 0,
    symbols: [
      { name: 'subject', kind: 'function', exported: true },
      { name: 'dependency', kind: 'variable', exported: true },
    ],
    edges: [{ line: 2, call: false }],
  })
})

test('performance contract: one syntax walk emits the exact semantic and internal graph for a source file', () => {
  const root = '/tmp/cg-one-pass-fixture'
  const sources = new Map([['src/a.ts', 'export function z({ value = 1 }){ return value }\n']])
  const project = createSemanticProject(root, sources)
  const file = project.getSourceFileOrThrow('/tmp/cg-one-pass-fixture/src/a.ts')
  let traversalCount = 0
  const walk = file.forEachDescendant.bind(file)
  file.forEachDescendant = (callback, ...args) => {
    traversalCount += 1
    return walk((node, traversal) => {
      node.getDescendantsOfKind = () => { throw new Error(`second descendant traversal from ${node.getKindName()}`) }
      node.getChildren = () => { throw new Error(`wrapper child traversal from ${node.getKindName()}`) }
      return callback(node, traversal)
    }, ...args)
  }

  const context = prepareSemanticProject(project, root)
  const partition = parsePartition('src/a.ts', sources.get('src/a.ts'), new Set(['src/a.ts']), context)
  const internal = decodeInternalPartition(partition.internalPartition, { compilerFingerprint: partition.internalFingerprint })

  assert.deepEqual({
    traversalCount,
    semantic: { file: partition.file, sourceHash: partition.sourceHash, symbols: partition.symbols, edges: partition.edges, dependencies: partition.dependencies, unresolved: partition.unresolved },
    internal: {
      owners: internal.owners.map(({ id, kind, name, symbolId, parentOwnerId, cyclomatic, branchCount, nestingDepth, nodeCount }) => ({ id, kind, name, symbolId: symbolId ?? null, parentOwnerId: parentOwnerId ?? null, cyclomatic, branchCount, nestingDepth, nodeCount })),
      nodes: internal.nodes.map(({ id, ownerId, kind, role, start, end, unreachable }) => ({ id, ownerId, kind, role, start, end, unreachable })),
      edges: internal.edges,
      relations: internal.relations,
    },
  }, {
    traversalCount: 1,
    semantic: {
      file: 'src/a.ts',
      sourceHash: 'af94513adaeca51eb2e3914445e0e06b9eb9f4fb3fd088528c66f1a14da3d2b0',
      symbols: [{ id: '76e3ba62aab7be875b7c8c2e', file: 'src/a.ts', name: 'z', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>({ value = 1 }:?):', ordinal: 0, exported: true }],
      edges: [],
      dependencies: [],
      unresolved: [],
    },
    internal: {
      owners: [
        { id: 0, kind: 'module', name: '<module>', symbolId: null, parentOwnerId: null, cyclomatic: 1, branchCount: 0, nestingDepth: 0, nodeCount: 2 },
        { id: 1, kind: 'function', name: 'z', symbolId: '76e3ba62aab7be875b7c8c2e', parentOwnerId: 0, cyclomatic: 2, branchCount: 0, nestingDepth: 0, nodeCount: 4 },
      ],
      nodes: [
        { id: 0, ownerId: 0, kind: 'entry', role: 'body', start: 0, end: 49, unreachable: false },
        { id: 1, ownerId: 0, kind: 'exit', role: 'body', start: 0, end: 49, unreachable: false },
        { id: 2, ownerId: 1, kind: 'entry', role: 'body', start: 0, end: 48, unreachable: false },
        { id: 3, ownerId: 1, kind: 'exit', role: 'body', start: 0, end: 48, unreachable: false },
        { id: 4, ownerId: 1, kind: 'return', role: 'body', start: 34, end: 46, unreachable: false },
        { id: 5, ownerId: 1, kind: 'condition', role: 'initializer', start: 20, end: 29, unreachable: false },
      ],
      edges: [{ ownerId: 0, from: 0, to: 1, kind: 'next' }, { ownerId: 1, from: 4, to: 3, kind: 'return' }, { ownerId: 1, from: 5, to: 4, kind: 'true' }, { ownerId: 1, from: 5, to: 4, kind: 'false' }, { ownerId: 1, from: 2, to: 5, kind: 'next' }],
      relations: [],
    },
  })
})

test('release-order regression: resolving an untracked property in an earlier file does not traverse that file twice', () => {
  const root = '/tmp/cg-untracked-declaration-fixture'
  const sources = new Map([
    ['src/a.ts', 'export const object = { value: 1 }\n'],
    ['src/b.ts', "import { object } from './a'; export function read(){ return object.value }\n"],
  ])
  const project = createSemanticProject(root, sources)
  const context = prepareSemanticProject(project, root)
  const knownFiles = new Set(['src/a.ts', 'src/b.ts'])

  const first = parsePartition('src/a.ts', sources.get('src/a.ts'), knownFiles, context)
  const later = parsePartition('src/b.ts', sources.get('src/b.ts'), knownFiles, context)

  assert.deepEqual({
    traversalCounts: context.semanticTraversalCounts,
    first: { symbols: first.symbols, edges: first.edges },
    later: { symbols: later.symbols, edges: later.edges },
  }, {
    traversalCounts: { 'src/a.ts': 1, 'src/b.ts': 1 },
    first: {
      symbols: [{ id: 'b98c416cbd6500fb5e3d454d', file: 'src/a.ts', name: 'object', kind: 'variable', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
      edges: [],
    },
    later: {
      symbols: [{ id: 'f17d4168d47708e09dde0167', file: 'src/b.ts', name: 'read', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
      edges: [{ from: 'f17d4168d47708e09dde0167', to: 'b98c416cbd6500fb5e3d454d', line: 1, call: false }],
    },
  })
})

test('domain analysis: cached declaration and identifier lines match compiler truth for JSDoc decorators nesting JSX and equal starts', () => {
  const root = '/tmp/cg-line-cursor-syntax-fixture'
  const sources = new Map([
    ['src/dep.ts', 'export function dep(){ return 1 }\n'],
    ['src/view.tsx', "import { dep } from './dep'\n\n/** docs\n * more\n */\n@sealed\nexport class Outer {\n  method() {\n    const same = () => dep()\n    return (\n      <section>\n        {dep()}\n      </section>\n    )\n  }\n}\nfunction sealed(value: unknown) {}\n"],
  ])
  const project = createSemanticProject(root, sources)

  for (const file of project.getSourceFiles()) {
    file.getStartLineNumber = () => { throw new Error('parser called SourceFile.getStartLineNumber') }
    file.forEachDescendant((node) => {
      node.getStartLineNumber = () => { throw new Error(`parser called getStartLineNumber for ${node.getKindName()}`) }
    })
  }

  const context = prepareSemanticProject(project, root)
  const dep = parsePartition('src/dep.ts', sources.get('src/dep.ts'), new Set(['src/dep.ts', 'src/view.tsx']), context)
  const view = parsePartition('src/view.tsx', sources.get('src/view.tsx'), new Set(['src/dep.ts', 'src/view.tsx']), context)

  assert.deepEqual(
    {
      symbols: view.symbols,
      edges: view.edges,
    },
    {
      symbols: [
        { id: 'c72dca5bc714034b75cc4b23', file: 'src/view.tsx', name: 'sealed', kind: 'function', line: 17, qualifiedPath: '<module>', signature: '<>(value:unknown):', ordinal: 0, exported: false },
        { id: '0e3f5012310b0832854e247d', file: 'src/view.tsx', name: 'method', kind: 'method', line: 8, qualifiedPath: 'class:Outer', signature: '<>():', ordinal: 0, exported: false },
        { id: '443ace6fdb65bed18bdb8fef', file: 'src/view.tsx', name: 'Outer', kind: 'class', line: 6, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: '606d25082d7a34d866b24aa9', file: 'src/view.tsx', name: 'same', kind: 'variable', line: 9, qualifiedPath: 'class:Outer/method:method', signature: '<>():', ordinal: 0, exported: false },
      ],
      edges: [
        { from: '443ace6fdb65bed18bdb8fef', to: 'c72dca5bc714034b75cc4b23', line: 6, call: false },
        { from: '606d25082d7a34d866b24aa9', to: 'c1ef1dc820da414da7cf1fb6', line: 9, call: true },
        { from: '0e3f5012310b0832854e247d', to: 'c1ef1dc820da414da7cf1fb6', line: 12, call: true },
      ],
    },
  )
})

test('error guessing and boundary values: a reusable line cursor preserves exact lines for forward equal and backward positions', async () => {
  const { LineCursor } = await import('../parser.mjs')
  const cursor = new LineCursor()

  cursor.reset('zero\none\ntwo')

  assert.deepEqual(
    { start: cursor.lineAt(0), forward: cursor.lineAt(5), equal: cursor.lineAt(5), backward: cursor.lineAt(0), end: cursor.lineAt(12) },
    { start: 1, forward: 2, equal: 2, backward: 1, end: 3 },
  )
})

test('equivalence partition and lifecycle boundary: one build-local cursor is reused across files and cleared after semantic preparation', () => {
  const root = '/tmp/cg-line-cursor-reuse-fixture'
  const sources = new Map([
    ['src/large.ts', 'export const retainedMarker = 1\nexport const second = retainedMarker\n'],
    ['src/small.ts', 'export const finalFile = 1\n'],
  ])
  const project = createSemanticProject(root, sources)

  const context = prepareSemanticProject(project, root)
  const large = parsePartition('src/large.ts', sources.get('src/large.ts'), new Set(['src/large.ts', 'src/small.ts']), context)
  const small = parsePartition('src/small.ts', sources.get('src/small.ts'), new Set(['src/large.ts', 'src/small.ts']), context)

  assert.deepEqual(
    {
      retainedSource: context.lineCursor.source,
      offset: context.lineCursor.offset,
      line: context.lineCursor.line,
      largeLines: [large.symbols[0].line, large.symbols[1].line],
      smallLine: small.symbols[0].line,
    },
    { retainedSource: '', offset: 0, line: 1, largeLines: [1, 2], smallLine: 1 },
  )
})

test('worker ownership trace contract: a persistent build keeps the semantic-project phase between source reading and parse indexing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-worker-owner-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  await engine.build()
  await engine.dispose()
  const phases = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.map((event) => event.name).filter((name) => ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'].includes(name))

  assert.deepEqual(phases, ['codegraph.build', 'scan', 'read-sources', 'semantic-project', 'parse-index', 'publish'])
})

test('domain analysis: cold refs records one enrichment phase while warm refs reuses the atomic overlay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-lazy-overlay-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })
  await engine.build()
  const complete = engine.readGeneration()
  const partitions = Object.fromEntries(Object.entries(complete.partitions).map(([file, id]) => {
    const partition = engine.store.readPartition(id)
    return [file, engine.store.writePartition({ ...partition, edges: partition.edges.filter(({ call }) => call) })]
  }))
  engine.store.publish({ ...complete, edgeCoverage: 'calls', partitions, partitionHashes: partitions })

  for await (const ignored of engine.query({ type: 'refs', name: 'value' })) void ignored
  for await (const ignored of engine.query({ type: 'refs', name: 'value' })) void ignored
  const phases = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.filter((event) => event.name === 'reference-overlay').map((event) => event.name)

  assert.deepEqual(phases, ['reference-overlay'])
})
