import path from 'node:path'
import { ts } from 'ts-morph'
import { prepareSemanticProject, parsePartition } from '../parser.mjs'

// Test-only adapter for the methods actually used by the existing partition/CFG path.
class RawNode {
  constructor(node, session) { this.compilerNode = node; this.session = session }
  getKind() { return this.compilerNode.kind }
  getKindName() { return ts.SyntaxKind[this.getKind()] }
  getParent() { return this.session.wrap(this.compilerNode.parent) }
  getSourceFile() { return this.session.wrap(this.session.sourceFile) }
  getProject() { return this.session.adapter }
  getFilePath() { return this.session.absolute }
  getStart() { return this.compilerNode.getStart(this.session.sourceFile) }
  getEnd() { return this.compilerNode.end }
  getText() { return this.compilerNode.getText(this.session.sourceFile) }
  getFullText() { return this.session.sourceFile.text }
  getName() {
    // ts-morph exposes a JSX attribute's name node, but not a declaration name.
    if (this.compilerNode.kind === ts.SyntaxKind.JsxAttribute) return undefined
    return this.compilerNode.name?.getText(this.session.sourceFile)
  }
  getNameNode() { return this.session.wrap(this.compilerNode.name) }
  isDefaultExport() { return Boolean(this.compilerNode.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) }
  getSymbol() { return this.session.symbolAt(this.compilerNode) }
  getModuleSpecifierValue() { return this.compilerNode.moduleSpecifier?.text }
  getModuleSpecifierSourceFile() { return undefined }
  forEachDescendant(visit) {
    const walk = node => ts.forEachChild(node, child => { visit(this.session.wrap(child)); walk(child) })
    walk(this.compilerNode)
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
    const result = []
    for (const node of this.compilerNode[field] ?? []) result.push(this.session.wrap(node))
    return result
  }
}
for (const [method, kind] of [['getImportDeclarations', ts.SyntaxKind.ImportDeclaration], ['getExportDeclarations', ts.SyntaxKind.ExportDeclaration]]) {
  RawNode.prototype[method] = function () {
    const result = []
    for (const node of this.compilerNode.statements) if (node.kind === kind) result.push(this.session.wrap(node))
    return result
  }
}

export function createOneFileSemanticSession(root, rel, options = { allowJs: true }) {
  const absolute = path.resolve(root, rel).split(path.sep).join('/')
  const session = {
    absolute, sourceFile: null, program: null, checker: null, nodes: new WeakMap(), symbols: new WeakMap(), lookups: new WeakMap(),
    stats: null,
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
      let symbol = node.symbol ?? this.checker.getSymbolAtLocation(node)
      if (!symbol && node.name) symbol = this.checker.getSymbolAtLocation(node.name)
      const wrapped = this.symbol(symbol)
      this.lookups.set(node, wrapped)
      return wrapped
    },
    parse(source, knownFiles = new Set([rel]), cachedPartitions = null, changeRange = null) {
      this.stats = { nodesCreated: 0, nodeCacheHits: 0, symbolLookups: 0, symbolCacheHits: 0, declarationCacheHits: 0, importSymbolCacheHits: 0, sourceCreates: 0, sourceUpdates: 0, programCreates: 0, checkerCreates: 0, syntaxMs: 0, programMs: 0, checkerMs: 0, partitionMs: 0, totalMs: 0 }
      const started = performance.now()
      let mark = started
      const changed = !this.sourceFile || this.sourceFile.text !== source
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
        this.sourceFile = ts.updateSourceFile(this.sourceFile, source, changeRange, true)
        this.stats.sourceUpdates += 1
      }
      this.stats.syntaxMs = performance.now() - mark
      if (changed) {
        this.lookups = new WeakMap(); this.symbols = new WeakMap()
        mark = performance.now()
        this.program = ts.createProgram([absolute], options, host, this.program ?? undefined)
        this.stats.programCreates += 1; this.stats.programMs = performance.now() - mark
        mark = performance.now()
        this.checker = this.program.getTypeChecker()
        this.stats.checkerCreates += 1; this.stats.checkerMs = performance.now() - mark
      }
      mark = performance.now()
      const result = parsePartition(rel, source, knownFiles, prepareSemanticProject(this.adapter, root), null, 'complete', true, false, cachedPartitions)
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
