import { Worker, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EDGE_COVERAGE } from './edge-coverage.mjs'
import { decodeSymbolPartition, GraphStore, symbolPartitionLayout, writeSymbolPartition } from './store.mjs'
import { deriveWorkerProfile } from './worker-profile.mjs'
import { createCachedReferenceIndex, repairCachedReferences, updateCachedGraphFacts, cachedUnresolvedEdges, cachedPublicationEdgePatches } from './cached-binding-resolver.mjs'

export { deriveWorkerProfile }

let createSemanticProject, readOneFileCompilerOptions, createOneFileSemanticSession, parsePartition, prepareSemanticProject, refreshSemanticFiles
const semanticWorker = !isMainThread && workerData?.semanticChecker === true
if (semanticWorker) {
  ({ createSemanticProject, readOneFileCompilerOptions, parsePartition, prepareSemanticProject, refreshSemanticFiles } = await import('./parser.mjs'))
  ;({ createOneFileSemanticSession } = await import('./one-file-semantic-library.mjs'))
}

// Retain owned syntax sessions and partition facts across changed-file validations.
let cache = null
let semanticOperationId = 0
let semanticStructuralWindow = 1
const structuralPending = new Map()

async function* structuralPartitions(context, sources, diagnostics) {
  if (semanticStructuralWindow === 0) {
    const { buildInternalGraph } = await import('./internal-graph.mjs')
    context.deferStructuralGraph = true
    context.preparedStructuralGraphs = new Map()
    for (const [file, source] of sources) {
      context.preparedStructuralGraphs.set(path.resolve(context.root, file), buildInternalGraph({ file, source, compilerOptions: context.project.getCompilerOptions() }))
      diagnostics.structuralJobsDispatched += 1
      yield [file, source]
    }
    return
  }
  const iterator = sources.entries()
  const pending = new Map()
  const workers = new Set()
  const compilerOptions = context.project.getCompilerOptions()
  context.deferStructuralGraph = true
  context.preparedStructuralGraphs = new Map()
  const enqueue = () => {
    const next = iterator.next()
    if (next.done) return
    const [file, source] = next.value
    const promise = new Promise((resolve, reject) => {
      structuralPending.set(file, { resolve, reject })
      parentPort.postMessage({ id: semanticOperationId, structuralRequest: { mode: 'structural', path: file, fileId: file, revision: semanticOperationId, source, compilerOptions } })
    }).then(result => ({ result }), error => ({ error }))
    pending.set(file, { source, promise })
    diagnostics.structuralJobsDispatched += 1
  }
  for (let index = 0; index < semanticStructuralWindow; index += 1) enqueue()
  while (pending.size) {
    const [file, job] = pending.entries().next().value
    const started = performance.now()
    const { result, error } = await job.promise
    const waited = performance.now() - started
    diagnostics.structuralPoolMs += waited
    if (context.semanticTiming) context.semanticTiming.structuralCfgMs += waited
    if (error) throw error
    workers.add(result.workerIndex)
    diagnostics.structuralWorkersUsed = workers.size
    pending.delete(file)
    context.preparedStructuralGraphs.set(path.resolve(context.root, file), result.graph)
    yield [file, job.source]
    enqueue()
  }
}

const POOL_JOB_COUNT = 300
const POOL_CANCELLED = 0
const POOL_WRITE_SEQUENCE = 1
const POOL_READ_SEQUENCE = 2
const POOL_WRITE_CURSOR = 3
const POOL_GENERATION = 4
const POOL_READ_CURSOR = 5
const POOL_HEADER_BYTES = 4096
const POOL_ARENA_BYTES = POOL_JOB_COUNT * 65536
const POOL_BYTES = POOL_HEADER_BYTES + POOL_ARENA_BYTES
const MAX_BATCH_JOBS = 8
const MAX_BATCH_AGE_MS = 100
const DEBUG_POOL = process.env.CODEGRAPH_DEBUG_POOL === '1'
const debugPool = (event, requestId, poolId, detail = {}) => {
  if (DEBUG_POOL) process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), epochMs: Date.now(), monotonicMs: performance.now(), pid: process.pid, threadId, side: 'worker', event, requestId, poolId, ...detail })}\n`)
}

export function appendJournalRecord(state, payload, activeRecords = 0) {
  const payloadLength = typeof payload === 'number' ? payload : payload.byteLength
  const allocation = Math.ceil((2 + payloadLength) / 32) * 32
  const bytes = state.memoryBuffer instanceof Uint8Array ? state.memoryBuffer : new Uint8Array(state.memoryBuffer)
  const allocationUnits = allocation / 32
  if (allocationUnits >= 0xFFFF) throw new Error('journal record exceeds allocation header capacity')
  const empty = activeRecords === 0
  if (!empty && state.insertionPointer === state.oldestActivePartition) return null
  if (!empty && state.insertionPointer < state.oldestActivePartition && allocation > state.oldestActivePartition - state.insertionPointer) return null
  if (state.insertionPointer + allocation > bytes.byteLength) {
    if (!empty && allocation > state.oldestActivePartition) return null
    bytes[state.insertionPointer] = 0xFF; bytes[state.insertionPointer + 1] = 0xFF; state.insertionPointer = 0
  }
  const header = state.insertionPointer
  bytes[header] = allocationUnits & 0xFF; bytes[header + 1] = allocationUnits >>> 8
  if (typeof payload !== 'number') bytes.set(payload, header + 2)
  state.insertionPointer = header + allocation
  if (state.insertionPointer === bytes.byteLength) state.insertionPointer = 0
  return { offset: header + 2, length: payloadLength }
}

export function advanceJournalPointer(state) {
  const bytes = state.memoryBuffer instanceof Uint8Array ? state.memoryBuffer : new Uint8Array(state.memoryBuffer)
  const units = bytes[state.oldestActivePartition] | bytes[state.oldestActivePartition + 1] << 8
  state.oldestActivePartition = (state.oldestActivePartition + units * 32) % bytes.byteLength
  if ((bytes[state.oldestActivePartition] | bytes[state.oldestActivePartition + 1] << 8) === 0xFFFF) state.oldestActivePartition = 0
}

const assertPoolActive = (metadata) => { if (Atomics.load(metadata, POOL_CANCELLED)) throw new Error('semantic partition pool cancelled') }
const reserveJobCounter = (metadata) => { const write = Atomics.load(metadata, POOL_WRITE_SEQUENCE); if (write - Atomics.load(metadata, POOL_READ_SEQUENCE) >= POOL_JOB_COUNT) return -1; Atomics.store(metadata, POOL_WRITE_SEQUENCE, write + 1); return write % POOL_JOB_COUNT }
const openPartitionPool = (buffer) => {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== POOL_BYTES) throw new Error('malformed semantic partition pool')
  const metadata = new Int32Array(buffer, 0, POOL_HEADER_BYTES / 4); const payload = new Uint8Array(buffer, POOL_HEADER_BYTES)
  return { buffer, metadata, payload, memoryBuffer: payload, insertionPointer: metadata[POOL_WRITE_CURSOR], oldestActivePartition: 0 }
}
const cancelPool = (buffer) => {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== POOL_BYTES) return
  const metadata = new Int32Array(buffer, 0, POOL_HEADER_BYTES / 4)
  Atomics.store(metadata, POOL_CANCELLED, 1)
}
const sameBlobs = (left, right) => {
  if (!left || !right) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}
const symbolPartitions = (partitions) => Object.fromEntries(Object.entries(partitions).map(([file, { internalPartition, internalFingerprint, ...partition }]) => [file, partition]))
const partitionFingerprints = (partitions) => Object.fromEntries(Object.entries(partitions).map(([file, partition]) => [file, partition.internalFingerprint]).filter(([, fingerprint]) => typeof fingerprint === 'string'))

function readSources(snapshot, sourceBlobs) {
  const sourceRoot = snapshot.sourceDir && path.resolve(snapshot.sourceDir)
  return new Map(Object.entries(sourceBlobs).map(([file, id]) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid SHA-256 source blob id: ${id}`)
    const target = path.resolve(sourceRoot, id); if (path.dirname(target) !== sourceRoot) throw new Error(`source blob path escapes sourceDir: ${id}`)
    const source = fs.readFileSync(target, 'utf8'); const digest = crypto.createHash('sha256').update(source).digest('hex'); if (digest !== id) throw new Error(`source blob digest mismatch: ${id}`)
    return [file, source]
  }))
}

function readPartitions(snapshot) {
  const root = path.resolve(snapshot.partitionDir)
  return Object.fromEntries(Object.entries(snapshot.basePartitionIds ?? {}).map(([file, id]) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid SHA-256 partition id: ${id}`)
    const target = path.resolve(root, `${id}.bin`)
    if (path.dirname(target) !== root) throw new Error(`partition path escapes partitionDir: ${id}`)
    const contents = fs.readFileSync(target); if (crypto.createHash('sha256').update(contents).digest('hex') !== id) throw new Error(`partition digest mismatch: ${id}`)
    const partition = decodeSymbolPartition(contents); if (partition.file !== file) throw new Error(`partition key/file mismatch: ${file}`)
    return [file, partition]
  }))
}

async function fullValidation(snapshot, sources, sourceBlobs, timing, timingMode = 'full-fallback') {
  const started = performance.now()
  const context = prepareSemanticProject(createSemanticProject(snapshot.root, sources), snapshot.root, null, timing)
  timing.projectCreateMs += performance.now() - started
  const structuralDiagnostics = { structuralWorkersUsed: 0, structuralJobsDispatched: 0, structuralPoolMs: 0 }
  const known = new Set(sources.keys()); const partitions = {}
  for await (const [file, source] of structuralPartitions(context, sources, structuralDiagnostics)) partitions[file] = parsePartition(file, source, known, context, null, EDGE_COVERAGE.COMPLETE)
  const cachedPartitions = symbolPartitions(partitions)
  cache = { root: path.resolve(snapshot.root), baseGeneration: snapshot.baseGeneration, sourceBlobs: { ...sourceBlobs }, sources, partitions: cachedPartitions, internalFingerprints: partitionFingerprints(partitions), referenceIndex: createCachedReferenceIndex(cachedPartitions), compilerOptions: context.project.getCompilerOptions(), semanticSessions: new Map(), context: null }
  return { revision: snapshot.revision, mode: 'full', timingMode, baseGeneration: snapshot.baseGeneration, sourceBlobs, partitions, structuralDiagnostics, semanticTraversalSummary: { ...context.semanticTraversalSummary } }
}

function ownedSnapshot(request, hydrate = false) {
  const { files, sources, sourceBlobs } = ownedSnapshotInput(request)
  const context = hydrate ? null : prepareSemanticProject(createSemanticProject(request.root, sources), request.root)
  const compilerOptions = hydrate ? readOneFileCompilerOptions(request.root) : context.project.getCompilerOptions()
  let partitions
  if (hydrate) {
    if (!request.partitions || typeof request.partitions !== 'object') throw new Error('malformed semantic hydrate partitions')
    const partitionFiles = Object.keys(request.partitions)
    if (partitionFiles.length !== files.length || partitionFiles.some((file) => !sources.has(file))) throw new Error('semantic partition membership mismatch')
    partitions = { ...request.partitions }
    for (const file of files) {
      const partition = partitions[file]
      if (!partition || partition.file !== file || partition.sourceHash !== sourceBlobs[file]) throw new Error(`semantic partition file/source hash mismatch: ${file}`)
    }
  } else {
    const known = new Set(files); partitions = {}
    for (const [file, source] of sources) partitions[file] = parsePartition(file, source, known, context, null, request.edgeCoverage ?? EDGE_COVERAGE.COMPLETE)
  }
  const internalFingerprints = hydrate ? { ...(request.internalFingerprints ?? {}) } : partitionFingerprints(partitions)
  if (hydrate && (Object.keys(internalFingerprints).length !== files.length || files.some((file) => typeof internalFingerprints[file] !== 'string'))) throw new Error('semantic internal fingerprint membership mismatch')
  const cachedPartitions = symbolPartitions(partitions)
  cache = { root: path.resolve(request.root), baseGeneration: request.generation ?? null, sourceBlobs, sources, partitions: cachedPartitions, internalFingerprints, referenceIndex: createCachedReferenceIndex(cachedPartitions, hydrate ? request.baseEdgePatches ?? request.edgePatches ?? [] : []), compilerOptions, semanticSessions: new Map(), context: null }
  return { mode: 'full', sourceBlobs, partitions }
}

function createBatchWriter(id, pool, traversalSummary, diagnostics) {
  let partitions = []; let startedAt = 0; let first = true; let batchId = 0
  const flush = (final = false, initial = false) => {
    if (!partitions.length) return
    batchId += 1
    const poolBatch = { requestId: id, poolId: pool.debugId, batchId, final: final || !initial && traversalSummary.remainingFiles === 0, partitionCount: partitions.length, slotCount: partitions.length }
    debugPool('Worker Publish Batch', id, pool.debugId, poolBatch)
    parentPort.postMessage({ id, progress: { partitions, semanticTraversalSummary: { ...traversalSummary }, ...(DEBUG_POOL ? { poolBatch } : {}) } })
    partitions = []; startedAt = 0
  }
  const writePartition = (file, ordinal, symbolPartition, internalBytes) => {
    diagnostics.recordsAttempted += 1
    const transportStarted = performance.now()
    const layout = symbolPartitionLayout(symbolPartition); const internalLength = internalBytes?.byteLength ?? 0; const length = layout.byteLength + internalLength
    if (DEBUG_POOL && Math.ceil((2 + length) / 32) >= 0xFFFF) fs.writeSync(2, `${JSON.stringify({ timestamp: new Date().toISOString(), epochMs: Date.now(), monotonicMs: performance.now(), pid: process.pid, threadId, side: 'worker', event: 'Worker Shared Memory Capacity Failure', requestId: id, poolId: pool.debugId, file, payloadBytes: length })}\n`)
    const counter = reserveJobCounter(pool.metadata)
    if (counter < 0) { diagnostics.capacityFailures += 1; diagnostics.transportMs += performance.now() - transportStarted; debugPool('Worker Shared Memory Capacity Failure', id, pool.debugId, { file, payloadBytes: length }); return null }
    const previous = pool.insertionPointer; let generation = pool.metadata[POOL_GENERATION]
    pool.oldestActivePartition = pool.metadata[POOL_READ_CURSOR]
    const activeJobs = Atomics.load(pool.metadata, POOL_WRITE_SEQUENCE) - Atomics.load(pool.metadata, POOL_READ_SEQUENCE)
    const record = appendJournalRecord(pool, length, activeJobs - 1)
    if (!record) { Atomics.sub(pool.metadata, POOL_WRITE_SEQUENCE, 1); diagnostics.capacityFailures += 1; diagnostics.transportMs += performance.now() - transportStarted; debugPool('Worker Shared Memory Capacity Failure', id, pool.debugId, { file, payloadBytes: length }); return null }
    const offset = record.offset
    if (offset === 2 && previous !== 0) generation += 1
    writeSymbolPartition(symbolPartition, layout, pool.payload.subarray(offset, offset + layout.byteLength))
    if (internalBytes) pool.payload.set(internalBytes, offset + layout.byteLength)
    pool.metadata[POOL_WRITE_CURSOR] = pool.insertionPointer
    pool.metadata[POOL_GENERATION] = pool.insertionPointer === 0 ? generation + 1 : generation
    if (offset === 2 && previous !== 0 || pool.insertionPointer === 0) diagnostics.wraparounds += 1
    diagnostics.recordsStreamed += 1
    diagnostics.bytesCopied += length
    diagnostics.transportMs += performance.now() - transportStarted
    if (!partitions.length) startedAt = performance.now()
    partitions.push({ file, ordinal, counter, offset, length, generation, symbolLength: layout.byteLength, internalLength })
    if (first || partitions.length === MAX_BATCH_JOBS) { const initial = first; first = false; flush(false, initial) }
    return { symbolLength: layout.byteLength, internalLength }
  }
  const flushElapsed = () => { if (partitions.length && performance.now() - startedAt >= MAX_BATCH_AGE_MS) flush() }
  return { writePartition, flush, flushElapsed }
}

function persistWorkerPartition(store, file, sourceHash, symbolPartition, internalBytes, internalFingerprint) {
  const partitionId = store.writePartition(symbolPartition); const internalPartitionId = store.writeInternalPartition(internalBytes)
  const symbolLength = fs.statSync(path.join(store.partitions, `${partitionId}.bin`)).size
  return { file, sourceHash, writer: 'worker', partitionId, internalPartitionId, serializedLength: symbolLength + internalBytes.byteLength, chunkCount: 0, symbolLength, internalLength: internalBytes.byteLength, symbolChunkCount: 0, internalChunkCount: 0, internalFingerprint }
}

function streamValidationResult(id, request, result, semanticTiming, operationStarted) {
  const pool = openPartitionPool(request.partitionPool)
  pool.debugId = request.partitionPoolDebugId ?? id
  const diagnostics = { requestId: id, poolId: pool.debugId, recordsAttempted: 0, recordsStreamed: 0, recordsPersisted: 0, bytesCopied: 0, wraparounds: 0, capacityFailures: 0, parseMs: result.parseMs, transportMs: 0 }
  const batches = createBatchWriter(id, pool, result.semanticTraversalSummary ?? cache?.context?.semanticTraversalSummary ?? { completedFiles: 0, remainingFiles: 0, maximumTraversalsPerFile: 0 }, diagnostics)
  const partitionReceipts = []
  const store = new GraphStore(request.root, request.cacheDir)
  const files = Object.keys(result.partitions ?? {}).sort()
  const ordinals = new Map(Object.keys(result.sourceBlobs ?? {}).sort().map((file, ordinal) => [file, ordinal]))
  for (const file of files) {
    const ordinal = ordinals.get(file)
    const { internalPartition, internalFingerprint, ...symbolPartition } = result.partitions[file]
    const streamed = batches.writePartition(file, ordinal, symbolPartition, internalPartition)
    const internalLength = internalPartition?.byteLength ?? 0
    partitionReceipts.push(streamed ? { file, sourceHash: result.sourceBlobs[file], writer: 'engine', serializedLength: streamed.symbolLength + internalLength, chunkCount: 1, symbolLength: streamed.symbolLength, internalLength, symbolChunkCount: 1, internalChunkCount: 0, internalFingerprint } : (diagnostics.recordsPersisted += 1, persistWorkerPartition(store, file, result.sourceBlobs[file], symbolPartition, internalPartition, internalFingerprint)))
    batches.flushElapsed()
  }
  batches.flush(true)
  const { partitions, parseMs, ...metadata } = result
  debugPool('Worker Semantic Timing Summary', id, pool.debugId, { mode: result.timingMode ?? result.mode, ...semanticTiming, operationElapsedMs: performance.now() - operationStarted })
  debugPool('Worker Shared Memory Summary', id, pool.debugId, { mode: result.mode, ...diagnostics })
  delete metadata.timingMode
  return { ...metadata, partitionReceipts, ...(DEBUG_POOL ? { poolDiagnostics: diagnostics } : {}) }
}

async function streamOwnedSnapshot(id, request) {
  const operationStarted = performance.now()
  const semanticTiming = { projectCreateMs: 0, syntaxCollectionMs: 0, structuralCfgMs: 0, exportsMs: 0, identifierResolutionMs: 0, internalRelationsMs: 0, encodingMs: 0, completeEdgeMaterializationMs: 0, refsLookupMs: 0 }
  const { root, sources, sourceBlobs } = ownedSnapshotInput(request)
  const pool = openPartitionPool(request.partitionPool)
  pool.debugId = request.partitionPoolDebugId ?? id
  const contextStarted = performance.now()
  const context = prepareSemanticProject(createSemanticProject(root, sources), root, null, semanticTiming)
  semanticTiming.projectCreateMs += performance.now() - contextStarted
  const structuralDiagnostics = { structuralWorkersUsed: 0, structuralJobsDispatched: 0, structuralPoolMs: 0 }
  const known = new Set(sources.keys())
  const cachedPartitions = {}
  const internalFingerprints = {}
  const partitionReceipts = []
  const diagnostics = { requestId: id, poolId: pool.debugId, recordsAttempted: 0, recordsStreamed: 0, recordsPersisted: 0, bytesCopied: 0, wraparounds: 0, capacityFailures: 0, parseMs: performance.now() - contextStarted, transportMs: 0 }
  const batches = createBatchWriter(id, pool, context.semanticTraversalSummary, diagnostics)
  const store = new GraphStore(request.root, request.cacheDir)
  const ordinals = new Map([...sources.keys()].sort().map((file, ordinal) => [file, ordinal]))
  for await (const [file, source] of structuralPartitions(context, sources, structuralDiagnostics)) {
    assertPoolActive(pool.metadata)
    const partitionStarted = performance.now()
    const partition = parsePartition(file, source, known, context, null, request.edgeCoverage ?? EDGE_COVERAGE.COMPLETE)
    diagnostics.parseMs += performance.now() - partitionStarted
    const { internalPartition, internalFingerprint, ...symbolPartition } = partition
    const ordinal = ordinals.get(file)
    cachedPartitions[file] = symbolPartition
    if (typeof internalFingerprint === 'string') internalFingerprints[file] = internalFingerprint
    const internalBytes = internalPartition
    const streamed = batches.writePartition(file, ordinal, symbolPartition, internalBytes)
    partitionReceipts.push(streamed ? { file, sourceHash: sourceBlobs[file], writer: 'engine', serializedLength: streamed.symbolLength + internalBytes.byteLength, chunkCount: 1, symbolLength: streamed.symbolLength, internalLength: internalBytes.byteLength, symbolChunkCount: 1, internalChunkCount: 0, internalFingerprint } : (diagnostics.recordsPersisted += 1, persistWorkerPartition(store, file, sourceBlobs[file], symbolPartition, internalBytes, internalFingerprint)))
    batches.flushElapsed()
  }
  batches.flush(true)
  assertPoolActive(pool.metadata)
  cache = { root: path.resolve(request.root), baseGeneration: request.generation ?? null, sourceBlobs, sources, partitions: cachedPartitions, internalFingerprints, referenceIndex: createCachedReferenceIndex(cachedPartitions), compilerOptions: context.project.getCompilerOptions(), semanticSessions: new Map(), context: null }
  partitionReceipts.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const semanticSessionStats = { ...context.project.getSourceFiles()[0]?.session.stats }
  debugPool('Worker Semantic Timing Summary', id, pool.debugId, { mode: 'full', ...semanticTiming, semanticSessionStats, operationElapsedMs: performance.now() - operationStarted })
  debugPool('Worker Shared Memory Summary', id, pool.debugId, { mode: 'full', ...diagnostics })
  return { mode: 'full', sourceBlobs, partitionReceipts, semanticSessionStats, semanticTraversalSummary: { ...context.semanticTraversalSummary }, poolDiagnostics: { ...structuralDiagnostics, ...(DEBUG_POOL ? diagnostics : {}) } }
}

function ownedSnapshotInput(request) {
  if (!request || typeof request.root !== 'string' || !Array.isArray(request.sources) || !request.sourceBlobs || typeof request.sourceBlobs !== 'object') throw new Error('malformed semantic ownership request')
  const files = request.sources.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw new Error('malformed semantic source entry')
    return entry[0]
  })
  const fileSet = new Set(files)
  if (fileSet.size !== files.length) throw new Error('duplicate semantic source membership')
  const sourceBlobs = { ...request.sourceBlobs }
  const blobFiles = Object.keys(sourceBlobs)
  if (blobFiles.length !== files.length || blobFiles.some((file) => !fileSet.has(file))) throw new Error('semantic source membership mismatch')
  const sources = new Map(request.sources)
  for (const [file, source] of sources) if (!/^[a-f0-9]{64}$/.test(sourceBlobs[file]) || crypto.createHash('sha256').update(source).digest('hex') !== sourceBlobs[file]) throw new Error(`semantic source hash mismatch: ${file}`)
  return { root: request.root, files, sources, sourceBlobs }
}

function validateSnapshot(snapshot, timing) {
  const workspaceRoot = path.resolve(snapshot.root)
  const sourceRoot = snapshot.sourceDir && path.resolve(snapshot.sourceDir)
  const changes = snapshot.changes ?? []
  const retainedCache = !snapshot.basePartitionIds && cache?.baseGeneration === snapshot.baseGeneration ? cache : null
  if (changes.length === 1 && retainedCache) {
    retainedCache.root = workspaceRoot
    const changed = changes[0]
    const retainedPartitions = retainedCache.partitions
    const retainedFingerprints = retainedCache.internalFingerprints
    const referenceIndex = retainedCache.referenceIndex
    const workCounters = { sourceMembershipCopied: 0, basePartitionsOpened: 0, changedPartitionsWritten: changed.type === 'unlink' ? 0 : 1, dependentSourcesRead: 0, repositoryRecordsMaterialized: 0, repositorySizedContainersAllocated: 0 }
    if (changed.type === 'unlink') {
      if (!retainedPartitions[changed.path] || !retainedCache.sourceBlobs[changed.path]) throw new Error(`single-file semantic unlink cannot remove: ${changed.path}`)
      delete retainedPartitions[changed.path]
      delete retainedFingerprints[changed.path]
      delete retainedCache.sourceBlobs[changed.path]
      retainedCache.sources.delete(changed.path)
      const edgePatches = repairCachedReferences(referenceIndex, retainedPartitions, changed.path)
      const publicationChanges = updateCachedGraphFacts(referenceIndex, retainedPartitions, changed.path, edgePatches)
      retainedCache.context = null
      retainedCache.semanticSessions.delete(changed.path)
      return { revision: snapshot.revision, mode: 'delta', timingMode: 'delta', publicationChanges, baseGeneration: snapshot.baseGeneration, sourceBlobs: {}, partitions: {}, tombstones: [changed.path], edgePatches, unresolvedEdges: cachedUnresolvedEdges(referenceIndex), publicationEdgePatches: cachedPublicationEdgePatches(referenceIndex), workCounters, internalBuildCount: 0, internalRebuiltFiles: [], internalReusedFiles: [], semanticTraversalSummary: { completedFiles: 0, remainingFiles: 0, maximumTraversalsPerFile: 0 } }
    }
    let source = changed.source
    if (source === undefined) {
      if (path.isAbsolute(changed.path)) throw new Error(`changed source path must be relative: ${changed.path}`)
      const diskTarget = path.resolve(workspaceRoot, changed.path); const relative = path.relative(workspaceRoot, diskTarget)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`changed source path escapes root: ${changed.path}`)
      const realRoot = fs.realpathSync(workspaceRoot); const realTarget = fs.realpathSync(diskTarget); const realRelative = path.relative(realRoot, realTarget)
      if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`changed source path escapes root through symbolic link: ${changed.path}`)
      source = fs.readFileSync(realTarget, 'utf8')
    }
    const contentDigest = crypto.createHash('sha256').update(source).digest('hex')
    const parsedDigest = crypto.createHash('sha256').update(`${changed.path}\0${source}`).digest('hex')
    if (changed.expectedDigest !== undefined && changed.expectedDigest !== parsedDigest) throw new Error(`changed source digest mismatch after parse: ${changed.path}`)
    const target = path.resolve(sourceRoot, contentDigest); if (path.dirname(target) !== sourceRoot) throw new Error('changed source blob path escapes sourceDir'); if (!fs.existsSync(target)) fs.writeFileSync(target, source)
    const started = performance.now()
    const compilerOptions = readOneFileCompilerOptions(snapshot.root)
    const optionsKey = JSON.stringify(compilerOptions)
    retainedCache.compilerOptions = compilerOptions
    let retainedSession = retainedCache.semanticSessions.get(changed.path)
    if (!retainedSession || retainedSession.root !== workspaceRoot || retainedSession.optionsKey !== optionsKey) {
      retainedSession = { root: workspaceRoot, optionsKey, session: createOneFileSemanticSession(snapshot.root, changed.path, compilerOptions), knownFiles: { has: (file) => Object.hasOwn(retainedPartitions, file) || file === changed.path } }
      retainedCache.semanticSessions.set(changed.path, retainedSession)
    }
    timing.projectCreateMs += performance.now() - started
    const structuralStats = retainedSession.session.structuralCaches.get(retainedSession.session.absolute)?.stats
    if (structuralStats) { structuralStats.rebuiltOwners = 0; structuralStats.reusedOwners = 0 }
    const partition = retainedSession.session.parse(source, retainedSession.knownFiles, retainedPartitions, null, timing)
    const context = retainedSession.session.context
    const partitions = { [changed.path]: partition }
    const { internalPartition, internalFingerprint, ...symbolPartition } = partition
    retainedPartitions[changed.path] = symbolPartition
    retainedFingerprints[changed.path] = internalFingerprint
    retainedCache.sourceBlobs[changed.path] = contentDigest
    retainedCache.sources.set(changed.path, source)
    retainedCache.context = context
    const edgePatches = repairCachedReferences(referenceIndex, retainedPartitions, changed.path)
    const publicationChanges = updateCachedGraphFacts(referenceIndex, retainedPartitions, changed.path, edgePatches)
    return { revision: snapshot.revision, mode: 'delta', timingMode: 'delta', publicationChanges, baseGeneration: snapshot.baseGeneration, sourceBlobs: { [changed.path]: contentDigest }, partitions, tombstones: [], edgePatches, unresolvedEdges: cachedUnresolvedEdges(referenceIndex), publicationEdgePatches: cachedPublicationEdgePatches(referenceIndex), workCounters, semanticSessionStats: retainedSession.session.stats, internalBuildCount: 1, internalRebuiltFiles: [changed.path], internalReusedFiles: [], semanticTraversalSummary: retainedSession.session.stats.analysisCacheHits ? { completedFiles: 0, remainingFiles: 0, maximumTraversalsPerFile: 0 } : { ...context.semanticTraversalSummary } }
  }
  const sourceBlobs = { ...(snapshot.baseSourceBlobs ?? retainedCache?.sourceBlobs ?? {}) }
  if (changes.length === 1 && snapshot.basePartitionIds) {
    const retainedPartitions = readPartitions(snapshot)
    const referenceIndex = createCachedReferenceIndex(retainedPartitions, snapshot.baseEdgePatches ?? [])
    const compilerOptions = readOneFileCompilerOptions(snapshot.root)
    const semanticSessions = new Map()
    const retainedFiles = Object.keys(sourceBlobs).sort()
    const partitionFiles = Object.keys(retainedPartitions).sort()
    const retainedFingerprints = { ...(snapshot.baseInternalFingerprints ?? {}) }
    const fingerprintFiles = Object.keys(retainedFingerprints).sort()
    if (partitionFiles.length !== retainedFiles.length || partitionFiles.some((file, index) => file !== retainedFiles[index] || retainedPartitions[file]?.sourceHash !== sourceBlobs[file])) throw new Error('retained semantic partition/source membership mismatch')
    if (fingerprintFiles.length !== retainedFiles.length || fingerprintFiles.some((file, index) => file !== retainedFiles[index] || typeof retainedFingerprints[file] !== 'string')) throw new Error('retained semantic internal fingerprint membership mismatch')
    const changed = changes[0]
    if (changed.type === 'unlink') {
      if (!retainedPartitions[changed.path] || !sourceBlobs[changed.path]) throw new Error(`single-file semantic unlink cannot remove: ${changed.path}`)
      delete retainedPartitions[changed.path]
      delete retainedFingerprints[changed.path]
      delete sourceBlobs[changed.path]
      const edgePatches = repairCachedReferences(referenceIndex, retainedPartitions, changed.path)
      const publicationChanges = updateCachedGraphFacts(referenceIndex, retainedPartitions, changed.path, edgePatches)
      cache = { root: path.resolve(snapshot.root), baseGeneration: snapshot.baseGeneration, sourceBlobs: { ...sourceBlobs }, sources: new Map(), partitions: retainedPartitions, internalFingerprints: retainedFingerprints, referenceIndex, compilerOptions, semanticSessions, context: null }
      return { revision: snapshot.revision, mode: 'delta', timingMode: 'delta', publicationChanges, baseGeneration: snapshot.baseGeneration, sourceBlobs: {}, partitions: {}, tombstones: [changed.path], edgePatches, unresolvedEdges: cachedUnresolvedEdges(referenceIndex), publicationEdgePatches: cachedPublicationEdgePatches(referenceIndex), internalBuildCount: 0, internalRebuiltFiles: [], internalReusedFiles: [], semanticTraversalSummary: { completedFiles: 0, remainingFiles: 0, maximumTraversalsPerFile: 0 } }
    }
    let source = changed.source
    if (source === undefined) {
      if (path.isAbsolute(changed.path)) throw new Error(`changed source path must be relative: ${changed.path}`)
      const diskTarget = path.resolve(workspaceRoot, changed.path); const relative = path.relative(workspaceRoot, diskTarget)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`changed source path escapes root: ${changed.path}`)
      const realRoot = fs.realpathSync(workspaceRoot); const realTarget = fs.realpathSync(diskTarget); const realRelative = path.relative(realRoot, realTarget)
      if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`changed source path escapes root through symbolic link: ${changed.path}`)
      source = fs.readFileSync(realTarget, 'utf8')
    }
    const contentDigest = crypto.createHash('sha256').update(source).digest('hex')
    const parsedDigest = crypto.createHash('sha256').update(`${changed.path}\0${source}`).digest('hex')
    if (changed.expectedDigest !== undefined && changed.expectedDigest !== parsedDigest) throw new Error(`changed source digest mismatch after parse: ${changed.path}`)
    const target = path.resolve(sourceRoot, contentDigest); if (path.dirname(target) !== sourceRoot) throw new Error('changed source blob path escapes sourceDir'); if (!fs.existsSync(target)) fs.writeFileSync(target, source)
    sourceBlobs[changed.path] = contentDigest
    const sources = new Map([[changed.path, source]])
    const started = performance.now()
    const retainedSession = { root: workspaceRoot, optionsKey: JSON.stringify(compilerOptions), session: createOneFileSemanticSession(snapshot.root, changed.path, compilerOptions), knownFiles: { has: file => Object.hasOwn(retainedPartitions, file) || file === changed.path } }
    semanticSessions.set(changed.path, retainedSession)
    timing.projectCreateMs += performance.now() - started
    const partition = retainedSession.session.parse(source, retainedSession.knownFiles, retainedPartitions, null, timing)
    const context = retainedSession.session.context
    const partitions = { [changed.path]: partition }
    const cachedPartitions = retainedPartitions
    const { internalPartition, internalFingerprint, ...symbolPartition } = partition
    cachedPartitions[changed.path] = symbolPartition
    const edgePatches = repairCachedReferences(referenceIndex, cachedPartitions, changed.path)
    const publicationChanges = updateCachedGraphFacts(referenceIndex, cachedPartitions, changed.path, edgePatches)
    const internalFingerprints = { ...retainedFingerprints, ...partitionFingerprints(partitions) }
    cache = { root: path.resolve(snapshot.root), baseGeneration: snapshot.baseGeneration, sourceBlobs: { ...sourceBlobs }, sources, partitions: cachedPartitions, internalFingerprints, referenceIndex, compilerOptions, semanticSessions, context }
    return { revision: snapshot.revision, mode: 'delta', timingMode: 'delta', publicationChanges, baseGeneration: snapshot.baseGeneration, sourceBlobs: { [changed.path]: contentDigest }, partitions, edgePatches, unresolvedEdges: cachedUnresolvedEdges(referenceIndex), publicationEdgePatches: cachedPublicationEdgePatches(referenceIndex), semanticSessionStats: retainedSession.session.stats, internalBuildCount: 1, internalRebuiltFiles: [changed.path], internalReusedFiles: [], semanticTraversalSummary: { ...context.semanticTraversalSummary } }
  }
  if (changes.length === 1) throw new Error(`single-file semantic delta cannot process: ${changes[0].path}`)
  let sources
  if (snapshot.sources) sources = new Map(snapshot.sources)
  else if (cache && cache.sources.size === Object.keys(sourceBlobs).length && sameBlobs(cache.sourceBlobs, sourceBlobs)) { sources = new Map(cache.sources); cache.baseGeneration = snapshot.baseGeneration }
  else sources = readSources(snapshot, sourceBlobs)
  const forceHydrate = Boolean(snapshot.basePartitionIds)
  let baseHydrated = !forceHydrate && Boolean(cache && sameBlobs(cache.sourceBlobs, sourceBlobs))
  if (!baseHydrated) {
    const basePartitions = readPartitions(snapshot)
    const files = [...sources.keys()]
    if (files.length === Object.keys(basePartitions).length && files.every((file) => basePartitions[file]?.file === file)) {
      const started = performance.now()
      const context = prepareSemanticProject(createSemanticProject(snapshot.root, sources), snapshot.root, null, timing)
      timing.projectCreateMs += performance.now() - started
      const cachedPartitions = { ...basePartitions }
      cache = { root: path.resolve(snapshot.root), baseGeneration: snapshot.baseGeneration, sourceBlobs: { ...sourceBlobs }, sources: new Map(sources), partitions: cachedPartitions, internalFingerprints: { ...(snapshot.baseInternalFingerprints ?? {}) }, referenceIndex: createCachedReferenceIndex(cachedPartitions, snapshot.baseEdgePatches ?? []), compilerOptions: context.project.getCompilerOptions(), semanticSessions: new Map(), context }
      baseHydrated = true
    }
  }
  for (const change of snapshot.changes ?? []) {
    if (change.type === 'unlink') { sources.delete(change.path); delete sourceBlobs[change.path] }
    else {
      let source = change.source
      if (source === undefined) {
        if (path.isAbsolute(change.path)) throw new Error(`changed source path must be relative: ${change.path}`)
        const diskTarget = path.resolve(workspaceRoot, change.path); const relative = path.relative(workspaceRoot, diskTarget)
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`changed source path escapes root: ${change.path}`)
        const realRoot = fs.realpathSync(workspaceRoot); const realTarget = fs.realpathSync(diskTarget); const realRelative = path.relative(realRoot, realTarget)
        if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`changed source path escapes root through symbolic link: ${change.path}`)
        source = fs.readFileSync(realTarget, 'utf8')
      }
      const contentDigest = crypto.createHash('sha256').update(source).digest('hex')
      const parsedDigest = crypto.createHash('sha256').update(`${change.path}\0${source}`).digest('hex')
      if (change.expectedDigest !== undefined && change.expectedDigest !== parsedDigest) throw new Error(`changed source digest mismatch after parse: ${change.path}`)
      const target = path.resolve(sourceRoot, contentDigest); if (path.dirname(target) !== sourceRoot) throw new Error('changed source blob path escapes sourceDir'); if (!fs.existsSync(target)) fs.writeFileSync(target, source); sources.set(change.path, source); sourceBlobs[change.path] = contentDigest
    }
  }

  return fullValidation(snapshot, sources, sourceBlobs, timing)
}

function referenceOverlay(request) {
  if (!cache || !sameBlobs(cache.sourceBlobs, request.sourceBlobs)) throw new Error('semantic checker worker cache does not match overlay generation')
  if (!Array.isArray(request.staleFiles)) throw new Error('overlay stale files must be an array')
  const stale = [...new Set(request.staleFiles)]
  if (stale.length !== request.staleFiles.length || stale.some((file) => !cache.sources.has(file))) throw new Error('overlay stale files do not match worker cache')
  if (stale.length && (!cache.context || cache.context.eligibleFiles.size !== cache.sources.size)) cache.context = prepareSemanticProject(createSemanticProject(cache.root, cache.sources), cache.root)
  const sourceFiles = stale.map((file) => cache.context.project.getSourceFile(path.join(cache.context.root, file)))
  if (sourceFiles.some((file) => !file)) throw new Error('overlay stale source is absent from worker project')
  refreshSemanticFiles(cache.context, sourceFiles)
  const known = new Set(cache.sources.keys()); const files = {}
  for (const file of stale) {
    const partition = parsePartition(file, cache.sources.get(file), known, cache.context, null, EDGE_COVERAGE.COMPLETE, false)
    files[file] = { edges: partition.edges.filter((edge) => !edge.call) }
  }
  return { generation: request.generation, files }
}

function advanceGeneration({ expectedGeneration, generation }) {
  if (!cache || cache.baseGeneration !== expectedGeneration) throw new Error('semantic checker worker generation acknowledgement mismatch')
  if (typeof generation !== 'string' || !generation) throw new Error('semantic checker worker generation acknowledgement is invalid')
  cache.baseGeneration = generation
  return { generation }
}

let nextSemanticProfileId = 1
export class SemanticCheckerWorker {
  constructor(options = {}) { this.structuralCount = options.structuralCount; this.worker = null; this.parserPool = null; this.profileId = nextSemanticProfileId++; this.nextId = 1; this.pending = new Map(); this.requestTail = Promise.resolve(); this.closed = false }
  async #prepareParserPool(root) {
    if (this.structuralCount === 0) return
    const { ParserApartmentPool } = await import('./parser-apartment-pool.mjs')
    if (this.closed) throw this.failure ?? new Error('semantic checker worker is disposed')
    if (this.parserPool && this.parserPool.root !== path.resolve(root)) { await this.parserPool.dispose(); this.parserPool = null }
    if (this.closed) throw this.failure ?? new Error('semantic checker worker is disposed')
    if (!this.parserPool) {
      const profileArgv = process.execArgv.filter((argument) => /^--(?:cpu|heap)-prof(?:$|-(?:dir|name)=)/.test(argument))
      this.parserPool = new ParserApartmentPool(root, { workerCount: this.structuralCount, baseExecArgv: deriveWorkerProfile(profileArgv, `structural-${this.profileId}`).execArgv, timeoutMs: profileArgv.length ? 0 : undefined })
      this.parserPool.workerCount = Math.max(1, this.parserPool.workerCount)
    }
  }
  // The thread loads its own copy of ts-morph and takes ~68ms to terminate. A query served from
  // the mmap page never validates, so spawning on construction charged every such process for a
  // thread it never used.
  #spawn() {
    if (this.worker) return this.worker
    const profileArgv = process.execArgv.filter((argument) => /^--(?:cpu|heap)-prof(?:$|-(?:dir|name)=)/.test(argument))
    this.worker = new Worker(new URL(import.meta.url), { workerData: { semanticChecker: true }, execArgv: deriveWorkerProfile(profileArgv, this.profileId === 1 ? 'semantic' : `semantic-${this.profileId}`).execArgv })
    this.worker.on('message', ({ id, progress, result, error, structuralRequest }) => {
      const pending = this.pending.get(id)
      if (!pending) return
      if (structuralRequest) {
        this.parserPool.parse(structuralRequest).then(graph => {
          if (!pending.settled) this.worker.postMessage({ id, structuralResult: { fileId: structuralRequest.fileId, revision: structuralRequest.revision, graph, workerIndex: this.parserPool.affinityByFile.get(String(structuralRequest.fileId)).index } })
        }, error => {
          if (!pending.settled) this.worker.postMessage({ id, structuralResult: { fileId: structuralRequest.fileId, revision: structuralRequest.revision, error: error.message } })
        })
        return
      }
      if (progress) {
        try { pending.onProgress?.(progress) } catch (progressError) { this.#settle(id, pending, progressError) }
        return
      }
      const workerError = error ? Object.assign(new Error(error.message), { stack: error.stack }) : null
      this.#settle(id, pending, workerError, result)
    })
    this.worker.on('error', (error) => this.#fail(error))
    this.worker.on('exit', (code) => { if (!this.closed) this.#fail(new Error(`semantic checker worker exited with code ${code}`)) })
    this.worker.unref()
    return this.worker
  }
  #settle(id, pending, error = null, result = null) { if (pending.settled) return; pending.settled = true; this.pending.delete(id); if (!this.pending.size) this.worker.unref(); if (error) { cancelPool(pending.pool); pending.reject(error) } else pending.resolve(result) }
  #fail(error) { if (this.failure) return; this.failure = error; this.closed = true; for (const [id, pending] of this.pending) this.#settle(id, pending, error); void this.dispose().catch(() => {}) }
  #request(type, payload, onProgress = null) {
    if (this.closed) return Promise.reject(this.failure ?? new Error('semantic checker worker is disposed'))
    const id = this.nextId++
    const run = async () => {
      if (this.closed) throw this.failure ?? new Error('semantic checker worker is disposed')
      if (type === 'index' || type === 'validate' && (payload?.changes?.length ?? 0) !== 1) await this.#prepareParserPool(payload.root)
      if (this.closed) throw this.failure ?? new Error('semantic checker worker is disposed')
      const worker = this.#spawn()
      worker.ref()
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress, pool: payload?.partitionPool, settled: false })
        worker.postMessage({ id, type, payload, structuralWindow: this.structuralCount === 0 ? 0 : this.parserPool?.workerCount ?? 1 })
      })
    }
    const result = this.requestTail.then(run, run)
    this.requestTail = result.then(() => undefined, () => undefined)
    return result
  }
  async validate(snapshot, onProgress) {
    if (snapshot?.partitionPool && typeof onProgress !== 'function') return Promise.reject(new Error('semantic partition transport requires a progress consumer'))
    const result = await this.#request('validate', snapshot, onProgress)
    return { ...result, poolDiagnostics: { ...(result.poolDiagnostics ?? {}), workersUsed: 1, jobsDispatched: result.structuralDiagnostics?.structuralJobsDispatched ?? snapshot?.changes?.length ?? 0 } }
  }
  async index(request, onProgress) {
    if (request?.partitionPool && typeof onProgress !== 'function') return Promise.reject(new Error('semantic partition transport requires a progress consumer'))
    const result = await this.#request('index', request, onProgress)
    return { ...result, poolDiagnostics: { ...(result.poolDiagnostics ?? {}), workersUsed: 1, jobsDispatched: request.sources.length } }
  }
  hydrate(request) { return this.#request('hydrate', request) }
  advanceGeneration(expectedGeneration, generation) { return this.#request('advance-generation', { expectedGeneration, generation }) }
  referenceOverlay(request) { return this.#request('reference-overlay', request) }
  dispose() {
    if (this.disposal) return this.disposal
    if (!this.closed) { this.closed = true; const error = new Error('semantic checker worker is disposed'); for (const [id, pending] of this.pending) this.#settle(id, pending, error) }
    this.disposal = (async () => { try { await this.parserPool?.dispose() } finally { await this.worker?.terminate().catch(() => {}) } })()
    return this.disposal
  }
}

let semanticRequestTail = Promise.resolve()
if (semanticWorker) parentPort.on('message', (message) => {
  if (message.structuralResult) {
    const result = message.structuralResult
    if (message.id !== semanticOperationId || result.revision !== semanticOperationId) return
    const pending = structuralPending.get(result.fileId)
    if (!pending) return
    structuralPending.delete(result.fileId)
    if (result.error) pending.reject(new Error(result.error))
    else pending.resolve(result)
    return
  }
  const handle = async () => {
  const { id, type, payload, snapshot } = message
  semanticOperationId = id
  semanticStructuralWindow = message.structuralWindow ?? 1
  try {
    const request = payload ?? snapshot
    if (type === 'index' || type === 'validate') debugPool('Worker Start', id, request.partitionPoolDebugId ?? id)
    const handlers = { index: () => streamOwnedSnapshot(id, payload), hydrate: () => ownedSnapshot(payload, true), validate: async () => { const operationStarted = performance.now(); const timing = { projectCreateMs: 0, syntaxCollectionMs: 0, structuralCfgMs: 0, exportsMs: 0, identifierResolutionMs: 0, internalRelationsMs: 0, encodingMs: 0, completeEdgeMaterializationMs: 0, refsLookupMs: 0 }; const result = await validateSnapshot(request, timing); result.parseMs = timing.projectCreateMs + timing.syntaxCollectionMs + timing.structuralCfgMs + timing.exportsMs + timing.identifierResolutionMs + timing.internalRelationsMs + timing.encodingMs; return streamValidationResult(id, request, result, timing, operationStarted) }, 'advance-generation': () => advanceGeneration(payload), 'reference-overlay': () => referenceOverlay(payload) }
    if (!handlers[type]) throw new Error(`unknown semantic checker operation: ${type}`)
    const result = await handlers[type]()
    if (type === 'index' || type === 'validate') debugPool('Worker Complete Processing', id, request.partitionPoolDebugId ?? id)
    parentPort.postMessage({ id, result })
  }
  catch (error) { parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } }) }
  }
  semanticRequestTail = semanticRequestTail.then(handle, handle)
})
