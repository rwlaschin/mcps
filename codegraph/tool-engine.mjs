import path from 'node:path'
import crypto from 'node:crypto'
import { controlFileHashes, createSourcePolicy } from './source-policy.mjs'
import { GraphStore, OVERLAY_VERSION } from './store.mjs'
import { EDGE_COVERAGE, coverageCode, coverageName } from './edge-coverage.mjs'

// Generations before version 3 predate the field and were always complete. Was copy-pasted at
// four call sites, each free to drift from the others.
const manifestCoverage = (manifest) =>
  manifest.version >= 3 ? (coverageCode(manifest.edgeCoverage) ?? EDGE_COVERAGE.CALLS) : EDGE_COVERAGE.COMPLETE
import { createTraceProfiler } from './trace-profile.mjs'
import { readSources } from './source-reader.mjs'
import { FileIdRegistry } from './file-index.mjs'
import { FileLocalResolver } from './incremental-resolver.mjs'
import { SemanticCheckerWorker } from './semantic-checker-worker.mjs'
import { MmapQueryCache } from './mmap-query-cache.mjs'
import { prepareQueryViewCache } from './query-cache-schema.mjs'
import { nativeMmapAdapter } from './native/mmap-adapter.mjs'

const contentHash = (text) => crypto.createHash('sha256').update(text).digest('hex')
const unresolvedCandidateMatches = (partitions, changedFiles) => {
  const changed = new Set(changedFiles.map((file) => file.split(path.sep).join('/')))
  return Object.values(partitions).some((partition) => partition.unresolved?.some((row) => row.candidates?.some((candidate) => changed.has(candidate))))
}
let semanticParser
const loadSemanticParser = () => semanticParser ??= import('./parser.mjs')

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
    const mmapOptions = options.mmapQueryCache ?? {}
    this.mmapQueryCache = new MmapQueryCache({
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
    this.workspace = null
    this.operationTail = Promise.resolve()
    this.disposed = false
    this.resolver = new FileLocalResolver(this.root, null, { ...(options.parserPool ? { parserPool: options.parserPool } : {}), parserPoolOptions: options.parserPoolOptions })
    this.parserPool = this.resolver.parserPool
    this.validationWorker = options.validationWorkerFactory?.() ?? new SemanticCheckerWorker()
    this.retainSemanticState = options.retainSemanticState === true
    this.validationPayloadObserver = options.validationPayloadObserver ?? null
    this.validationWorkerHydrated = false
    this.validationBasePartitions = null
    // Adopt the persisted generation up front. Leaving this null made a bare engine behave
    // differently from one reached through DaemonQueryEngine: the query-view cache is keyed by
    // generation, so a null one missed on every call and every query silently re-read all
    // partitions from disk instead of using the mapped page. Two entry points, two speeds.
    this.validatedGeneration = (() => { try { return this.store.readGeneration().generation ?? null } catch { return null } })()
    this.validatedSourceBlobs = {}
    this.validationChanges = new Map()
    this.validationEpoch = 0
    this.activeValidation = null
    this.pendingValidation = null
  }
  build() { return this.#enqueueOperation(() => this.#build()) }
  incremental(events, prefetched = null) { return this.#enqueueOperation(() => this.#incremental(events, prefetched)) }
  reconcile() { return this.#enqueueOperation(() => this.#reconcile()) }
  async #build() {
    this.#discardWorkspace()
    if (this.retainSemanticState) { this.validationWorkerHydrated = false; this.validationBasePartitions = null }
    this.policy = createSourcePolicy(this.root)
    const profile = this.#beginOperation('build')
    try {
    const scan = this.profiler?.begin('scan', undefined, { memory: true })
    const files = this.policy.scan(); this.#synchronizeFileIds(files); const known = new Set(files); const partitions = {}; const parsedFiles = []
    if (scan) this.profiler.end(scan)
    const sources = await this.#readSources(files, profile)
    const sourceBlobs = Object.fromEntries([...sources].map(([file, source]) => [file, this.store.writeSource(source)]))
    const semantic = this.profiler?.begin('semantic-project', undefined, { memory: true })
    let workspace = null; let ownedPartitions = null; let context = null; let parser = null
    if (this.retainSemanticState) {
      const result = await this.validationWorker.index({ root: this.root, sources: [...sources], sourceBlobs, edgeCoverage: EDGE_COVERAGE.CALLS })
      this.#validateOwnedResult(result, sourceBlobs)
      ownedPartitions = result.partitions
      Object.assign(partitions, result.partitions)
    } else {
      parser = await loadSemanticParser()
      context = parser.prepareSemanticProject(parser.createSemanticProject(this.root, sources), this.root, this.profiler)
      workspace = { project: context.project, host: context.project.__codegraphHost, context, sources }
    }
    if (semantic) this.profiler.end(semantic)
    const parseIndex = this.profiler?.begin('parse-index', undefined, { memory: true })
    for (const rel of files) { partitions[rel] = this.store.writePartition(this.retainSemanticState ? partitions[rel] : this.#parse(rel, sources, known, context, parser.parsePartition), this.profiler); parsedFiles.push(rel) }
    if (parseIndex) this.profiler.end(parseIndex)
    const publish = this.profiler?.begin('publish', undefined, { memory: true })
    const generation = this.store.publish({ version: 3, root: this.root, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), controlHashes: controlFileHashes(this.root), sources: sourceBlobs, partitions, partitionHashes: partitions })
    if (workspace) workspace.generation = generation.generation
    this.workspace = workspace
    this.resolver = new FileLocalResolver(this.root, sources, { parserPool: this.parserPool })
    this.validatedGeneration = generation.generation
    this.validatedSourceBlobs = sourceBlobs
    this.validationWorkerHydrated = this.retainSemanticState
    this.validationBasePartitions = this.retainSemanticState ? { generation: generation.generation, partitions: ownedPartitions } : null
    this.validationChanges.clear()
    this.validationEpoch += 1
    if (publish) this.profiler.end(publish)
    return this.#finishOperation(profile, { generation: generation.generation, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), parsedFiles, reusedFiles: [] })
    } catch (error) { this.#discardWorkspace(); await this.#failOperation(profile, error); throw error }
  }
  async #incremental(events, prefetched = null) {
    {
    const normalizedEvents = uniqueEvents(events)
    if (normalizedEvents.some((event) => this.policy.isControlRelative(this.policy.normalize(path.resolve(this.root, event.path))))) return this.#build()
    const previous = this.store.readGeneration()
    if (!this.validatedGeneration || this.validatedGeneration !== previous.generation || !this.resolver.sourceEntries().length) {
      this.resolver = new FileLocalResolver(this.root, new Map(Object.entries(previous.sources ?? {}).map(([file, id]) => [file, this.store.readSource(id)])), { parserPool: this.parserPool })
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
    const diskBacked = !prefetched && accepted.some((event) => event.type !== 'unlink' && event.source === undefined)
    const diskFileCount = accepted.filter((event) => event.type !== 'unlink' && event.source === undefined).length
    const apartmentBacked = diskBacked && diskFileCount >= 2 && this.parserPool.snapshot().workerCount > 0 && accepted.every((event) => event.type === 'unlink' || event.source === undefined)
    let changes; let refreshed
    if (apartmentBacked) {
      changes = accepted.map((event) => ({ ...event, fileId: event.path }))
      refreshed = await this.applyFileChanges(changes)
    } else {
      const needRead = accepted.filter((event) => event.type !== 'unlink' && event.source === undefined).map((event) => event.path)
      const read = prefetched?.sources ?? await this.#readSources(needRead, null)
      changes = accepted.map((event) => event.type === 'unlink' ? event : { ...event, source: event.source ?? read.get(event.path) })
      refreshed = this.applyChanges(changes)
    }
    const result = { generation: this.validatedGeneration, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), parsedFiles: changes.filter((event) => event.type !== 'unlink').map((event) => event.path).sort(), reusedFiles: this.resolver.snapshot().files.filter((file) => !changes.some((event) => event.path === file)), ...(this.profiler ? { profile: { path: this.profilePath, format: 'chrome-trace-event' } } : {}) }
    if (apartmentBacked) {
      result.validation = refreshed.validation.then((validated) => { result.validationMode = validated?.validationMode; result.validatedFiles = validated?.validatedFiles; result.generation = validated?.generation ?? result.generation; return validated })
    } else {
      const validated = await refreshed.validation
      result.validationMode = validated?.validationMode; result.validatedFiles = validated?.validatedFiles; result.generation = validated?.generation ?? result.generation
    }
    return result
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
      if (this.retainSemanticState && (!this.validationWorkerHydrated || this.validatedGeneration !== generation.generation)) {
        const persistedPartitions = Object.fromEntries(Object.entries(generation.partitions).map(([file, id]) => [file, this.store.readPartition(id)]))
        const hydrated = await this.validationWorker.hydrate({ root: this.root, generation: generation.generation, sources: [...readResult.sources], sourceBlobs: generation.sources ?? {}, partitions: persistedPartitions })
        this.#validateOwnedResult(hydrated, generation.sources ?? {})
        this.#discardWorkspace()
        this.validationWorkerHydrated = true
        this.validationBasePartitions = { generation: generation.generation, partitions: persistedPartitions }
      } else if (!this.retainSemanticState && (!this.workspace || this.workspace.generation !== generation.generation)) {
        this.#discardWorkspace()
        this.workspace = await this.#createWorkspace(readResult.sources, generation.generation)
      }
      this.resolver = new FileLocalResolver(this.root, readResult.sources, { parserPool: this.parserPool })
      this.validatedGeneration = generation.generation
      this.validatedSourceBlobs = generation.sources ?? {}
      if (!this.retainSemanticState) { this.validationWorkerHydrated = false; this.validationBasePartitions = null }
      this.validationChanges.clear()
      this.validationEpoch += 1
      return this.#profileResult({ generation: generation.generation, edgeCoverage: coverageName(manifestCoverage(generation)), parsedFiles: [], reusedFiles: [...files] }, profile)
    } catch (error) {
      if (profile) await this.#failOperation(profile, error)
      if (this.retainSemanticState && existingGeneration) { this.validationWorkerHydrated = false; this.validationBasePartitions = null; throw error }
      return this.#build()
    }
  }
  readGeneration(generation) { return this.store.readGeneration(generation) }
  provisionalSnapshot() { return this.resolver.snapshot() }
  applyChanges(changes, options = {}) {
    if (this.disposed) throw new Error('codegraph engine is disposed')
    const args = { revision: this.resolver.revision + 1, freshness: 'provisional', coverage: 'module-linked-syntax', status: 'ok' }
    const token = this.profiler?.begin('codegraph.provisional-refresh', args)
    let snapshot
    try { snapshot = this.resolver.applyChanges(changes, options) } catch (error) { args.status = 'error'; if (token) this.profiler.end(token); throw error }
    if (token) this.profiler.end(token)
    return this.#publishProvisional(snapshot, changes)
  }
  async applyFileChanges(changes, options = {}) {
    if (this.disposed) throw new Error('codegraph engine is disposed')
    const args = { revision: this.resolver.revision + 1, freshness: 'provisional', coverage: 'module-linked-syntax', status: 'ok' }
    const token = this.profiler?.begin('codegraph.provisional-refresh', args)
    let snapshot
    try { snapshot = await this.resolver.applyFileChanges(changes, options) } catch (error) { args.status = 'error'; if (token) this.profiler.end(token); throw error }
    if (token) this.profiler.end(token)
    return this.#publishProvisional(snapshot, changes)
  }
  #publishProvisional(snapshot, changes) {
    this.provisionalQueryView = null
    for (const change of changes) {
      const normalized = { ...change, path: slash(change.path) }
      if (normalized.type !== 'unlink' && normalized.source === undefined) normalized.expectedDigest = this.resolver.files.get(normalized.path)?.digest
      this.validationChanges.set(normalized.path, normalized)
    }
    const validatedGeneration = this.validatedGeneration ?? (() => { try { return this.store.readGeneration().generation } catch { return null } })()
    const validation = this.#scheduleValidation(snapshot.revision)
    return { ...snapshot, validatedGeneration, validation }
  }
  registeredFiles() {
    const files = new Set(this.workspace?.sources.keys() ?? Object.keys(this.store.readGeneration().partitions))
    for (const [file, hash] of Object.entries(controlFileHashes(this.root))) if (hash) files.add(file)
    return files
  }
  async dispose() {
    this.disposed = true
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
    this.mmapQueryCache.dispose()
    this.provisionalQueryView = null
    this.#discardWorkspace()
    await this.parserPool.dispose()
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
    const baseView = this.#validatedQueryView(generation, EDGE_COVERAGE.CALLS)
    const base = baseView.mapped ? { generation: baseView.generation, edgeCoverage: baseView.edgeCoverage } : baseView.graph
    if (coverageCode(base.edgeCoverage) === EDGE_COVERAGE.COMPLETE) return baseView
    // A mapped base carries no edges — the page is a call-coverage projection. Merging an overlay
    // onto it needs the real base edges, so read them from the generation's partitions rather than
    // from the stub, which is undefined here and used to throw inside mergeOrdered.
    const baseEdges = () => baseView.mapped
      ? this.#graphFromPartitions(baseView.manifest ?? this.store.readGeneration(base.generation), EDGE_COVERAGE.CALLS).edges
      : base.edges
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
    const merged = mergeOrdered(baseEdges(), this.#orderedOverlayEdges(base.generation, overlay))
    const full = baseView.mapped ? this.#graphFromPartitions(manifest, EDGE_COVERAGE.CALLS) : base
    const graph = { ...full, edgeCoverage: coverageName(EDGE_COVERAGE.COMPLETE), edges: merged }
    return this.#rememberValidatedQueryView(base.generation, EDGE_COVERAGE.COMPLETE, this.queryViewFactory(graph, manifest), manifest)
  }
  pinQuery(request, options = {}) {
    if (!request.generation && request.consistency === 'latest') {
      const view = this.#provisionalQueryView()
      const graph = view.graph
      return { metadata: { revision: graph.revision, freshness: graph.freshness, coverage: graph.coverage, validatedGeneration: graph.validatedGeneration }, graph, rows: this.query(request, { ...options, queryViewPin: view }) }
    }
    const baseView = this.#validatedQueryView(request.generation, EDGE_COVERAGE.CALLS)
    const view = request.type === 'refs' || request.type === 'graph' ? (this.#cachedValidatedQueryView(baseView.graph.generation, EDGE_COVERAGE.COMPLETE) ?? baseView) : baseView
    const graph = view.graph
    return { metadata: { revision: null, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation }, graph, rows: this.query({ ...request, generation: graph.generation }, { ...options, queryViewPin: view }) }
  }
  async queryBatch(request, options = {}) {
    const { signal } = options; const maxQueue = Math.max(1, options.maxQueue ?? 64)
    if (signal?.aborted) return []
    const latest = !request.generation && request.consistency === 'latest'
    let view = options.queryViewPin
    if (view && (request.type === 'refs' || request.type === 'graph') && coverageCode(view.graph.edgeCoverage) !== EDGE_COVERAGE.COMPLETE) view = null
    if (!view) {
      if (latest) view = this.#provisionalQueryView()
      else if (request.type === 'refs' || request.type === 'graph') {
        view = await this.#completeQueryView(request.generation, options)
      } else view = this.#validatedQueryView(request.generation, EDGE_COVERAGE.CALLS)
    }
    if (!view || signal?.aborted) return []
    if (view.mapped) return this.#queryMapped(view, request, signal)
    const graph = view.graph
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
      ? { revision: graph.revision, freshness: graph.freshness, coverage: graph.coverage, validatedGeneration: graph.validatedGeneration, files: graph.files, symbols: graph.symbols, edges: graph.edges, unresolvedEdges: graph.unresolvedEdges }
      : { generation: graph.generation, edgeCoverage: graph.edgeCoverage, files: graph.files, symbols: graph.symbols, edges: graph.edges }]
    else throw new Error(`unknown query type: ${request.type}`)
    // Async generators are pull-based: there are zero prefetched rows, so the bounded queue
    // cannot exceed one row regardless of consumer speed.
    if (!Number.isInteger(maxQueue)) throw new Error('maxQueue must be an integer')
    const limit = Math.min(request.limit ?? rows.length, rows.length)
    const metadata = latest ? { revision: graph.revision, freshness: graph.freshness, coverage: graph.coverage, validatedGeneration: graph.validatedGeneration } : null
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
    while (this.validatedQueryViews.size > 2) this.validatedQueryViews.delete(this.validatedQueryViews.keys().next().value)
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
    if (this.provisionalQueryView?.graph.revision === this.resolver.revision) return this.provisionalQueryView
    const graph = { ...this.provisionalSnapshot(), validatedGeneration: this.validatedGeneration }
    this.provisionalQueryView = this.queryViewFactory(graph)
    return this.provisionalQueryView
  }
  #parse(rel, sources, known, context, parsePartition) {
    if (this.instrument) this.instrument({ phase: 'parse', file: rel })
    const source = sources.get(rel)
    if (this.activeProfile) this.activeProfile.args.filesParsed += 1
    return parsePartition(rel, source, known, context, this.profiler, EDGE_COVERAGE.CALLS)
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
        let fragments = null
        let usedWorker = false
        if (manifest.generation === this.validatedGeneration && this.validationWorkerHydrated && typeof this.validationWorker.referenceOverlay === 'function') {
          try { fragments = await this.validationWorker.referenceOverlay({ generation: manifest.generation, sourceBlobs: manifest.sources, staleFiles: stale }); usedWorker = true }
          catch { fragments = null }
        }
        if (usedWorker) {
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
        } else {
          // A cold or mismatched worker keeps the historical whole-project path.
          const { createSemanticProject, parsePartition, prepareSemanticProject } = await loadSemanticParser()
          const sources = new Map(Object.entries(manifest.sources).map(([file, id]) => [file, this.store.readSource(id)]))
          const context = prepareSemanticProject(createSemanticProject(this.root, sources), this.root, this.profiler)
          const known = new Set(sources.keys())
          for (const rel of stale) {
            const partition = parsePartition(rel, sources.get(rel), known, context, this.profiler, EDGE_COVERAGE.COMPLETE)
            files[rel] = { key: keys.get(rel) ?? null, edges: partition.edges.filter((edge) => !edge.call) }
          }
        }
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
  async #createWorkspace(sources, generation = null) {
    const { createSemanticProject, prepareSemanticProject } = await loadSemanticParser()
    const context = prepareSemanticProject(createSemanticProject(this.root, sources), this.root, this.profiler)
    return { project: context.project, host: context.project.__codegraphHost, context, sources: new Map(sources), generation }
  }
  #discardWorkspace() {
    if (!this.workspace) return
    this.workspace = null
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
    try {
      const changes = [...this.validationChanges.values()]
      const changedFiles = changes.map((change) => change.path)
      const base = this.store.readGeneration(this.validatedGeneration)
      const payload = { revision: request.revision, root: this.root, changedFiles, changes, baseGeneration: base.generation, baseSourceBlobs: this.validatedSourceBlobs, ...(!this.validationWorkerHydrated ? { basePartitionIds: base.partitions, partitionDir: this.store.partitions } : {}), sourceDir: this.store.sources }
      this.validationPayloadObserver?.(payload)
      const result = await this.validationWorker.validate(payload)
      request.resolve(await this.#acceptValidation(result, request.epoch, base, changedFiles))
    } catch (error) {
      if (!this.disposed) {
        const failure = this.profiler?.begin('codegraph.background-validation', { revision: request.revision, freshness: 'validated', coverage: coverageName(EDGE_COVERAGE.CALLS), status: 'error', error: error.message })
        if (failure) this.profiler.end(failure)
        try { await this.profiler?.write() } catch {}
        request.reject(error)
      }
    } finally {
      if (this.activeValidation !== request) return
      this.activeValidation = null
      const pending = this.pendingValidation
      this.pendingValidation = null
      if (pending) this.#startValidation(pending)
    }
  }
  async #acceptValidation(result, epoch = this.validationEpoch, base = this.store.readGeneration(this.validatedGeneration), changedFiles = []) {
    const revision = result.revision
    if (epoch !== this.validationEpoch || revision !== this.resolver.revision || this.disposed) { this.validationWorkerHydrated = false; this.validationBasePartitions = null; return null }
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
      const sources = productionBlobs ? null : new Map(result.sources ?? this.resolver.sourceEntries())
      const snapshot = result.partitions ? null : (result.files ? result : this.resolver.snapshot())
      const partitionsByFile = result.partitions ?? Object.fromEntries(snapshot.files.map((file) => [file, {
        file,
        sourceHash: contentHash(sources.get(file) ?? ''),
        symbols: snapshot.symbols.filter((symbol) => symbol.file === file).map(({ start, end, bodyStart, parent, ...symbol }) => symbol),
        edges: snapshot.edges.filter((edge) => edge.fromFile === file).map(({ fromFile, fromName, toFile, toName, toLine, ...edge }) => edge),
        dependencies: [], unresolved: [],
      }]))
      const validatedFiles = Object.keys(partitionsByFile).sort()
      if (result.mode === 'full' && (validatedFiles.length !== sourceFiles.length || validatedFiles.some((file, index) => file !== sourceFiles[index]))) throw new Error('full semantic validation returned incomplete partition membership')
      if (result.mode === 'delta' && (validatedFiles.length === 0 || changedFiles.some((file) => !validatedFiles.includes(file)))) throw new Error('delta semantic validation omitted a changed partition')
      if (result.mode === 'delta') {
        const basePartitions = this.validationBasePartitions?.generation === base.generation
          ? this.validationBasePartitions.partitions
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
      for (const [file, partition] of Object.entries(partitionsByFile)) {
        if (!expectedFiles.has(file)) throw new Error(`semantic validation returned unknown partition: ${file}`)
        if (!partition || partition.file !== file) throw new Error(`semantic validation partition key/file mismatch: ${file}`)
        if (contentHash(this.store.readSource(productionBlobs[file])) !== partition.sourceHash) throw new Error(`semantic validation partition source mismatch: ${file}`)
        partitionIds[file] = this.store.writePartition(partition, this.profiler)
      }
      for (const file of Object.keys(partitionIds)) if (!expectedFiles.has(file)) delete partitionIds[file]
      if (Object.keys(partitionIds).length !== sourceFiles.length) throw new Error('semantic validation would publish incomplete partitions')
      if (epoch !== this.validationEpoch || revision !== this.resolver.revision || this.disposed) return null
      if (this.store.readGeneration().generation !== base.generation) throw new Error('semantic validation base generation advanced before publication')
      const sourceIds = productionBlobs ?? Object.fromEntries([...sources].map(([file, source]) => [file, this.store.writeSource(source)]))
      const generation = this.store.publish({ version: 3, root: this.root, edgeCoverage: coverageName(EDGE_COVERAGE.CALLS), controlHashes: controlFileHashes(this.root), sources: sourceIds, partitions: partitionIds, partitionHashes: partitionIds })
      this.validatedGeneration = generation.generation
      this.validatedSourceBlobs = sourceIds
      this.validationWorkerHydrated = true
      const cachedPartitions = result.mode === 'full' ? {} : this.validationBasePartitions?.generation === base.generation
        ? { ...this.validationBasePartitions.partitions }
        : Object.fromEntries(Object.entries(base.partitions).map(([file, id]) => [file, this.store.readPartition(id)]))
      Object.assign(cachedPartitions, partitionsByFile)
      for (const file of Object.keys(cachedPartitions)) if (!expectedFiles.has(file)) delete cachedPartitions[file]
      this.validationBasePartitions = { generation: generation.generation, partitions: cachedPartitions }
      this.validationChanges.clear()
      return { ...generation, validationMode: result.mode, validatedFiles }
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
