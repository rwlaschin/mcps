import path from 'node:path'
import fs from 'node:fs'
import { watch as chokidarWatch } from 'chokidar'
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
  constructor(root, options = {}) { this.root = path.resolve(root); this.engine = options.engine ?? new CodeGraphEngine(this.root); this.debounceMs = options.debounceMs ?? 150; this.onError = options.onError; this.nativeWatch = options.nativeWatch ?? fs.watch; this.fallbackWatch = options.fallbackWatch ?? chokidarWatch; this.watcher = null; this.queue = null; this.registered = new Set(); this.fallbackStarted = false }
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
    // ONE recursive watch for the whole tree. Per-path watching costs an open fd per file on
    // macOS (kqueue), which leaked ~900 handles per indexed repo and starved the network stack.
    try {
      const watcher = this.nativeWatch(this.root, { recursive: true, persistent: true }, (_event, name) => {
        if (name) this.enqueue(null, path.join(this.root, name))
      })
      this.watcher = watcher
      watcher.on('error', (error) => { this.#report(error); this.#startFallback(watcher) })
    } catch (error) {
      this.#report(error)
      this.#startFallback()
    }
    return this
  }
  #report(error) { Promise.resolve(this.onError?.(error)).catch(() => {}) }
  #startFallback(nativeWatcher) {
    if (this.fallbackStarted) return
    this.fallbackStarted = true
    nativeWatcher?.close()
    this.watcher = null
    // Chokidar normally delegates to fs.watch too. Polling deliberately bypasses exhausted macOS
    // FSEvents/watch resources, trading that failure mode for periodic stat scans and extra CPU.
    const policy = this.engine.policy
    try {
      const watcher = this.fallbackWatch(this.root, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        usePolling: true,
        ignored: (candidate, stats) => {
          const relative = policy.normalize(candidate)
          if (relative === '') return false
          if (policy.isIgnoredRelative(relative)) return true
          if (stats?.isDirectory()) return false
          if (stats?.isFile()) return !policy.acceptWatchPath(candidate)
          return false
        },
      })
      this.watcher = watcher
      watcher.on('add', (file) => this.enqueue('add', file))
      watcher.on('change', (file) => this.enqueue('change', file))
      watcher.on('unlink', (file) => this.enqueue('unlink', file))
      watcher.on('error', (error) => this.#report(error))
    } catch (error) { this.#report(error) }
  }
  // fs.watch only reports 'rename' | 'change', so add/change/unlink is derived from disk plus the
  // registered set. Pass an explicit type to enqueue a known transition without touching disk.
  enqueue(type, file) {
    const policy = this.engine.policy
    const relative = policy.normalize(file)
    if (relative === '' || policy.isIgnoredRelative(relative)) return
    const resolved = type ?? (!fs.existsSync(file) ? 'unlink' : this.registered.has(relative) ? 'change' : 'add')
    if (resolved === 'unlink' ? (this.registered.has(relative) || this.queue.hasPending(relative)) : policy.acceptWatchPath(file)) this.queue.push({ type: resolved, path: relative })
  }
  async close() { await this.watcher?.close(); if (this.queue) await this.queue.close(); await this.engine.dispose?.() }
}
