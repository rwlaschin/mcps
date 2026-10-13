import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { SyntaxKind, ts, getCompilerOptionsFromTsConfig, RealFileSystemHost } from '@ts-morph/common'
import { PrefetchedFileSystemHost } from './prefetched-file-system.mjs'
import { createRawSemanticProject } from './one-file-semantic-library.mjs'
import { EDGE_COVERAGE, requireCoverage } from './edge-coverage.mjs'
import { addInternalGraphRelations, buildInternalGraphFromCollectedSyntax, encodeInternalPartition } from './internal-graph.mjs'
import { moduleCandidates } from './module-candidates.mjs'
import { extractCachedBindings, resolveCachedImport, visitImportBindings } from './cached-binding-resolver.mjs'

export const contentHash = (text) => crypto.createHash('sha256').update(text).digest('hex')
const slash = (p) => p.split(path.sep).join('/')
const declarationKinds = new Map([
  [SyntaxKind.FunctionDeclaration, 'function'], [SyntaxKind.MethodDeclaration, 'method'],
  [SyntaxKind.ClassDeclaration, 'class'], [SyntaxKind.InterfaceDeclaration, 'interface'],
  [SyntaxKind.TypeAliasDeclaration, 'type'], [SyntaxKind.EnumDeclaration, 'enum'],
  [SyntaxKind.VariableDeclaration, 'variable'],
])

export class LineCursor {
  constructor() {
    this.source = ''
    this.offset = 0
    this.line = 1
  }

  reset(source) {
    this.source = source
    this.offset = 0
    this.line = 1
  }

  lineAt(position) {
    if (position < this.offset) {
      const source = this.source
      let offset = 0
      let line = 1
      while (offset < position) {
        if (source.charCodeAt(offset) === 10) line += 1
        offset += 1
      }
      return line
    }

    const source = this.source
    let offset = this.offset
    let line = this.line
    while (offset < position) {
      if (source.charCodeAt(offset) === 10) {
        line += 1
      }
      offset += 1
    }
    this.offset = offset
    this.line = line
    return line
  }

  clear() {
    this.source = ''
    this.offset = 0
    this.line = 1
  }
}

export function createSemanticProject(root, sources, options = {}) {
  const fileSystem = new PrefetchedFileSystemHost(root, sources, new RealFileSystemHost())
  return createRawSemanticProject(root, sources, readOneFileCompilerOptions(root), fileSystem, options)
}

export function readOneFileCompilerOptions(root) {
  const tsConfig = path.join(root, 'tsconfig.json')
  const jsConfig = path.join(root, 'jsconfig.json')
  const config = fs.existsSync(tsConfig) ? tsConfig : fs.existsSync(jsConfig) ? jsConfig : undefined
  const fileSystem = new RealFileSystemHost()
  fileSystem.readDirSync = () => []
  const options = { ...(config ? getCompilerOptionsFromTsConfig(config, { fileSystem }).options : {}), allowJs: true }
  return options
}

export function createOneFileSemanticProject(root, sources) {
  return createRawSemanticProject(root, sources, readOneFileCompilerOptions(root))
}

function nodeName(node) {
  const named = node.getName?.(); if (named) return named
  if ((node?.compilerNode.kind === SyntaxKind.Constructor)) return 'constructor'
  if (((node?.compilerNode.kind === SyntaxKind.FunctionDeclaration) || (node?.compilerNode.kind === SyntaxKind.ClassDeclaration)) && node.isDefaultExport?.()) return 'default'
  return null
}

function semanticPath(node) {
  const parts = []
  for (let cur = node.getParent(); cur && !(cur?.compilerNode.kind === SyntaxKind.SourceFile); cur = cur.getParent()) {
    const name = nodeName(cur)
    if (name) parts.unshift(`${declarationKinds.get(cur.getKind()) ?? cur.getKindName()}:${name}`)
  }
  return parts.join('/') || '<module>'
}

function semanticSignature(node) {
  const typeParameters = node.getTypeParameters?.().map((item) => item.getText()).join(',') ?? ''
  const parameters = node.getParameters?.().map((item) => `${item.getName()}:${item.getTypeNode()?.getText() ?? '?'}`).join(',') ?? ''
  const returnType = node.getReturnTypeNode?.()?.getText() ?? ''
  const declaredType = node.getTypeNode?.()?.getText() ?? ''
  return `<${typeParameters}>(${parameters}):${returnType || declaredType}`
}

function recordCollectedSyntax(state, node, owner) {
  const bucket = state.nodesByKind.get(node.getKind())
  const isIdentifier = node.compilerNode.kind === SyntaxKind.Identifier
  let fact = bucket ? state.syntaxFacts.get(node.compilerNode) : null
  if (bucket && !fact) { fact = { name: nodeName(node), signature: semanticSignature(node) }; state.syntaxFacts.set(node.compilerNode, fact) }
  if (bucket || isIdentifier) {
    const line = state.lineCursor.lineAt(node.getStart())
    if (bucket) bucket.push({ node, line, name: fact.name, signature: fact.signature })
    if (isIdentifier) state.identifiers.push({ node, line, owner })
  }
  return fact?.name ? node.compilerNode : owner
}

function relevantCollectedNode(node) {
  return declarationKinds.has(node.kind) || node.kind === SyntaxKind.Identifier
}

function replayCollectedSyntax(state, root, inherited) {
  const owner = relevantCollectedNode(root) ? recordCollectedSyntax(state, state.file.session.wrap(root), inherited) : inherited
  const retained = state.inventories.get(root)
  if (retained) {
    retained.currentSourceRoot = state.file.compilerNode
    state.stats.reusedOwners += 1
    for (const entry of retained.entries) {
      const incoming = entry.owner ?? owner
      if (entry.nested) replayCollectedSyntax(state, entry.node, incoming)
      else recordCollectedSyntax(state, state.file.session.wrap(entry.node), incoming)
    }
    return
  }
  state.stats.rebuiltOwners += 1
  const previousEntries = state.entries, previousRootOwner = state.rootOwner
  const entries = []
  state.entries = entries; state.rootOwner = owner
  visitCollectedChildren(state, root, owner)
  state.inventories.set(root, { entries, currentSourceRoot: state.file.compilerNode })
  state.entries = previousEntries; state.rootOwner = previousRootOwner
}

function visitCollectedChildren(state, node, incoming) {
  const previousOwner = state.owner, previousItems = state.items
  const items = state.children ? [] : null
  state.owner = incoming; state.items = items
  ts.forEachChild(node, state.visitChild)
  if (state.children) state.children.set(node, items)
  state.owner = previousOwner; state.items = previousItems
}

function visitCollectedChild(state, child) {
  const incoming = state.owner
  if (!state.inventories) {
    const owner = relevantCollectedNode(child) ? recordCollectedSyntax(state, state.file.session.wrap(child), incoming) : incoming
    const previousOwner = state.owner
    state.owner = owner
    ts.forEachChild(child, state.visitChild)
    state.owner = previousOwner
    return
  }
  state.stats.visitedNodes += 1
  if (state.children) state.items.push(state.file.session.wrap(child))
  const savedOwner = incoming === state.rootOwner ? null : incoming
  if (declarationKinds.has(child.kind) || ts.isFunctionLike(child) || child.kind === SyntaxKind.Block || child.kind === SyntaxKind.CatchClause || child.kind === SyntaxKind.ModuleBlock) {
    state.entries.push({ node: child, owner: savedOwner, nested: true })
    replayCollectedSyntax(state, child, incoming)
    return
  }
  let owner = incoming
  if (relevantCollectedNode(child)) {
    state.entries.push({ node: child, owner: savedOwner })
    owner = recordCollectedSyntax(state, state.file.session.wrap(child), incoming)
  }
  visitCollectedChildren(state, child, owner)
}

function pruneCollectedSyntax(state, root) {
  const retained = state.inventories.get(root)
  if (!retained || retained.currentSourceRoot === state.file.compilerNode) return
  if (declarationKinds.has(root.kind) && state.byDeclaration?.delete(root)) state.stats.deletedDeclarations += 1
  for (const entry of retained.entries) if (entry.nested) pruneCollectedSyntax(state, entry.node)
}

function collectFileSyntax(file, source, lineCursor, timing, preparedStructuralGraph, deferStructuralGraph = false, byDeclaration = null) {
  const started = performance.now()
  const nodesByKind = new Map([...declarationKinds.keys()].map((syntaxKind) => [syntaxKind, []]))
  const identifiers = []
  const structuralCache = file.structuralCache
  const syntaxFacts = structuralCache ? structuralCache.syntax ??= new WeakMap() : new WeakMap()
  const nativeTraversal = Boolean((preparedStructuralGraph || deferStructuralGraph) && file.compilerNode && file.session?.wrap)
  const children = nativeTraversal ? null : structuralCache ? structuralCache.children ??= new WeakMap() : new WeakMap()
  lineCursor.reset(source)
  const state = { file, nodesByKind, identifiers, syntaxFacts, lineCursor, children, byDeclaration, owner: null }
  if (structuralCache && file.session?.sourceFile === file.compilerNode) {
    state.inventories = structuralCache.inventories ??= new WeakMap()
    state.stats = structuralCache.inventoryStats = { rebuiltOwners: 0, reusedOwners: 0, visitedNodes: 0, deletedDeclarations: 0 }
    state.visitChild = child => { visitCollectedChild(state, child) }
    replayCollectedSyntax(state, file.compilerNode, null)
    if (structuralCache.currentRoot) pruneCollectedSyntax(state, structuralCache.currentRoot)
    structuralCache.currentRoot = file.compilerNode
  } else if (nativeTraversal) {
    state.visitChild = child => { visitCollectedChild(state, child) }
    ts.forEachChild(file.compilerNode, state.visitChild)
  } else {
    const emptyChildren = []
    const stack = [file]; const ownerStack = [null]; const building = [false]; let depth = 0
    file.forEachDescendant((node) => {
      const parent = node.getParent()
      while (stack[depth] !== parent) { if (!children.has(stack[depth].compilerNode)) children.set(stack[depth].compilerNode, emptyChildren); depth -= 1 }
      if (building[depth]) children.get(parent.compilerNode).push(node)
      else if (!children.has(parent.compilerNode)) { children.set(parent.compilerNode, [node]); building[depth] = true }
      const owner = recordCollectedSyntax(state, node, ownerStack[depth])
      depth += 1; stack[depth] = node; ownerStack[depth] = owner; building[depth] = false
    })
    while (depth >= 0) { if (!children.has(stack[depth].compilerNode)) children.set(stack[depth].compilerNode, emptyChildren); depth -= 1 }
  }

  const groups = new Map(); const result = []
  for (const [syntaxKind, kind] of declarationKinds) {
    for (const { node, line, name, signature } of nodesByKind.get(syntaxKind)) {
      if (!name) continue
      const qualifiedPath = semanticPath(node)
      const group = `${qualifiedPath}:${kind}:${name}:${signature}`; const ordinal = groups.get(group) ?? 0; groups.set(group, ordinal + 1)
      const rel = slash(path.relative(file.getProject().__codegraphRoot, file.getFilePath()))
      const fact = syntaxFacts.get(node.compilerNode)
      const previous = fact.identity
      const identity = previous && previous.file === rel && previous.name === name && previous.kind === kind && previous.signature === signature && previous.qualifiedPath === qualifiedPath && previous.ordinal === ordinal
        ? previous.line === line ? previous : { ...previous, line }
        : { id: contentHash(`${rel}\0${qualifiedPath}\0${kind}\0${name}\0${signature}\0${ordinal}`).slice(0, 24), file: rel, name, kind, line, qualifiedPath, signature, ordinal }
      fact.identity = identity
      result.push({ node, identity })
    }
  }
  const rel = slash(path.relative(file.getProject().__codegraphRoot, file.getFilePath()))
  const structuralStarted = performance.now()
  const internalSyntax = preparedStructuralGraph ?? (deferStructuralGraph ? null : buildInternalGraphFromCollectedSyntax(file, rel, { children, identifiers }, undefined, { structuralCache }))
  const structuralMs = performance.now() - structuralStarted
  if (timing) { timing.structuralCfgMs += structuralMs; timing.syntaxCollectionMs += performance.now() - started - structuralMs }
  return { rows: result, identifiers, internalSyntax }
}

function ensureSemanticFile(context, file, profiler = context.profiler) {
  const filePath = file.getFilePath()
  if (context.perFile.has(filePath)) return context.perFile.get(filePath)
  if (!context.eligibleFiles.has(filePath) || context.preparedFiles.has(filePath)) return null
    const rel = slash(path.relative(context.root, filePath))
    const args = { file: rel, descendantTraversals: 1, declarationCount: 0, identifierCount: 0 }
    const profile = profiler?.begin('collect-file-syntax', args)
    try {
      const retainedFacts = file.session?.sourceFile === file.compilerNode ? file.structuralCache : null
      if (!retainedFacts) for (const node of context.nodesByFile.get(filePath) ?? []) context.byDeclaration.delete(node)
      const preparedStructuralGraph = context.preparedStructuralGraphs?.get(filePath)
      const analysis = collectFileSyntax(file, file.getFullText(), context.lineCursor, context.semanticTiming, preparedStructuralGraph, context.deferStructuralGraph, context.byDeclaration)
      context.preparedStructuralGraphs?.delete(filePath)
      args.declarationCount = analysis.rows.length
      args.identifierCount = analysis.identifiers.length
      context.perFile.set(filePath, analysis)
      if (!retainedFacts) context.nodesByFile.set(filePath, analysis.rows.map((row) => row.node.compilerNode))
      for (const row of analysis.rows) if (context.byDeclaration.get(row.node.compilerNode) !== row.identity) context.byDeclaration.set(row.node.compilerNode, row.identity)
      context.preparedFiles.add(filePath)
      const traversals = (context.traversalsByFile.get(filePath) ?? 0) + 1
      context.traversalsByFile.set(filePath, traversals)
      context.semanticTraversalSummary.completedFiles += 1
      context.semanticTraversalSummary.remainingFiles -= 1
      context.semanticTraversalSummary.maximumTraversalsPerFile = Math.max(context.semanticTraversalSummary.maximumTraversalsPerFile, traversals)
      return analysis
    } finally {
      context.lineCursor.clear()
      if (profile) profiler.end(profile)
    }
}

// Re-collects syntax for a subset of an existing context's files. `nodesByFile` exists so an
// overwritten source file's declaration nodes leave `byDeclaration` instead of accumulating
// detached nodes for the life of the worker.
export function refreshSemanticFiles(context, files, profiler = null) {
  for (const file of files) {
    const filePath = file.getFilePath()
    if (!context.eligibleFiles.has(filePath)) {
      context.eligibleFiles.add(filePath)
      context.semanticTraversalSummary.remainingFiles += 1
    }
    if (file.session?.sourceFile !== file.compilerNode) {
      for (const node of context.nodesByFile.get(filePath) ?? []) context.byDeclaration.delete(node)
      context.nodesByFile.delete(filePath)
    }
    context.perFile.delete(filePath)
    context.traversalsByFile.delete(filePath)
    if (context.preparedFiles.delete(filePath)) {
      context.semanticTraversalSummary.completedFiles -= 1
      context.semanticTraversalSummary.remainingFiles += 1
    }
  }
  for (const file of files) ensureSemanticFile(context, file, profiler)
  return context
}

export function prepareSemanticProject(project, root, profiler = null, semanticTiming = null) {
  project.__codegraphRoot = root
  const eligibleFiles = new Set(project.getSourceFiles().map((file) => file.getFilePath()))
  const context = { project, root, byDeclaration: new Map(), perFile: new Map(), nodesByFile: new Map(), eligibleFiles, preparedFiles: new Set(), traversalsByFile: new Map(), lineCursor: new LineCursor(), semanticTraversalSummary: { completedFiles: 0, remainingFiles: eligibleFiles.size, maximumTraversalsPerFile: 0 }, profiler, semanticTiming }
  Object.defineProperty(context, 'semanticTraversalCounts', { get: () => Object.fromEntries([...eligibleFiles].map((filePath) => [slash(path.relative(root, filePath)), context.traversalsByFile.get(filePath) ?? 0])) })
  return context
}

function identityForDeclaration(declaration, context) {
  const existing = context.byDeclaration.get(declaration.compilerNode)
  if (existing) return existing
  const file = declaration.getSourceFile()
  if (!context.eligibleFiles.has(file.getFilePath())) return null
  ensureSemanticFile(context, file)
  return context.byDeclaration.get(declaration.compilerNode) ?? null
}

function identityForSymbol(symbol, context, identifierArgs) {
  for (const declaration of symbol?.getDeclarations?.() ?? []) {
    if (identifierArgs) identifierArgs.declarationProbes += 1
    const identity = identityForDeclaration(declaration, context)
    if (identity) return identity
  }
  return null
}

function callExpressionForIdentifier(ident) {
  const node = ident.compilerNode
  const parent = node.parent
  if ((parent?.kind === SyntaxKind.CallExpression) && parent.expression === node) return true
  const grand = parent?.parent
  return (parent?.kind === SyntaxKind.PropertyAccessExpression) && parent.name === node && (grand?.kind === SyntaxKind.CallExpression) && grand.expression === parent
}

function resolveIdentifierEdges(identifiers, localByNode, context, identifierArgs, coverage, targetByIdentifier, resolveMissing = null, references = null, cacheFirst = false) {
  const edges = []

  for (const identifier of identifiers) {
    const { node: ident, line, owner } = identifier
    identifierArgs.total += 1
    let call = callExpressionForIdentifier(ident)
    if (coverage === EDGE_COVERAGE.CALLS && !call) continue
    const from = owner ? localByNode.get(owner) : null
    if (!from) { identifierArgs.noOwner += 1; continue }
    const parent = ident.compilerNode.parent
    const probeCached = cacheFirst && resolveMissing && parent?.kind === SyntaxKind.PropertyAccessExpression && parent.name === ident.compilerNode
    let cached = probeCached ? resolveMissing(ident, null) : null
    let symbol = cached?.target ? null : ident.getSymbol?.()
    if (!probeCached) cached = resolveMissing ? resolveMissing(ident, symbol) : null
    if (cached?.call) call = true
    if (cached?.reference) { cached.reference.from = from.id; cached.reference.line = line; cached.reference.call = call; references.push(cached.reference) }
    if (!symbol && !cached?.target) { targetByIdentifier.set(ident.compilerNode, null); identifierArgs.symbolMissing += 1; continue }
    let target = cached?.target ?? null
    if (!target) {
      const alias = expandAliasSymbol(symbol)
      if (alias !== symbol) { symbol = alias; identifierArgs.aliases += 1 }
      target = identityForSymbol(symbol, context, identifierArgs)
    }
    targetByIdentifier.set(ident.compilerNode, target?.id ?? null)
    if (!target) { identifierArgs.targetMissing += 1; continue }
    if (target.id === from.id) { identifierArgs.selfTarget += 1; continue }
    edges.push({ from: from.id, to: target.id, line, call })
    identifierArgs.edges += 1
    if (call) identifierArgs.calls += 1
    else identifierArgs.nonCalls += 1
  }
  return edges
}

function expandAliasSymbol(symbol) {
  if (!(symbol.getFlags() & ts.SymbolFlags.Alias)) return symbol
  try { return symbol.getAliasedSymbol() ?? symbol } catch { return symbol }
}

function cachedReceiverFor(node, file, imports, receiverFacts) {
  if (!node) return null
  if (receiverFacts.has(node)) return receiverFacts.get(node)
  receiverFacts.set(node, null)
  let receiver = null
  if (ts.isIdentifier(node)) {
    const declarations = file.session.symbolAt(node)?.getDeclarations?.()
    if (declarations?.length === 1) {
      const declaration = declarations[0].compilerNode
      const imported = imports.get(node.text)
      if (imported && declaration.getStart() >= imported.start && declaration.end <= imported.end) receiver = imported
      else if (ts.isVariableDeclaration(declaration)) receiver = cachedReceiverFor(declaration.initializer, file, imports, receiverFacts)
    }
  } else if (ts.isNewExpression(node)) {
    const constructor = cachedReceiverFor(node.expression, file, imports, receiverFacts)
    if (constructor) receiver = { ...constructor, instance: true }
  }
  else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) receiver = cachedReceiverFor(node.expression, file, imports, receiverFacts)
  else if (ts.isPropertyAccessExpression(node)) {
    const base = cachedReceiverFor(node.expression, file, imports, receiverFacts)
    if (base?.namespace) receiver = { specifier: base.specifier, remote: node.name.text }
    else if (node.name.text === 'current' && ts.isIdentifier(node.expression)) {
      const declarations = file.session.symbolAt(node.expression)?.getDeclarations?.()
      const initializer = declarations?.length === 1 ? declarations[0].compilerNode.initializer : null
      const factory = initializer && ts.isCallExpression(initializer) ? cachedReceiverFor(initializer.expression, file, imports, receiverFacts) : null
      if (factory?.specifier === 'react' && factory.remote === 'useRef' && initializer.typeArguments?.length === 1) {
        const type = initializer.typeArguments[0]
        let named = null
        if (ts.isTypeReferenceNode(type)) named = type
        else if (ts.isUnionTypeNode(type)) for (const member of type.types) {
          if (ts.isTypeReferenceNode(member)) { if (named) { named = null; break }; named = member }
          else if (!(ts.isLiteralTypeNode(member) && member.literal.kind === SyntaxKind.NullKeyword)) { named = null; break }
        }
        if (named && ts.isIdentifier(named.typeName)) {
          const target = cachedReceiverFor(named.typeName, file, imports, receiverFacts)
          if (target) receiver = { ...target, instance: true }
        }
      }
    }
  }
  receiverFacts.set(node, receiver)
  return receiver
}

export function parsePartition(rel, source, knownFiles, context, profiler = null, edgeCoverage = EDGE_COVERAGE.COMPLETE, includeInternals = true, retainAnalysis = false, cachedPartitions = null) {
  const absolute = path.join(context.root, rel)
  const file = context.project.getSourceFile(absolute)
  if (!file) throw new Error(`source was not prefetched: ${rel}`)
  const analysis = ensureSemanticFile(context, file, profiler)
  const preparedStructuralGraph = context.preparedStructuralGraphs?.get(absolute)
  if (preparedStructuralGraph) { analysis.internalSyntax = preparedStructuralGraph; context.preparedStructuralGraphs.delete(absolute) }
  const { rows } = analysis

  const exportArgs = { file: rel, exportsVisited: 0 }
  const exportProfile = profiler?.begin('exports', exportArgs)
  let started = performance.now()
  let nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const exportedIds = new Set()
  const symbolRows = rows.map(({ identity }) => identity)
  const bindings = extractCachedBindings(file.compilerNode, symbolRows, ts, exportedIds, file.structuralCache)
  exportArgs.exportsVisited = bindings.length
  if (context.semanticTiming) context.semanticTiming.exportsMs += Math.max(0, performance.now() - started - (context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs - nestedStarted))
  if (exportProfile) profiler.end(exportProfile)
  const symbols = symbolRows.map((identity) => ({ ...identity, exported: exportedIds.has(identity.id) }))
  const imports = new Map()
  const importFacts = file.structuralCache ? file.structuralCache.imports ??= new WeakMap() : null
  if (importFacts) {
    for (const statement of file.compilerNode.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      let facts = importFacts.get(statement)
      if (!facts) { facts = []; visitImportBindings({ statements: [statement] }, ts, (name, specifier, remote, namespace) => facts.push({ name, specifier, remote, namespace })); importFacts.set(statement, facts) }
      for (const fact of facts) imports.set(fact.name, fact.namespace ? { specifier: fact.specifier, namespace: true, start: statement.pos, end: statement.end } : { specifier: fact.specifier, remote: fact.remote, start: statement.pos, end: statement.end })
    }
  } else visitImportBindings(file.compilerNode, ts, (name, specifier, remote, namespace, start, end) => imports.set(name, namespace ? { specifier, namespace: true, start, end } : { specifier, remote, start, end }))
  const references = []
  const receiverFacts = new WeakMap()
  const resolveMissing = (ident, symbol) => {
    const node = ident.compilerNode
    const parent = node.parent
    if ((parent?.kind === SyntaxKind.PropertyAccessExpression) && parent.name === node) {
      if (!cachedPartitions && symbol) {
        const declarations = symbol.getDeclarations()
        let eligible = declarations.length === 0
        for (const declaration of declarations) if (context.eligibleFiles.has(declaration.compilerNode.getSourceFile().fileName)) { eligible = true; break }
        if (!eligible) return null
      }
      const receiver = cachedReceiverFor(parent.expression, file, imports, receiverFacts)
      if (!receiver) return null
      const reference = { specifier: receiver.specifier, remote: receiver.remote, namespace: Boolean(receiver.namespace), property: parent.name.getText(file.compilerNode) }
      if (receiver.instance) reference.instance = true
      return { target: cachedPartitions && resolveCachedImport(cachedPartitions, rel, reference, reference.property), reference }
    }
    const imported = imports.get(ident.getText())
    if (!imported) return null
    let declaration = null
    for (const candidate of symbol?.getDeclarations?.() ?? []) if (candidate.getStart() >= imported.start && candidate.getEnd() <= imported.end) { declaration = candidate; break }
    if (!declaration) return null
    const propertyAccess = (parent?.kind === SyntaxKind.PropertyAccessExpression) && parent.expression === node ? parent : null
    const reference = { specifier: imported.specifier, remote: imported.remote, namespace: Boolean(imported.namespace), property: null }
    const target = cachedPartitions && resolveCachedImport(cachedPartitions, rel, reference)
    return { target, call: propertyAccess ? (propertyAccess.parent?.kind === SyntaxKind.CallExpression) : false, reference }
  }
  const localByNode = new Map(rows.map(({ node, identity }) => [node.compilerNode, identity]))
  const targetByIdentifier = new Map()
  const identifierArgs = { file: rel, total: 0, noOwner: 0, symbolMissing: 0, aliases: 0, targetMissing: 0, selfTarget: 0, edges: 0, calls: 0, nonCalls: 0, declarationProbes: 0 }
  const identifierProfile = profiler?.begin('identifiers-symbol-resolution', identifierArgs)
  started = performance.now()
  nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const edges = resolveIdentifierEdges(analysis.identifiers, localByNode, context, identifierArgs, requireCoverage(edgeCoverage), targetByIdentifier, resolveMissing, references, Boolean(cachedPartitions))
  if (context.semanticTiming) context.semanticTiming.identifierResolutionMs += Math.max(0, performance.now() - started - (context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs - nestedStarted))
  if (identifierProfile) profiler.end(identifierProfile)
  const dependencies = []; const unresolved = []
  const dependencyArgs = { file: rel, dependencyDecls: 0, resolved: 0, unresolved: 0, candidates: 0 }
  const dependencyProfile = profiler?.begin('dependencies', dependencyArgs)
  for (const decl of file.getImportDeclarations().concat(file.getExportDeclarations())) {
    dependencyArgs.dependencyDecls += 1
    const target = decl.getModuleSpecifierSourceFile()
    if (target) { dependencies.push(slash(path.relative(context.root, target.getFilePath()))); dependencyArgs.resolved += 1; continue }
    const specifier = decl.getModuleSpecifierValue?.()
    if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue
    const candidates = moduleCandidates(rel, specifier)
    const known = candidates.find((candidate) => knownFiles.has(candidate))
    if (known) { dependencies.push(known); dependencyArgs.resolved += 1; continue }
    dependencyArgs.unresolved += 1
    dependencyArgs.candidates += candidates.length
    unresolved.push({ specifier, candidates })
  }
  if (dependencyProfile) profiler.end(dependencyProfile)
  const sourceHashArgs = { file: rel, sourceBytes: Buffer.byteLength(source) }
  const sourceHashProfile = profiler?.begin('source-hash', sourceHashArgs)
  const sourceHash = contentHash(source)
  if (sourceHashProfile) profiler.end(sourceHashProfile)
  const resolveInternalTarget = (identifier) => {
    if (!identifier || typeof identifier.getKind !== 'function' || !(identifier?.compilerNode.kind === SyntaxKind.Identifier)) return null
    if (targetByIdentifier.has(identifier.compilerNode)) return targetByIdentifier.get(identifier.compilerNode)
    let symbol = identifier.getSymbol?.()
    if (!symbol) { targetByIdentifier.set(identifier.compilerNode, null); return null }
    symbol = expandAliasSymbol(symbol)
    const target = identityForSymbol(symbol, context)?.id ?? null
    targetByIdentifier.set(identifier.compilerNode, target)
    return target
  }
  started = performance.now()
  nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const semanticTargets = [...targetByIdentifier.values()].filter(Boolean).sort()
  if (retainAnalysis) analysis.semanticTargets = semanticTargets
  const orderedDependencies = [...new Set(dependencies)].sort()
  const internalFingerprint = contentHash(JSON.stringify({ schema: 1, typescript: ts.version, compilerOptions: context.project.getCompilerOptions(), sourceHash, dependencies: orderedDependencies, semanticTargets }))
  const internalGraph = includeInternals ? addInternalGraphRelations(file, analysis.internalSyntax, analysis.identifiers, resolveInternalTarget) : null
  if (internalGraph) {
    const symbolByOwnerLocation = new Map()
    for (const symbol of symbols) {
      const key = `${symbol.name}\0${symbol.line}`
      if (!symbolByOwnerLocation.has(key)) symbolByOwnerLocation.set(key, symbol)
    }
    for (const owner of internalGraph.owners) {
      const symbol = symbolByOwnerLocation.get(`${owner.name}\0${owner.line}`)
      if (symbol) owner.symbolId = symbol.id
    }
  }
  if (context.semanticTiming) context.semanticTiming.internalRelationsMs += Math.max(0, performance.now() - started - (context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs - nestedStarted))
  let internalPartition
  if (internalGraph) {
    started = performance.now()
    internalPartition = encodeInternalPartition({ compilerFingerprint: internalFingerprint, ...internalGraph })
    if (context.semanticTiming) context.semanticTiming.encodingMs += performance.now() - started
  }
  // The worker writes these required fields directly into the existing shared packed tables.
  const partition = { file: rel, sourceHash, symbols, edges, dependencies: orderedDependencies, unresolved, bindings, references, internalFingerprint, ...(internalPartition ? { internalPartition } : {}) }
  if (!retainAnalysis) context.perFile.delete(file.getFilePath())
  return partition
}
