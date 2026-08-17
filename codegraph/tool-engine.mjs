import path from 'node:path'
import { createSourcePolicy } from './source-policy.mjs'
import { contentHash, createSemanticProject, parsePartition, prepareSemanticProject } from './parser.mjs'
import { GraphStore } from './store.mjs'
import { createTraceProfiler } from './trace-profile.mjs'
import { readSources } from './source-reader.mjs'
import { FileIdRegistry } from './file-index.mjs'
import { FileLocalResolver } from './incremental-resolver.mjs'
import { SemanticCheckerWorker } from './semantic-checker-worker.mjs'
import { MmapQueryCache } from './mmap-query-cache.mjs'
import { nativeMmapAdapter } from './native/mmap-adapter.mjs'

const slash = (p) => p.split(path.sep).join('/')
const uniqueEvents = (events) => [...new Map(events.map((event) => [`${event.type}:${slash(event.path)}`, { ...event, path: slash(event.path) }])).values()]

const edgeOrder = (a, b) => `${a.from}:${a.to}:${a.line}`.localeCompare(`${b.from}:${b.to}:${b.line}`)
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
      filePath: path.join(this.store.dir, 'query-view-cache.bin'),
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
    this.validatedQueryViews = new Map()
    this.provisionalQueryView = null
    this.workspace = null
    this.operationTail = Promise.resolve()
    this.disposed = false
    this.resolver = new FileLocalResolver(this.root, null, { ...(options.parserPool ? { parserPool: options.parserPool } : {}), parserPoolOptions: options.parserPoolOptions })
    this.parserPool = this.resolver.parserPool
    this.validationWorker = options.validationWorkerFactory?.() ?? new SemanticCheckerWorker()
    this.validationPayloadObserver = options.validationPayloadObserver ?? null
    this.validatedGeneration = null
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
    const profile = this.#beginOperation('build')
    try {
    const scan = this.profiler?.begin('scan', undefined, { memory: true })
    const files = this.policy.scan(); this.#synchronizeFileIds(files); const known = new Set(files); const partitions = {}; const parsedFiles = []
    if (scan) this.profiler.end(scan)
    const sources = await this.#readSources(files, profile)
    const semantic = this.profiler?.begin('semantic-project', undefined, { memory: true })
    const context = prepareSemanticProject(createSemanticProject(this.root, sources), this.root, this.profiler)
    const workspace = { project: context.project, host: context.project.__codegraphHost, context, sources }
    if (semantic) this.profiler.end(semantic)
    const parseIndex = this.profiler?.begin('parse-index', undefined, { memory: true })
    for (const rel of files) {
      const partition = this.#parse(rel, sources, known, context); partitions[rel] = this.store.writePartition(partition, this.profiler); parsedFiles.push(rel)
    }
    if (parseIndex) this.profiler.end(parseIndex)
    const publish = this.profiler?.begin('publish', undefined, { memory: true })
    const sourceBlobs = Object.fromEntries([...sources].map(([file, source]) => [file, this.store.writeSource(source)]))
    const generation = this.store.publish({ version: 3, root: this.root, edgeCoverage: 'calls', sources: sourceBlobs, partitions, partitionHashes: partitions })
    workspace.generation = generation.generation
    this.workspace = workspace
    this.resolver = new FileLocalResolver(this.root, sources, { parserPool: this.parserPool })
    this.validatedGeneration = generation.generation
    this.validatedSourceBlobs = sourceBlobs
    this.validationChanges.clear()
    this.validationEpoch += 1
    if (publish) this.profiler.end(publish)
    return this.#finishOperation(profile, { generation: generation.generation, edgeCoverage: 'calls', parsedFiles, reusedFiles: [] })
    } catch (error) { this.#discardWorkspace(); await this.#failOperation(profile, error); throw error }
  }
  async #incremental(events, prefetched = null) {
    {
    const previous = this.store.readGeneration()
    if (!this.validatedGeneration || this.validatedGeneration !== previous.generation || !this.resolver.sourceEntries().length) {
      this.resolver = new FileLocalResolver(this.root, new Map(Object.entries(previous.sources ?? {}).map(([file, id]) => [file, this.store.readSource(id)])), { parserPool: this.parserPool })
      this.validatedGeneration = previous.generation
      this.validatedSourceBlobs = previous.sources ?? {}
      this.validationChanges.clear()
      this.validationEpoch += 1
    }
    const accepted = []
    for (const event of uniqueEvents(events)) {
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
    if (!apartmentBacked) await refreshed.validation
    return { generation: this.validatedGeneration, edgeCoverage: 'calls', ...(apartmentBacked ? { validation: refreshed.validation } : {}), parsedFiles: changes.filter((event) => event.type !== 'unlink').map((event) => event.path).sort(), reusedFiles: this.resolver.snapshot().files.filter((file) => !changes.some((event) => event.path === file)), ...(this.profiler ? { profile: { path: this.profilePath, format: 'chrome-trace-event' } } : {}) }
    }
  }
  async #reconcile() {
    const profile = this.#beginOperation('reconcile')
    try {
      const generation = this.store.readGeneration()
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
      if (!this.workspace || this.workspace.generation !== generation.generation) {
        this.#discardWorkspace()
        this.workspace = this.#createWorkspace(readResult.sources, generation.generation)
      }
      this.resolver = new FileLocalResolver(this.root, readResult.sources, { parserPool: this.parserPool })
      this.validatedGeneration = generation.generation
      this.validatedSourceBlobs = generation.sources ?? {}
      this.validationChanges.clear()
      this.validationEpoch += 1
      return this.#profileResult({ generation: generation.generation, edgeCoverage: generation.version >= 3 ? (generation.edgeCoverage ?? 'calls') : 'complete', parsedFiles: [], reusedFiles: [...files] }, profile)
    } catch (error) {
      if (profile) await this.#failOperation(profile, error)
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
  registeredFiles() { return new Set(this.workspace?.sources.keys() ?? Object.keys(this.store.readGeneration().partitions)) }
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
    for (const entry of this.validatedQueryViews.values()) for (const coverage of ['calls', 'complete']) entry[coverage]?.release?.()
    this.validatedQueryViews.clear()
    this.mmapQueryCache.dispose()
    this.provisionalQueryView = null
    this.#discardWorkspace()
    await this.parserPool.dispose()
    await this.validationWorker.dispose()
  }
  snapshot(generation) {
    return this.#validatedQueryView(generation, 'calls').graph
  }
  async snapshotComplete(generation, options = {}) {
    const view = await this.#completeQueryView(generation, options)
    return view?.mapped ? view : view?.graph ?? null
  }
  async #completeQueryView(generation, options = {}) {
    const baseView = this.#validatedQueryView(generation, 'calls')
    const base = baseView.mapped ? { generation: baseView.generation, edgeCoverage: baseView.edgeCoverage } : baseView.graph
    if (base.edgeCoverage === 'complete') return baseView
    const cached = this.#cachedValidatedQueryView(base.generation, 'complete')
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
    const graph = { ...base, edgeCoverage: 'complete', edges: [...base.edges, ...overlay.edges].sort(edgeOrder) }
    return this.#rememberValidatedQueryView(base.generation, 'complete', this.queryViewFactory(graph, manifest), manifest)
  }
  pinQuery(request, options = {}) {
    if (!request.generation && request.consistency === 'latest') {
      const view = this.#provisionalQueryView()
      const graph = view.graph
      return { metadata: { revision: graph.revision, freshness: graph.freshness, coverage: graph.coverage, validatedGeneration: graph.validatedGeneration }, graph, rows: this.query(request, { ...options, queryViewPin: view }) }
    }
    const baseView = this.#validatedQueryView(request.generation, 'calls')
    const view = request.type === 'refs' || request.type === 'graph' ? (this.#cachedValidatedQueryView(baseView.graph.generation, 'complete') ?? baseView) : baseView
    const graph = view.graph
    return { metadata: { revision: null, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation }, graph, rows: this.query({ ...request, generation: graph.generation }, { ...options, queryViewPin: view }) }
  }
  async queryBatch(request, options = {}) {
    const { signal } = options; const maxQueue = Math.max(1, options.maxQueue ?? 64)
    if (signal?.aborted) return []
    const latest = !request.generation && request.consistency === 'latest'
    let view = options.queryViewPin
    if (view && (request.type === 'refs' || request.type === 'graph') && view.graph.edgeCoverage !== 'complete') view = null
    if (!view) {
      if (latest) view = this.#provisionalQueryView()
      else if (request.type === 'refs' || request.type === 'graph') {
        view = await this.#completeQueryView(request.generation, options)
      } else view = this.#validatedQueryView(request.generation, 'calls')
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
    const lease = this.mmapQueryCache.acquire({ generation, coverage })
    if (!lease) return null
    const mapped = lease.value.mappedView
    const mappedEntry = this.validatedQueryViews.get(generation) ?? { manifest: null }
    mappedEntry[coverage]?.release?.()
    mappedEntry[coverage] = mapped
    this.validatedQueryViews.delete(generation); this.validatedQueryViews.set(generation, mappedEntry)
    while (this.validatedQueryViews.size > 2) {
      const oldest = this.validatedQueryViews.keys().next().value
      const evicted = this.validatedQueryViews.get(oldest)
      for (const kind of ['calls', 'complete']) evicted[kind]?.release?.()
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
    if (publishMapped) this.mmapQueryCache.publish({ generation, coverage, view: { graph: view.graph, manifest } })
    return view
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
    if (coverage === 'complete' && (manifest.version >= 3 ? (manifest.edgeCoverage ?? 'calls') : 'complete') !== 'complete') {
      throw new Error(`complete query view for ${manifest.generation} has not been materialized`)
    }
    const partitions = Object.entries(manifest.partitions).sort(([a], [b]) => a.localeCompare(b)).map(([, id]) => this.store.readPartition(id))
    const symbols = partitions.flatMap((partition) => partition.symbols).sort((a, b) => a.id.localeCompare(b.id))
    const symbolIds = new Set(symbols.map((symbol) => symbol.id))
    const edges = partitions.flatMap((partition) => partition.edges.filter((edge) => symbolIds.has(edge.from) && symbolIds.has(edge.to))).sort(edgeOrder)
    const graph = { generation: manifest.generation, edgeCoverage: manifest.version >= 3 ? (manifest.edgeCoverage ?? 'calls') : 'complete', files: partitions.map((partition) => partition.file), symbols, edges }
    const view = this.queryViewFactory(graph, manifest)
    this.#rememberValidatedQueryView(manifest.generation, coverage, view, manifest)
    if (coverage !== graph.edgeCoverage) this.#rememberValidatedQueryView(manifest.generation, graph.edgeCoverage, view, manifest)
    return view
  }
  #provisionalQueryView() {
    if (this.provisionalQueryView?.graph.revision === this.resolver.revision) return this.provisionalQueryView
    const graph = { ...this.provisionalSnapshot(), validatedGeneration: this.validatedGeneration }
    this.provisionalQueryView = this.queryViewFactory(graph)
    return this.provisionalQueryView
  }
  #parse(rel, sources, known, context) {
    if (this.instrument) this.instrument({ phase: 'parse', file: rel })
    const source = sources.get(rel)
    if (this.activeProfile) this.activeProfile.args.filesParsed += 1
    return parsePartition(rel, source, known, context, this.profiler, 'calls')
  }
  async #buildReferenceOverlay(manifest) {
    this.instrument?.({ phase: 'reference-overlay', generation: manifest.generation })
    const token = this.profiler?.begin('reference-overlay', { generation: manifest.generation }, { memory: true })
    try {
      const sources = new Map(Object.entries(manifest.sources).map(([file, id]) => [file, this.store.readSource(id)]))
      const context = prepareSemanticProject(createSemanticProject(this.root, sources), this.root, this.profiler)
      const known = new Set(sources.keys()); const edges = []
      for (const [rel, source] of sources) {
        const partition = parsePartition(rel, source, known, context, this.profiler, 'complete')
        for (const edge of partition.edges) if (!edge.call) edges.push(edge)
      }
      const overlay = { generation: manifest.generation, edgeCoverage: 'complete', edges }
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
  #createWorkspace(sources, generation = null) {
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
      const payload = { revision: request.revision, root: this.root, changedFiles, changes, baseSourceBlobs: this.validatedSourceBlobs, sourceDir: this.store.sources }
      this.validationPayloadObserver?.(payload)
      const result = await this.validationWorker.validate(payload)
      request.resolve(await this.#acceptValidation(result, request.epoch))
    } catch (error) {
      if (!this.disposed) {
        const failure = this.profiler?.begin('codegraph.background-validation', { revision: request.revision, freshness: 'validated', coverage: 'calls', status: 'error', error: error.message })
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
  async #acceptValidation(result, epoch = this.validationEpoch) {
    const revision = result.revision
    if (epoch !== this.validationEpoch || revision !== this.resolver.revision || this.disposed) return null
    const args = { revision, freshness: 'validated', coverage: 'calls', status: 'ok' }
    const token = this.profiler?.begin('codegraph.background-validation', args)
    try {
      const productionBlobs = result.sourceBlobs ?? null
      const sources = productionBlobs ? null : new Map(result.sources ?? this.resolver.sourceEntries())
      const snapshot = result.partitions ? null : (result.files ? result : this.resolver.snapshot())
      const partitionsByFile = result.partitions ?? Object.fromEntries(snapshot.files.map((file) => [file, {
        file,
        sourceHash: contentHash(sources.get(file) ?? ''),
        symbols: snapshot.symbols.filter((symbol) => symbol.file === file).map(({ start, end, bodyStart, parent, ...symbol }) => symbol),
        edges: snapshot.edges.filter((edge) => edge.fromFile === file).map(({ fromFile, fromName, toFile, toName, toLine, ...edge }) => edge),
        dependencies: [], unresolved: [],
      }]))
      const partitionIds = {}; for (const [file, partition] of Object.entries(partitionsByFile)) partitionIds[file] = this.store.writePartition(partition, this.profiler)
      if (epoch !== this.validationEpoch || revision !== this.resolver.revision || this.disposed) return null
      const sourceIds = productionBlobs ?? Object.fromEntries([...sources].map(([file, source]) => [file, this.store.writeSource(source)]))
      const generation = this.store.publish({ version: 3, root: this.root, edgeCoverage: 'calls', sources: sourceIds, partitions: partitionIds, partitionHashes: partitionIds })
      this.validatedGeneration = generation.generation
      this.validatedSourceBlobs = sourceIds
      this.validationChanges.clear()
      return generation
    } catch (error) { args.status = 'error'; args.error = error.message; throw error } finally { if (token) this.profiler.end(token); try { await this.profiler?.write() } catch {} }
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
