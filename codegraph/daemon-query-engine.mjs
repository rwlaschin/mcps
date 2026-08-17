import fs from 'node:fs'
import path from 'node:path'
import { MmapQueryCache } from './mmap-query-cache.mjs'
import { nativeMmapAdapter } from './native/mmap-adapter.mjs'

const endpoint = ({ id, name, file, line, kind }) => ({ id, name, file, line, kind })

export class DaemonQueryEngine {
  constructor(root, options = {}) {
    this.root = path.resolve(root)
    this.cache = (options.cacheFactory ?? (() => new MmapQueryCache({
      filePath: path.join(this.root, '.codegraph', 'query-view-cache.bin'),
      root: this.root,
      adapter: nativeMmapAdapter,
    })))()
    this.engineFactory = options.engineFactory ?? (async () => {
      const { CodeGraphEngine } = await import('./tool-engine.mjs')
      return new CodeGraphEngine(this.root)
    })
    this.fallback = null
    this.leases = new Set()
    this.disposed = false
  }

  async queryBatch(request, options = {}) {
    if (options.signal?.aborted) return []
    if (this.disposed) throw new Error('daemon query engine is disposed')
    if (request.consistency === 'latest') return (await this.#fallback()).queryBatch(request, options)
    const generation = request.generation ?? this.#currentGeneration()
    if (!generation) return (await this.#fallback()).queryBatch(request, options)
    const coverage = request.type === 'refs' || request.type === 'graph' ? 'complete' : 'calls'
    let lease
    try {
      lease = this.cache.acquire({ generation, coverage })
      if (!lease && request.type === 'symbols') lease = this.cache.acquire({ generation, coverage: 'complete' })
    } catch {}
    if (!lease) return (await this.#fallback()).queryBatch(request, options)
    this.leases.add(lease)
    try { return this.#queryMapped(lease.value.mappedView, request, options.signal) }
    finally { lease.release(); this.leases.delete(lease) }
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
    this.cache.dispose?.()
    const fallback = await this.fallback?.catch(() => null)
    await fallback?.dispose?.()
  }

  #currentGeneration() {
    try { return fs.readFileSync(path.join(this.root, '.codegraph', 'CURRENT'), 'utf8').trim() || null }
    catch { return null }
  }

  #fallback() {
    if (!this.fallback) this.fallback = Promise.resolve().then(() => this.engineFactory())
    return this.fallback
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
