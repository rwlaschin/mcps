import fs from 'node:fs'
import path from 'node:path'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { parseFile } from './incremental-resolver.mjs'

const DEFAULT_TIMEOUT_MS = 30_000

const workerCountOption = (value) => {
  const count = value === undefined ? Math.max(0, availableParallelism() - 1) : value
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) throw new TypeError('workerCount must be a finite non-negative integer')
  return count
}

const normalizeRelativePath = (root, value) => {
  if (typeof value !== 'string' || path.isAbsolute(value)) throw new TypeError('parser path must be relative')
  const target = path.resolve(root, value); const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`parser path escapes root: ${value}`)
  return relative.split(path.sep).join('/')
}

export class ParserApartmentPool {
  constructor(root, options = {}) {
    this.root = path.resolve(root); this.workerCount = workerCountOption(options.workerCount); this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.readFileSync = options.readFileSync ?? fs.readFileSync; this.realpathSync = options.realpathSync ?? fs.realpathSync
    this.workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions))
    this.latestRevisionByFile = new Map(); this.affinityByFile = new Map(); this.nextRequestId = 1; this.closed = false
    this.workers = []
  }

  #ensureWorkers() {
    if (this.workers.length === 0 && this.workerCount > 0) this.workers.push(this.#newApartment(0))
  }
  #newApartment(index) { const apartment = { index, worker: null, queue: [], active: null, replacing: null, terminated: false, requiresRequestId: false }; this.#installWorker(apartment); return apartment }
  #installWorker(apartment) {
    const worker = this.workerFactory(new URL('./incremental-parser-worker.mjs', import.meta.url), { workerData: { root: this.root } }); apartment.worker = worker; apartment.terminated = false
    worker.on('message', (message) => { if (apartment.worker === worker) this.#onMessage(apartment, message) })
    worker.on('error', (error) => { if (apartment.worker === worker) this.#replaceAfterFailure(apartment, error) })
    worker.on('exit', (code) => { if (!this.closed && apartment.worker === worker) this.#replaceAfterFailure(apartment, new Error(`parser worker exited with code ${code}`)) })
    worker.unref?.()
  }

  parse(request) {
    if (this.closed) return Promise.reject(new Error('parser apartment pool is disposed'))
    const { fileId, revision } = request ?? {}
    if ((typeof fileId !== 'string' && typeof fileId !== 'number') || !Number.isFinite(revision)) return Promise.reject(new TypeError('fileId and finite revision are required'))
    let normalizedPath
    try { normalizedPath = normalizeRelativePath(this.root, request.path) } catch (error) { return Promise.reject(error) }
    const identity = String(fileId); const latest = this.latestRevisionByFile.get(identity)
    if (latest !== undefined && revision < latest) return Promise.resolve(null)
    this.latestRevisionByFile.set(identity, revision)
    if (this.workerCount === 0) {
      try {
        const lexicalTarget = path.resolve(this.root, normalizedPath); let target = lexicalTarget
        try { target = this.realpathSync(lexicalTarget) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        let realRoot = this.root
        try { realRoot = this.realpathSync(this.root) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        const relative = path.relative(realRoot, target)
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`parser path escapes root through symbolic link: ${normalizedPath}`)
        return Promise.resolve(parseFile(normalizedPath, this.readFileSync(target, 'utf8'), undefined, { includeSource: false }))
      } catch (error) { return Promise.reject(error) }
    }
    this.#ensureWorkers()
    let apartment = this.affinityByFile.get(identity)
    if (!apartment) {
      apartment = this.workers.find((candidate) => !candidate.active && !candidate.replacing && candidate.queue.length === 0)
      if (!apartment && this.workers.length < this.workerCount) { apartment = this.#newApartment(this.workers.length); this.workers.push(apartment) }
      if (!apartment) apartment = this.workers.reduce((best, candidate) => candidate.queue.length + (candidate.active ? 1 : 0) < best.queue.length + (best.active ? 1 : 0) ? candidate : best)
      this.affinityByFile.set(identity, apartment)
    }
    for (let index = apartment.queue.length - 1; index >= 0; index -= 1) { const queued = apartment.queue[index]; if (queued.fileId === identity && queued.revision <= revision) { apartment.queue.splice(index, 1); queued.resolve(null) } }
    return new Promise((resolve, reject) => { apartment.queue.push({ requestId: this.nextRequestId++, path: normalizedPath, fileId: identity, revision, resolve, reject, timer: null }); this.#dispatch(apartment) })
  }

  release(request, fileId, revision) {
    if (typeof request === 'string') request = { path: request, fileId, revision }
    const identity = String(request?.fileId); const latest = this.latestRevisionByFile.get(identity)
    if (latest !== undefined && request.revision < latest) return false
    const apartment = this.affinityByFile.get(identity)
    if (apartment?.worker && !this.closed) apartment.worker.postMessage({ type: 'release', path: normalizeRelativePath(this.root, request.path), fileId: identity, ...(request.revision === undefined ? {} : { revision: request.revision }) })
    this.latestRevisionByFile.delete(identity); this.affinityByFile.delete(identity)
    return true
  }

  #dispatch(apartment) {
    if (this.closed || apartment.replacing || apartment.active || apartment.queue.length === 0) return
    const work = apartment.queue.shift()
    if (work.revision !== this.latestRevisionByFile.get(work.fileId)) { work.resolve(null); this.#dispatch(apartment); return }
    apartment.active = work; apartment.worker.ref?.()
    work.timer = setTimeout(() => { if (apartment.active === work) { apartment.active = null; work.reject(new Error(`parser request timed out: ${work.path}`)); this.#replaceWorker(apartment) } }, this.timeoutMs)
    apartment.worker.postMessage({ type: 'parse', requestId: work.requestId, path: work.path, fileId: work.fileId, revision: work.revision })
  }
  #onMessage(apartment, message) {
    const work = apartment.active
    if (!work || (message?.requestId === undefined ? apartment.requiresRequestId : message.requestId !== work.requestId) || message?.fileId !== work.fileId || message?.revision !== work.revision) return
    clearTimeout(work.timer); apartment.active = null
    if (message.type === 'error') work.reject(new Error(message.error ?? `parser worker failed: ${work.path}`))
    else if (work.revision !== this.latestRevisionByFile.get(work.fileId)) work.resolve(null)
    else work.resolve(message.parsed)
    if (apartment.queue.length === 0) apartment.worker.unref?.(); this.#dispatch(apartment)
  }
  #replaceAfterFailure(apartment, error) { if (apartment.replacing || this.closed) return; if (apartment.active) { clearTimeout(apartment.active.timer); apartment.active.reject(error); apartment.active = null } this.#replaceWorker(apartment) }
  #replaceWorker(apartment) {
    if (apartment.replacing || this.closed) return
    const oldWorker = apartment.worker; apartment.terminated = true; apartment.requiresRequestId = true
    apartment.replacing = Promise.resolve(oldWorker.terminate()).catch(() => {}).then(() => { if (this.closed) return; this.#installWorker(apartment); apartment.replacing = null; this.#dispatch(apartment) })
  }
  snapshot() { return { workerCount: this.closed ? 0 : this.workerCount, queued: this.workers.reduce((total, worker) => total + worker.queue.length, 0), inFlight: this.workers.reduce((total, worker) => total + (worker.active ? 1 : 0), 0), latestRevisionByFile: Object.fromEntries(this.latestRevisionByFile) } }
  async dispose() {
    if (this.closed) return; this.closed = true; const error = new Error('parser apartment pool is disposed')
    for (const apartment of this.workers) { if (apartment.active) { clearTimeout(apartment.active.timer); apartment.active.reject(error); apartment.active = null } for (const work of apartment.queue.splice(0)) work.reject(error) }
    await Promise.allSettled(this.workers.map(async (apartment) => { await apartment.replacing; if (!apartment.terminated && apartment.worker) { apartment.terminated = true; await apartment.worker.terminate() } }))
  }
}
