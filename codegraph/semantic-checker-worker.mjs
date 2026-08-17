import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createSemanticProject, parsePartition, prepareSemanticProject } from './parser.mjs'

function validateSnapshot(snapshot) {
  const workspaceRoot = path.resolve(snapshot.root)
  const sourceRoot = snapshot.sourceDir && path.resolve(snapshot.sourceDir); const sourceBlobs = { ...(snapshot.baseSourceBlobs ?? {}) }
  const sources = snapshot.sources ? new Map(snapshot.sources) : new Map(Object.entries(sourceBlobs).map(([file, id]) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid SHA-256 source blob id: ${id}`)
    const target = path.resolve(sourceRoot, id); if (path.dirname(target) !== sourceRoot) throw new Error(`source blob path escapes sourceDir: ${id}`)
    const source = fs.readFileSync(target, 'utf8'); const digest = crypto.createHash('sha256').update(source).digest('hex'); if (digest !== id) throw new Error(`source blob digest mismatch: ${id}`)
    return [file, source]
  }))
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
  const context = prepareSemanticProject(createSemanticProject(snapshot.root, sources), snapshot.root)
  const known = new Set(sources.keys()); const partitions = {}
  for (const [file, source] of sources) partitions[file] = parsePartition(file, source, known, context, null, 'calls')
  return { revision: snapshot.revision, sourceBlobs, partitions }
}

export class SemanticCheckerWorker {
  constructor() {
    this.worker = new Worker(new URL(import.meta.url)); this.nextId = 1; this.pending = new Map(); this.closed = false
    this.worker.on('message', ({ id, result, error }) => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); if (!this.pending.size) this.worker.unref(); if (error) pending.reject(Object.assign(new Error(error.message), { stack: error.stack })); else pending.resolve(result) })
    this.worker.on('error', (error) => this.#fail(error))
    this.worker.on('exit', (code) => { if (!this.closed) this.#fail(new Error(`semantic checker worker exited with code ${code}`)) })
    this.worker.unref()
  }
  #fail(error) { if (this.failure) return; this.failure = error; this.closed = true; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.worker.unref() }
  validate(snapshot) { if (this.closed) return Promise.reject(this.failure ?? new Error('semantic checker worker is disposed')); const id = this.nextId++; this.worker.ref(); return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, snapshot }) }) }
  async dispose() { if (!this.closed) { this.closed = true; const error = new Error('semantic checker worker is disposed'); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() } await this.worker.terminate().catch(() => {}) }
}

if (!isMainThread) parentPort.on('message', ({ id, snapshot }) => { try { parentPort.postMessage({ id, result: validateSnapshot(snapshot) }) } catch (error) { parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } }) } })
