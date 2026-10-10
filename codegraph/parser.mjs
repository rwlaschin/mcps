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

function collectFileSyntax(file, source, lineCursor, timing, preparedStructuralGraph, deferStructuralGraph = false, byDeclaration = null) {
  const started = performance.now()
  const nodesByKind = new Map([...declarationKinds.keys()].map((syntaxKind) => [syntaxKind, []]))
  const identifiers = []
  const structuralCache = file.structuralCache
  const syntaxFacts = structuralCache ? structuralCache.syntax ??= new WeakMap() : new WeakMap()
  const nativeTraversal = Boolean((preparedStructuralGraph || deferStructuralGraph) && file.compilerNode && file.session?.wrap)
  const children = nativeTraversal ? null : structuralCache ? structuralCache.children ??= new WeakMap() : new WeakMap()
  lineCursor.reset(source)
  const record = (node, owner) => {
    const bucket = nodesByKind.get(node.getKind())
    const isIdentifier = (node?.compilerNode.kind === SyntaxKind.Identifier)
    let fact = bucket ? syntaxFacts.get(node.compilerNode) : null
    if (bucket && !fact) { fact = { name: nodeName(node), signature: semanticSignature(node) }; syntaxFacts.set(node.compilerNode, fact) }
    if (bucket || isIdentifier) {
      const line = lineCursor.lineAt(node.getStart())
      if (bucket) bucket.push({ node, line, name: fact.name, signature: fact.signature })
      if (isIdentifier) identifiers.push({ node, line, owner })
    }
    return fact?.name ? node.compilerNode : owner
  }
  if (structuralCache && file.session?.sourceFile === file.compilerNode) {
    const inventories = structuralCache.inventories ??= new WeakMap()
    const stats = structuralCache.inventoryStats = { rebuiltOwners: 0, reusedOwners: 0, visitedNodes: 0, deletedDeclarations: 0 }
    const boundary = node => declarationKinds.has(node.kind) || ts.isFunctionLike(node) || node.kind === SyntaxKind.Block || node.kind === SyntaxKind.CatchClause || node.kind === SyntaxKind.ModuleBlock
    const relevant = node => declarationKinds.has(node.kind) || node.kind === SyntaxKind.Identifier
    const replay = (root, inherited) => {
      const owner = relevant(root) ? record(file.session.wrap(root), inherited) : inherited
      const retained = inventories.get(root)
      if (retained) {
        retained.currentSourceRoot = file.compilerNode
        stats.reusedOwners += 1
        for (const entry of retained.entries) {
          const incoming = entry.owner ?? owner
          if (entry.nested) replay(entry.node, incoming)
          else record(file.session.wrap(entry.node), incoming)
        }
        return
      }
      stats.rebuiltOwners += 1
      const entries = []
      const visitChildren = (node, incoming) => {
        const items = children ? [] : null
        ts.forEachChild(node, child => {
          stats.visitedNodes += 1
          if (children) items.push(file.session.wrap(child))
          const savedOwner = incoming === owner ? null : incoming
          if (boundary(child)) { entries.push({ node: child, owner: savedOwner, nested: true }); replay(child, incoming); return }
          let nextOwner = incoming
          if (relevant(child)) { entries.push({ node: child, owner: savedOwner }); nextOwner = record(file.session.wrap(child), incoming) }
          visitChildren(child, nextOwner)
        })
        if (children) children.set(node, items)
      }
      visitChildren(root, owner)
      inventories.set(root, { entries, currentSourceRoot: file.compilerNode })
    }
    replay(file.compilerNode, null)
    const prune = root => {
      const retained = inventories.get(root)
      if (!retained || retained.currentSourceRoot === file.compilerNode) return
      if (declarationKinds.has(root.kind) && byDeclaration?.delete(root)) stats.deletedDeclarations += 1
      for (const entry of retained.entries) if (entry.nested) prune(entry.node)
    }
    if (structuralCache.currentRoot) prune(structuralCache.currentRoot)
    structuralCache.currentRoot = file.compilerNode
  } else if (nativeTraversal) {
    const visit = (node, owner) => {
      const nextOwner = declarationKinds.has(node.kind) || node.kind === SyntaxKind.Identifier ? record(file.session.wrap(node), owner) : owner
      ts.forEachChild(node, child => { visit(child, nextOwner) })
    }
    ts.forEachChild(file.compilerNode, child => { visit(child, null) })
  } else {
    const emptyChildren = []
    const stack = [file]; const ownerStack = [null]; const building = [false]; let depth = 0
    file.forEachDescendant((node) => {
      const parent = node.getParent()
      while (stack[depth] !== parent) { if (!children.has(stack[depth].compilerNode)) children.set(stack[depth].compilerNode, emptyChildren); depth -= 1 }
      if (building[depth]) children.get(parent.compilerNode).push(node)
      else if (!children.has(parent.compilerNode)) { children.set(parent.compilerNode, [node]); building[depth] = true }
      const owner = record(node, ownerStack[depth])
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
  const parent = ident.getParent()
  if ((parent?.compilerNode.kind === SyntaxKind.CallExpression) && parent.getExpression() === ident) return true
  const grand = parent?.getParent()
  return (parent?.compilerNode.kind === SyntaxKind.PropertyAccessExpression) && parent.getNameNode() === ident && (grand?.compilerNode.kind === SyntaxKind.CallExpression) && grand.getExpression() === parent
}

function resolveIdentifierEdges(identifiers, localByNode, context, identifierArgs, coverage, targetByIdentifier, resolveMissing = null, references = null) {
  const edges = []

  for (const identifier of identifiers) {
    const { node: ident, line, owner } = identifier
    identifierArgs.total += 1
    let call = callExpressionForIdentifier(ident)
    if (coverage === EDGE_COVERAGE.CALLS && !call) continue
    const from = owner ? localByNode.get(owner) : null
    if (!from) { identifierArgs.noOwner += 1; continue }
    let symbol = ident.getSymbol?.()
    if (!symbol) { targetByIdentifier.set(ident.compilerNode, null); identifierArgs.symbolMissing += 1; continue }
    const cached = resolveMissing ? resolveMissing(ident, symbol) : null
    if (cached?.call) call = true
    if (cached?.reference) { cached.reference.from = from.id; cached.reference.line = line; cached.reference.call = call; references.push(cached.reference) }
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
  const resolveMissing = (ident, symbol) => {
    const parent = ident.getParent()
    if ((parent?.compilerNode.kind === SyntaxKind.PropertyAccessExpression) && parent.getNameNode() === ident) return null
    const imported = imports.get(ident.getText())
    if (!imported) return null
    const declaration = symbol.getDeclarations?.().find((node) => node.getStart() >= imported.start && node.getEnd() <= imported.end)
    if (!declaration) return null
    const propertyAccess = (parent?.compilerNode.kind === SyntaxKind.PropertyAccessExpression) && parent.getExpression() === ident ? parent : null
    const property = propertyAccess?.getName() ?? null
    const reference = { specifier: imported.specifier, remote: imported.remote, namespace: Boolean(imported.namespace), property }
    const target = cachedPartitions && resolveCachedImport(cachedPartitions, rel, reference, property)
    return { target, call: propertyAccess ? (propertyAccess.getParent()?.compilerNode.kind === SyntaxKind.CallExpression) : false, reference }
  }
  const localByNode = new Map(rows.map(({ node, identity }) => [node.compilerNode, identity]))
  const targetByIdentifier = new Map()
  const identifierArgs = { file: rel, total: 0, noOwner: 0, symbolMissing: 0, aliases: 0, targetMissing: 0, selfTarget: 0, edges: 0, calls: 0, nonCalls: 0, declarationProbes: 0 }
  const identifierProfile = profiler?.begin('identifiers-symbol-resolution', identifierArgs)
  started = performance.now()
  nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const edges = resolveIdentifierEdges(analysis.identifiers, localByNode, context, identifierArgs, requireCoverage(edgeCoverage), targetByIdentifier, resolveMissing, references)
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
