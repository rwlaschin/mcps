import path from 'node:path'
import crypto from 'node:crypto'
import ts from '@ts-morph/common/dist/typescript.js'
import { ParserApartmentPool } from './parser-apartment-pool.mjs'
import { extractCachedBindings, resolveCachedImport, visitImportBindings } from './cached-binding-resolver.mjs'

const slash = (value) => value.split(path.sep).join('/')
const AST_CACHE_MIN_ELAPSED_MS = 8
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const normalizedLimit = (value, fallback, name) => {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite non-negative number`)
  return Math.max(0, Math.floor(value))
}
const textChangeRange = (before, after) => {
  let start = 0
  while (start < before.length && start < after.length && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
  let oldEnd = before.length; let newEnd = after.length
  while (oldEnd > start && newEnd > start && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) { oldEnd -= 1; newEnd -= 1 }
  return { span: { start, length: oldEnd - start }, newLength: newEnd - start }
}

const resolveReference = (reference, files) => {
  const { parsed, call } = reference; const dependencies = new Set()
  let target = null; let importedReference = false
  if (!call.property) {
    target = parsed.symbols.filter((item) => item.name === call.base && item.kind === 'function' && (!item.parent || item.parent === call.owner || item.parent === call.owner.parent)).sort((a, b) => (b.parent ? 1 : 0) - (a.parent ? 1 : 0) || b.start - a.start)[0]
    const imported = parsed.imports.get(call.base); importedReference = Boolean(imported); if (!target && imported) target = resolveCachedImport(files, parsed.file, imported, null, dependencies)
  } else {
    const namespace = parsed.namespaces.get(call.base); importedReference = Boolean(namespace); if (namespace) target = resolveCachedImport(files, parsed.file, { specifier: namespace, namespace: true }, call.property, dependencies)
    const imported = parsed.imports.get(call.base); importedReference ||= Boolean(imported); if (!target && imported) target = resolveCachedImport(files, parsed.file, imported, call.property, dependencies)
  }
  const output = target ? { edge: { from: call.owner.id, to: target.id, fromFile: call.owner.file, fromName: call.owner.name, toFile: target.file, toName: target.name, toLine: target.line, line: call.line, call: true } } : importedReference ? { unresolved: { from: call.owner.id, fromFile: call.owner.file, fromName: call.owner.name, expression: call.expression, line: call.line, reason: 'missing-import-target' } } : call.property ? { unresolved: { from: call.owner.id, fromFile: call.owner.file, fromName: call.owner.name, expression: call.expression, line: call.line, reason: 'ambiguous-property-call' } } : {}
  return { id: reference.id, file: reference.file, parsed, call, ...output, dependencies }
}

const deletedFile = Symbol('deleted file')
class ForkedFiles {
  constructor(base = new Map()) { this.base = base; this.changes = new Map() }
  get size() { let size = this.base.size; for (const [file, value] of this.changes) { const existed = this.base.has(file); if (value === deletedFile && existed) size -= 1; else if (value !== deletedFile && !existed) size += 1 } return size }
  get(file) { const value = this.changes.get(file); return value === deletedFile ? undefined : value ?? this.base.get(file) }
  has(file) { return this.changes.has(file) ? this.changes.get(file) !== deletedFile : this.base.has(file) }
  set(file, value) { this.changes.set(file, value); return this }
  delete(file) { const existed = this.has(file); this.changes.set(file, deletedFile); return existed }
  *entries() { for (const [file, value] of this.changes) if (value !== deletedFile) yield [file, value]; for (const [file, value] of this.base) if (!this.changes.has(file)) yield [file, value] }
  *keys() { for (const [file] of this.entries()) yield file }
  *values() { for (const [, value] of this.entries()) yield value }
  [Symbol.iterator]() { return this.entries() }
}

const adoptOverlay = (target, overlay) => { for (const [key, value] of overlay.changes) { if (value === deletedFile) target.delete(key); else target.set(key, value) } }

export function createParseDiagnosticsCollector(options = {}) {
  if (!options.enabled) return null

  const thresholdMs = options.thresholdMs ?? 8
  const capacity = Math.max(0, options.capacity ?? 100)
  const now = options.now ?? (() => performance.now())
  const cpuUsage = options.cpuUsage ?? (() => process.cpuUsage())
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage())
  const aggregate = { parses: 0, wallMs: 0, parseCount: 0, extractCount: 0, nodeCount: 0 }
  const events = []
  const records = []
  const gcEntries = []

  const recordGc = ({ startTime, duration, kind }) => {
    const entry = { startTime, duration, kind }
    gcEntries.push(entry)
    const gcCapacity = Math.max(64, capacity * 4)
    if (gcEntries.length > gcCapacity) gcEntries.splice(0, gcEntries.length - gcCapacity)
    for (const record of records) {
      const overlapStart = Math.max(record.startTime, startTime)
      const overlapEnd = Math.min(record.endTime, startTime + duration)
      if (overlapEnd > overlapStart && !record.event.gc.some((item) => item.startTime === startTime && item.duration === duration && item.kind === kind)) record.event.gc.push({ ...entry, overlapMs: overlapEnd - overlapStart })
    }
  }

  const collector = {
    begin(attribution) {
      return {
        attribution: { ...attribution },
        startTime: now(),
        cpu: cpuUsage(),
        memory: memoryUsage(),
        resource: resourceUsage(),
      }
    },
    end(token, counts) {
      const endTime = now()
      const cpu = cpuUsage()
      const memory = memoryUsage()
      const resource = resourceUsage()
      const wallMs = endTime - token.startTime

      aggregate.parses += 1
      aggregate.wallMs += wallMs
      aggregate.parseCount += counts.parseCount
      aggregate.extractCount += counts.extractCount
      aggregate.nodeCount += counts.nodeCount

      if (wallMs <= thresholdMs || capacity === 0) return

      const cpuUserMs = (cpu.user - token.cpu.user) / 1000
      const cpuSystemMs = (cpu.system - token.cpu.system) / 1000
      const { file, root, ...attribution } = token.attribution
      const gc = []
      for (const entry of gcEntries) {
        const overlapStart = Math.max(token.startTime, entry.startTime)
        const overlapEnd = Math.min(endTime, entry.startTime + entry.duration)
        if (overlapEnd > overlapStart) gc.push({ ...entry, overlapMs: overlapEnd - overlapStart })
      }
      const event = {
        file: slash(path.relative(root, file)),
        ...attribution,
        wallMs,
        cpuUserMs,
        cpuSystemMs,
        unaccountedMs: Math.round(Math.max(0, wallMs - cpuUserMs - cpuSystemMs) * 1000) / 1000,
        heapDeltaBytes: memory.heapUsed - token.memory.heapUsed,
        rssDeltaBytes: memory.rss - token.memory.rss,
        voluntaryContextSwitches: resource.voluntaryContextSwitches - token.resource.voluntaryContextSwitches,
        involuntaryContextSwitches: resource.involuntaryContextSwitches - token.resource.involuntaryContextSwitches,
        minorPageFaults: resource.minorPageFault - token.resource.minorPageFault,
        majorPageFaults: resource.majorPageFault - token.resource.majorPageFault,
        ...counts,
        gc,
        severe: wallMs > 50,
      }
      events.push(event)
      records.push({ startTime: token.startTime, endTime, event })
      if (events.length > capacity) {
        const excess = events.length - capacity
        events.splice(0, excess)
        records.splice(0, excess)
      }
    },
    recordGc,
    snapshot() {
      return {
        aggregate: { ...aggregate },
        events: events.map((event) => ({ ...event, gc: event.gc.map((entry) => ({ ...entry })) })),
      }
    },
  }

  options.observeGc?.(recordGc)
  return collector
}

export function parseFile(file, source, sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), options = {}) {
  const symbols = []; const imports = new Map(); const namespaces = new Map()
  const symbolByNode = new Map()
  const isExported = (node) => Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  const lineAt = (offset) => sourceFile.getLineAndCharacterOfPosition(offset).line + 1
  const add = (name, kind, node, exported, parent = null, displayName = name) => {
    const start = node.getStart(sourceFile); const line = lineAt(start); const qualifiedPath = parent ? `${parent.qualifiedPath}/${parent.kind}:${parent.name}` : '<module>'
    const symbol = { id: `${file}\0${qualifiedPath}\0${kind}\0${displayName}\0${line}`, file, name: displayName, kind, line, qualifiedPath, signature: '', ordinal: 0, exported, start, end: source.length, parent }
    symbols.push(symbol); symbolByNode.set(node, symbol); return symbol
  }
  const declarationParent = (node) => { for (let parent = node.parent; parent; parent = parent.parent) { const symbol = symbolByNode.get(parent); if (symbol?.kind === 'function' || symbol?.kind === 'method') return symbol } return null }
  const functionNodes = []; const classNodes = []; const variableStatements = []; const callNodes = []; let nodeCount = 0
  const visit = (node) => {
    nodeCount += 1
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functionNodes.push(node)
    if (ts.isClassDeclaration(node) && node.name) classNodes.push(node)
    if (ts.isVariableStatement(node)) variableStatements.push(node)
    if (ts.isCallExpression(node)) callNodes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  for (const node of functionNodes) { const symbol = add(node.name.text, 'function', node, isExported(node), declarationParent(node)); symbol.bodyStart = node.body.getStart(sourceFile) + 1; symbol.end = node.body.end }
  for (const node of classNodes) {
    const cls = add(node.name.text, 'class', node, isExported(node)); cls.bodyStart = node.getStart(sourceFile); cls.end = node.end
    for (const member of node.members) if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) { const symbol = add(member.name.text, 'method', member, cls.exported, cls, `${cls.name}.${member.name.text}`); symbol.bodyStart = member.body?.getStart(sourceFile) + 1; symbol.end = member.body?.end ?? member.end }
  }
  for (const node of variableStatements) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) add(declaration.name.text, 'variable', declaration, isExported(node))
  visitImportBindings(sourceFile, ts, (name, specifier, remote, namespace) => {
    if (namespace) namespaces.set(name, specifier)
    else imports.set(name, { specifier, remote })
  })
  const calls = []
  for (const node of callNodes) {
    const owner = declarationParent(node)
    if (owner) {
      let base = null; let property = null
      if (ts.isIdentifier(node.expression)) base = node.expression.text
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) { base = node.expression.expression.text; property = node.expression.name.text }
      if (base) calls.push({ owner, base, property, line: lineAt(node.expression.getStart(sourceFile)), expression: property ? `${base}.${property}` : base })
    }
  }
  const digest = sha256(`${file}\0${source}`)
  const bindings = extractCachedBindings(sourceFile, symbols, ts)
  return { file, ...(options.includeSource === false ? {} : { source }), digest, stateHash: Number.parseInt(digest.slice(0, 8), 16), sourceBytes: Buffer.byteLength(source), nodeCount, symbols, imports, namespaces, bindings, calls }
}

export class FileLocalResolver {
  constructor(root, sources = null, options = {}, fork = null) { this.root = path.resolve(root); this.revision = fork?.revision ?? 0; this.files = fork ? new ForkedFiles(fork.files) : new Map(); this.graphFiles = fork ? new ForkedFiles(fork.graphFiles) : new Map(); this.references = fork ? new ForkedFiles(fork.references) : new Map(); this.dependencyRefs = fork ? new ForkedFiles(fork.dependencyRefs) : new Map(); this.dependencyBucketCloneCount = 0; this.family = fork?.family ?? { parserPool: options.parserPool ?? new ParserApartmentPool(this.root, options.parserPoolOptions), ownsParserPool: !options.parserPool, disposed: false, parseCache: new Map(), parseCacheBytes: 0, digestTransitions: new Map() }; this.familyOwner = !fork; this.parseCache = this.family.parseCache; this.digestTransitions = this.family.digestTransitions; this.stateHash = fork?.stateHash ?? 0; this.cached = fork?.cached ?? null; this.digestFilesRef = null; this.now = options.now ?? (() => performance.now()); this.onParserEvent = options.onParserEvent; this.onWork = options.onWork; this.parsedSinceSnapshot = new Set(); this.resolvedSinceSnapshot = new Set(); this.mutationFile = null; this.astCacheMaxEntries = normalizedLimit(options.astCacheMaxEntries, 32, 'astCacheMaxEntries'); this.astCacheMaxBytes = normalizedLimit(options.astCacheMaxBytes, 1024 * 1024, 'astCacheMaxBytes'); this.astCacheMinSourceBytes = normalizedLimit(options.astCacheMinSourceBytes, 64 * 1024, 'astCacheMinSourceBytes'); this.astCache = fork ? new Map(fork.astCache) : new Map(); this.astCacheBytes = fork?.astCacheBytes ?? 0; this.parserPool = this.family.parserPool; if (sources) this.loadSources(sources) }
  get parseCacheBytes() { return this.family.parseCacheBytes }
  set parseCacheBytes(value) { this.family.parseCacheBytes = value }
  fork() { return new FileLocalResolver(this.root, null, { now: this.now, onParserEvent: this.onParserEvent, onWork: this.onWork, astCacheMaxEntries: this.astCacheMaxEntries, astCacheMaxBytes: this.astCacheMaxBytes, astCacheMinSourceBytes: this.astCacheMinSourceBytes }, { revision: this.revision, files: this.files, graphFiles: this.graphFiles, references: this.references, dependencyRefs: this.dependencyRefs, family: this.family, stateHash: this.stateHash, cached: this.cached, astCache: this.astCache, astCacheBytes: this.astCacheBytes }) }
  adopt(staged, revision = staged.revision) { if (!(staged instanceof FileLocalResolver) || staged.family !== this.family || !(staged.files instanceof ForkedFiles)) throw new TypeError('resolver fork required'); adoptOverlay(this.files, staged.files); adoptOverlay(this.graphFiles, staged.graphFiles); adoptOverlay(this.references, staged.references); adoptOverlay(this.dependencyRefs, staged.dependencyRefs); this.stateHash = staged.stateHash; this.cached = staged.cached ? { ...staged.cached, revision } : null; this.astCache = staged.astCache; this.astCacheBytes = staged.astCacheBytes; this.digestFilesRef = this.files; this.digestFiles = staged.digestFiles; this.digestIndex = staged.digestIndex; this.digestLeafBase = staged.digestLeafBase; this.digestTree = staged.digestTree; this.parsedSinceSnapshot = staged.parsedSinceSnapshot; this.resolvedSinceSnapshot = staged.resolvedSinceSnapshot; this.mutationFile = staged.mutationFile; this.revision = revision; return this }
  #parse(file, source) {
    const key = sha256(`${file}\0${source}`); const cached = this.#cachedParse(key, file, source)
    if (cached) return cached
    const retained = this.astCache.get(file); const started = this.now(); let sourceFile
    if (retained) { const changeRange = textChangeRange(retained.source, source); this.astCache.delete(file); this.astCache.set(file, retained); sourceFile = retained.sourceFile.update(source, changeRange); const event = { file, operation: 'update', nodeCountSource: 'fact-extraction' }; Object.defineProperty(event, 'changeRange', { value: changeRange, enumerable: false }); this.onParserEvent?.(event) } else { sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); this.onParserEvent?.({ file, operation: 'create', nodeCountSource: 'fact-extraction' }) }
    const parsed = parseFile(file, source, sourceFile); this.parsedSinceSnapshot.add(file); const elapsed = this.now() - started
    if (Number.isFinite(elapsed) && elapsed > AST_CACHE_MIN_ELAPSED_MS && parsed.sourceBytes >= this.astCacheMinSourceBytes) this.#retainAst(file, source, sourceFile, parsed.nodeCount)
    else this.#releaseAst(file)
    this.#cacheParse(key, parsed)
    return parsed
  }
  #cachedParse(key, file, source) { const cached = this.parseCache.get(key); if (!cached || cached.file !== file || cached.source !== source) return null; this.parseCache.delete(key); this.parseCache.set(key, cached); return cached }
  #cacheParse(key, parsed) {
    const previous = this.parseCache.get(key)
    if (previous) { this.parseCache.delete(key); this.parseCacheBytes -= previous.sourceBytes }
    this.parseCache.set(key, parsed); this.parseCacheBytes += parsed.sourceBytes
    while (this.parseCache.size > 0 && (this.parseCache.size > 32 || this.parseCacheBytes > 1024 * 1024)) { const oldest = this.parseCache.keys().next().value; const removed = this.parseCache.get(oldest); this.parseCache.delete(oldest); this.parseCacheBytes -= removed.sourceBytes }
    if (this.parseCacheBytes < 0) this.parseCacheBytes = 0
  }
  #retainAst(file, source, sourceFile, nodeCount) { const previous = this.astCache.get(file); if (previous) { this.astCache.delete(file); this.astCacheBytes -= previous.estimatedBytes } const entry = { source, sourceFile, estimatedBytes: Buffer.byteLength(source) + nodeCount * 192 }; this.astCache.set(file, entry); this.astCacheBytes += entry.estimatedBytes; while (this.astCache.size > this.astCacheMaxEntries || this.astCacheBytes > this.astCacheMaxBytes) { const oldest = this.astCache.keys().next().value; const removed = this.astCache.get(oldest); this.astCache.delete(oldest); this.astCacheBytes -= removed.estimatedBytes } }
  #releaseAst(file) { const retained = this.astCache.get(file); if (!retained) return; this.astCache.delete(file); this.astCacheBytes -= retained.estimatedBytes; if (this.astCacheBytes < 0) this.astCacheBytes = 0 }
  astCacheSnapshot() { return { entries: this.astCache.size, estimatedBytes: this.astCacheBytes, files: [...this.astCache.keys()].sort() } }
  #dependencyBucket(dependency, create = false) { let ids = this.dependencyRefs.get(dependency); if (this.dependencyRefs instanceof ForkedFiles && ids && !this.dependencyRefs.changes.has(dependency)) { ids = new Set(ids); this.dependencyRefs.set(dependency, ids); this.dependencyBucketCloneCount += 1 } if (!ids && create) { ids = new Set(); this.dependencyRefs.set(dependency, ids) } return ids }
  #unindexReference(id) { const previous = this.references.get(id); if (!previous) return; for (const dependency of previous.dependencies) { const ids = this.#dependencyBucket(dependency); if (!ids) continue; ids.delete(id); if (!ids.size) this.dependencyRefs.delete(dependency) } this.references.delete(id) }
  #indexReference(reference) { const previous = this.references.get(reference.id); const resolved = resolveReference(reference, this.files); this.references.set(reference.id, resolved); for (const dependency of previous?.dependencies ?? []) if (!resolved.dependencies.has(dependency)) { const ids = this.#dependencyBucket(dependency); ids?.delete(reference.id); if (ids && !ids.size) this.dependencyRefs.delete(dependency) } for (const dependency of resolved.dependencies) if (!previous?.dependencies.has(dependency)) this.#dependencyBucket(dependency, true).add(reference.id) }
  #installFileGraph(parsed) { const previous = this.graphFiles.get(parsed.file); const referenceIds = parsed.calls.map((call, index) => `${parsed.file}\0${index}`); const retained = new Set(referenceIds); for (const id of previous?.referenceIds ?? []) if (!retained.has(id)) this.#unindexReference(id); this.graphFiles.set(parsed.file, { symbols: parsed.symbols.map(({ start, end, bodyStart, parent, ...symbol }) => symbol), referenceIds }); parsed.calls.forEach((call, index) => this.#indexReference({ id: referenceIds[index], file: parsed.file, parsed, call })) }
  loadPartitions(partitions, revision = this.revision) {
    this.files = new Map(); this.graphFiles = new Map(); this.references = new Map(); this.dependencyRefs = new Map()
    for (const partition of partitions) this.files.set(partition.file, partition)
    for (const partition of partitions) {
      const referenceIds = []
      for (let index = 0; index < (partition.references ?? []).length; index += 1) {
        const reference = partition.references[index]; const id = `${partition.file}\0${index}`; const base = `#cached-${index}`
        const owner = partition.symbols.find((symbol) => symbol.id === reference.from) ?? { id: reference.from, file: partition.file, name: '' }
        const parsed = { file: partition.file, symbols: partition.symbols, imports: new Map(), namespaces: new Map() }
        if (reference.namespace) parsed.namespaces.set(base, reference.specifier)
        else parsed.imports.set(base, { specifier: reference.specifier, remote: reference.remote })
        this.#indexReference({ id, file: partition.file, parsed, call: { owner, base, property: reference.property, line: reference.line, expression: base } })
        referenceIds.push(id)
      }
      const imported = new Map()
      for (const id of referenceIds) {
        const edge = this.references.get(id)?.edge
        if (!edge) continue
        const key = `${edge.from}\0${edge.to}\0${edge.line}\0${edge.call ? 1 : 0}`
        imported.set(key, (imported.get(key) ?? 0) + 1)
      }
      const edges = []
      for (const edge of partition.edges ?? []) {
        const key = `${edge.from}\0${edge.to}\0${edge.line}\0${edge.call ? 1 : 0}`; const count = imported.get(key) ?? 0
        if (count) imported.set(key, count - 1)
        else edges.push(edge)
      }
      this.graphFiles.set(partition.file, { symbols: partition.symbols, referenceIds, edges })
    }
    this.stateHash = 0; this.revision = revision; this.cached = null; this.#rebuildDigestTree()
    return this
  }
  loadSources(sources) { const next = new Map(); let stateHash = 0; for (const [file, source] of sources) { const parsed = this.#parse(slash(file), source); next.set(slash(file), parsed); stateHash ^= parsed.stateHash } this.files = next; this.graphFiles = new Map(); this.references = new Map(); this.dependencyRefs = new Map(); for (const parsed of next.values()) this.#installFileGraph(parsed); this.stateHash = stateHash; this.#rebuildDigestTree(); this.cached = null }
  applyChanges(changes, options = {}) {
    if (options.baseRevision !== undefined && options.baseRevision !== this.revision) throw new Error(`stale base revision ${options.baseRevision}; latest is ${this.revision}`)
    const prepared = changes.map((change) => { const file = slash(change.path); if (change.type === 'unlink') return { type: 'unlink', file, fileId: change.fileId ?? file }; if (typeof change.source !== 'string') throw new TypeError(`source text required: ${file}`); return { type: change.type, file, parsed: this.#parse(file, change.source) } })
    return this.#commitPrepared(prepared, options)
  }
  async applyFileChanges(changes, options = {}) {
    if (options.baseRevision !== undefined && options.baseRevision !== this.revision) throw new Error(`stale base revision ${options.baseRevision}; latest is ${this.revision}`)
    const targetRevision = this.revision + 1
    const prepared = await Promise.all(changes.map(async (change) => {
      const file = slash(path.posix.normalize(change.path))
      if (change.type === 'unlink') return { type: 'unlink', file, fileId: change.fileId ?? file }
      if (change.source !== undefined) throw new TypeError(`disk-backed change must not include source text: ${file}`)
      const parsed = await this.parserPool.parse({ path: file, fileId: change.fileId ?? file, revision: targetRevision })
      if (!parsed) throw new Error(`stale or superseded parse result: ${file}`)
      return { type: change.type, file, parsed }
    }))
    if (options.baseRevision !== undefined && options.baseRevision !== this.revision) throw new Error(`stale base revision ${options.baseRevision}; latest is ${this.revision}`)
    if (this.revision + 1 !== targetRevision) throw new Error(`stale parse batch revision ${targetRevision}; latest is ${this.revision}`)
    for (const change of prepared) if (change.type !== 'unlink') this.parsedSinceSnapshot.add(change.file)
    return this.#commitPrepared(prepared, options)
  }
  #commitPrepared(prepared, options = {}) {
    if (options.baseRevision !== undefined && options.baseRevision !== this.revision) throw new Error(`stale base revision ${options.baseRevision}; latest is ${this.revision}`)
    let stateHash = this.stateHash; let rebuildDigest = false; const affected = new Set()
    this.mutationFile = prepared[0]?.file ?? null
    for (const change of prepared) for (const id of this.dependencyRefs.get(change.file) ?? []) affected.add(id)
    for (const change of prepared) { const before = this.files.get(change.file); if (before) stateHash ^= before.stateHash; if (change.type === 'unlink') { const graph = this.graphFiles.get(change.file); for (const id of graph?.referenceIds ?? []) this.#unindexReference(id); this.graphFiles.delete(change.file); this.files.delete(change.file); this.parserPool.release?.({ path: change.file, fileId: change.fileId ?? change.file, revision: this.revision + 1 }); this.#releaseAst(change.file); rebuildDigest = true } else { if (!before) rebuildDigest = true; this.files.set(change.file, change.parsed); stateHash ^= change.parsed.stateHash; if (!rebuildDigest) this.#updateDigest(change.file, change.parsed.digest) } }
    const changedIds = new Set(); for (const change of prepared) if (change.type !== 'unlink') { this.#installFileGraph(change.parsed); for (const id of this.graphFiles.get(change.file).referenceIds) changedIds.add(id); this.resolvedSinceSnapshot.add(change.file) }
    for (const id of affected) if (!changedIds.has(id)) { const reference = this.references.get(id); if (reference) this.#indexReference(reference) }
    if (rebuildDigest) this.#rebuildDigestTree()
    this.stateHash = stateHash; this.revision += 1; this.cached = null
    return options.materialize === false ? this.#reportWork() : this.snapshot()
  }
  snapshot() {
    if (this.cached) return this.cached
    const files = [...this.files.keys()].sort(); const records = files.map((file) => this.graphFiles.get(file)); const refs = records.flatMap((item) => item.referenceIds.map((id) => this.references.get(id))); const graph = { files, symbols: records.flatMap((item) => item.symbols), edges: records.flatMap((item) => item.edges ?? []).concat(refs.flatMap((item) => item.edge ? [item.edge] : [])), unresolvedEdges: refs.flatMap((item) => item.unresolved ? [item.unresolved] : []) }
    this.cached = { revision: this.revision, freshness: 'provisional', coverage: 'module-linked-syntax', ...graph }
    this.#reportWork()
    return this.cached
  }
  #reportWork() { let work; if (this.mutationFile) { const resolvedFiles = [...this.resolvedSinceSnapshot].sort(); const resolved = this.resolvedSinceSnapshot; work = { type: 'work', mutationFile: this.mutationFile, parsedFiles: [...this.parsedSinceSnapshot].sort(), resolvedFiles, reusedFiles: [...this.files.keys()].filter((file) => !resolved.has(file)).sort(), fullRebuild: false }; this.onWork?.(work) } this.parsedSinceSnapshot.clear(); this.resolvedSinceSnapshot.clear(); this.mutationFile = null; return work }
  sourceEntries() { return [...this.files.values()].map(({ file, source }) => [file, source]) }
  async dispose() { if (this.familyOwner && this.family.ownsParserPool && !this.family.disposed) { this.family.disposed = true; await this.parserPool.dispose() } }
  #rebuildDigestTree() {
    this.digestFilesRef = this.files; this.digestFiles = [...this.files.keys()].sort(); this.digestIndex = new Map(this.digestFiles.map((file, index) => [file, index]))
    let size = 1; while (size < this.digestFiles.length) size *= 2; this.digestLeafBase = size; this.digestTree = new Array(size * 2).fill(sha256(''))
    for (let index = 0; index < this.digestFiles.length; index++) this.digestTree[size + index] = this.files.get(this.digestFiles[index]).digest ?? sha256(`${this.digestFiles[index]}\0${this.files.get(this.digestFiles[index]).source ?? ''}`)
    for (let index = size - 1; index > 0; index--) this.digestTree[index] = sha256(`${this.digestTree[index * 2]}${this.digestTree[index * 2 + 1]}`)
  }
  #updateDigest(file, digest) {
    const fileIndex = this.digestIndex?.get(file); if (fileIndex === undefined) { this.#rebuildDigestTree(); return }
    const transitionKey = `${this.digestTree[1]}:${file}:${digest}`; const cached = this.digestTransitions.get(transitionKey)
    if (cached) { for (const [index, value] of cached) this.digestTree[index] = value; return }
    let index = this.digestLeafBase + fileIndex; const changed = [[index, digest]]; this.digestTree[index] = digest
    while ((index = Math.floor(index / 2)) > 0) { const value = sha256(`${this.digestTree[index * 2]}${this.digestTree[index * 2 + 1]}`); this.digestTree[index] = value; changed.push([index, value]) }
    this.digestTransitions.set(transitionKey, changed); if (this.digestTransitions.size > 64) this.digestTransitions.delete(this.digestTransitions.keys().next().value)
  }
  #workspaceDigest() { if (this.digestFilesRef !== this.files) this.#rebuildDigestTree(); return this.digestTree[1] }
}
