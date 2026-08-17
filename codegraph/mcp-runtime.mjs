import path from 'node:path'
import chokidar from 'chokidar'
import { CodeGraphEngine } from './tool-engine.mjs'

export class DebouncedBuildQueue {
  constructor(build, options = {}) { this.build = build; this.debounceMs = options.debounceMs ?? 150; this.onError = options.onError ?? (() => {}); this.pending = new Map(); this.timer = null; this.running = null; this.closed = false; this.waiters = [] }
  push(event) {
    if (this.closed) return
    const previous = this.pending.get(event.path)
    if (previous?.type === 'add' && event.type === 'unlink') this.pending.delete(event.path)
    else if (previous?.type === 'unlink' && event.type !== 'unlink') this.pending.set(event.path, { ...event, type: 'add' })
    else if (previous?.type === 'add' && event.type === 'change') this.pending.set(event.path, previous)
    else this.pending.set(event.path, event)
    clearTimeout(this.timer)
    if (!this.pending.size) { this.timer = null; this.#settle(); return }
    this.timer = setTimeout(() => this.#drain(), this.debounceMs)
  }
  hasPending(pathname) { return this.pending.has(pathname) }
  async #drain() {
    if (this.running || this.closed || !this.pending.size) return
    const batch = [...this.pending.values()]; this.pending.clear()
    this.running = Promise.resolve(this.build(batch))
    try { await this.running } catch (error) { try { await this.onError(error) } catch {} } finally { this.running = null; if (this.pending.size && !this.closed) this.timer = setTimeout(() => this.#drain(), this.debounceMs); else this.#settle() }
  }
  idle() { if (!this.running && !this.pending.size && !this.timer) return Promise.resolve(); return new Promise((resolve) => this.waiters.push(resolve)) }
  #settle() { clearTimeout(this.timer); this.timer = null; if (!this.running && !this.pending.size) for (const resolve of this.waiters.splice(0)) resolve() }
  async close() { this.closed = true; clearTimeout(this.timer); this.timer = null; if (this.running) await this.running.catch(() => {}); this.pending.clear(); this.#settle() }
}

export class McpProjectRuntime {
  constructor(root, options = {}) { this.root = path.resolve(root); this.engine = options.engine ?? new CodeGraphEngine(this.root); this.debounceMs = options.debounceMs ?? 150; this.onError = options.onError; this.watcher = null; this.queue = null; this.registered = new Set() }
  async start() {
    await this.engine.reconcile()
    this.registered = new Set(this.engine.registeredFiles?.() ?? [])
    this.queue = new DebouncedBuildQueue(async (events) => {
      await this.engine.incremental(events)
      for (const event of events) {
        if (event.type === 'unlink') this.registered.delete(event.path)
        else this.registered.add(event.path)
      }
    }, { debounceMs: this.debounceMs, onError: this.onError })
    const policy = this.engine.policy
    this.watcher = chokidar.watch(this.root, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      useFsEvents: true,
      usePolling: false,
      ignored: (candidate, stats) => {
        const rel = policy.normalize(candidate)
        if (rel === '') return false
        if (policy.isIgnoredRelative(rel)) return true
        if (stats?.isDirectory()) return false
        if (stats?.isFile()) return !policy.acceptWatchPath(candidate)
        return false
      },
    })
    const enqueue = (type, file) => {
      const relative = policy.normalize(file)
      if (type === 'unlink' ? (this.registered.has(relative) || this.queue.hasPending(relative)) : policy.acceptWatchPath(file)) this.queue.push({ type, path: relative })
    }
    this.watcher.on('add', (f) => enqueue('add', f)).on('change', (f) => enqueue('change', f)).on('unlink', (f) => enqueue('unlink', f))
    return this
  }
  async close() { if (this.watcher) await this.watcher.close(); if (this.queue) await this.queue.close(); await this.engine.dispose?.() }
}
