import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { isMainThread, threadId } from 'node:worker_threads'
import { controlFileHashes, createSourcePolicy } from './source-policy.mjs'
import { decodeInternalPartition, decodeSymbolPartition, GraphStore, OVERLAY_VERSION, openInternalPartition, readSymbolPartitionIdentity } from './store.mjs'
import { EDGE_COVERAGE, coverageCode, coverageName } from './edge-coverage.mjs'

// Generations before version 3 predate the field and were always complete. Was copy-pasted at
// four call sites, each free to drift from the others.
const manifestCoverage = (manifest) =>
  manifest.version >= 3 ? (coverageCode(manifest.edgeCoverage) ?? EDGE_COVERAGE.CALLS) : EDGE_COVERAGE.COMPLETE
import { createTraceProfiler } from './trace-profile.mjs'
import { readSources } from './source-reader.mjs'
import { FileIdRegistry } from './file-index.mjs'
import { advanceJournalPointer, SemanticCheckerWorker } from './semantic-checker-worker.mjs'
import { MmapQueryCache } from './mmap-query-cache.mjs'
import { prepareQueryViewCache } from './query-cache-schema.mjs'
import { nativeMmapAdapter } from './native/mmap-adapter.mjs'

const contentHash = (text) => crypto.createHash('sha256').update(text).digest('hex')
const POOL_JOB_COUNT = 300
const POOL_CANCELLED = 0
const POOL_READ_SEQUENCE = 2
const POOL_READ_CURSOR = 5
const POOL_HEADER_BYTES = 4096
const POOL_ARENA_BYTES = POOL_JOB_COUNT * 65536
const POOL_BYTES = POOL_HEADER_BYTES + POOL_ARENA_BYTES
const DEBUG_POOL = process.env.CODEGRAPH_DEBUG_POOL === '1'
let poolDebugSequence = 0
const debugPool = (event, detail) => {
  if (DEBUG_POOL) process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), epochMs: Date.now(), monotonicMs: performance.now(), pid: process.pid, threadId, side: 'main', event, ...detail })}\n`)
}
const createPartitionPool = () => {
  const buffer = new SharedArrayBuffer(POOL_BYTES)
  const metadata = new Int32Array(buffer, 0, POOL_HEADER_BYTES / 4)
  const payload = new Uint8Array(buffer, POOL_HEADER_BYTES)
  return { buffer, metadata, payload, memoryBuffer: payload, insertionPointer: 0, oldestActivePartition: 0, debugId: DEBUG_POOL ? `${process.pid}:${Date.now()}:${++poolDebugSequence}` : null }
}
const cancelPartitionPool = (pool) => {
  if (!pool) return
  Atomics.store(pool.metadata, POOL_CANCELLED, 1)
}
const completePartitionJob = (pool) => { advanceJournalPointer(pool); pool.metadata[POOL_READ_CURSOR] = pool.oldestActivePartition; Atomics.add(pool.metadata, POOL_READ_SEQUENCE, 1) }
const unresolvedCandidateMatches = (partitions, changedFiles) => {
  const changed = new Set(changedFiles.map((file) => file.split(path.sep).join('/')))
  return Object.values(partitions).some((partition) => partition.unresolved?.some((row) => row.candidates?.some((candidate) => changed.has(candidate))))
}
const persistPartition = (store, partition, profiler) => {
  const { internalPartition, internalFingerprint, ...symbolPartition } = partition
  return { partition: store.writePartition(symbolPartition, profiler), internal: internalPartition ? store.writeInternalPartition(internalPartition) : null, internalFingerprint }
}

const internalFingerprints = (store, manifest) => Object.fromEntries(Object.entries(manifest.internalPartitions ?? {}).map(([file, id]) => [file, openInternalPartition(store.readInternalPartition(id)).compilerFingerprint]))

const slash = (p) => p.split(path.sep).join('/')
const uniqueEvents = (events) => [...new Map(events.map((event) => [`${event.type}:${slash(event.path)}`, { ...event, path: slash(event.path) }])).values()]
const reverseClosure = (partitions, changed) => {
  const importers = new Map()
  for (const [file, partition] of Object.entries(partitions)) for (const dependency of partition.dependencies ?? []) {
    const files = importers.get(dependency); if (files) files.push(file); else importers.set(dependency, [file])
  }
  const result = new Set(changed); const queue = [...changed]
  while (queue.length) for (const file of importers.get(queue.pop()) ?? []) if (!result.has(file)) { result.add(file); queue.push(file) }
  return result
}

// Field-wise, not `${a.from}:${a.to}:${a.line}`.localeCompare(...): that built two strings per
// comparison and ran ICU collation over hex ids and an integer — 109ms of a 503ms query.
const edgeOrder = (a, b) =>
  (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
  (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
  (a.line - b.line)

// Both inputs are already ordered, so a 2-way merge costs n comparisons instead of the n log n
// a re-sort of the concatenation pays.
const mergeOrdered = (left, right) => {
  const merged = new Array(left.length + right.length)
  let l = 0; let r = 0; let out = 0
  while (l < left.length && r < right.length) merged[out++] = edgeOrder(left[l], right[r]) <= 0 ? left[l++] : right[r++]
  while (l < left.length) merged[out++] = left[l++]
  while (r < right.length) merged[out++] = right[r++]
  return merged
}
const appendIndex = (index, key, value) => {
  const rows = index.get(key)
  if (rows) rows.push(value)
  else index.set(key, [value])
}
const createQueryView = (graph, manifest = null) => {
  const symbolById = new Map()
  const symbolsByName = new Map()
  const symbolsByFile = new Map()
  const incomingByTo = new Map()
  const outgoingByFrom = new Map()
  for (const symbol of graph.symbols) {
    symbolById.set(symbol.id, symbol)
    appendIndex(symbolsByName, symbol.name, symbol)
    appendIndex(symbolsByFile, symbol.file, symbol)
  }
  for (const edge of graph.edges) {
    appendIndex(incomingByTo, edge.to, edge)
    appendIndex(outgoingByFrom, edge.from, edge)
  }
  return Object.freeze({ graph, manifest, symbolById, symbolsByName, symbolsByFile, incomingByTo, outgoingByFrom })
}
const endpoint = ({ id, name, file, line, kind }) => ({ id, name, file, line, kind })

export class CodeGraphEngine {
  constructor(root, options = {}) {
    this.root = path.resolve(root)
    this.policy = createSourcePolicy(this.root)
    this.store = new GraphStore(this.root, options.cacheDir)
    this.ownsMmapQueryCache = options.queryCache == null
    const mmapOptions = options.mmapQueryCache ?? {}
    this.mmapQueryCache = options.queryCache ?? new MmapQueryCache({
      filePath: prepareQueryViewCache(this.store.dir),
      root: this.root,
      adapter: mmapOptions.adapter === undefined ? nativeMmapAdapter : mmapOptions.adapter,
      ...(mmapOptions.capacityBytes === undefined ? {} : { capacityBytes: mmapOptions.capacityBytes }),
    })
    this.instrument = options.instrument ?? null
    this.queryViewFactory = options.queryViewFactory ?? createQueryView
    this.profilePath = options.profile === undefined ? undefined : path.resolve(this.root, options.profile)
    this.profiler = createTraceProfiler(this.profilePath, options.profileDeps)
    this.readConcurrency = options.readConcurrency
    this.sourceReaderDeps = options.sourceReaderDeps ?? {}
    this.fileIds = new FileIdRegistry()
    this.overlayBuilds = new Map()
    this.partitionCache = null
    this.overlayEdgeCache = null
    this.validatedQueryViews = new Map()
    this.provisionalQueryView = null
    this.operationTail = Promise.resolve()
    this.disposed = false
    this.validationWorker = options.validationWorkerFactory?.() ?? new SemanticCheckerWorker()
    this.validationPayloadObserver = options.validationPayloadObserver ?? null
    this.validationWorkerHydrated = false
    this.validationBasePartitions = null
    // Adopt the persisted generation up front. Leaving this null made a bare engine behave
    // differently from one reached through DaemonQueryEngine: the query-view cache is keyed by
    // generation, so a null one missed on every call and every query silently re-read all
    // partitions from disk instead of using the mapped page. Two entry points, two speeds.
    const adoptedGeneration = (() => { try { return this.store.readGeneration() } catch { return null } })()
    this.validatedGeneration = adoptedGeneration?.generation ?? null
    this.validatedSourceBlobs = adoptedGeneration?.sources ?? {}
    this.validationChanges = new Map()
    this.validationRevision = 0
    this.publishedValidationRevision = 0
    this.validationEpoch = 0
    this.activeValidation = null
    this.pendingValidation = null
    this.activePartitionPool = null
  }
  build() { return this.#enqueueOperation(() => this.#build()) }
  incremental(events, prefetched = null) { return this.#enqueueOperation(() => this.#incremental(events, prefetched)) }
  reconcile() { return this.#enqueueOperation(() => this.#reconcile()) }
  async #build() {
    this.validationWorkerHydrated = false
    this.validationBasePartitions = null
    this.policy = createSourcePolicy(this.root)
    const profile = this.#beginOperation('build')
    let buildPool = null
    try {
    const scan = this.profiler?.begin('scan', undefined, { memory: true })
    const files = this.policy.scan(); this.#synchronizeFileIds(files); const partitions = {}; const internalPartitions = {}; const parsedFiles = []
    if (scan) this.profiler.end(scan)
    const sources = await this.#readSources(files, profile)
    const sourceBlobs = Object.fromEntries([...sources].map(([file, source]) => [file, this.store.writeSource(source)]))
    const semantic = this.profiler?.begin('semantic-project', undefined, { memory: true })
    {
      const expectedFiles = [...sources.keys()].sort()
      const engineReceipts = new Map()
      buildPool = createPartitionPool()
      this.activePartitionPool = buildPool
      let persistenceMs = 0
      const onPartition = ({ partitions: completed, poolBatch }) => {
        if (poolBatch) { debugPool('Main Receive Batch', poolBatch); debugPool('Main Start Batch', poolBatch) }
        for (const job of completed) {
          const persistenceStarted = performance.now()
          const { file, ordinal, offset, symbolLength, internalLength } = job
          if (file !== expectedFiles[ordinal]) throw new Error(`invalid semantic partition job: ${file}`)
          this.instrument?.({ phase: 'parse', file })
          if (this.activeProfile) this.activeProfile.args.filesParsed += 1
          this.#validateOwnedIdentity(file, readSymbolPartitionIdentity(buildPool.payload, offset, symbolLength), sourceBlobs)
          const partitionId = this.store.writePackedPartitionRange(buildPool.payload, offset, symbolLength, file, this.profiler)
          const internalPartitionId = this.store.writeInternalPartitionRange(buildPool.payload, offset + symbolLength, internalLength)
          engineReceipts.set(file, { file, sourceHash: sourceBlobs[file], writer: 'engine', serializedLength: job.length, chunkCount: 1, symbolLength, internalLength, symbolChunkCount: 1, internalChunkCount: 0, partitionId, internalPartitionId, internalFingerprint: null })
          completePartitionJob(buildPool)
          persistenceMs += performance.now() - persistenceStarted
        }
        if (poolBatch) debugPool('Main Complete Batch', poolBatch)
      }
      const result = await this.validationWorker.index({
        root: this.root,
        sources: expectedFiles.map((file) => [file, sources.get(file)]),
        sourceBlobs,
        cacheDir: path.relative(this.root, this.store.dir),
        edgeCoverage: EDGE_COVERAGE.CALLS,
        partitionPool: buildPool.buffer,
        ...(buildPool?.debugId ? { partitionPoolDebugId: buildPool.debugId } : {}),
      }, onPartition)
      if (result.poolDiagnostics) {
        const { parseMs: workerParseMs, ...diagnostics } = result.poolDiagnostics
        debugPool('Main Shared Memory Summary', { mode: result.mode, ...diagnostics, workerParseMs, persistenceMs })
        delete result.poolDiagnostics
      }
      if (this.disposed) throw new Error('codegraph engine is disposed')
      for (const receipt of result.partitionReceipts ?? []) if (receipt.writer === 'engine' && engineReceipts.has(receipt.file)) engineReceipts.get(receipt.file).internalFingerprint = receipt.internalFingerprint
      const receipts = this.#validateOwnedReceipts(result, sourceBlobs, expectedFiles, engineReceipts)
      for (const file of expectedFiles.slice().sort()) {
        const receipt = receipts.get(file)
        partitions[file] = receipt.partitionId
        internalPartitions[file] = receipt.internalPartitionId
      }
    }
    if (semantic) this.profiler.end(semantic)
    const parseIndex = this.profiler?.begin('parse-index', undefined, { memory: true })
    for (const rel of files) {
      if (typeof partitions[rel] !== 'string') throw new Error(`semantic ownership omitted partition: ${rel}`)
      parsedFiles.push(rel)
    }
    if (parseIndex) this.profiler.end(parseIndex)
    if (this.disposed) throw new Error('codegraph engine is disposed')
    const publish = this.profiler?.begin('publish', undefined, { memory: true })
    const generation = this.store.publish({ version: 3, root: this.root, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), controlHashes: controlFileHashes(this.root), sources: sourceBlobs, partitions, internalPartitions, partitionHashes: partitions })
    this.validatedGeneration = generation.generation
    this.validatedSourceBlobs = sourceBlobs
    this.validationWorkerHydrated = true
    this.validationBasePartitions = null
    this.validationChanges.clear()
    this.validationEpoch += 1
    this.activePartitionPool = null
    if (publish) this.profiler.end(publish)
    return this.#finishOperation(profile, { generation: generation.generation, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), parsedFiles, reusedFiles: [] })
    } catch (error) { cancelPartitionPool(buildPool); this.activePartitionPool = null; await this.#failOperation(profile, error); throw error }
  }
  async #incremental(events, prefetched = null) {
    {
    const normalizedEvents = uniqueEvents(events)
    if (normalizedEvents.some((event) => this.policy.isControlRelative(this.policy.normalize(path.resolve(this.root, event.path))))) return this.#build()
    const previous = this.store.readGeneration()
    if (!this.validatedGeneration || this.validatedGeneration !== previous.generation) {
      this.validatedGeneration = previous.generation
      this.validatedSourceBlobs = previous.sources ?? {}
      this.validationWorkerHydrated = false
      this.validationBasePartitions = null
      this.validationChanges.clear()
      this.validationEpoch += 1
    }
    const accepted = []
    for (const event of normalizedEvents) {
      const rel = this.policy.normalize(path.resolve(this.root, event.path))
      if (!this.policy.isSourceRelative(rel) || this.policy.isIgnoredRelative(rel)) continue
      if (event.type === 'unlink') accepted.push({ type: 'unlink', path: rel })
      else if (event.source !== undefined) accepted.push({ type: event.type, path: rel, source: event.source })
      else if (this.policy.acceptWatchPath(path.join(this.root, rel))) accepted.push({ type: event.type, path: rel })
    }
    const needRead = accepted.filter((event) => event.type !== 'unlink' && event.source === undefined).map((event) => event.path)
    const read = prefetched?.sources ?? await this.#readSources(needRead, null)
    const changes = accepted.map((event) => event.type === 'unlink' ? event : { ...event, source: event.source ?? read.get(event.path) })
    const refreshed = this.#publishWorkerChanges(changes)
    const result = { generation: this.validatedGeneration, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), parsedFiles: changes.filter((event) => event.type !== 'unlink').map((event) => event.path).sort(), reusedFiles: Object.keys(previous.partitions).filter((file) => !changes.some((event) => event.path === file)).sort(), ...(this.profiler ? { profile: { path: this.profilePath, format: 'chrome-trace-event' } } : {}) }
    const applyValidation = (validated) => {
      result.validationMode = validated?.validationMode; result.validatedFiles = validated?.validatedFiles; result.generation = validated?.generation ?? result.generation
      result.internalBuildCount = validated?.internalBuildCount; result.internalRebuiltFiles = validated?.internalRebuiltFiles; result.internalReusedFiles = validated?.internalReusedFiles
      return validated
    }
    result.validation = refreshed.validation.then(applyValidation)
    return this.#profileResult(result, null)
    }
  }
  async #reconcile() {
    const profile = this.#beginOperation('reconcile')
    let existingGeneration = false
    try {
      const generation = this.store.readGeneration()
      existingGeneration = true
      const controls = controlFileHashes(this.root)
      if (!generation.controlHashes || JSON.stringify(generation.controlHashes) !== JSON.stringify(controls)) {
        if (profile) this.profiler.end(profile.operation)
        return this.#build()
      }
      const scan = this.profiler?.begin('scan', undefined, { memory: true })
      const fileList = this.policy.scan()
      this.#synchronizeFileIds(fileList)
      const files = new Set(fileList)
      if (scan) this.profiler.end(scan)
      const readResult = await this.#readSourceSnapshot(fileList, profile)
      const indexed = new Set(Object.keys(generation.partitions))
      const events = []
      for (const file of files) {
        if (!indexed.has(file)) events.push({ type: 'add', path: file })
        else {
          const partition = this.store.readPartition(generation.partitions[file])
          const source = readResult.sources.get(file)
          if (contentHash(source) !== partition.sourceHash) events.push({ type: 'change', path: file })
        }
      }
      for (const file of indexed) if (!files.has(file)) events.push({ type: 'unlink', path: file })
      if (profile) this.profiler.end(profile.operation)
      if (events.length) return this.#incremental(events, { files: fileList, ...readResult })
      if (!this.validationWorkerHydrated || this.validatedGeneration !== generation.generation) {
        const persistedPartitions = Object.fromEntries(Object.entries(generation.partitions).map(([file, id]) => [file, this.store.readPartition(id)]))
        const hydrated = await this.validationWorker.hydrate({ root: this.root, generation: generation.generation, sources: [...readResult.sources], sourceBlobs: generation.sources ?? {}, partitions: persistedPartitions, internalFingerprints: internalFingerprints(this.store, generation) })
        this.#validateOwnedResult(hydrated, generation.sources ?? {})
        this.validationWorkerHydrated = true
        this.validationBasePartitions = { generation: generation.generation, partitions: persistedPartitions }
      }
      this.validatedGeneration = generation.generation
      this.validatedSourceBlobs = generation.sources ?? {}
      this.validationChanges.clear()
      this.validationEpoch += 1
      return this.#profileResult({ generation: generation.generation, edgeCoverage: coverageName(manifestCoverage(generation)), parsedFiles: [], reusedFiles: [...files] }, profile)
    } catch (error) {
      if (profile) await this.#failOperation(profile, error)
      if (existingGeneration) { this.validationWorkerHydrated = false; this.validationBasePartitions = null; throw error }
      return this.#build()
    }
  }
  readGeneration(generation) { return this.store.readGeneration(generation) }
  provisionalSnapshot() {
    const graph = this.#validatedQueryView(this.validatedGeneration, EDGE_COVERAGE.CALLS).graph
    return { ...graph, revision: this.publishedValidationRevision, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation }
  }
  applyChanges(changes, options = {}) {
    if (this.disposed) throw new Error('codegraph engine is disposed')
    return this.#publishWorkerChanges(changes, options)
  }
  async applyFileChanges(changes, options = {}) {
    if (this.disposed) throw new Error('codegraph engine is disposed')
    const normalized = changes.map((change) => ({ ...change, path: slash(change.path) }))
    const needRead = normalized.filter((change) => change.type !== 'unlink' && change.source === undefined).map((change) => change.path)
    const sources = await this.#readSources(needRead, null)
    return this.#publishWorkerChanges(normalized.map((change) => change.type === 'unlink' ? change : { ...change, source: change.source ?? sources.get(change.path) }), options)
  }
  #publishWorkerChanges(changes, options = {}) {
    if (options.baseRevision !== undefined && options.baseRevision !== this.validationRevision) throw new Error(`stale base revision ${options.baseRevision}; latest is ${this.validationRevision}`)
    this.provisionalQueryView = null
    for (const change of changes) {
      const normalized = { ...change, path: slash(change.path) }
      if (normalized.type !== 'unlink' && typeof normalized.source === 'string') normalized.expectedDigest = contentHash(`${normalized.path}\0${normalized.source}`)
      this.validationChanges.set(normalized.path, normalized)
    }
    const revision = ++this.validationRevision
    const snapshot = this.provisionalSnapshot()
    return { ...snapshot, revision, validatedGeneration: this.validatedGeneration, validation: this.#scheduleValidation(revision) }
  }
  registeredFiles() {
    const files = new Set(Object.keys(this.store.readGeneration().partitions))
    for (const [file, hash] of Object.entries(controlFileHashes(this.root))) if (hash) files.add(file)
    return files
  }
  async dispose() {
    this.disposed = true
    cancelPartitionPool(this.activePartitionPool)
    this.validationEpoch += 1
    if (this.activeValidation) this.activeValidation.resolve(null)
    if (this.pendingValidation) this.pendingValidation.resolve(null)
    this.activeValidation = null
    this.pendingValidation = null
    await this.operationTail.catch(() => {})
    await Promise.allSettled([...this.overlayBuilds.values()])
    this.overlayBuilds.clear()
    for (const entry of this.validatedQueryViews.values()) for (const coverage of [EDGE_COVERAGE.CALLS, EDGE_COVERAGE.COMPLETE]) entry[coverage]?.release?.()
    this.validatedQueryViews.clear()
    if (this.ownsMmapQueryCache) this.mmapQueryCache.dispose()
    this.provisionalQueryView = null
    await this.validationWorker.dispose()
  }
  snapshot(generation) {
    return this.#validatedQueryView(generation, EDGE_COVERAGE.CALLS).graph
  }
  async snapshotComplete(generation, options = {}) {
    const view = await this.#completeQueryView(generation, options)
    return view?.mapped ? view : view?.graph ?? null
  }
  // The overlay stores edges grouped per file, so flattening yields file order, not edge order.
  // Sorting it is the merge's precondition; memoized per generation so it is paid once, not once
  // per query.
  #orderedOverlayEdges(generation, overlay) {
    if (this.overlayEdgeCache?.generation === generation) return this.overlayEdgeCache.edges
    const edges = overlay.ordered ? overlay.edges : [...overlay.edges].sort(edgeOrder)
    this.overlayEdgeCache = { generation, edges }
    return edges
  }
  async #completeQueryView(generation, options = {}) {
    const target = generation ?? this.validatedGeneration
    const complete = this.#cachedValidatedQueryView(target, EDGE_COVERAGE.COMPLETE)
    if (complete) return complete
    const baseView = this.#validatedQueryView(generation, EDGE_COVERAGE.CALLS)
    const base = baseView.mapped ? { generation: baseView.generation, edgeCoverage: baseView.edgeCoverage } : baseView.graph
    if (coverageCode(base.edgeCoverage) === EDGE_COVERAGE.COMPLETE) return baseView
    const cached = this.#cachedValidatedQueryView(base.generation, EDGE_COVERAGE.COMPLETE)
    if (cached) return cached
    if (options.signal?.aborted) return null
    const manifest = baseView.manifest ?? this.store.readGeneration(base.generation)
    let overlay = this.store.readOverlay(base.generation)
    if (!overlay) {
      let pending = this.overlayBuilds.get(manifest.generation)
      if (!pending) {
        pending = this.#buildReferenceOverlay(manifest)
        this.overlayBuilds.set(manifest.generation, pending)
        pending.finally(() => this.overlayBuilds.delete(manifest.generation)).catch(() => {})
      }
      overlay = await pending
    }
    if (options.signal?.aborted) return null
    const full = baseView.mapped ? this.#graphFromPartitions(manifest, EDGE_COVERAGE.CALLS) : base
    const merged = mergeOrdered(full.edges, this.#orderedOverlayEdges(base.generation, overlay))
    const graph = { ...full, edgeCoverage: coverageName(EDGE_COVERAGE.COMPLETE), edges: merged }
    return this.#rememberValidatedQueryView(base.generation, EDGE_COVERAGE.COMPLETE, this.queryViewFactory(graph, manifest), manifest)
  }
  pinQuery(request, options = {}) {
    if (!request.generation && request.consistency === 'latest') {
      const view = this.#provisionalQueryView()
      const graph = view.graph
      return { metadata: { revision: null, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation }, graph, rows: this.query(request, { ...options, queryViewPin: view }) }
    }
    const baseView = this.#validatedQueryView(request.generation, EDGE_COVERAGE.CALLS)
    const view = request.type === 'refs' || request.type === 'graph' ? (this.#cachedValidatedQueryView(baseView.graph.generation, EDGE_COVERAGE.COMPLETE) ?? baseView) : baseView
    const graph = view.graph
    return { metadata: { revision: null, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation }, graph, rows: this.query({ ...request, generation: graph.generation }, { ...options, queryViewPin: view }) }
  }
  async queryBatch(request, options = {}) {
    const { signal } = options; const maxQueue = Math.max(1, options.maxQueue ?? 64)
    if (signal?.aborted) return []
    const semanticTiming = DEBUG_POOL && request.type === 'refs' ? { cache: this.validatedQueryViews.get(request.generation ?? this.validatedGeneration)?.[EDGE_COVERAGE.COMPLETE] ? 'warm' : 'cold', completeEdgeMaterializationMs: 0, refsLookupMs: 0 } : null
    const latest = !request.generation && request.consistency === 'latest'
    let view = options.queryViewPin
    if (view && (request.type === 'refs' || request.type === 'graph') && coverageCode(view.graph.edgeCoverage) !== EDGE_COVERAGE.COMPLETE) view = null
    if (!view) {
      if (latest) view = this.#provisionalQueryView()
      else if (request.type === 'refs' || request.type === 'graph') {
        const started = semanticTiming && performance.now()
        view = await this.#completeQueryView(request.generation, options)
        if (semanticTiming) semanticTiming.completeEdgeMaterializationMs = performance.now() - started
      } else view = this.#validatedQueryView(request.generation, EDGE_COVERAGE.CALLS)
    }
    if (!view || signal?.aborted) return []
    const lookupStarted = semanticTiming && performance.now()
    const graph = view.graph
    const metadata = latest ? { revision: null, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation } : null
    if (view.mapped) {
      const rows = this.#queryMapped(view, request, signal)
      if (semanticTiming) { semanticTiming.refsLookupMs = performance.now() - lookupStarted; debugPool('Main Semantic Timing Summary', { operation: 'refs', ...semanticTiming }) }
      if (!metadata) return rows
      if (request.type === 'graph') return rows.map((row) => ({ ...metadata, files: row.files, symbols: row.symbols, edges: row.edges, unresolvedEdges: row.unresolvedEdges }))
      return rows.map((row) => ({ ...row, ...metadata }))
    }
    let rows
    const matches = (symbol) => (!request.name || symbol.name === request.name) && (!request.file || symbol.file === request.file || symbol.file.endsWith(request.file))
    const matchingSymbols = () => {
      if (request.id) { const symbol = view.symbolById.get(request.id); return symbol ? [symbol] : [] }
      const candidates = request.name ? (view.symbolsByName.get(request.name) ?? []) : graph.symbols
      return request.file ? candidates.filter(matches) : candidates
    }
    if (request.type === 'symbols') rows = request.name || request.file ? matchingSymbols() : graph.symbols
    else if (request.type === 'refs') {
      rows = matchingSymbols().flatMap((symbol) => view.incomingByTo.get(symbol.id) ?? []).sort((a, b) => a.line - b.line || a.from.localeCompare(b.from))
    } else if (request.type === 'deps') {
      rows = matchingSymbols().flatMap((symbol) => view.outgoingByFrom.get(symbol.id) ?? [])
    } else if (request.type === 'graph') rows = [latest
      ? { ...metadata, files: graph.files, symbols: graph.symbols, edges: graph.edges, unresolvedEdges: graph.unresolvedEdges }
      : { generation: graph.generation, edgeCoverage: graph.edgeCoverage, files: graph.files, symbols: graph.symbols, edges: graph.edges }]
    else throw new Error(`unknown query type: ${request.type}`)
    // Async generators are pull-based: there are zero prefetched rows, so the bounded queue
    // cannot exceed one row regardless of consumer speed.
    if (!Number.isInteger(maxQueue)) throw new Error('maxQueue must be an integer')
    const limit = Math.min(request.limit ?? rows.length, rows.length)
    const resolved = request.resolved === true && (request.type === 'refs' || request.type === 'deps')
    const result = resolved ? [] : new Array(limit)
    for (let i = 0; i < limit; i++) {
      if (signal?.aborted) return []
      let row = rows[i]
      if (resolved) {
        const fromSymbol = view.symbolById.get(row.from)
        const toSymbol = view.symbolById.get(row.to)
        if (!fromSymbol || !toSymbol) continue
        row = { ...row, fromSymbol: endpoint(fromSymbol), toSymbol: endpoint(toSymbol) }
        result.push(metadata ? { ...row, ...metadata } : row)
      } else result[i] = metadata && request.type !== 'graph' ? { ...row, ...metadata } : row
    }
    if (semanticTiming) { semanticTiming.refsLookupMs = performance.now() - lookupStarted; debugPool('Main Semantic Timing Summary', { operation: 'refs', ...semanticTiming }) }
    return signal?.aborted ? [] : result
  }
  async *query(request, options = {}) {
    const rows = await this.queryBatch(request, options)
    for (const row of rows) { if (options.signal?.aborted) return; yield row }
  }
  #queryMapped(view, request, signal) {
    if (signal?.aborted) return []
    let rows
    if (request.type === 'symbols') rows = view.matchingSymbols(request)
    else if (request.type === 'refs') rows = view.relationships(request, 'incoming').sort((a, b) => a.line - b.line || a.from.localeCompare(b.from))
    else if (request.type === 'deps') rows = view.relationships(request, 'outgoing')
    else if (request.type === 'graph') rows = [view.graph]
    else throw new Error(`unknown query type: ${request.type}`)
    const limit = Math.min(request.limit ?? rows.length, rows.length)
    const result = []
    for (let index = 0; index < limit; index += 1) {
      if (signal?.aborted) return []
      const row = rows[index]
      if (request.resolved === true && (request.type === 'refs' || request.type === 'deps')) {
        const fromSymbol = view.matchingSymbols({ id: row.from })[0]
        const toSymbol = view.matchingSymbols({ id: row.to })[0]
        if (fromSymbol && toSymbol) result.push({ ...row, fromSymbol: endpoint(fromSymbol), toSymbol: endpoint(toSymbol) })
      } else result.push(row)
    }
    return result
  }
  #cachedValidatedQueryView(generation, coverage) {
    const entry = this.validatedQueryViews.get(generation)
    const view = entry?.[coverage]
    if (view) { this.validatedQueryViews.delete(generation); this.validatedQueryViews.set(generation, entry) }
    if (view) return view
    if (!generation) return null
    const lease = this.mmapQueryCache.acquire({ generation, coverage: coverageName(coverage) })
    if (!lease) return null
    const mapped = lease.value.mappedView
    const mappedEntry = this.validatedQueryViews.get(generation) ?? { manifest: null }
    mappedEntry[coverage]?.release?.()
    mappedEntry[coverage] = mapped
    this.validatedQueryViews.delete(generation); this.validatedQueryViews.set(generation, mappedEntry)
    while (this.validatedQueryViews.size > 2) {
      const oldest = this.validatedQueryViews.keys().next().value
      const evicted = this.validatedQueryViews.get(oldest)
      for (const kind of [EDGE_COVERAGE.CALLS, EDGE_COVERAGE.COMPLETE]) evicted[kind]?.release?.()
      this.validatedQueryViews.delete(oldest)
    }
    return mapped
  }
  #rememberValidatedQueryView(generation, coverage, view, manifest, publishMapped = true) {
    const entry = this.validatedQueryViews.get(generation) ?? { manifest }
    if (entry[coverage] !== view) entry[coverage]?.release?.()
    entry[coverage] = view
    this.validatedQueryViews.delete(generation)
    this.validatedQueryViews.set(generation, entry)
    while (this.validatedQueryViews.size > 2) {
      const oldest = this.validatedQueryViews.keys().next().value
      const evicted = this.validatedQueryViews.get(oldest)
      for (const kind of [EDGE_COVERAGE.CALLS, EDGE_COVERAGE.COMPLETE]) evicted[kind]?.release?.()
      this.validatedQueryViews.delete(oldest)
    }
    if (publishMapped) this.mmapQueryCache.publish({ generation, coverage: coverageName(coverage), view: { graph: view.graph, manifest } })
    return view
  }
  // Both the calls view and the overlay reuse keys need every partition, and each read is ~170ms
  // for a 900-file repo. One generation's worth is kept so the second reader is free; a new
  // generation drops it, since partitions are content-addressed and never mutate in place.
  #readPartitions(manifest) {
    if (this.partitionCache?.generation === manifest.generation) return this.partitionCache.partitions
    const partitions = Object.entries(manifest.partitions ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([, id]) => this.store.readPartition(id))
    this.partitionCache = { generation: manifest.generation, partitions }
    return partitions
  }
  #graphFromPartitions(manifest, stored) {
    const partitions = this.#readPartitions(manifest)
    const symbols = partitions.flatMap((partition) => partition.symbols).sort((a, b) => a.id.localeCompare(b.id))
    const symbolIds = new Set(symbols.map((symbol) => symbol.id))
    const edges = partitions.flatMap((partition) => partition.edges.filter((edge) => symbolIds.has(edge.from) && symbolIds.has(edge.to))).sort(edgeOrder)
    return { generation: manifest.generation, edgeCoverage: coverageName(stored), files: partitions.map((partition) => partition.file), symbols, edges }
  }
  #validatedQueryView(generation, coverage) {
    const target = generation ?? this.validatedGeneration
    if (target) {
      const cached = this.#cachedValidatedQueryView(target, coverage)
      if (cached) return cached
    }
    const manifest = this.store.readGeneration(generation)
    const cached = this.#cachedValidatedQueryView(manifest.generation, coverage)
    if (cached) return cached
    const stored = manifestCoverage(manifest)
    if (coverage === EDGE_COVERAGE.COMPLETE && stored !== EDGE_COVERAGE.COMPLETE) {
      throw new Error(`complete query view for ${manifest.generation} has not been materialized`)
    }
    const graph = this.#graphFromPartitions(manifest, stored)
    const view = this.queryViewFactory(graph, manifest)
    this.#rememberValidatedQueryView(manifest.generation, coverage, view, manifest)
    if (coverage !== stored) this.#rememberValidatedQueryView(manifest.generation, stored, view, manifest)
    return view
  }
  #provisionalQueryView() {
    return this.#validatedQueryView(this.validatedGeneration, EDGE_COVERAGE.CALLS)
  }
  // A file's resolved reference edges depend on its own text and on the text of everything it can
  // reach through imports — a renamed export changes the edge's target id without touching the
  // referencing file. Keying reuse on that transitive closure is what makes it sound to skip a
  // reparse; keying on the file's own hash alone would emit stale edge targets.
  #overlayReuseKeys(manifest) {
    const dependencies = new Map(); const hashes = new Map()
    for (const partition of this.#readPartitions(manifest)) {
      dependencies.set(partition.file, partition.dependencies ?? []); hashes.set(partition.file, partition.sourceHash)
    }
    const closure = new Map([...dependencies.keys()].map((file) => [file, new Set([file])]))
    // ponytail: fixpoint over ~1k files; swap for Tarjan SCC if a repo makes this measurable.
    for (let changed = true; changed;) {
      changed = false
      for (const [file, list] of dependencies) {
        const reachable = closure.get(file)
        for (const dependency of list) {
          for (const item of closure.get(dependency) ?? []) if (!reachable.has(item)) { reachable.add(item); changed = true }
        }
      }
    }
    return new Map([...closure].map(([file, reachable]) =>
      [file, contentHash([...reachable].sort().map((item) => `${item}\0${hashes.get(item)}`).join('\n'))]))
  }
  async #buildReferenceOverlay(manifest) {
    this.instrument?.({ phase: 'reference-overlay', generation: manifest.generation })
    const token = this.profiler?.begin('reference-overlay', { generation: manifest.generation }, { memory: true })
    try {
      const keys = this.#overlayReuseKeys(manifest)
      const donor = this.store.donorOverlayFiles(manifest.generation)
      const files = {}; const stale = []
      for (const rel of Object.keys(manifest.sources)) {
        const key = keys.get(rel); const prior = donor[rel]
        if (key && prior && prior.key === key) files[rel] = prior
        else stale.push(rel)
      }
      if (stale.length) {
        if (manifest.generation !== this.validatedGeneration || !this.validationWorkerHydrated) {
          const sources = Object.entries(manifest.sources).map(([file, id]) => [file, this.store.readSource(id)])
          const persistedPartitions = Object.fromEntries(Object.entries(manifest.partitions).map(([file, id]) => [file, this.store.readPartition(id)]))
          const hydrated = await this.validationWorker.hydrate({ root: this.root, generation: manifest.generation, sources, sourceBlobs: manifest.sources, partitions: persistedPartitions, internalFingerprints: internalFingerprints(this.store, manifest) })
          this.#validateOwnedResult(hydrated, manifest.sources)
          this.validationWorkerHydrated = true
          this.validationBasePartitions = { generation: manifest.generation, partitions: persistedPartitions }
        }
        const fragments = await this.validationWorker.referenceOverlay({ generation: manifest.generation, sourceBlobs: manifest.sources, staleFiles: stale })
        if (!fragments || typeof fragments !== 'object' || fragments.generation !== manifest.generation || !fragments.files || typeof fragments.files !== 'object' || Array.isArray(fragments.files)) throw new Error('malformed semantic worker overlay result')
        const returned = Object.keys(fragments.files).sort(); const expected = [...stale].sort()
        if (returned.length !== expected.length || returned.some((file, index) => file !== expected[index])) throw new Error('semantic worker overlay fragment membership mismatch')
        const partitions = this.#readPartitions(manifest); const symbols = new Map(partitions.flatMap((partition) => partition.symbols).map((symbol) => [symbol.id, symbol]))
        for (const rel of stale) {
          const fragment = fragments.files[rel]
          if (!fragment || !Array.isArray(fragment.edges)) throw new Error(`malformed semantic worker overlay fragment: ${rel}`)
          for (const edge of fragment.edges) {
            if (!edge || Object.keys(edge).length !== 4 || !['call', 'from', 'line', 'to'].every((key) => Object.hasOwn(edge, key)) || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !Number.isInteger(edge.line) || edge.line < 1 || edge.call !== false) throw new Error(`malformed semantic worker overlay edge: ${rel}`)
            const from = symbols.get(edge.from); const to = symbols.get(edge.to)
            if (!from || !to) throw new Error(`semantic worker overlay edge endpoint is absent: ${rel}`)
            if (from.file !== rel) throw new Error(`semantic worker overlay edge belongs to wrong fragment: ${rel}`)
          }
          files[rel] = { key: keys.get(rel) ?? null, edges: fragment.edges }
        }
        if (manifest.generation !== this.validatedGeneration) { this.validationWorkerHydrated = false; this.validationBasePartitions = null }
      }
      const overlay = { generation: manifest.generation, edgeCoverage: coverageName(EDGE_COVERAGE.COMPLETE), version: OVERLAY_VERSION, files, ordered: true, edges: Object.values(files).flatMap((entry) => entry.edges).sort(edgeOrder) }
      if (this.disposed) throw new Error('codegraph engine is disposed')
      this.store.writeOverlay(manifest.generation, overlay)
      return overlay
    } finally {
      if (token) {
        this.profiler.end(token)
        try { await this.profiler.write() } catch {}
      }
    }
  }
  #synchronizeFileIds(files) {
    const active = new Set(files)
    for (const [file] of this.fileIds.entries()) if (!active.has(file)) this.fileIds.release(file)
    for (const file of files) this.fileIds.intern(file)
  }
  #validateOwnedResult(result, sourceBlobs) {
    if (!result || result.mode !== 'full' || !result.sourceBlobs || !result.partitions) throw new Error('malformed semantic ownership result')
    const files = Object.keys(sourceBlobs).sort()
    const returned = Object.keys(result.sourceBlobs).sort()
    const partitionFiles = Object.keys(result.partitions).sort()
    if (returned.length !== files.length || returned.some((file, index) => file !== files[index] || result.sourceBlobs[file] !== sourceBlobs[file])) throw new Error('semantic ownership source membership mismatch')
    if (partitionFiles.length !== files.length || partitionFiles.some((file, index) => file !== files[index])) throw new Error('semantic ownership partition membership mismatch')
    for (const file of files) {
      const partition = result.partitions[file]
      if (!partition || partition.file !== file || partition.sourceHash !== sourceBlobs[file]) throw new Error(`semantic ownership partition file/source mismatch: ${file}`)
      if (!Array.isArray(partition.symbols) || !Array.isArray(partition.edges) || !Array.isArray(partition.dependencies) || !Array.isArray(partition.unresolved)) throw new Error(`malformed semantic ownership partition: ${file}`)
    }
  }
  #validateOwnedPartition(file, partition, sourceBlobs) {
    if (!sourceBlobs[file]) throw new Error(`semantic ownership returned unknown partition: ${file}`)
    if (!partition || partition.file !== file || partition.sourceHash !== sourceBlobs[file]) throw new Error(`semantic ownership partition file/source mismatch: ${file}`)
    if (!Array.isArray(partition.symbols) || !Array.isArray(partition.edges) || !Array.isArray(partition.dependencies) || !Array.isArray(partition.unresolved)) throw new Error(`malformed semantic ownership partition: ${file}`)
  }
  #validateOwnedIdentity(file, partition, sourceBlobs) {
    if (partition.file !== file || sourceBlobs[file] && partition.sourceHash !== sourceBlobs[file]) throw new Error(`semantic ownership partition file/source mismatch: ${file}`)
  }
  #validateOwnedReceipts(result, sourceBlobs, expectedFiles, engineReceipts) {
    if (!result || result.mode !== 'full' || !result.sourceBlobs || !Array.isArray(result.partitionReceipts)) throw new Error('malformed semantic ownership receipt result')
    const files = expectedFiles.slice().sort()
    const returned = Object.keys(result.sourceBlobs).sort()
    if (returned.length !== files.length || returned.some((file, index) => file !== files[index] || result.sourceBlobs[file] !== sourceBlobs[file])) throw new Error('semantic ownership source membership mismatch')
    if (result.partitionReceipts.length !== files.length) throw new Error('semantic ownership partition receipt membership mismatch')
    const receipts = new Map()
    for (let index = 0; index < result.partitionReceipts.length; index += 1) {
      const receipt = result.partitionReceipts[index]
      const file = files[index]
      const workerOwned = receipt?.writer === 'worker'
      const validLengths = Number.isInteger(receipt?.symbolLength) && receipt.symbolLength > 0 && Number.isInteger(receipt?.internalLength) && receipt.internalLength > 0 && (workerOwned ? receipt.symbolChunkCount === 0 && receipt.internalChunkCount === 0 && receipt.chunkCount === 0 : receipt.symbolChunkCount === 1 && receipt.internalChunkCount === 0 && receipt.chunkCount === 1) && receipt.serializedLength === receipt.symbolLength + receipt.internalLength
      if (!receipt || receipt.file !== file || receipt.sourceHash !== sourceBlobs[file] || !validLengths || !['engine', 'worker'].includes(receipt.writer) || receipts.has(file)) throw new Error(`semantic ownership partition receipt mismatch: ${file}`)
      const durable = workerOwned ? receipt : engineReceipts.get(file)
      if (!durable || !/^[a-f0-9]{64}$/.test(durable.partitionId) || !/^[a-f0-9]{64}$/.test(durable.internalPartitionId) || typeof durable.internalFingerprint !== 'string') throw new Error(`semantic ownership partition receipt is not durable: ${file}`)
      if (durable.serializedLength !== receipt.serializedLength || durable.chunkCount !== receipt.chunkCount || durable.symbolLength !== receipt.symbolLength || durable.internalLength !== receipt.internalLength) throw new Error(`semantic ownership partition receipt length mismatch: ${file}`)
      if (durable.internalFingerprint !== receipt.internalFingerprint) throw new Error(`semantic ownership internal fingerprint mismatch: ${file}`)
      if (workerOwned) {
        const symbolBytes = fs.readFileSync(path.join(this.store.partitions, `${durable.partitionId}.bin`))
        const internalBytes = fs.readFileSync(path.join(this.store.internalPartitions, `${durable.internalPartitionId}.bin`))
        if (contentHash(symbolBytes) !== durable.partitionId || contentHash(internalBytes) !== durable.internalPartitionId || symbolBytes.byteLength !== receipt.symbolLength || internalBytes.byteLength !== receipt.internalLength) throw new Error(`semantic ownership partition receipt durable content mismatch: ${file}`)
        const partition = decodeSymbolPartition(symbolBytes)
        this.#validateOwnedPartition(file, partition, sourceBlobs)
        const internal = decodeInternalPartition(internalBytes, { compilerFingerprint: receipt.internalFingerprint })
        if (internal.owners.some((owner) => owner.file !== file)) throw new Error(`semantic ownership internal partition file mismatch: ${file}`)
      } else if (!fs.existsSync(path.join(this.store.partitions, `${durable.partitionId}.bin`)) || !fs.existsSync(path.join(this.store.internalPartitions, `${durable.internalPartitionId}.bin`))) throw new Error(`semantic ownership partition receipt is missing durable content: ${file}`)
      receipts.set(file, durable)
    }
    for (const receipt of result.partitionReceipts) if (engineReceipts.has(receipt.file) && receipt.writer !== 'engine') throw new Error('semantic ownership engine partition membership mismatch')
    return receipts
  }
  #enqueueOperation(operation) {
    if (this.disposed) return Promise.reject(new Error('codegraph engine is disposed'))
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.catch(() => {})
    return result
  }
  #scheduleValidation(revision) {
    let resolve
    let reject
    const validation = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
    const request = { revision, epoch: this.validationEpoch, resolve, reject }
    if (this.activeValidation) {
      if (this.pendingValidation) this.pendingValidation.resolve(null)
      this.pendingValidation = request
    } else this.#startValidation(request)
    return validation
  }
  #startValidation(request) {
    if (this.disposed || request.epoch !== this.validationEpoch) { request.resolve(null); return }
    this.activeValidation = request
    this.#runValidation(request)
  }
  async #runValidation(request) {
    let validationPool = null
    try {
      const changes = [...this.validationChanges.values()]
      const changedFiles = changes.map((change) => change.path)
      const expectedSourceBlobs = { ...this.validatedSourceBlobs }
      for (const change of changes) change.type === 'unlink' || change.source === undefined ? delete expectedSourceBlobs[change.path] : expectedSourceBlobs[change.path] = contentHash(change.source)
      const base = this.store.readGeneration(this.validatedGeneration)
      validationPool = createPartitionPool()
      this.activePartitionPool = validationPool
      const payload = { revision: request.revision, root: this.root, cacheDir: path.relative(this.root, this.store.dir), changedFiles, changes, baseGeneration: base.generation, baseSourceBlobs: this.validatedSourceBlobs, ...(!this.validationWorkerHydrated ? { basePartitionIds: base.partitions, baseInternalFingerprints: internalFingerprints(this.store, base), partitionDir: this.store.partitions } : {}), sourceDir: this.store.sources, partitionPool: validationPool.buffer, ...(validationPool.debugId ? { partitionPoolDebugId: validationPool.debugId } : {}) }
      this.validationPayloadObserver?.(payload)
      const partitions = new Map(); const transported = new Map()
      let persistenceMs = 0
      const onProgress = ({ partitions: completed, poolBatch }) => {
        if (poolBatch) { debugPool('Main Receive Batch', poolBatch); debugPool('Main Start Batch', poolBatch) }
        for (const job of completed) {
          const persistenceStarted = performance.now()
          const { file, offset, symbolLength, internalLength } = job
          this.#validateOwnedIdentity(file, readSymbolPartitionIdentity(validationPool.payload, offset, symbolLength), expectedSourceBlobs)
          const partitionId = this.store.writePackedPartitionRange(validationPool.payload, offset, symbolLength, file, this.profiler)
          const internalPartitionId = internalLength ? this.store.writeInternalPartitionRange(validationPool.payload, offset + symbolLength, internalLength) : null
          transported.set(file, { partitionId, internalPartitionId })
          completePartitionJob(validationPool)
          persistenceMs += performance.now() - persistenceStarted
        }
        if (poolBatch) debugPool('Main Complete Batch', poolBatch)
      }
      const result = await this.validationWorker.validate(payload, onProgress)
      if (result?.poolDiagnostics) {
        const { parseMs: workerParseMs, ...diagnostics } = result.poolDiagnostics
        debugPool('Main Shared Memory Summary', { mode: result.mode, ...diagnostics, workerParseMs, persistenceMs })
        delete result.poolDiagnostics
      }
      if (!result || !['full', 'delta'].includes(result.mode)) throw new Error(`unknown semantic validation mode: ${result?.mode}`)
      if (!result.baseGeneration || result.baseGeneration !== base.generation || result.baseGeneration !== this.validatedGeneration) throw new Error('semantic validation base generation mismatch')
      if (!Array.isArray(result.partitionReceipts)) throw new Error('semantic validation returned incomplete partition results')
      for (const receipt of result.partitionReceipts) {
        const durable = receipt.writer === 'worker' ? receipt : transported.get(receipt.file)
        if (!durable) throw new Error(`semantic validation partition receipt mismatch: ${receipt.file}`)
        const partition = this.store.readPartition(durable.partitionId)
        partition.internalFingerprint = receipt.internalFingerprint
        partitions.set(receipt.file, partition)
        transported.set(receipt.file, { partitionId: durable.partitionId, internalPartitionId: durable.internalPartitionId })
      }
      if (result.partitionReceipts.length !== partitions.size) throw new Error('semantic validation returned incomplete partition results')
      for (const receipt of result.partitionReceipts) {
        const partition = partitions.get(receipt.file)
        if (!partition || !['engine', 'worker'].includes(receipt.writer) || receipt.sourceHash !== result.sourceBlobs?.[receipt.file] || receipt.internalFingerprint !== partition.internalFingerprint) throw new Error(`semantic validation partition receipt mismatch: ${receipt.file}`)
      }
      result.partitions = Object.fromEntries(partitions)
      request.resolve(await this.#acceptValidation(result, request.epoch, base, changedFiles, transported))
    } catch (error) {
      if (!this.disposed) {
        this.validationWorkerHydrated = false
        this.validationBasePartitions = null
        const failure = this.profiler?.begin('codegraph.background-validation', { revision: request.revision, freshness: 'validated', coverage: coverageName(EDGE_COVERAGE.CALLS), status: 'error', error: error.message })
        if (failure) this.profiler.end(failure)
        try { await this.profiler?.write() } catch {}
        request.reject(error)
      }
    } finally {
      if (this.activePartitionPool === validationPool) this.activePartitionPool = null
      if (this.activeValidation !== request) return
      this.activeValidation = null
      const pending = this.pendingValidation
      this.pendingValidation = null
      if (pending) this.#startValidation(pending)
    }
  }
  async #acceptValidation(result, epoch = this.validationEpoch, base = this.store.readGeneration(this.validatedGeneration), changedFiles = [], transported = null) {
    const revision = result.revision
    if (epoch !== this.validationEpoch || revision !== this.validationRevision || this.disposed) { this.validationWorkerHydrated = false; this.validationBasePartitions = null; return null }
    const args = { revision, freshness: 'validated', coverage: coverageName(EDGE_COVERAGE.CALLS), status: 'ok' }
    const token = this.profiler?.begin('codegraph.background-validation', args)
    try {
      if (result.mode !== 'full' && result.mode !== 'delta') throw new Error(`unknown semantic validation mode: ${result.mode}`)
      if (!result.baseGeneration || result.baseGeneration !== base.generation || result.baseGeneration !== this.validatedGeneration) throw new Error('semantic validation base generation mismatch')
      if (this.store.readGeneration().generation !== base.generation) throw new Error('semantic validation base generation is stale')
      const productionBlobs = result.sourceBlobs ?? null
      if (!productionBlobs) throw new Error('semantic validation omitted source blob membership')
      const expectedFiles = new Set(Object.keys(base.sources ?? {}))
      for (const change of this.validationChanges.values()) change.type === 'unlink' ? expectedFiles.delete(change.path) : expectedFiles.add(change.path)
      const sourceFiles = Object.keys(productionBlobs).sort()
      if (sourceFiles.length !== expectedFiles.size || sourceFiles.some((file) => !expectedFiles.has(file))) throw new Error('semantic validation returned incomplete source membership')
      if (!result.partitions) throw new Error('semantic validation omitted shared partition results')
      const partitionsByFile = result.partitions
      const validatedFiles = Object.keys(partitionsByFile).sort()
      if (result.mode === 'full' && (validatedFiles.length !== sourceFiles.length || validatedFiles.some((file, index) => file !== sourceFiles[index]))) throw new Error('full semantic validation returned incomplete partition membership')
      if (result.mode === 'delta' && (validatedFiles.length === 0 || changedFiles.some((file) => !validatedFiles.includes(file)))) throw new Error('delta semantic validation omitted a changed partition')
      let basePartitions = null
      if (result.mode === 'delta') {
        basePartitions = this.validationBasePartitions?.generation === base.generation
          ? this.validationBasePartitions.partitions
          : this.partitionCache?.generation === base.generation
            ? Object.fromEntries(this.partitionCache.partitions.map((partition) => [partition.file, partition]))
          : Object.fromEntries(Object.entries(base.partitions).map(([file, id]) => [file, this.store.readPartition(id)]))
        if (unresolvedCandidateMatches(basePartitions, changedFiles)) throw new Error('delta semantic validation is unsafe with an unresolved candidate matching a changed path')
        const requiredFiles = [...reverseClosure(basePartitions, changedFiles)].sort()
        if (requiredFiles.length !== validatedFiles.length || requiredFiles.some((file, index) => file !== validatedFiles[index])) throw new Error('delta semantic validation partition keys do not match required dependent closure')
        for (const file of sourceFiles) if (!changedFiles.includes(file) && productionBlobs[file] !== base.sources[file]) throw new Error(`delta semantic validation changed unchanged source blob: ${file}`)
      }
      for (const change of this.validationChanges.values()) if (change.type !== 'unlink') {
        const source = this.store.readSource(productionBlobs[change.path])
        if (change.source !== undefined && contentHash(change.source) !== productionBlobs[change.path]) throw new Error(`semantic validation changed source blob mismatch: ${change.path}`)
        if (change.expectedDigest !== undefined && contentHash(`${change.path}\0${source}`) !== change.expectedDigest) throw new Error(`semantic validation provisional source mismatch: ${change.path}`)
      }
      const partitionIds = { ...base.partitions }
      const internalPartitionIds = { ...(base.internalPartitions ?? {}) }
      for (const [file, partition] of Object.entries(partitionsByFile)) {
        if (!expectedFiles.has(file)) throw new Error(`semantic validation returned unknown partition: ${file}`)
        if (!partition || partition.file !== file) throw new Error(`semantic validation partition key/file mismatch: ${file}`)
        if (contentHash(this.store.readSource(productionBlobs[file])) !== partition.sourceHash) throw new Error(`semantic validation partition source mismatch: ${file}`)
        const bytes = transported?.get(file)
        const { internalPartition, internalFingerprint, ...symbolPartition } = partition
        const persisted = bytes?.partitionId
          ? { partition: bytes.partitionId, internal: bytes.internalPartitionId, internalFingerprint }
          : bytes
          ? { partition: this.store.writePartitionBytes(bytes.symbol, this.profiler, symbolPartition), internal: bytes.internal ? this.store.writeInternalPartition(bytes.internal) : null, internalFingerprint }
          : persistPartition(this.store, partition, this.profiler)
        partitionIds[file] = persisted.partition
        if (persisted.internal) internalPartitionIds[file] = persisted.internal
        else {
          if (productionBlobs[file] !== base.sources[file]) throw new Error(`semantic validation omitted changed internal partition: ${file}`)
          const existing = base.internalPartitions?.[file]
          if (!existing) throw new Error(`semantic validation cannot reuse missing internal partition: ${file}`)
          openInternalPartition(this.store.readInternalPartition(existing), { compilerFingerprint: persisted.internalFingerprint })
          internalPartitionIds[file] = existing
        }
      }
      for (const file of Object.keys(partitionIds)) if (!expectedFiles.has(file)) { delete partitionIds[file]; delete internalPartitionIds[file] }
      if (Object.keys(partitionIds).length !== sourceFiles.length) throw new Error('semantic validation would publish incomplete partitions')
      if (epoch !== this.validationEpoch || revision !== this.validationRevision || this.disposed) return null
      if (this.store.readGeneration().generation !== base.generation) throw new Error('semantic validation base generation advanced before publication')
      const sourceIds = productionBlobs
      const generation = this.store.publish({ version: 3, root: this.root, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), controlHashes: controlFileHashes(this.root), sources: sourceIds, partitions: partitionIds, internalPartitions: internalPartitionIds, partitionHashes: partitionIds })
      this.validatedGeneration = generation.generation
      this.publishedValidationRevision = revision
      this.validatedSourceBlobs = sourceIds
      this.validationWorkerHydrated = true
      const cachedPartitions = result.mode === 'full' ? {} : this.validationBasePartitions?.generation === base.generation
        ? { ...this.validationBasePartitions.partitions }
        : { ...basePartitions }
      Object.assign(cachedPartitions, partitionsByFile)
      for (const file of Object.keys(cachedPartitions)) if (!expectedFiles.has(file)) delete cachedPartitions[file]
      this.validationBasePartitions = { generation: generation.generation, partitions: cachedPartitions }
      this.partitionCache = { generation: generation.generation, partitions: Object.values(cachedPartitions).sort((left, right) => left.file.localeCompare(right.file)) }
      this.validationChanges.clear()
      return { ...generation, validationMode: result.mode, validatedFiles, internalBuildCount: result.internalBuildCount ?? validatedFiles.length, internalRebuiltFiles: result.internalRebuiltFiles ?? validatedFiles, internalReusedFiles: result.internalReusedFiles ?? [] }
    } catch (error) { this.validationWorkerHydrated = false; this.validationBasePartitions = null; args.status = 'error'; args.error = error.message; throw error } finally { if (token) this.profiler.end(token); try { await this.profiler?.write() } catch {} }
  }
  async #readSources(files, profile) {
    return (await this.#readSourceSnapshot(files, profile)).sources
  }
  async #readSourceSnapshot(files, profile) {
    const readPhase = this.profiler?.begin('read-sources', undefined, { memory: true })
    try {
      const result = await readSources(this.root, { scan: () => files }, {
        ...this.sourceReaderDeps,
        concurrency: this.readConcurrency ?? this.sourceReaderDeps.concurrency,
        measure: Boolean(profile),
      })
      this.#recordReadStats(profile, result.stats)
      return result
    } finally {
      if (readPhase) this.profiler.end(readPhase)
    }
  }
  #recordReadStats(profile, stats) {
    if (!profile) return
    profile.args.filesRead += stats.filesRead
    profile.args.bytesRead += stats.bytesRead
    profile.args.readMs += stats.readMs
    profile.args.readConcurrency = stats.readConcurrency
    profile.args.peakReads = Math.max(profile.args.peakReads, stats.peakReads)
  }
  #beginOperation(name) {
    if (!this.profiler) return null
    const args = { filesRead: 0, bytesRead: 0, readMs: 0, filesParsed: 0, filesReused: 0, readConcurrency: this.readConcurrency ?? this.sourceReaderDeps.concurrency ?? 16, peakReads: 0, status: 'ok' }
    const profile = { args, operation: this.profiler.begin(`codegraph.${name}`, args, { memory: true }) }
    this.activeProfile = profile
    return profile
  }
  async #finishOperation(profile, result) {
    if (profile) {
      profile.args.filesReused = result.reusedFiles.length
      this.profiler.end(profile.operation)
      this.activeProfile = null
    }
    return this.#profileResult(result, profile)
  }
  async #failOperation(profile, error) {
    if (!profile) return
    profile.args.status = 'error'
    profile.args.error = error.message
    this.profiler.end(profile.operation)
    this.activeProfile = null
    try { await this.profiler.write() } catch {}
  }
  async #profileResult(result, profile = this.activeProfile) {
    if (!this.profiler) return result
    const descriptor = { path: this.profilePath, format: 'chrome-trace-event' }
    try { await this.profiler.write() } catch (error) { descriptor.error = error.message }
    if (profile === this.activeProfile) this.activeProfile = null
    return { ...result, profile: descriptor }
  }
}
