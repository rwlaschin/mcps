import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EDGE_COVERAGE } from './edge-coverage.mjs'

let createSemanticProject, parsePartition, prepareSemanticProject, refreshSemanticFiles
const semanticWorker = !isMainThread && workerData?.semanticChecker === true
if (semanticWorker) ({ createSemanticProject, parsePartition, prepareSemanticProject, refreshSemanticFiles } = await import('./parser.mjs'))

// The last validated state, kept so an edit costs the edit rather than the tree: the ts-morph
// project, its syntax context and the partitions it produced are all reusable when the incoming
// snapshot's base is exactly the state this cache describes.
let cache = null

const sameBlobs = (left, right) => {
  if (!left || !right) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

// A changed file whose declarations are not confined to its own module scope can alter resolution
// in files that do not import it, which no dependency-graph closure bounds. Those go the full way.
const globalScoped = (source) => /\bdeclare\s+(?:global|module)\b/.test(source) || /\/\/\/\s*<reference\b/.test(source)
const moduleScoped = (file, source) => /\.(?:mjs|mts)$/i.test(file) || /(^|[\n;])\s*(?:import|export)\b/m.test(source)

// Everything that imports, re-exports from, or transitively depends on a changed file can resolve
// differently after the change, so the reparse set is the changed files plus that closure.
function dependentClosure(partitions, changed) {
  const importers = new Map()
  for (const [file, partition] of Object.entries(partitions)) for (const dependency of partition.dependencies ?? []) {
    if (!importers.has(dependency)) importers.set(dependency, [])
    importers.get(dependency).push(file)
  }
  const set = new Set(changed); const queue = [...changed]
  while (queue.length) for (const importer of importers.get(queue.pop()) ?? []) if (!set.has(importer)) { set.add(importer); queue.push(importer) }
  return set
}

const unresolvedCandidateMatches = (partitions, changedFiles) => {
  const changed = new Set(changedFiles.map((file) => file.split(path.sep).join('/')))
  return Object.values(partitions).some((partition) => partition.unresolved?.some((row) => row.candidates?.some((candidate) => changed.has(candidate))))
}

function readSources(snapshot, sourceBlobs) {
  const sourceRoot = snapshot.sourceDir && path.resolve(snapshot.sourceDir)
  return new Map(Object.entries(sourceBlobs).map(([file, id]) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid SHA-256 source blob id: ${id}`)
    const target = path.resolve(sourceRoot, id); if (path.dirname(target) !== sourceRoot) throw new Error(`source blob path escapes sourceDir: ${id}`)
    const source = fs.readFileSync(target, 'utf8'); const digest = crypto.createHash('sha256').update(source).digest('hex'); if (digest !== id) throw new Error(`source blob digest mismatch: ${id}`)
    return [file, source]
  }))
}

function readPartitions(snapshot) {
  const root = path.resolve(snapshot.partitionDir)
  return Object.fromEntries(Object.entries(snapshot.basePartitionIds ?? {}).map(([file, id]) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid SHA-256 partition id: ${id}`)
    const target = path.resolve(root, `${id}.json`); if (path.dirname(target) !== root) throw new Error(`partition path escapes partitionDir: ${id}`)
    const contents = fs.readFileSync(target, 'utf8'); if (crypto.createHash('sha256').update(contents).digest('hex') !== id) throw new Error(`partition digest mismatch: ${id}`)
    const partition = JSON.parse(contents); if (partition.file !== file) throw new Error(`partition key/file mismatch: ${file}`)
    return [file, partition]
  }))
}

function fullValidation(snapshot, sources, sourceBlobs) {
  const context = prepareSemanticProject(createSemanticProject(snapshot.root, sources), snapshot.root)
  const known = new Set(sources.keys()); const partitions = {}
  for (const [file, source] of sources) partitions[file] = parsePartition(file, source, known, context, null, EDGE_COVERAGE.CALLS)
  cache = { baseGeneration: snapshot.baseGeneration, sourceBlobs: { ...sourceBlobs }, sources, partitions, context }
  return { revision: snapshot.revision, mode: 'full', baseGeneration: snapshot.baseGeneration, sourceBlobs, partitions }
}

function ownedSnapshot(request, hydrate = false) {
  if (!request || typeof request.root !== 'string' || !Array.isArray(request.sources) || !request.sourceBlobs || typeof request.sourceBlobs !== 'object') throw new Error('malformed semantic ownership request')
  const files = request.sources.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw new Error('malformed semantic source entry')
    return entry[0]
  })
  if (new Set(files).size !== files.length) throw new Error('duplicate semantic source membership')
  const sourceBlobs = { ...request.sourceBlobs }
  const blobFiles = Object.keys(sourceBlobs)
  if (blobFiles.length !== files.length || blobFiles.some((file) => !files.includes(file))) throw new Error('semantic source membership mismatch')
  const sources = new Map(request.sources)
  for (const [file, source] of sources) if (!/^[a-f0-9]{64}$/.test(sourceBlobs[file]) || crypto.createHash('sha256').update(source).digest('hex') !== sourceBlobs[file]) throw new Error(`semantic source hash mismatch: ${file}`)
  const context = prepareSemanticProject(createSemanticProject(request.root, sources), request.root)
  let partitions
  if (hydrate) {
    if (!request.partitions || typeof request.partitions !== 'object') throw new Error('malformed semantic hydrate partitions')
    const partitionFiles = Object.keys(request.partitions)
    if (partitionFiles.length !== files.length || partitionFiles.some((file) => !sources.has(file))) throw new Error('semantic partition membership mismatch')
    partitions = { ...request.partitions }
    for (const file of files) {
      const partition = partitions[file]
      if (!partition || partition.file !== file || partition.sourceHash !== sourceBlobs[file]) throw new Error(`semantic partition file/source hash mismatch: ${file}`)
    }
  } else {
    const known = new Set(files); partitions = {}
    for (const [file, source] of sources) partitions[file] = parsePartition(file, source, known, context, null, request.edgeCoverage ?? EDGE_COVERAGE.COMPLETE)
  }
  cache = { baseGeneration: request.generation ?? null, sourceBlobs, sources, partitions, context }
  return { mode: 'full', sourceBlobs, partitions }
}

function validateSnapshot(snapshot) {
  const workspaceRoot = path.resolve(snapshot.root)
  const sourceRoot = snapshot.sourceDir && path.resolve(snapshot.sourceDir); const sourceBlobs = { ...(snapshot.baseSourceBlobs ?? {}) }
  let sources
  if (snapshot.sources) sources = new Map(snapshot.sources)
  else if (cache && sameBlobs(cache.sourceBlobs, sourceBlobs)) { sources = new Map(cache.sources); cache.baseGeneration = snapshot.baseGeneration }
  else sources = readSources(snapshot, sourceBlobs)
  const forceHydrate = Boolean(snapshot.basePartitionIds)
  let baseHydrated = !forceHydrate && Boolean(cache && sameBlobs(cache.sourceBlobs, sourceBlobs))
  if (!baseHydrated) {
    const basePartitions = readPartitions(snapshot)
    const files = [...sources.keys()]
    if (files.length === Object.keys(basePartitions).length && files.every((file) => basePartitions[file]?.file === file)) {
      const context = prepareSemanticProject(createSemanticProject(snapshot.root, sources), snapshot.root)
      cache = { baseGeneration: snapshot.baseGeneration, sourceBlobs: { ...sourceBlobs }, sources: new Map(sources), partitions: { ...basePartitions }, context }
      baseHydrated = true
    }
  }
  const oldSource = cache?.sources.get(snapshot.changes?.[0]?.path) ?? ''
  const changes = snapshot.changes ?? []
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

  const changed = changes[0]
  const safe = baseHydrated && changes.length === 1 && changed.type === 'change' && sources.has(changed.path) &&
    moduleScoped(changed.path, oldSource) && !globalScoped(oldSource) && moduleScoped(changed.path, sources.get(changed.path)) && !globalScoped(sources.get(changed.path)) &&
    !unresolvedCandidateMatches(cache.partitions, [changed.path])
  if (!safe) return fullValidation(snapshot, sources, sourceBlobs)

  try {
    const affected = dependentClosure(cache.partitions, [changed.path])
    const changedFile = cache.context.project.createSourceFile(path.join(workspaceRoot, changed.path), sources.get(changed.path), { overwrite: true })
    const files = [...affected].map((file) => file === changed.path ? changedFile : cache.context.project.getSourceFile(path.join(workspaceRoot, file)))
    if (files.some((file) => !file)) return fullValidation(snapshot, sources, sourceBlobs)
    refreshSemanticFiles(cache.context, files)
    const known = new Set(sources.keys()); const partitions = {}
    for (const file of [...affected].sort()) partitions[file] = parsePartition(file, sources.get(file), known, cache.context, null, EDGE_COVERAGE.CALLS)
    Object.assign(cache.partitions, partitions)
    cache.sources = sources; cache.sourceBlobs = { ...sourceBlobs }
    return { revision: snapshot.revision, mode: 'delta', baseGeneration: snapshot.baseGeneration, sourceBlobs, partitions }
  } catch {
    return fullValidation(snapshot, sources, sourceBlobs)
  }
}

function referenceOverlay(request) {
  if (!cache || !sameBlobs(cache.sourceBlobs, request.sourceBlobs)) throw new Error('semantic checker worker cache does not match overlay generation')
  if (!Array.isArray(request.staleFiles)) throw new Error('overlay stale files must be an array')
  const stale = [...new Set(request.staleFiles)]
  if (stale.length !== request.staleFiles.length || stale.some((file) => !cache.sources.has(file))) throw new Error('overlay stale files do not match worker cache')
  const sourceFiles = stale.map((file) => cache.context.project.getSourceFile(path.join(cache.context.root, file)))
  if (sourceFiles.some((file) => !file)) throw new Error('overlay stale source is absent from worker project')
  refreshSemanticFiles(cache.context, sourceFiles)
  const known = new Set(cache.sources.keys()); const files = {}
  for (const file of stale) {
    const partition = parsePartition(file, cache.sources.get(file), known, cache.context, null, EDGE_COVERAGE.COMPLETE)
    files[file] = { edges: partition.edges.filter((edge) => !edge.call) }
  }
  return { generation: request.generation, files }
}

export class SemanticCheckerWorker {
  constructor() { this.worker = null; this.nextId = 1; this.pending = new Map(); this.closed = false }
  // The thread loads its own copy of ts-morph and takes ~68ms to terminate. A query served from
  // the mmap page never validates, so spawning on construction charged every such process for a
  // thread it never used.
  #spawn() {
    if (this.worker) return this.worker
    this.worker = new Worker(new URL(import.meta.url), { workerData: { semanticChecker: true } })
    this.worker.on('message', ({ id, result, error }) => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); if (!this.pending.size) this.worker.unref(); if (error) pending.reject(Object.assign(new Error(error.message), { stack: error.stack })); else pending.resolve(result) })
    this.worker.on('error', (error) => this.#fail(error))
    this.worker.on('exit', (code) => { if (!this.closed) this.#fail(new Error(`semantic checker worker exited with code ${code}`)) })
    this.worker.unref()
    return this.worker
  }
  #fail(error) { if (this.failure) return; this.failure = error; this.closed = true; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.worker?.unref() }
  #request(type, payload) { if (this.closed) return Promise.reject(this.failure ?? new Error('semantic checker worker is disposed')); const id = this.nextId++; const worker = this.#spawn(); worker.ref(); return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); worker.postMessage({ id, type, payload }) }) }
  validate(snapshot) { return this.#request('validate', snapshot) }
  index(request) { return this.#request('index', request) }
  hydrate(request) { return this.#request('hydrate', request) }
  referenceOverlay(request) { return this.#request('reference-overlay', request) }
  async dispose() { if (!this.closed) { this.closed = true; const error = new Error('semantic checker worker is disposed'); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() } await this.worker?.terminate().catch(() => {}) }
}

if (semanticWorker) parentPort.on('message', ({ id, type, payload, snapshot }) => {
  try {
    const handlers = { index: () => ownedSnapshot(payload), hydrate: () => ownedSnapshot(payload, true), validate: () => validateSnapshot(payload ?? snapshot), 'reference-overlay': () => referenceOverlay(payload) }
    if (!handlers[type]) throw new Error(`unknown semantic checker operation: ${type}`)
    parentPort.postMessage({ id, result: handlers[type]() })
  }
  catch (error) { parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } }) }
})
