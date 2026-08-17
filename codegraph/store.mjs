import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const stable = (value) => JSON.stringify(value)
const digest = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex')
const digestSerialized = (value) => crypto.createHash('sha256').update(value).digest('hex')

export class GraphStore {
  constructor(root, cacheDir = '.codegraph') {
    this.root = root; this.dir = path.join(root, cacheDir)
    this.partitions = path.join(this.dir, 'partitions'); this.generations = path.join(this.dir, 'generations')
    this.sources = path.join(this.dir, 'sources'); this.overlays = path.join(this.dir, 'overlays')
  }
  initialize() {
    fs.mkdirSync(this.partitions, { recursive: true }); fs.mkdirSync(this.generations, { recursive: true })
    fs.mkdirSync(this.sources, { recursive: true }); fs.mkdirSync(this.overlays, { recursive: true })
  }
  writePartition(partition, profiler = null) {
    const contents = stable(partition)
    const partitionBytes = Buffer.byteLength(contents)
    const hashArgs = { file: partition.file, partitionBytes }
    const hashProfile = profiler?.begin('partition-hash', hashArgs)
    const id = digestSerialized(contents)
    if (hashProfile) profiler.end(hashProfile)
    const writeArgs = { file: partition.file, partitionBytes, cacheWrite: 0 }
    const writeProfile = profiler?.begin('partition-write', writeArgs)
    this.initialize(); const target = path.join(this.partitions, `${id}.json`)
    if (!fs.existsSync(target)) { this.#atomicWrite(target, contents); writeArgs.cacheWrite = 1 }
    if (writeProfile) profiler.end(writeProfile)
    return id
  }
  readPartition(id) { return JSON.parse(fs.readFileSync(path.join(this.partitions, `${id}.json`), 'utf8')) }
  writeSource(source) {
    this.initialize()
    const id = crypto.createHash('sha256').update(source).digest('hex')
    const target = path.join(this.sources, id)
    if (!fs.existsSync(target)) this.#atomicWrite(target, source)
    return id
  }
  readSource(id) { return fs.readFileSync(path.join(this.sources, id), 'utf8') }
  readOverlay(generation) {
    try { return JSON.parse(fs.readFileSync(path.join(this.overlays, `${generation}.json`), 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  writeOverlay(generation, overlay) {
    this.initialize()
    if (overlay.generation !== generation) throw new Error('overlay generation mismatch')
    this.#atomicWrite(path.join(this.overlays, `${generation}.json`), stable(overlay))
    return overlay
  }
  publish(manifest) {
    this.initialize(); const generation = `${Date.now().toString(36)}-${digest(manifest).slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}`
    const complete = { ...manifest, generation, createdAt: new Date().toISOString() }
    this.#atomicWrite(path.join(this.generations, `${generation}.json`), stable(complete))
    this.#atomicWrite(path.join(this.dir, 'CURRENT'), generation)
    return complete
  }
  readGeneration(generation) {
    this.initialize()
    if (!generation) {
      try { generation = fs.readFileSync(path.join(this.dir, 'CURRENT'), 'utf8').trim() } catch {}
      if (!generation || !fs.existsSync(path.join(this.generations, `${generation}.json`))) {
        const available = fs.readdirSync(this.generations).filter((f) => f.endsWith('.json'))
          .sort((a, b) => fs.statSync(path.join(this.generations, a)).mtimeMs - fs.statSync(path.join(this.generations, b)).mtimeMs || a.localeCompare(b))
        if (!available.length) throw new Error('no codegraph generation; run build')
        generation = available.at(-1).slice(0, -5)
        this.#atomicWrite(path.join(this.dir, 'CURRENT'), generation)
      }
    }
    return JSON.parse(fs.readFileSync(path.join(this.generations, `${generation}.json`), 'utf8'))
  }
  #atomicWrite(target, contents) {
    const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temp, contents); fs.renameSync(temp, target)
  }
}
