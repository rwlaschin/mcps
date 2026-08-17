import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createTraceProfiler } from '../trace-profile.mjs'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { createSemanticProject, parsePartition, prepareSemanticProject } from '../parser.mjs'

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

test('hotpath regression: one changed file profiles provisional refresh and background validation with exact revision metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-warm-incremental-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a() }\n")
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })
  await engine.build()
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export function b(){ return a()+2 }\n")

  await engine.incremental([{ type: 'change', path: 'src/b.ts' }])
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents
  const events = trace.filter((event) => event.name === 'codegraph.provisional-refresh' || event.name === 'codegraph.background-validation')

  assert.deepEqual(events.map(({ name, args }) => ({ name, revision: args.revision, freshness: args.freshness, coverage: args.coverage, status: args.status })), [
    { name: 'codegraph.provisional-refresh', revision: 1, freshness: 'provisional', coverage: 'module-linked-syntax', status: 'ok' },
    { name: 'codegraph.background-validation', revision: 1, freshness: 'validated', coverage: 'calls', status: 'ok' },
  ])
})

test('domain analysis: fast refresh profiles provisional work separately from background validation and reports exact revision metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-provisional-refresh-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath, validationWorkerFactory: () => ({ validate: async (snapshot) => snapshot, dispose: async () => {} }) })
  await engine.build()

  const refreshed = engine.applyChanges([{ type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' }])
  await refreshed.validation
  const events = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.filter((event) => event.name === 'codegraph.provisional-refresh' || event.name === 'codegraph.background-validation')

  assert.deepEqual(events.map(({ name, args }) => ({ name, revision: args.revision, freshness: args.freshness, coverage: args.coverage, status: args.status })), [
    { name: 'codegraph.provisional-refresh', revision: 1, freshness: 'provisional', coverage: 'module-linked-syntax', status: 'ok' },
    { name: 'codegraph.background-validation', revision: 1, freshness: 'validated', coverage: 'calls', status: 'ok' },
  ])
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

test('domain analysis: detailed profiling emits one analyzer-compatible complete event per file and parser subphase with literal counters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-detail-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b'; export function a(){ return b() }\n")
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(){ return 1 }\n')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  await engine.build()
  const detailed = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.filter((event) => event.args?.file)

  assert.deepEqual(detailed.map((event) => ({ name: event.name, file: event.args.file, phase: event.ph, category: event.cat, counterKeys: Object.keys(event.args).filter((key) => key !== 'file').sort() })), [
    { name: 'collect-file-syntax', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['declarationCount', 'descendantTraversals', 'identifierCount'] },
    { name: 'collect-file-syntax', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['declarationCount', 'descendantTraversals', 'identifierCount'] },
    { name: 'exports', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['exportsVisited'] },
    { name: 'identifiers-symbol-resolution', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['aliases', 'calls', 'declarationProbes', 'edges', 'noOwner', 'nonCalls', 'selfTarget', 'symbolMissing', 'targetMissing', 'total'] },
    { name: 'dependencies', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['candidates', 'dependencyDecls', 'resolved', 'unresolved'] },
    { name: 'source-hash', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['sourceBytes'] },
    { name: 'partition-hash', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['partitionBytes'] },
    { name: 'partition-write', file: 'src/a.ts', phase: 'X', category: 'codegraph', counterKeys: ['cacheWrite', 'partitionBytes'] },
    { name: 'exports', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['exportsVisited'] },
    { name: 'identifiers-symbol-resolution', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['aliases', 'calls', 'declarationProbes', 'edges', 'noOwner', 'nonCalls', 'selfTarget', 'symbolMissing', 'targetMissing', 'total'] },
    { name: 'dependencies', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['candidates', 'dependencyDecls', 'resolved', 'unresolved'] },
    { name: 'source-hash', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['sourceBytes'] },
    { name: 'partition-hash', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['partitionBytes'] },
    { name: 'partition-write', file: 'src/b.ts', phase: 'X', category: 'codegraph', counterKeys: ['cacheWrite', 'partitionBytes'] },
  ])
})

test('boundary values: a declaration-free file still emits exactly one event for every detailed subphase with zero counters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-detail-empty-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'empty.ts'), '')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  await engine.build()
  const detailed = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.filter((event) => event.args?.file === 'src/empty.ts')

  assert.deepEqual(detailed.map((event) => ({ name: event.name, args: event.name === 'partition-hash' || event.name === 'partition-write' ? { ...event.args, partitionBytesIsPositiveInteger: Number.isInteger(event.args.partitionBytes) && event.args.partitionBytes > 0, partitionBytes: undefined } : event.args })), [
    { name: 'collect-file-syntax', args: { file: 'src/empty.ts', descendantTraversals: 1, declarationCount: 0, identifierCount: 0 } },
    { name: 'exports', args: { file: 'src/empty.ts', exportsVisited: 0 } },
    { name: 'identifiers-symbol-resolution', args: { file: 'src/empty.ts', total: 0, noOwner: 0, symbolMissing: 0, aliases: 0, targetMissing: 0, selfTarget: 0, edges: 0, calls: 0, nonCalls: 0, declarationProbes: 0 } },
    { name: 'dependencies', args: { file: 'src/empty.ts', dependencyDecls: 0, resolved: 0, unresolved: 0, candidates: 0 } },
    { name: 'source-hash', args: { file: 'src/empty.ts', sourceBytes: 0 } },
    { name: 'partition-hash', args: { file: 'src/empty.ts', partitionBytes: undefined, partitionBytesIsPositiveInteger: true } },
    { name: 'partition-write', args: { file: 'src/empty.ts', partitionBytes: undefined, cacheWrite: 1, partitionBytesIsPositiveInteger: true } },
  ])
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

test('domain analysis: identifier resolution profiling partitions every identifier through one terminal outcome and every edge by call shape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-identifier-outcomes-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', noEmit: true }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'dependency.ts'), 'export function dependency(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'subject.ts'), "import { dependency as imported } from './dependency'\nexport function subject(parameter: number){ subject; parameter; missingName; imported; return imported() }\n")
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  await engine.build()
  const event = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.find((candidate) => candidate.name === 'identifiers-symbol-resolution' && candidate.args.file === 'src/subject.ts')

  assert.deepEqual(event.args, {
    file: 'src/subject.ts',
    total: 9,
    noOwner: 0,
    symbolMissing: 0,
    aliases: 1,
    targetMissing: 0,
    selfTarget: 0,
    edges: 1,
    calls: 1,
    nonCalls: 0,
    declarationProbes: 1,
  })
})

test('boundary values: identifier resolution profiling reconciles an empty file with every counter at zero', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-identifier-empty-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'empty.ts'), '')
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })

  await engine.build()
  const event = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.find((candidate) => candidate.name === 'identifiers-symbol-resolution')

  assert.deepEqual(event.args, { file: 'src/empty.ts', total: 0, noOwner: 0, symbolMissing: 0, aliases: 0, targetMissing: 0, selfTarget: 0, edges: 0, calls: 0, nonCalls: 0, declarationProbes: 0 })
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
    edges: [],
  })
})

test('domain analysis and hotpath regression: one descendant walk per file indexes declarations and identifiers without kind-specific fallback', () => {
  const root = '/tmp/cg-one-pass-fixture'
  const sources = new Map([
    ['src/a.ts', "import { b } from './b'; export function z(){ return b() }\nexport const a = z()\n"],
    ['src/b.ts', 'export function b(){ return 1 }\n'],
  ])
  const project = createSemanticProject(root, sources)
  const traversals = new Map()

  for (const file of project.getSourceFiles()) {
    traversals.set(file.getBaseName(), 0)
    const walk = file.forEachDescendant.bind(file)
    file.forEachDescendant = (...args) => {
      traversals.set(file.getBaseName(), traversals.get(file.getBaseName()) + 1)
      return walk(...args)
    }
    file.getDescendantsOfKind = () => { throw new Error(`kind-specific descendant fallback used for ${file.getBaseName()}`) }
  }

  const context = prepareSemanticProject(project, root)
  const a = parsePartition('src/a.ts', sources.get('src/a.ts'), new Set(['src/a.ts', 'src/b.ts']), context)
  const b = parsePartition('src/b.ts', sources.get('src/b.ts'), new Set(['src/a.ts', 'src/b.ts']), context)

  assert.deepEqual({ traversals: Object.fromEntries(traversals), partitions: [a, b] }, {
    traversals: { 'a.ts': 1, 'b.ts': 1 },
    partitions: [
      {
        file: 'src/a.ts',
        sourceHash: '806358c49b0ff2eee9e2378fd033004819930bf85ceecbf7d1d7b3c26ecbb2f7',
        symbols: [
          { id: '39d29ade4a34dea5e9d8e826', file: 'src/a.ts', name: 'z', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
          { id: '15c29361acdf05e1efdf95f0', file: 'src/a.ts', name: 'a', kind: 'variable', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        ],
        edges: [
          { from: '39d29ade4a34dea5e9d8e826', to: '6d1f36a6e18b5f8677635dc0', line: 1, call: true },
          { from: '15c29361acdf05e1efdf95f0', to: '39d29ade4a34dea5e9d8e826', line: 2, call: true },
        ],
        dependencies: ['src/b.ts'],
        unresolved: [],
      },
      {
        file: 'src/b.ts',
        sourceHash: 'e21cb4b885a9027e3c6384b92f6b7d1d8f93a4beaac235270341532dd57b65b0',
        symbols: [{ id: '6d1f36a6e18b5f8677635dc0', file: 'src/b.ts', name: 'b', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
        edges: [],
        dependencies: [],
        unresolved: [],
      },
    ],
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

test('domain analysis: cold refs records one enrichment phase while warm refs reuses the atomic overlay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-lazy-overlay-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const tracePath = path.join(root, 'profile.json')
  const engine = new CodeGraphEngine(root, { profile: tracePath })
  await engine.build()

  for await (const ignored of engine.query({ type: 'refs', name: 'value' })) void ignored
  for await (const ignored of engine.query({ type: 'refs', name: 'value' })) void ignored
  const phases = JSON.parse(fs.readFileSync(tracePath, 'utf8')).traceEvents.filter((event) => event.name === 'reference-overlay').map((event) => event.name)

  assert.deepEqual(phases, ['reference-overlay'])
})
