import path from 'node:path'
import { ts, getLibFiles, libFolderInMemoryPath } from '@ts-morph/common'
import { prepareSemanticProject, refreshSemanticFiles, parsePartition, contentHash } from './parser.mjs'
import { encodeInternalPartition } from './internal-graph.mjs'

const bundledLibraries = new Map()
for (const library of getLibFiles()) bundledLibraries.set(`${libFolderInMemoryPath}/${library.fileName}`, library.text)

// Only ordinary expression references share a Value lookup in an actual lexical scope.
function expressionReference(node) {
  const parent = node.parent
  if (!parent || parent.name === node || parent.propertyName === node) return false
  switch (parent.kind) {
    case ts.SyntaxKind.CallExpression: case ts.SyntaxKind.NewExpression:
      return parent.expression === node || Boolean(parent.arguments?.includes(node))
    case ts.SyntaxKind.BinaryExpression: return parent.left === node || parent.right === node
    case ts.SyntaxKind.PrefixUnaryExpression: case ts.SyntaxKind.PostfixUnaryExpression: return parent.operand === node
    case ts.SyntaxKind.ReturnStatement: case ts.SyntaxKind.ThrowStatement: case ts.SyntaxKind.AwaitExpression:
    case ts.SyntaxKind.YieldExpression: case ts.SyntaxKind.ExpressionStatement: case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.NonNullExpression: case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement: case ts.SyntaxKind.SwitchStatement: case ts.SyntaxKind.SpreadElement:
    case ts.SyntaxKind.TemplateSpan: return parent.expression === node
    case ts.SyntaxKind.ConditionalExpression: return parent.condition === node || parent.whenTrue === node || parent.whenFalse === node
    case ts.SyntaxKind.ArrayLiteralExpression: return parent.elements.includes(node)
    case ts.SyntaxKind.TaggedTemplateExpression: return parent.tag === node
    case ts.SyntaxKind.VariableDeclaration: return parent.initializer === node
    default: return false
  }
}
function excludedLookupContext(node) {
  if (ts.isTypeNode(node) || node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return true
  switch (node.kind) {
    case ts.SyntaxKind.Parameter: case ts.SyntaxKind.TypeQuery: case ts.SyntaxKind.ExpressionWithTypeArguments:
    case ts.SyntaxKind.HeritageClause: case ts.SyntaxKind.ImportDeclaration: case ts.SyntaxKind.ImportEqualsDeclaration:
    case ts.SyntaxKind.ImportSpecifier: case ts.SyntaxKind.ExportDeclaration: case ts.SyntaxKind.ExportSpecifier:
    case ts.SyntaxKind.ExportAssignment: case ts.SyntaxKind.ObjectLiteralExpression: case ts.SyntaxKind.ShorthandPropertyAssignment: case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.BindingElement: case ts.SyntaxKind.ObjectBindingPattern: case ts.SyntaxKind.ArrayBindingPattern:
    case ts.SyntaxKind.ComputedPropertyName: case ts.SyntaxKind.Decorator: case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.ClassStaticBlockDeclaration: case ts.SyntaxKind.EnumMember: case ts.SyntaxKind.WithStatement:
    case ts.SyntaxKind.MethodSignature: case ts.SyntaxKind.CallSignature: case ts.SyntaxKind.ConstructSignature:
    case ts.SyntaxKind.FunctionType: case ts.SyntaxKind.ConstructorType: case ts.SyntaxKind.IndexSignature:
      return true
    default: return false
  }
}
function lexicalBoundary(node) {
  if (node.locals || ts.isFunctionLike(node)) return true
  switch (node.kind) {
    case ts.SyntaxKind.SourceFile: case ts.SyntaxKind.Block: case ts.SyntaxKind.ModuleBlock: case ts.SyntaxKind.CaseBlock:
    case ts.SyntaxKind.CatchClause: case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.ClassDeclaration: case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.ModuleDeclaration: return true
    default: return false
  }
}
function lexicalScope(session, node) {
  if (session.scopeClassifications.has(node)) return session.scopeClassifications.get(node)
  let scope = null
  if (node.pos >= 0 && !(node.flags & ts.NodeFlags.Synthesized) && !excludedLookupContext(node)) {
    if (node.kind === ts.SyntaxKind.SourceFile) scope = node.scriptKind === ts.ScriptKind.TS || node.scriptKind === ts.ScriptKind.TSX ? node : null
    else if (node.parent) {
      const outer = lexicalScope(session, node.parent)
      if (outer) scope = lexicalBoundary(node) ? node : outer
    }
  }
  session.scopeClassifications.set(node, scope)
  return scope
}

// Retain structural facts for unchanged compiler nodes in the one-file worker.
class RawNode {
  constructor(node, session) { this.compilerNode = node; this.session = session; this.startPos = undefined; this.start = undefined; this.text = undefined; this.name = undefined; this.arrays = undefined; this.parentNode = undefined; this.parent = undefined }
  getKind() { return this.compilerNode.kind }
  getKindName() { return ts.SyntaxKind[this.getKind()] }
  getParent() {
    if (this.parentNode !== this.compilerNode.parent) { this.parentNode = this.compilerNode.parent; this.parent = this.session.wrap(this.parentNode) }
    return this.parent
  }
  getSourceFile() { return this.session.wrap(this.compilerNode.getSourceFile()) }
  getProject() { return this.session.adapter }
  get structuralCache() {
    const file = this.compilerNode.getSourceFile().fileName
    let cache = this.session.structuralCaches.get(file)
    if (!cache) {
      cache = { owners: new WeakMap(), stats: { rebuiltOwners: 0, reusedOwners: 0 } }
      this.session.structuralCaches.set(file, cache)
    }
    return cache
  }
  getFilePath() { return this.compilerNode.getSourceFile().fileName }
  getStart() {
    if (this.startPos !== this.compilerNode.pos) { this.start = this.compilerNode.getStart(this.compilerNode.getSourceFile()); this.startPos = this.compilerNode.pos }
    return this.start
  }
  getEnd() { return this.compilerNode.end }
  getText() { return this.text ??= this.compilerNode.getText(this.compilerNode.getSourceFile()) }
  getFullText() { return this.compilerNode.getFullText() }
  getName() {
    // ts-morph exposes a JSX attribute's name node, but not a declaration name.
    if (this.compilerNode.kind === ts.SyntaxKind.JsxAttribute) return undefined
    return this.name ??= this.compilerNode.name?.getText(this.compilerNode.getSourceFile())
  }
  getNameNode() { return this.session.wrap(this.compilerNode.name) }
  isDefaultExport() { return Boolean(this.compilerNode.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) }
  getSymbol() { return this.session.symbolAt(this.compilerNode) }
  getModuleSpecifierValue() { return this.compilerNode.moduleSpecifier?.text }
  getModuleSpecifierSourceFile() {
    const symbol = this.compilerNode.moduleSpecifier && this.session.symbolAt(this.compilerNode.moduleSpecifier)
    for (const declaration of symbol?.getDeclarations() ?? []) if (declaration.getKind() === ts.SyntaxKind.SourceFile) return declaration
    return undefined
  }
  forEachDescendant(visit) {
    const children = this.structuralCache.children ??= new WeakMap()
    const emptyChildren = []
    const walk = node => {
      let items = children.get(node.compilerNode)
      if (!items) { ts.forEachChild(node.compilerNode, child => { (items ??= []).push(this.session.wrap(child)) }); items ??= emptyChildren; children.set(node.compilerNode, items) }
      for (const child of items) { visit(child); walk(child) }
    }
    walk(this)
  }
}
// Each entry is a concrete compiler-node field consumed by parser.mjs/internal-graph.mjs.
for (const [method, field] of Object.entries({
  getInitializer: 'initializer', getBody: 'body', getTypeNode: 'type', getReturnTypeNode: 'type',
  getExpression: 'expression', getOperatorToken: 'operatorToken', getQuestionDotTokenNode: 'questionDotToken',
  getWhenTrue: 'whenTrue', getWhenFalse: 'whenFalse', getCondition: 'condition', getLeft: 'left', getRight: 'right',
  getThenStatement: 'thenStatement', getElseStatement: 'elseStatement', getIncrementor: 'incrementor',
  getStatement: 'statement', getCaseBlock: 'caseBlock', getFinallyBlock: 'finallyBlock', getCatchClause: 'catchClause',
  getBlock: 'block', getTryBlock: 'tryBlock', getLabel: 'label',
})) RawNode.prototype[method] = function () { return this.session.wrap(this.compilerNode[field]) }
for (const [method, field] of Object.entries({ getStatements: 'statements', getParameters: 'parameters', getTypeParameters: 'typeParameters', getClauses: 'clauses' })) {
  RawNode.prototype[method] = function () {
    if (this.arrays?.[field]) return this.arrays[field]
    const result = []
    for (const node of this.compilerNode[field] ?? []) result.push(this.session.wrap(node))
    return (this.arrays ??= Object.create(null))[field] = result
  }
}
for (const [method, kind] of [['getImportDeclarations', ts.SyntaxKind.ImportDeclaration], ['getExportDeclarations', ts.SyntaxKind.ExportDeclaration]]) {
  RawNode.prototype[method] = function () {
    if (this.arrays?.[method]) return this.arrays[method]
    const result = []
    for (const node of this.compilerNode.statements) if (node.kind === kind) result.push(this.session.wrap(node))
    return (this.arrays ??= Object.create(null))[method] = result
  }
}

export function createOneFileSemanticSession(root, rel, options = { allowJs: true }) {
  const absolute = path.resolve(root, rel).split(path.sep).join('/')
  const session = {
    absolute, sourceFile: null, program: null, checker: null, nodes: new WeakMap(), symbols: new WeakMap(), lookups: new WeakMap(),
    stats: null, sourceWrapped: null, analysisCache: null, context: null, scopeClassifications: new WeakMap(), lexicalResults: new WeakMap(), structuralCaches: new Map(),
    wrap(node) {
      if (!node) return undefined
      let wrapped = this.nodes.get(node)
      if (wrapped) this.stats.nodeCacheHits += 1
      else { wrapped = new RawNode(node, this); this.nodes.set(node, wrapped); this.stats.nodesCreated += 1 }
      return wrapped
    },
    symbol(symbol) {
      if (!symbol) return undefined
      let wrapped = this.symbols.get(symbol)
      if (!wrapped) {
        let declarations
        wrapped = {
          getFlags: () => symbol.flags,
          getDeclarations: () => {
            if (declarations) { this.stats.declarationCacheHits += 1; return declarations }
            declarations = []
            for (const declaration of symbol.declarations ?? []) declarations.push(this.wrap(declaration))
            return declarations
          },
          getAliasedSymbol: () => this.symbol(this.checker.getAliasedSymbol(symbol)),
        }
        this.symbols.set(symbol, wrapped)
      } else if (symbol.flags & ts.SymbolFlags.Alias) this.stats.importSymbolCacheHits += 1
      return wrapped
    },
    symbolAt(node) {
      if (this.lookups.has(node)) { this.stats.symbolCacheHits += 1; return this.lookups.get(node) }
      this.stats.symbolLookups += 1
      let symbol = node.symbol
      if (!symbol) {
        const scope = node.kind === ts.SyntaxKind.Identifier && node.pos >= 0 && !(node.flags & ts.NodeFlags.Synthesized) && expressionReference(node) ? lexicalScope(this, node.parent) : null
        if (scope) {
          this.stats.lexicalEligible += 1
          // Compiler scopes and Symbols are distinct keys; both checker-owned memos reset together.
          let names = this.symbols.get(scope)
          if (names?.has(node.text)) { this.stats.lexicalCacheHits += 1; symbol = names.get(node.text) }
          else {
            this.stats.lexicalCacheMisses += 1
            let bound
            if (this.sourceFile) for (let current = node.parent; current; current = current.parent) {
              this.stats.binderScopeProbes += 1
              bound = current.locals?.get(node.escapedText)
              if (bound) break
            }
            const declaration = bound?.declarations?.length === 1 ? bound.declarations[0] : null
            const ordinary = declaration && ts.isIdentifier(declaration.name) && !bound.exportSymbol &&
              (bound.flags === ts.SymbolFlags.FunctionScopedVariable || bound.flags === ts.SymbolFlags.BlockScopedVariable || bound.flags === ts.SymbolFlags.Function)
            let exported = false
            if (ordinary) for (let current = declaration; current && current.kind !== ts.SyntaxKind.SourceFile; current = current.parent) {
              if (current.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) { exported = true; break }
            }
            const owned = this.lexicalResults.get(scope)?.get(node.text)
            if (this.sourceFile && ordinary && !exported && owned?.declaration === declaration && owned.flags === bound.flags) {
              this.stats.durableLexicalHits += 1
              this.lookups.set(node, owned.facade)
              if (!names) { names = new Map(); this.symbols.set(scope, names) }
              names.set(node.text, bound)
              return owned.facade
            }
            this.stats.durableLexicalMisses += 1; this.stats.remainingCheckerLookups += 1
            symbol = this.checker.getSymbolAtLocation(node)
            if (!names) { names = new Map(); this.symbols.set(scope, names) }
            names.set(node.text, symbol)
            if (this.sourceFile && ordinary && !exported && symbol === bound) {
              let facts = this.lexicalResults.get(scope)
              if (!facts) { facts = new Map(); this.lexicalResults.set(scope, facts) }
              const declarations = [this.wrap(declaration)]; const flags = bound.flags
              facts.set(node.text, { declaration, flags, facade: { getFlags: () => flags, getDeclarations: () => declarations } })
            } else this.lexicalResults.get(scope)?.delete(node.text)
          }
        } else { this.stats.remainingCheckerLookups += 1; symbol = this.checker.getSymbolAtLocation(node) }
      }
      if (!symbol && node.name) { this.stats.remainingCheckerLookups += 1; symbol = this.checker.getSymbolAtLocation(node.name) }
      const wrapped = this.symbol(symbol)
      this.lookups.set(node, wrapped)
      return wrapped
    },
    parse(source, knownFiles = new Set([rel]), cachedPartitions = null, changeRange = null, timing = null) {
      this.stats = { analysisCacheHits: 0, durableLexicalHits: 0, durableLexicalMisses: 0, binderScopeProbes: 0, lexicalEligible: 0, lexicalCacheHits: 0, lexicalCacheMisses: 0, remainingCheckerLookups: 0, nodesCreated: 0, nodeCacheHits: 0, symbolLookups: 0, symbolCacheHits: 0, declarationCacheHits: 0, importSymbolCacheHits: 0, sourceCreates: 0, sourceUpdates: 0, programCreates: 0, checkerCreates: 0, syntaxMs: 0, programMs: 0, checkerMs: 0, partitionMs: 0, totalMs: 0 }
      const started = performance.now()
      let mark = started
      const previousSource = this.sourceFile?.text
      const changed = !this.sourceFile || previousSource !== source
      const cache = this.analysisCache
      if (!this.sourceFile) {
        this.sourceFile = ts.createSourceFile(absolute, source, options.target ?? ts.ScriptTarget.Latest, true)
        this.stats.sourceCreates += 1
      } else if (changed) {
        if (!changeRange) {
          const previous = this.sourceFile.text
          let start = 0
          while (start < previous.length && start < source.length && previous[start] === source[start]) start += 1
          let oldEnd = previous.length; let newEnd = source.length
          while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === source[newEnd - 1]) { oldEnd -= 1; newEnd -= 1 }
          changeRange = ts.createTextChangeRange(ts.createTextSpan(start, oldEnd - start), newEnd - start)
        }
        this.sourceFile = ts.updateSourceFile(this.sourceFile, source, changeRange)
        this.stats.sourceUpdates += 1
      }
      this.stats.syntaxMs = performance.now() - mark
      if (changed) this.sourceWrapped = this.wrap(this.sourceFile)
      let bindingContextUnchanged = cache && (cachedPartitions === null && cache.cachedPartitions === null && knownFiles.size === 1 && knownFiles.has(rel) || cachedPartitions === cache.cachedPartitions && knownFiles === cache.knownFiles)
      if (bindingContextUnchanged && cachedPartitions) {
        for (const [file, partition, sourceHash] of cache.dependencies) {
          if (cachedPartitions[file] !== partition || cachedPartitions[file]?.sourceHash !== sourceHash) { bindingContextUnchanged = false; break }
        }
      }
      const reuseAnalysis = bindingContextUnchanged &&
        source.length === previousSource.length && (!changed || changeRange.span.start >= cache.start &&
        changeRange.span.start + changeRange.span.length <= cache.end && changeRange.newLength === changeRange.span.length) &&
        /^\d+$/.test(source.slice(cache.start, cache.end))
      if (reuseAnalysis) {
          mark = performance.now()
          const sourceHash = contentHash(source)
          const internalFingerprint = contentHash(JSON.stringify({ schema: 1, typescript: ts.version, compilerOptions: options, sourceHash, dependencies: cache.partition.dependencies, semanticTargets: cache.targets }))
          const result = { ...cache.partition, sourceHash, internalFingerprint, internalPartition: encodeInternalPartition({ compilerFingerprint: internalFingerprint, ...cache.graph }) }
          this.stats.analysisCacheHits = 1; this.stats.partitionMs = performance.now() - mark; this.stats.totalMs = performance.now() - started
          if (timing) { timing.projectCreateMs += this.stats.syntaxMs; timing.encodingMs += this.stats.partitionMs }
          return result
      }
      if (changed || this.program.getSourceFile(absolute) !== this.sourceFile) {
        this.lookups = new WeakMap(); this.symbols = new WeakMap(); this.scopeClassifications = new WeakMap()
        mark = performance.now()
        this.program = ts.createProgram([absolute], options, host, this.program ?? undefined)
        this.stats.programCreates += 1; this.stats.programMs = performance.now() - mark
        mark = performance.now()
        this.checker = this.program.getTypeChecker()
        this.stats.checkerCreates += 1; this.stats.checkerMs = performance.now() - mark
      }
      mark = performance.now()
      if (timing) timing.projectCreateMs += performance.now() - started
      const context = this.context ??= prepareSemanticProject(this.adapter, root, null, timing)
      context.semanticTiming = timing
      if (context.perFile.has(absolute)) refreshSemanticFiles(context, [this.sourceWrapped])
      const result = parsePartition(rel, source, knownFiles, context, null, 'complete', true, true, cachedPartitions)
      this.analysisCache = null
      const fn = this.sourceFile.statements.at(-1)
      const expression = fn?.body?.statements?.length === 1 && fn.body.statements[0].kind === ts.SyntaxKind.ReturnStatement ? fn.body.statements[0].expression : null
      if (fn?.kind === ts.SyntaxKind.FunctionDeclaration &&
          !fn.modifiers?.length && !fn.asteriskToken && !fn.parameters.length && !fn.typeParameters?.length && !fn.type && expression?.kind === ts.SyntaxKind.NumericLiteral && /^\d+$/.test(expression.getText(this.sourceFile))) {
        const analysis = context.perFile.get(absolute); const dependencies = []
        if (cachedPartitions) for (const file of result.dependencies) {
          if (file !== rel) dependencies.push([file, cachedPartitions[file], cachedPartitions[file]?.sourceHash])
        }
        this.analysisCache = { partition: result, graph: analysis.internalSyntax, targets: analysis.semanticTargets, dependencies, cachedPartitions, knownFiles, start: expression.getStart(this.sourceFile), end: expression.end }
      }
      this.stats.partitionMs = performance.now() - mark; this.stats.totalMs = performance.now() - started
      return result
    },
  }
  const host = {
    getSourceFile: file => file === absolute ? session.sourceFile : undefined,
    getDefaultLibFileName: () => ts.getDefaultLibFilePath(options), writeFile: () => {},
    getCurrentDirectory: () => root, getCanonicalFileName: file => path.resolve(root, file).split(path.sep).join('/'),
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n', fileExists: file => file === absolute,
    readFile: file => file === absolute ? session.sourceFile.text : undefined,
    directoryExists: () => false, getDirectories: () => [], readDirectory: () => [],
  }
  session.adapter = {
    getSourceFiles: () => [session.wrap(session.sourceFile)],
    getSourceFile: file => path.resolve(root, file).split(path.sep).join('/') === absolute ? session.wrap(session.sourceFile) : undefined,
    getCompilerOptions: () => options,
  }
  return session
}

// Shared raw-node runtime for complete batches and standalone graph construction.
export function createRawSemanticProject(root, sources, options, fileSystem = null, { skipLoadingLibFiles = false, loadLibFiles = Boolean(fileSystem) } = {}) {
  const first = sources.keys().next().value ?? '.'
  const session = createOneFileSemanticSession(root, first, options)
  session.stats = { durableLexicalHits: 0, durableLexicalMisses: 0, binderScopeProbes: 0, lexicalEligible: 0, lexicalCacheHits: 0, lexicalCacheMisses: 0, remainingCheckerLookups: 0, nodesCreated: 0, nodeCacheHits: 0, symbolLookups: 0, symbolCacheHits: 0, declarationCacheHits: 0, importSymbolCacheHits: 0 }
  const files = new Map()
  const roots = []
  const directories = new Set()
  for (const [rel, source] of sources) {
    const absolute = path.resolve(root, rel).split(path.sep).join('/')
    roots.push(absolute)
    if (fileSystem) for (let directory = path.dirname(absolute); !directories.has(directory); directory = path.dirname(directory)) {
      directories.add(directory)
      if (directory === path.dirname(directory)) break
    }
    files.set(absolute, ts.createSourceFile(absolute, source, options.target ?? ts.ScriptTarget.Latest, true))
  }
  const host = ts.createCompilerHost(options, true)
  host.getDefaultLibLocation = () => libFolderInMemoryPath
  host.getDefaultLibFileName = () => `${libFolderInMemoryPath}/${ts.getDefaultLibFileName(options)}`
  host.getCurrentDirectory = () => root
  host.getCanonicalFileName = file => path.resolve(root, file).split(path.sep).join('/')
  host.readFile = file => {
    const existing = files.get(host.getCanonicalFileName(file))
    if (existing) return existing.text
    if (loadLibFiles && !skipLoadingLibFiles && bundledLibraries.has(host.getCanonicalFileName(file))) return bundledLibraries.get(host.getCanonicalFileName(file))
    if (!fileSystem) return undefined
    try { return fileSystem.readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error }
  }
  host.fileExists = file => files.has(host.getCanonicalFileName(file)) || loadLibFiles && !skipLoadingLibFiles && bundledLibraries.has(host.getCanonicalFileName(file)) || Boolean(fileSystem?.fileExistsSync(file))
  host.directoryExists = dir => directories.has(host.getCanonicalFileName(dir)) || Boolean(fileSystem?.directoryExistsSync(dir))
  host.getDirectories = dir => {
    const result = []
    if (fileSystem?.directoryExistsSync(dir)) for (const entry of fileSystem.readDirSync(dir)) if (entry.isDirectory) result.push(entry.path)
    return result
  }
  host.realpath = file => fileSystem ? fileSystem.realpathSync(file) : file
  host.getSourceFile = (file, languageVersion) => {
    const absolute = host.getCanonicalFileName(file)
    let sourceFile = files.get(absolute)
    if (sourceFile) return sourceFile
    const source = host.readFile(file)
    if (source === undefined) return undefined
    sourceFile = ts.createSourceFile(absolute, source, languageVersion, true)
    files.set(absolute, sourceFile)
    return sourceFile
  }
  const program = { get compilerObject() { return session.program ??= ts.createProgram(roots, options, host) } }
  let checker
  Object.defineProperty(session, 'checker', { get() { return checker ??= program.compilerObject.getTypeChecker() } })
  const sourceFiles = []
  for (const absolute of roots) sourceFiles.push(session.wrap(files.get(absolute)))
  session.adapter = {
    getProgram: () => program,
    getSourceFiles: () => sourceFiles,
    getSourceFile: file => session.wrap(files.get(host.getCanonicalFileName(file))),
    getSourceFileOrThrow(file) { const source = this.getSourceFile(file); if (!source) throw new Error(`Source file not found: ${file}`); return source },
    getCompilerOptions: () => options,
    __codegraphHost: fileSystem,
  }
  return session.adapter
}
