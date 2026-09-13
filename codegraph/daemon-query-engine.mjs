import fs from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import { MmapQueryCache } from './mmap-query-cache.mjs'
import { prepareQueryViewCache } from './query-cache-schema.mjs'
import { EDGE_COVERAGE, coverageCode, coverageName } from './edge-coverage.mjs'
import { nativeMmapAdapter } from './native/mmap-adapter.mjs'
import { GraphStore, openInternalPartition } from './store.mjs'

const endpoint = ({ id, name, file, line, kind }) => ({ id, name, file, line, kind })
const DEBUG_POOL = process.env.CODEGRAPH_DEBUG_POOL === '1'

const resolveOwner = (owners, selector) => {
  if (!selector) return null
  const matches = owners.filter((owner) => selector.id !== undefined ? owner.id === selector.id :
    (selector.symbol === undefined || owner.name === selector.symbol) && (selector.line === undefined || owner.line === selector.line) &&
    (selector.column === undefined || owner.column === selector.column) && (selector.kind === undefined || owner.kind === selector.kind))
  if (matches.length !== 1) throw new Error(matches.length ? 'owner selector is ambiguous' : 'owner not found')
  return matches[0]
}

const internalRows = (graph, owner, request, { signal } = {}) => {
  const checkCancelled = () => { if (signal?.aborted) throw signal.reason ?? new Error('internal query aborted') }
  const ownedNodes = graph.nodes.filter((node) => !owner || node.ownerId === owner.id)
  const ownedEdges = graph.edges.filter((edge) => !owner || edge.ownerId === owner.id)
  if (request.operation === 'metrics') return [{ record: 'metrics', owner, profile: 'codegraph-cfg-v1', metrics: { cyclomatic: owner.cyclomatic, branchCount: owner.branchCount, nestingDepth: owner.nestingDepth } }]
  if (request.operation === 'map') {
    const view = request.view ?? 'combined'
    const rows = [{ record: 'owner', owner }, ...ownedNodes.map((node) => ({ record: 'node', ownerId: owner.id, node }))]
    if (view !== 'syntax') rows.push(...ownedEdges.map((edge) => ({ record: 'edge', ownerId: owner.id, edge })))
    if (view === 'combined') rows.push(...graph.relations.filter((relation) => relation.ownerId === owner.id).map((relation) => ({ record: 'relation', ownerId: owner.id, relation })))
    return rows
  }
  if (request.operation === 'search') {
    const match = request.match
    return ownedNodes.filter((node) => (!match.nodeKind || node.kind === match.nodeKind) && (!match.role || node.role === match.role) &&
      (!match.edgeKind || ownedEdges.some((edge) => edge.from === node.id && edge.kind === match.edgeKind)) &&
      (!match.relationKind || graph.relations.some((relation) => relation.fromNode === node.id && relation.kind === match.relationKind)) &&
      (!match.targetSymbolId || graph.relations.some((relation) => relation.fromNode === node.id && relation.targetSymbolId === match.targetSymbolId)))
      .map((node) => ({ record: 'match', owner: graph.owners[node.ownerId], node, ancestors: [] }))
  }
  if (request.operation === 'paths') {
    const select = (selector) => ownedNodes.filter((node) => (selector.id === undefined || node.id === selector.id) && (selector.nodeKind === undefined || node.kind === selector.nodeKind) && (selector.role === undefined || node.role === selector.role) && (selector.symbolId === undefined || node.symbolId === selector.symbolId))
    const from = select(request.from); const to = select(request.to)
    if (from.length !== 1 || to.length !== 1) throw new Error('path endpoints must each resolve one node')
    const avoided = new Set(request.avoid ? select(request.avoid).map(({ id }) => id) : [])
    if (avoided.has(from[0].id) || avoided.has(to[0].id)) throw new Error('avoid matches a path endpoint')
    const maxDepth = request.maxDepth ?? 100; const maxPaths = request.maxPaths ?? 20
    const adjacency = new Map()
    for (const candidate of ownedEdges) { if (!adjacency.has(candidate.from)) adjacency.set(candidate.from, []); adjacency.get(candidate.from).push(candidate) }
    for (const values of adjacency.values()) values.sort((a, b) => a.to - b.to || a.kind.localeCompare(b.kind))
    const queue = [{ id: from[0].id, parent: null, depth: 1 }]; const paths = []; let head = 0
    const contains = (item, id) => { for (let cursor = item; cursor; cursor = cursor.parent) if (cursor.id === id) return true; return false }
    const materialize = (item) => { const result = Array(item.depth); for (let cursor = item, index = item.depth - 1; cursor; cursor = cursor.parent, index -= 1) result[index] = cursor.id; return result }
    while (head < queue.length && paths.length < maxPaths) {
      checkCancelled()
      const item = queue[head++]; const last = item.id
      if (last === to[0].id) { paths.push(materialize(item)); continue }
      if (item.depth >= maxDepth) continue
      for (const edge of adjacency.get(last) ?? []) if (!contains(item, edge.to) && !avoided.has(edge.to)) queue.push({ id: edge.to, parent: item, depth: item.depth + 1 })
    }
    return paths.map((nodeIds) => ({ record: 'path', ownerId: owner.id, nodeIds, edges: nodeIds.slice(1).map((to, index) => adjacency.get(nodeIds[index]).find((edge) => edge.to === to)), truncated: head < queue.length }))
  }
  throw new Error(`unknown internals operation: ${request.operation}`)
}

export class DaemonQueryEngine {
  constructor(root, options = {}) {
    this.root = path.resolve(root)
    this.ownsCache = options.cache == null
    this.cache = options.cache ?? (options.cacheFactory ?? (() => new MmapQueryCache({
      filePath: prepareQueryViewCache(path.join(this.root, '.codegraph')),
      root: this.root,
      adapter: nativeMmapAdapter,
    })))()
    this.engineFactory = options.engineFactory ?? (async () => {
      const { CodeGraphEngine } = await import('./tool-engine.mjs')
      return new CodeGraphEngine(this.root)
    })
    this.disposeFallback = options.disposeFallback ?? true
    this.fallback = null
    this.leases = new Set()
    this.disposed = false
  }

  async queryBatch(request, options = {}) {
    const rows = (await this.pinQuery(request, options)).rows
    if (Array.isArray(rows)) return rows
    const result = []
    for await (const row of rows) {
      if (options.signal?.aborted) return []
      result.push(row)
    }
    return result
  }

  async pinQuery(request, options = {}) {
    if (options.signal?.aborted) return { metadata: {}, graph: null, rows: [] }
    if (this.disposed) throw new Error('daemon query engine is disposed')
    if (request.type === 'internals' || request.type === 'internal-summaries') return this.#pinInternal(request, options)
    if (request.consistency === 'latest') return this.#pinFallback(request, options)
    const generation = request.generation ?? this.#currentGeneration()
    if (!generation) return this.#pinFallback(request, options)
    const coverage = request.type === 'refs' || request.type === 'graph'
      ? (coverageCode(request.edgeCoverage) ?? EDGE_COVERAGE.COMPLETE)
      : EDGE_COVERAGE.CALLS
    let lease
    try {
      lease = this.cache.acquire({ generation, coverage: coverageName(coverage) })
      if (!lease && request.type === 'symbols') lease = this.cache.acquire({ generation, coverage: coverageName(EDGE_COVERAGE.COMPLETE) })
    } catch {}
    if (!lease) return this.#pinFallback(request, options)
    this.leases.add(lease)
    try {
      const view = lease.value.mappedView
      const refsStarted = DEBUG_POOL && request.type === 'refs' ? performance.now() : 0
      const rows = this.#queryMapped(view, request, options.signal)
      if (DEBUG_POOL && request.type === 'refs') process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), epochMs: Date.now(), monotonicMs: performance.now(), pid: process.pid, threadId, side: 'main', event: 'Main Semantic Timing Summary', operation: 'refs', cache: 'warm', completeEdgeMaterializationMs: 0, refsLookupMs: performance.now() - refsStarted })}\n`)
      return {
        metadata: { revision: null, freshness: 'validated', coverage: view.edgeCoverage, validatedGeneration: view.generation },
        graph: request.type === 'graph' ? rows[0] : null,
        rows,
      }
    }
    finally { lease.release(); this.leases.delete(lease) }
  }

  #pinInternal(request, options) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('internal query aborted')
    const generation = request.generation ?? this.#currentGeneration()
    if (!generation) throw new Error('no validated generation; run build')
    const acquired = this.cache.acquireInternal?.({ generation, file: request.file })
    if (acquired) {
      try {
        const method = request.type === 'internal-summaries' ? 'summaries' : request.operation
        const rows = acquired.value[method]?.(request, options) ?? []
        return { metadata: { revision: null, freshness: 'validated', coverage: 'calls', internalCoverage: 'syntax-and-cfg', validatedGeneration: generation }, graph: null, rows }
      } finally { acquired.release() }
    }
    const store = new GraphStore(this.root)
    const manifest = store.readGeneration(generation)
    if (request.type === 'internal-summaries') {
      const owners = []
      for (const [file, id] of Object.entries(manifest.internalPartitions ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const view = openInternalPartition(store.readInternalPartition(id))
        for (const owner of view.owners()) if (owner.symbolId && (request.includeTests || !/(^|\/)test(s)?\//.test(file))) owners.push({ ...owner, file })
      }
      if (request.metricsOnly) return { metadata: { revision: null, freshness: 'validated', coverage: manifest.edgeCoverage ?? 'calls', internalCoverage: 'syntax-and-cfg', validatedGeneration: generation }, graph: null, rows: [{ owners, edges: [], generation, roots: [], truncated: false }] }
      const ids = new Set(owners.map(({ symbolId }) => symbolId))
      const edges = Object.values(manifest.partitions ?? {}).flatMap((id) => store.readPartition(id).edges).filter((edge) => edge.call && ids.has(edge.from) && ids.has(edge.to))
      const incoming = new Map(); const outgoing = new Map()
      for (const edge of edges) { incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1); outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1) }
      const summaries = owners.map((owner) => ({ ...owner, ownerId: owner.id, nodeCount: owner.nodeCount ?? 0, incomingCallCount: incoming.get(owner.symbolId) ?? 0, outgoingCallCount: outgoing.get(owner.symbolId) ?? 0 }))
      const roots = request.root ? (ids.has(request.root) ? [request.root] : []) : summaries.filter((owner) => owner.incomingCallCount === 0 && owner.outgoingCallCount > 0).slice(0, 20).map(({ symbolId }) => symbolId)
      return { metadata: { revision: null, freshness: 'validated', coverage: manifest.edgeCoverage ?? 'calls', internalCoverage: 'syntax-and-cfg', validatedGeneration: generation }, graph: null, rows: [{ owners: summaries, edges, generation, roots, truncated: false }] }
    }
    const id = manifest.internalPartitions?.[request.file]
    if (!id) throw new Error(`no internal partition for ${request.file}; rebuild the index`)
    const view = openInternalPartition(store.readInternalPartition(id))
    const cap = Math.min(request.limit ?? 2000, 2000)
    const collect = (rows, label, countTowardsLimit = true) => {
      const result = []
      for (const row of rows) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('internal query aborted')
        result.push(row)
        if (countTowardsLimit && result.length > cap) throw new Error(`${label} exceeds requested limit ${cap}; narrow the query`)
      }
      return result
    }
    const owners = request.owner?.id !== undefined ? [view.ownerAt(request.owner.id)].filter(Boolean) : collect(view.owners(), 'owner scan', false)
    const owner = resolveOwner(owners, request.owner)
    const graph = { owners, nodes: collect(view.nodes(owner?.id), 'node records'), edges: collect(view.edges(owner?.id), 'edge records'), relations: collect(view.relations(owner?.id), 'relation records') }
    const rows = internalRows(graph, owner, request, options)
    let records = 0
    for (const row of rows) { records += row.record === 'path' ? 1 + row.nodeIds.length + row.edges.length : 1; if (records > cap) throw new Error(`result exceeds requested limit ${cap}; narrow the query`) }
    return { metadata: { revision: null, freshness: 'validated', coverage: manifest.edgeCoverage ?? 'calls', internalCoverage: 'syntax-and-cfg', validatedGeneration: generation }, graph: null, rows }
  }

  async *query(request, options = {}) {
    for (const row of await this.queryBatch(request, options)) {
      if (options.signal?.aborted) return
      yield row
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const lease of this.leases) lease.release()
    this.leases.clear()
    if (this.ownsCache) this.cache.dispose?.()
    if (this.disposeFallback) {
      const fallback = await this.fallback?.catch(() => null)
      await fallback?.dispose?.()
    }
  }

  #currentGeneration() {
    try { return fs.readFileSync(path.join(this.root, '.codegraph', 'CURRENT'), 'utf8').trim() || null }
    catch { return null }
  }

  #fallback() {
    if (!this.fallback) this.fallback = Promise.resolve().then(() => this.engineFactory())
    return this.fallback
  }

  async #pinFallback(request, options) {
    const engine = await this.#fallback()
    if (request.type === 'graph' && coverageCode(request.edgeCoverage) === EDGE_COVERAGE.COMPLETE) {
      const graph = await engine.snapshotComplete(request.generation, options)
      return { metadata: { revision: null, freshness: 'validated', coverage: graph.edgeCoverage, validatedGeneration: graph.generation }, graph, rows: [graph] }
    }
    if (engine.pinQuery) return engine.pinQuery(request, options)
    return { metadata: {}, graph: null, rows: await engine.queryBatch(request, options) }
  }

  #queryMapped(view, request, signal) {
    if (signal?.aborted) return []
    let rows
    if (request.type === 'symbols') rows = view.matchingSymbols(request)
    else if (request.type === 'refs') rows = view.relationships(request, 'incoming').sort((a, b) => a.line - b.line || a.from.localeCompare(b.from))
    else if (request.type === 'deps') rows = view.relationships(request, 'outgoing')
    else if (request.type === 'graph') rows = [view.graph]
    else throw new Error(`unknown query type: ${request.type}`)
    const limit = Math.min(Math.max(0, request.limit ?? rows.length), rows.length)
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
}
