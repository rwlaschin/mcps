import { createTypeScriptLanguageAnalyzer } from './typescript-language-analyzer.mjs'
import { createGoLanguageAnalyzer } from './go-language-analyzer.mjs'
import { PublicationFacts } from './publication-facts.mjs'

export const defaultLanguageAnalyzers = [createTypeScriptLanguageAnalyzer, createGoLanguageAnalyzer]

const mapForOwner = (registry, owner, values) => {
  const selected = {}
  for (const file in values ?? {}) if (registry.analyzerFor(file) === owner) selected[file] = values[file]
  return selected
}

export class LanguageSemanticWorker {
  constructor(registry, options = {}) {
    this.registry = registry
    this.options = options
    this.workers = new Map()
    this.facts = new Map()
    this.publication = null
    this.pendingOwners = new Map()
  }
  worker(owner) {
    let worker = this.workers.get(owner)
    if (!worker) { worker = owner.createSemanticWorker(this.options); this.workers.set(owner, worker) }
    return worker
  }
  sourceGroups(sources) {
    const groups = new Map()
    for (const entry of sources) {
      const owner = this.registry.analyzerFor(entry[0])
      if (!owner) throw new Error(`source has no analyzer: ${entry[0]}`)
      let group = groups.get(owner)
      if (!group) { group = []; groups.set(owner, group) }
      group.push(entry)
    }
    return groups
  }
  remember(owner, result) {
    let facts = this.facts.get(owner)
    if (!facts) { facts = { sourceBlobs: {} }; this.facts.set(owner, facts) }
    if (result.mode === 'full') facts.sourceBlobs = result.sourceBlobs
    else for (const file in result.sourceBlobs ?? {}) facts.sourceBlobs[file] = result.sourceBlobs[file]
    for (const file of result.tombstones ?? []) delete facts.sourceBlobs[file]
    return result
  }
  async index(request, onProgress) {
    this.root = request.root; this.cacheDir = request.cacheDir
    const groups = this.sourceGroups(request.sources)
    this.facts.clear(); this.publication = null; this.pendingOwners.clear()
    for (const [owner, worker] of this.workers) if (!groups.has(owner)) { await worker.dispose(); this.workers.delete(owner) }
    if (groups.size <= 1) {
      const owner = groups.keys().next().value ?? this.registry.analyzers[0]
      return this.remember(owner, await this.worker(owner).index(request, onProgress))
    }
    const ordinals = new Map()
    for (let ordinal = 0; ordinal < request.sources.length; ordinal += 1) ordinals.set(request.sources[ordinal][0], ordinal)
    const result = { mode: 'full', sourceBlobs: {}, partitionReceipts: [], poolDiagnostics: { workersUsed: 0, jobsDispatched: 0 } }
    // The transport arena has one writer; each language keeps its own parallel parser pool.
    for (const [owner, sources] of groups) {
      const progress = (value) => { for (const job of value.partitions) job.ordinal = ordinals.get(job.file); onProgress?.(value) }
      const partial = this.remember(owner, await this.worker(owner).index({ ...request, sources, sourceBlobs: mapForOwner(this.registry, owner, request.sourceBlobs) }, progress))
      Object.assign(result.sourceBlobs, partial.sourceBlobs)
      result.partitionReceipts.push(...partial.partitionReceipts)
      result.poolDiagnostics.workersUsed += partial.poolDiagnostics?.workersUsed ?? 0
      result.poolDiagnostics.jobsDispatched += partial.poolDiagnostics?.jobsDispatched ?? sources.length
    }
    return result
  }
  async hydrate(request) {
    this.root = request.root; this.cacheDir = request.cacheDir
    const groups = this.sourceGroups(request.sources)
    if (groups.size <= 1) {
      const owner = groups.keys().next().value ?? this.registry.analyzers[0]
      return this.remember(owner, await this.worker(owner).hydrate(request))
    }
    await this.seedPublication(request.generation)
    const result = { mode: 'full', sourceBlobs: {}, partitions: {} }
    for (const [owner, sources] of groups) {
      const partial = this.remember(owner, await this.worker(owner).hydrate({ ...request, sources,
        sourceBlobs: mapForOwner(this.registry, owner, request.sourceBlobs),
        partitions: mapForOwner(this.registry, owner, request.partitions),
        internalFingerprints: mapForOwner(this.registry, owner, request.internalFingerprints),
        edgePatches: (request.edgePatches ?? []).filter((patch) => this.registry.analyzerFor(patch.file) === owner),
      }))
      Object.assign(result.sourceBlobs, partial.sourceBlobs)
      Object.assign(result.partitions, partial.partitions)
    }
    return result
  }
  async validate(request, onProgress) {
    this.root = request.root; this.cacheDir = request.cacheDir
    const owner = this.registry.analyzerFor(request.changes[0]?.path)
    let oneOwner = true
    for (const change of request.changes) if (this.registry.analyzerFor(change.path) !== owner) oneOwner = false
    const mixedBase = request.baseAnalyzers && Object.keys(request.baseAnalyzers).length > 1
    if (oneOwner && !mixedBase && this.workers.size <= 1 && (!this.workers.size || this.workers.has(owner))) {
      return this.remember(owner, await this.worker(owner).validate(request, onProgress))
    }
    const groups = new Map()
    for (const change of request.changes) {
      const analyzer = this.registry.analyzerFor(change.path)
      let group = groups.get(analyzer)
      if (!group) { group = []; groups.set(analyzer, group) }
      group.push(change)
    }
    if (request.baseSourceBlobs) for (const analyzer of this.registry.analyzers) this.pendingOwners.set(analyzer, {
      baseSourceBlobs: mapForOwner(this.registry, analyzer, request.baseSourceBlobs),
      basePartitionIds: mapForOwner(this.registry, analyzer, request.basePartitionIds),
      baseInternalFingerprints: mapForOwner(this.registry, analyzer, request.baseInternalFingerprints),
      baseEdgePatches: (request.baseEdgePatches ?? []).filter((patch) => this.registry.analyzerFor(patch.file) === analyzer),
      partitionDir: request.partitionDir,
    })
    const results = []
    for (const [analyzer, changes] of groups) {
      const payload = { ...request, changes }
      const retained = this.pendingOwners.get(analyzer)
      if (retained) {
        Object.assign(payload, retained)
        this.pendingOwners.delete(analyzer)
        payload.changedFiles = []
        for (const change of changes) payload.changedFiles.push(change.path)
      } else if (!this.workers.has(analyzer)) {
        await this.worker(analyzer).hydrate({ root: request.root, generation: request.baseGeneration, sources: [], sourceBlobs: {}, partitions: {}, internalFingerprints: {}, edgePatches: [] })
      }
      results.push(this.remember(analyzer, await this.worker(analyzer).validate(payload, onProgress)))
    }
    const result = request.changes.length === 1 ? results[0] : await this.mergeBatch(request, results)
    if (request.changes.length === 1 && result.mode !== 'delta') throw new Error('single-file analyzer validation must retain changed-file partitions')
    if (request.changes.length === 1) {
      await this.seedPublication(request.baseGeneration)
      this.publication.apply(result, request.changes[0].path)
    }
    return result
  }
  async seedPublication(generation) {
    if (this.publication) return
    const { GraphStore } = await import('./store.mjs')
    const manifest = new GraphStore(this.root, this.cacheDir).readGeneration(generation)
    this.publication = new PublicationFacts(manifest)
  }
  async mergeBatch(request, results) {
    const [{ GraphStore, openInternalPartition }, { default: fs }, { default: path }] = await Promise.all([import('./store.mjs'), import('node:fs'), import('node:path')])
    const store = new GraphStore(request.root, request.cacheDir)
    const base = store.readGeneration(request.baseGeneration)
    const sourceBlobs = { ...base.sources }
    const receipts = new Map()
    const result = { mode: 'full', revision: request.revision, baseGeneration: request.baseGeneration, sourceBlobs, partitionReceipts: [], internalBuildCount: 0, internalRebuiltFiles: [], internalReusedFiles: [] }
    for (const partial of results) {
      Object.assign(sourceBlobs, partial.sourceBlobs)
      for (const file of partial.tombstones ?? []) delete sourceBlobs[file]
      for (const receipt of partial.partitionReceipts) receipts.set(receipt.file, receipt)
      result.internalBuildCount += partial.internalBuildCount ?? 0
      result.internalRebuiltFiles.push(...partial.internalRebuiltFiles ?? [])
      result.internalReusedFiles.push(...partial.internalReusedFiles ?? [])
    }
    for (const file in sourceBlobs) {
      let receipt = receipts.get(file)
      if (!receipt) {
        const partitionId = base.partitions[file], internalPartitionId = base.internalPartitions[file]
        const symbolLength = fs.statSync(path.join(store.partitions, `${partitionId}.bin`)).size
        const internalLength = fs.statSync(path.join(store.internalPartitions, `${internalPartitionId}.bin`)).size
        receipt = { file, sourceHash: sourceBlobs[file], writer: 'worker', partitionId, internalPartitionId, symbolLength, internalLength, serializedLength: symbolLength + internalLength, chunkCount: 0, internalFingerprint: openInternalPartition(store.readInternalPartition(internalPartitionId)).compilerFingerprint }
      }
      result.partitionReceipts.push(receipt)
    }
    this.publication = null
    return result
  }
  async advanceGeneration(expectedGeneration, generation) {
    if (this.facts.size > 1) await this.seedPublication(generation)
    for (const worker of this.workers.values()) await worker.advanceGeneration(expectedGeneration, generation)
    return { generation }
  }
  async referenceOverlay(request) {
    if (this.workers.size === 1) return this.workers.values().next().value.referenceOverlay(request)
    const groups = new Map()
    for (const file of request.staleFiles) {
      const owner = this.registry.analyzerFor(file)
      let files = groups.get(owner)
      if (!files) { files = []; groups.set(owner, files) }
      files.push(file)
    }
    const result = { generation: request.generation, files: {} }
    for (const [owner, staleFiles] of groups) {
      const partial = await this.worker(owner).referenceOverlay({ ...request, staleFiles, sourceBlobs: this.facts.get(owner).sourceBlobs })
      Object.assign(result.files, partial.files)
    }
    return result
  }
  async dispose() { await Promise.all([...this.workers.values()].map((worker) => worker.dispose())); this.workers.clear(); this.facts.clear() }
}
