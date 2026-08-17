import path from 'node:path'
import crypto from 'node:crypto'
import { ts } from '@ts-morph/common'
import { ParserApartmentPool } from './parser-apartment-pool.mjs'

const slash = (value) => value.split(path.sep).join('/')
const AST_CACHE_MIN_ELAPSED_MS = 8
const moduleCandidates = (file, specifier) => { const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)); return [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map((ext) => base + ext), ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map((ext) => base + ext)] }
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
  const symbols = []; const imports = new Map(); const namespaces = new Map(); const reexports = new Map()
  const symbolByNode = new Map()
  const isExported = (node) => Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  const lineAt = (offset) => sourceFile.getLineAndCharacterOfPosition(offset).line + 1
  const add = (name, kind, node, exported, parent = null, displayName = name) => {
    const start = node.getStart(sourceFile); const line = lineAt(start); const qualifiedPath = parent ? `${parent.qualifiedPath}/${parent.kind}:${parent.name}` : '<module>'
    const symbol = { id: `${file}\0${qualifiedPath}\0${kind}\0${displayName}\0${line}`, file, name: displayName, kind, line, qualifiedPath, signature: '', ordinal: 0, exported, start, end: source.length, parent }
    symbols.push(symbol); symbolByNode.set(node, symbol); return symbol
  }
  const declarationParent = (node) => { for (let parent = node.parent; parent; parent = parent.parent) { const symbol = symbolByNode.get(parent); if (symbol?.kind === 'function' || symbol?.kind === 'method') return symbol } return null }
  const visitFunctions = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) { const symbol = add(node.name.text, 'function', node, isExported(node), declarationParent(node)); symbol.bodyStart = node.body.getStart(sourceFile) + 1; symbol.end = node.body.end }
    ts.forEachChild(node, visitFunctions)
  }
  visitFunctions(sourceFile)
  const visitClasses = (node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const cls = add(node.name.text, 'class', node, isExported(node)); cls.bodyStart = node.getStart(sourceFile); cls.end = node.end
      for (const member of node.members) if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) { const symbol = add(member.name.text, 'method', member, cls.exported, cls, `${cls.name}.${member.name.text}`); symbol.bodyStart = member.body?.getStart(sourceFile) + 1; symbol.end = member.body?.end ?? member.end }
    }
    ts.forEachChild(node, visitClasses)
  }
  visitClasses(sourceFile)
  const visitVariables = (node) => {
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) add(declaration.name.text, 'variable', declaration, isExported(node))
    ts.forEachChild(node, visitVariables)
  }
  visitVariables(sourceFile)
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text; const clause = statement.importClause
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) imports.set(element.name.text, { specifier, remote: element.propertyName?.text ?? element.name.text })
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.set(clause.namedBindings.name.text, specifier)
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) reexports.set(element.name.text, { specifier: statement.moduleSpecifier.text, remote: element.propertyName?.text ?? element.name.text })
  }
  const calls = []; let nodeCount = 0
  const visitCalls = (node, owner = null) => {
    nodeCount += 1
    const declared = symbolByNode.get(node); const nextOwner = declared && (declared.kind === 'function' || declared.kind === 'method') ? declared : owner
    if (ts.isCallExpression(node) && nextOwner) {
      let base = null; let property = null
      if (ts.isIdentifier(node.expression)) base = node.expression.text
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) { base = node.expression.expression.text; property = node.expression.name.text }
      if (base) calls.push({ owner: nextOwner, base, property, line: lineAt(node.expression.getStart(sourceFile)), expression: property ? `${base}.${property}` : base })
    }
    ts.forEachChild(node, (child) => visitCalls(child, nextOwner))
  }
  visitCalls(sourceFile)
  const digest = sha256(`${file}\0${source}`)
  return { file, ...(options.includeSource === false ? {} : { source }), digest, stateHash: Number.parseInt(digest.slice(0, 8), 16), sourceBytes: Buffer.byteLength(source), nodeCount, symbols, imports, namespaces, reexports, calls }
}

export class FileLocalResolver {
  constructor(root, sources = null, options = {}) { this.root = path.resolve(root); this.revision = 0; this.files = new Map(); this.parseCache = new Map(); this.parseCacheBytes = 0; this.graphCache = new Map(); this.digestTransitions = new Map(); this.stateHash = 0; this.cached = null; this.digestFilesRef = null; this.now = options.now ?? (() => performance.now()); this.onParserEvent = options.onParserEvent; this.astCacheMaxEntries = normalizedLimit(options.astCacheMaxEntries, 32, 'astCacheMaxEntries'); this.astCacheMaxBytes = normalizedLimit(options.astCacheMaxBytes, 1024 * 1024, 'astCacheMaxBytes'); this.astCacheMinSourceBytes = normalizedLimit(options.astCacheMinSourceBytes, 64 * 1024, 'astCacheMinSourceBytes'); this.astCache = new Map(); this.astCacheBytes = 0; this.ownsParserPool = !options.parserPool; this.parserPool = options.parserPool ?? new ParserApartmentPool(this.root, options.parserPoolOptions); if (sources) this.loadSources(sources) }
  #parse(file, source) {
    const key = sha256(`${file}\0${source}`); const cached = this.#cachedParse(key, file, source)
    if (cached) return cached
    const retained = this.astCache.get(file); const started = this.now(); let sourceFile
    if (retained) { const changeRange = textChangeRange(retained.source, source); this.astCache.delete(file); this.astCache.set(file, retained); sourceFile = retained.sourceFile.update(source, changeRange); const event = { file, operation: 'update', nodeCountSource: 'fact-extraction' }; Object.defineProperty(event, 'changeRange', { value: changeRange, enumerable: false }); this.onParserEvent?.(event) } else { sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); this.onParserEvent?.({ file, operation: 'create', nodeCountSource: 'fact-extraction' }) }
    const parsed = parseFile(file, source, sourceFile); const elapsed = this.now() - started
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
  loadSources(sources) { const next = new Map(); let stateHash = 0; for (const [file, source] of sources) { const parsed = this.#parse(slash(file), source); next.set(slash(file), parsed); stateHash ^= parsed.stateHash } this.files = next; this.stateHash = stateHash; this.#rebuildDigestTree(); this.cached = null }
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
    return this.#commitPrepared(prepared, options)
  }
  #commitPrepared(prepared, options = {}) {
    if (options.baseRevision !== undefined && options.baseRevision !== this.revision) throw new Error(`stale base revision ${options.baseRevision}; latest is ${this.revision}`)
    let stateHash = this.stateHash; let rebuildDigest = false
    for (const change of prepared) { const before = this.files.get(change.file); if (before) stateHash ^= before.stateHash; if (change.type === 'unlink') { this.files.delete(change.file); this.parserPool.release?.({ path: change.file, fileId: change.fileId ?? change.file, revision: this.revision + 1 }); this.#releaseAst(change.file); rebuildDigest = true } else { if (!before) rebuildDigest = true; this.files.set(change.file, change.parsed); stateHash ^= change.parsed.stateHash; if (!rebuildDigest) this.#updateDigest(change.file, change.parsed.digest) } }
    if (rebuildDigest) this.#rebuildDigestTree()
    this.stateHash = stateHash; this.revision += 1; this.cached = null
    return this.snapshot()
  }
  snapshot() {
    if (this.cached) return this.cached
    const stateKey = this.#workspaceDigest()
    const cachedGraph = this.graphCache.get(stateKey)
    if (cachedGraph) { this.cached = { revision: this.revision, freshness: 'provisional', coverage: 'module-linked-syntax', ...cachedGraph }; return this.cached }
    const parsedFiles = [...this.files.values()].sort((a, b) => a.file.localeCompare(b.file)); const symbols = parsedFiles.flatMap((item) => item.symbols)
    const exported = new Map(symbols.filter((item) => item.exported).map((item) => [`${item.file}:${item.name}`, item]))
    const resolveModule = (from, specifier) => moduleCandidates(from, specifier).find((candidate) => this.files.has(candidate))
    const resolveExport = (file, name, seen = new Set()) => { const key = `${file}:${name}`; if (seen.has(key)) return null; seen.add(key); const direct = exported.get(key); if (direct) return direct; const link = this.files.get(file)?.reexports.get(name); if (!link) return null; const target = resolveModule(file, link.specifier); return target ? resolveExport(target, link.remote, seen) : null }
    const edges = []; const unresolvedEdges = []
    for (const parsed of parsedFiles) for (const call of parsed.calls) {
      let target = null
      if (!call.property) {
        const local = parsed.symbols.filter((item) => item.name === call.base && item.kind === 'function' && (!item.parent || item.parent === call.owner || item.parent === call.owner.parent)).sort((a, b) => (b.parent ? 1 : 0) - (a.parent ? 1 : 0) || b.start - a.start)[0]
        target = local
        const imported = parsed.imports.get(call.base); if (!target && imported) { const module = resolveModule(parsed.file, imported.specifier); if (module) target = resolveExport(module, imported.remote) }
      } else {
        const namespace = parsed.namespaces.get(call.base); if (namespace) { const module = resolveModule(parsed.file, namespace); if (module) target = resolveExport(module, call.property) }
        const imported = parsed.imports.get(call.base); if (!target && imported) { const module = resolveModule(parsed.file, imported.specifier); const cls = module && resolveExport(module, imported.remote); if (cls?.kind === 'class') target = symbols.find((item) => item.file === cls.file && item.name === `${cls.name}.${call.property}`) ?? null }
      }
      if (target) edges.push({ from: call.owner.id, to: target.id, fromFile: call.owner.file, fromName: call.owner.name, toFile: target.file, toName: target.name, toLine: target.line, line: call.line, call: true })
      else if (call.property) unresolvedEdges.push({ from: call.owner.id, fromFile: call.owner.file, fromName: call.owner.name, expression: call.expression, line: call.line, reason: 'ambiguous-property-call' })
    }
    const publicSymbols = symbols.map(({ start, end, bodyStart, parent, ...symbol }) => symbol)
    const graph = { files: parsedFiles.map((item) => item.file), symbols: publicSymbols, edges, unresolvedEdges }; this.graphCache.set(stateKey, graph); if (this.graphCache.size > 32) this.graphCache.delete(this.graphCache.keys().next().value)
    this.cached = { revision: this.revision, freshness: 'provisional', coverage: 'module-linked-syntax', ...graph }
    return this.cached
  }
  sourceEntries() { return [...this.files.values()].map(({ file, source }) => [file, source]) }
  async dispose() { if (this.ownsParserPool) await this.parserPool.dispose() }
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
