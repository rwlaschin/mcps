import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const packageRoot = path.resolve(import.meta.dirname, '..')
const driver = String.raw`
(async () => {
  const crypto = require('node:crypto')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { SemanticCheckerWorker } = await import('./semantic-checker-worker.mjs')
  const sources = [
    ['src/a.ts', 'export function a(x){ return x ? a(x - 1) : 0 }'],
    ['src/b.ts', 'import { a } from "./a"; export const b = a(1)'],
  ]
  const sourceBlobs = Object.fromEntries(sources.map(([file, source]) => [file, crypto.createHash('sha256').update(source).digest('hex')]))
  const buffer = new SharedArrayBuffer(4096 + 300 * 65536)
  const metadata = new Int32Array(buffer, 0, 1024)
  metadata[3] = 300
  for (let slot = 0; slot < 300; slot += 1) metadata[4 + slot] = slot
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-worker-diagnostic-'))
  const worker = new SemanticCheckerWorker()
  const cold = await worker.index({ root, generation: 'cold-generation', sources, sourceBlobs, partitionPool: buffer, partitionPoolDebugId: 'cold-test' }, () => {})
  const changedSource = 'export function a(x){ return x ? a(x - 2) : 0 }'
  const sourceDir = path.join(root, '.codegraph', 'sources')
  fs.mkdirSync(sourceDir, { recursive: true })
  const incremental = await worker.validate({ root, revision: 1, baseGeneration: 'cold-generation', baseSourceBlobs: sourceBlobs, sourceDir, changes: [{ type: 'change', path: 'src/a.ts', source: changedSource }], partitionPool: buffer, partitionPoolDebugId: 'incremental-test' }, () => {})
  const globalSource = 'export {}; declare global { interface Window { diagnostic: boolean } }'
  const global = await worker.validate({ root, revision: 2, baseGeneration: 'cold-generation', baseSourceBlobs: { ...sourceBlobs, 'src/a.ts': crypto.createHash('sha256').update(changedSource).digest('hex') }, sourceDir, changes: [{ type: 'change', path: 'src/a.ts', source: globalSource }], partitionPool: buffer, partitionPoolDebugId: 'global-test' }, () => {})
  process.stdout.write(JSON.stringify([cold, incremental, global].map(({ mode, sourceBlobs }) => ({ mode, files: Object.keys(sourceBlobs).sort() }))))
  await new Promise((resolve) => setTimeout(resolve, 100))
  await worker.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})()
`

const run = (enabled) => {
  const env = { ...process.env }
  if (enabled) env.CODEGRAPH_DEBUG_POOL = '1'
  else delete env.CODEGRAPH_DEBUG_POOL
  return spawnSync(process.execPath, ['-e', driver], { cwd: packageRoot, env, encoding: 'utf8', timeout: 10_000 })
}

const handoffDriver = String.raw`
(async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { CodeGraphEngine } = await import('./tool-engine.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-handoff-diagnostic-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1 }\n')
  for (const suffix of ['01', '02', '03', '04', '05', '06', '07', '08']) {
    fs.writeFileSync(path.join(root, 'src', 'use' + suffix + '.ts'), "import { a } from './a'; export function use" + suffix + "(){ return a() }\n")
  }
  const engine = new CodeGraphEngine(root, { cacheDir: '.handoff-cache' })
  await engine.build()
  const changed = engine.applyChanges([{ type: 'change', path: 'src/a.ts', source: 'export function a(){ return 2 }\n' }])
  await changed.validation
  await engine.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})()
`

const runHandoff = (enabled) => {
  const env = { ...process.env }
  if (enabled) env.CODEGRAPH_DEBUG_POOL = '1'
  else delete env.CODEGRAPH_DEBUG_POOL
  return spawnSync(process.execPath, ['-e', handoffDriver], { cwd: packageRoot, env, encoding: 'utf8', timeout: 20_000 })
}

const handoffEvents = new Set(['Worker Publish Batch', 'Main Receive Batch', 'Main Start Batch', 'Main Complete Batch'])
const perFileEvents = new Set(['Worker Load File', 'Worker Finish Parsing File', 'Worker Create Info Object', 'Worker Update Info Object', 'Worker Complete Info Object'])
const semanticTimingFields = ['projectCreateMs', 'syntaxCollectionMs', 'structuralCfgMs', 'exportsMs', 'identifierResolutionMs', 'internalRelationsMs', 'encodingMs', 'completeEdgeMaterializationMs', 'refsLookupMs']
const summaries = (stderr, event) => stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.event === event)
const parseHandoffs = (stderr) => stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter(({ event }) => handoffEvents.has(event))
const metadataMatches = (left, right) => ['requestId', 'poolId', 'batchId', 'final', 'partitionCount', 'slotCount'].every((field) => left[field] === right[field])
const correlatedBatches = (records) => records.filter(({ event }) => event === 'Worker Publish Batch').map((worker) => {
  const main = records.filter(({ event, batchId }) => event.startsWith('Main ') && batchId === worker.batchId)
  return {
    batchId: worker.batchId,
    final: worker.final,
    partitionCount: worker.partitionCount,
    slotCount: worker.slotCount,
    mainEvents: main.map(({ event }) => event),
    mainMetadataMatches: main.length === 3 && main.every((record) => metadataMatches(worker, record)),
  }
})

test('equivalence partition: worker-to-main batch diagnostics remain silent when debug mode is disabled', () => {
  const result = runHandoff(false)
  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 0, stderr: '' })
})

test('cold handoff state machine: every worker publication is received, started, and completed once by main with identical batch metadata', () => {
  const result = runHandoff(true)
  assert.equal(result.status, 0, result.stderr)
  const allRecords = result.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const records = allRecords.filter(({ event, requestId }) => handoffEvents.has(event) && requestId === 1)
  const publications = records.filter(({ event }) => event === 'Worker Publish Batch')
  assert.deepEqual({
    status: result.status,
    batches: correlatedBatches(records),
    workerLifecycle: publications.map(({ event }) => event),
    mainLifecycle: records.filter(({ event }) => event.startsWith('Main ')).map(({ event }) => event),
    partitionTotal: publications.reduce((total, { partitionCount }) => total + partitionCount, 0),
    partitionCountIsNotSlotCount: publications.some(({ partitionCount, slotCount }) => slotCount > partitionCount),
  }, {
    status: 0,
    batches: [
      { batchId: 1, final: false, partitionCount: 1, slotCount: 1, mainEvents: ['Main Receive Batch', 'Main Start Batch', 'Main Complete Batch'], mainMetadataMatches: true },
      { batchId: 2, final: true, partitionCount: 8, slotCount: 8, mainEvents: ['Main Receive Batch', 'Main Start Batch', 'Main Complete Batch'], mainMetadataMatches: true },
    ],
    workerLifecycle: ['Worker Publish Batch', 'Worker Publish Batch'],
    mainLifecycle: ['Main Receive Batch', 'Main Start Batch', 'Main Complete Batch', 'Main Receive Batch', 'Main Start Batch', 'Main Complete Batch'],
    partitionTotal: 9,
    partitionCountIsNotSlotCount: false,
  })
})

test('batch-age boundary: nine fast partitions do not cause the old eight-partition non-final flush and the final flush is exempt', () => {
  const result = runHandoff(true)
  assert.equal(result.status, 0, result.stderr)
  const publications = parseHandoffs(result.stderr).filter(({ event, requestId }) => event === 'Worker Publish Batch' && requestId === 1)
  assert.deepEqual(publications.map(({ final, partitionCount }) => ({ final, partitionCount })), [
    { final: false, partitionCount: 1 },
    { final: true, partitionCount: 8 },
  ])
})

test('incremental handoff state machine: changing a dependency publishes exactly its one changed partition in a correlated batch', () => {
  const result = runHandoff(true)
  assert.equal(result.status, 0, result.stderr)
  const records = parseHandoffs(result.stderr).filter(({ requestId }) => requestId === 3)
  const publications = records.filter(({ event }) => event === 'Worker Publish Batch')
  assert.deepEqual({ status: result.status, batches: correlatedBatches(records), partitionTotal: publications.reduce((total, { partitionCount }) => total + partitionCount, 0) }, {
    status: 0,
    batches: [
      { batchId: 1, final: false, partitionCount: 1, slotCount: 1, mainEvents: ['Main Receive Batch', 'Main Start Batch', 'Main Complete Batch'], mainMetadataMatches: true },
    ],
    partitionTotal: 1,
  })
})

test('equivalence partition: aggregate semantic diagnostics preserve receipts, stay silent when disabled, and remove per-file events when enabled', () => {
  const disabled = run(false)
  const enabled = run(true)
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.equal(enabled.status, 0, enabled.stderr)
  const enabledEvents = enabled.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).map(({ event }) => event)

  assert.deepEqual(
    { disabledStatus: disabled.status, enabledStatus: enabled.status, disabledStderr: disabled.stderr, disabledReceipt: disabled.stdout, enabledReceipt: enabled.stdout, forbiddenEvents: enabledEvents.filter((event) => perFileEvents.has(event)) },
    { disabledStatus: 0, enabledStatus: 0, disabledStderr: '', disabledReceipt: '[{"mode":"full","files":["src/a.ts","src/b.ts"]},{"mode":"delta","files":["src/a.ts"]},{"mode":"delta","files":["src/a.ts"]}]', enabledReceipt: '[{"mode":"full","files":["src/a.ts","src/b.ts"]},{"mode":"delta","files":["src/a.ts"]},{"mode":"delta","files":["src/a.ts"]}]', forbiddenEvents: [] },
  )
})

test('domain analysis: full, delta, and full-fallback operations emit one correlated summary with bounded semantic phases', () => {
  const result = run(true)
  assert.equal(result.status, 0, result.stderr)
  const records = summaries(result.stderr, 'Worker Semantic Timing Summary')
  const shape = records.map((record) => ({
    requestId: record.requestId,
    poolId: record.poolId,
    mode: record.mode,
    fields: semanticTimingFields.filter((field) => Number.isFinite(record[field]) && record[field] >= 0),
    bounded: record.projectCreateMs + record.syntaxCollectionMs + record.structuralCfgMs + record.exportsMs + record.identifierResolutionMs + record.internalRelationsMs + record.encodingMs + record.completeEdgeMaterializationMs + record.refsLookupMs <= record.operationElapsedMs + 1,
  }))

  assert.deepEqual(shape, [
    { requestId: 1, poolId: 'cold-test', mode: 'full', fields: semanticTimingFields, bounded: true },
    { requestId: 2, poolId: 'incremental-test', mode: 'delta', fields: semanticTimingFields, bounded: true },
    { requestId: 3, poolId: 'global-test', mode: 'delta', fields: semanticTimingFields, bounded: true },
  ])
})

test('diagnostic summaries report full, delta, and global-scoped full validation with correlated transport counters and timings', () => {
  const workerResult = run(true)
  const handoffResult = runHandoff(true)
  assert.equal(workerResult.status, 0, workerResult.stderr)
  assert.equal(handoffResult.status, 0, handoffResult.stderr)
  const worker = summaries(workerResult.stderr, 'Worker Shared Memory Summary')
  const main = summaries(handoffResult.stderr, 'Main Shared Memory Summary')
  assert.deepEqual(worker.map(({ requestId, poolId, mode }) => ({ requestId, poolId, mode })), [
    { requestId: 1, poolId: 'cold-test', mode: 'full' },
    { requestId: 2, poolId: 'incremental-test', mode: 'delta' },
    { requestId: 3, poolId: 'global-test', mode: 'delta' },
  ])
  for (const record of [...worker, ...main]) {
    for (const field of ['recordsAttempted', 'recordsStreamed', 'recordsPersisted', 'bytesCopied', 'wraparounds', 'capacityFailures']) assert.equal(Number.isInteger(record[field]) && record[field] >= 0, true, `${field}: ${JSON.stringify(record)}`)
    for (const field of record.event.startsWith('Worker') ? ['parseMs', 'transportMs'] : ['workerParseMs', 'transportMs', 'persistenceMs']) assert.equal(Number.isFinite(record[field]) && record[field] >= 0, true, `${field}: ${JSON.stringify(record)}`)
    assert.equal(record.recordsAttempted, record.recordsStreamed + record.recordsPersisted)
  }
  assert.deepEqual(main.map(({ requestId, mode }) => ({ requestId, mode })), [{ requestId: 1, mode: 'full' }, { requestId: 3, mode: 'delta' }])
  for (const record of main) {
    const matchingWorker = summaries(handoffResult.stderr, 'Worker Shared Memory Summary').find(({ requestId, poolId }) => requestId === record.requestId && poolId === record.poolId)
    assert.deepEqual(Object.fromEntries(['mode', 'recordsAttempted', 'recordsStreamed', 'recordsPersisted', 'bytesCopied', 'wraparounds', 'capacityFailures', 'transportMs'].map((field) => [field, record[field]])), Object.fromEntries(['mode', 'recordsAttempted', 'recordsStreamed', 'recordsPersisted', 'bytesCopied', 'wraparounds', 'capacityFailures', 'transportMs'].map((field) => [field, matchingWorker[field]])))
    assert.equal(record.workerParseMs, matchingWorker.parseMs)
  }
})

test('301st shared-memory record falls back to worker persistence and reports one capacity failure', () => {
  const source = String.raw`
(async () => {
  const crypto = require('node:crypto')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { SemanticCheckerWorker } = await import('./semantic-checker-worker.mjs')
  const sources = Array.from({ length: 301 }, (_, index) => ['src/f' + index + '.ts', 'export const value' + index + ' = ' + index])
  const sourceBlobs = Object.fromEntries(sources.map(([file, text]) => [file, crypto.createHash('sha256').update(text).digest('hex')]))
  const buffer = new SharedArrayBuffer(4096 + 300 * 65536)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-capacity-diagnostic-'))
  const worker = new SemanticCheckerWorker()
  await worker.index({ root, cacheDir: '.cache', generation: 'capacity-generation', sources, sourceBlobs, partitionPool: buffer, partitionPoolDebugId: 'capacity-test' }, () => {})
  await new Promise((resolve) => setTimeout(resolve, 100))
  await worker.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})()
`
  const env = { ...process.env, CODEGRAPH_DEBUG_POOL: '1' }
  const result = spawnSync(process.execPath, ['-e', source], { cwd: packageRoot, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
  const [summary] = summaries(result.stderr, 'Worker Shared Memory Summary')
  const [failure] = summaries(result.stderr, 'Worker Shared Memory Capacity Failure')
  assert.ok(summary, result.stderr)
  assert.deepEqual({ file: failure.file, payloadBytesIsExactInteger: Number.isInteger(failure.payloadBytes) && failure.payloadBytes > 0 }, { file: 'src/f300.ts', payloadBytesIsExactInteger: true })
  assert.deepEqual({ status: result.status, recordsAttempted: summary.recordsAttempted, recordsStreamed: summary.recordsStreamed, recordsPersisted: summary.recordsPersisted, capacityFailures: summary.capacityFailures }, { status: 0, recordsAttempted: 301, recordsStreamed: 300, recordsPersisted: 1, capacityFailures: 1 })
})

test('oversized journal record reports its file and exact payload bytes before preserving the allocator failure', () => {
  const source = String.raw`
(async () => {
  const crypto = require('node:crypto')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oversized-diagnostic-'))
  const { SemanticCheckerWorker } = await import('./semantic-checker-worker.mjs')
  const { createSemanticProject, parsePartition, prepareSemanticProject } = await import('./parser.mjs')
  const { symbolPartitionLayout } = await import('./store.mjs')
  const file = 'src/oversized.ts'
  const text = 'export const ' + 'a'.repeat(2_200_000) + ' = 1'
  const context = prepareSemanticProject(createSemanticProject(root, new Map([[file, text]])), root)
  const { internalPartition, internalFingerprint, ...symbolPartition } = parsePartition(file, text, new Set([file]), context)
  process.stdout.write(String(symbolPartitionLayout(symbolPartition).byteLength + internalPartition.byteLength))
  const worker = new SemanticCheckerWorker()
  const buffer = new SharedArrayBuffer(4096 + 300 * 65536)
  await worker.index({ root, generation: 'oversized-generation', sources: [[file, text]], sourceBlobs: { [file]: crypto.createHash('sha256').update(text).digest('hex') }, partitionPool: buffer, partitionPoolDebugId: 'oversized-test' }, () => {}).then(() => { throw new Error('expected oversized journal failure') }, async (error) => { if (error.message !== 'journal record exceeds allocation header capacity') throw error; await worker.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
})()
`
  const result = spawnSync(process.execPath, ['-e', source], { cwd: packageRoot, env: { ...process.env, CODEGRAPH_DEBUG_POOL: '1' }, encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
  const [failure] = summaries(result.stderr, 'Worker Shared Memory Capacity Failure')
  assert.deepEqual({ file: failure.file, exactPayloadBytes: failure.payloadBytes }, { file: 'src/oversized.ts', exactPayloadBytes: Number(result.stdout) })
  assert.equal(failure.payloadBytes >= 0xFFFF * 32 - 2, true)
})
