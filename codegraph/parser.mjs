import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { Project, Node, SyntaxKind, ts } from 'ts-morph'
import { RealFileSystemHost } from '@ts-morph/common'
import { PrefetchedFileSystemHost } from './prefetched-file-system.mjs'
import { EDGE_COVERAGE, requireCoverage } from './edge-coverage.mjs'
import { addInternalGraphRelations, buildInternalGraphFromCollectedSyntax, encodeInternalPartition } from './internal-graph.mjs'

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

export function createSemanticProject(root, sources) {
  const config = ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(root, name)).find((file) => fs.existsSync(file))
  const fileSystem = new PrefetchedFileSystemHost(root, sources, new RealFileSystemHost())
  const project = new Project({ fileSystem, ...(config ? { tsConfigFilePath: config } : {}), skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } })
  for (const [rel, source] of sources) project.createSourceFile(path.join(root, rel), source, { overwrite: true })
  project.__codegraphHost = fileSystem
  return project
}

function nodeName(node) {
  const named = node.getName?.(); if (named) return named
  if (Node.isConstructorDeclaration(node)) return 'constructor'
  if ((Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node)) && node.isDefaultExport?.()) return 'default'
  return null
}

function semanticPath(node) {
  const parts = []
  for (let cur = node.getParent(); cur && !Node.isSourceFile(cur); cur = cur.getParent()) {
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

function collectFileSyntax(file, source, lineCursor, timing) {
  const started = performance.now()
  const nodesByKind = new Map([...declarationKinds.keys()].map((syntaxKind) => [syntaxKind, []]))
  const identifiers = []
  const internalNodes = [file]
  const firstChild = [-1]
  const nextSibling = [-1]
  const lastChild = [-1]
  const localOwner = [null]
  const stack = [0]
  lineCursor.reset(source)
  file.forEachDescendant((node) => {
    const parent = node.getParent()
    while (stack.length && internalNodes[stack.at(-1)] !== parent) stack.pop()
    const parentIndex = stack.at(-1)
    const internalIndex = internalNodes.length
    internalNodes.push(node); firstChild.push(-1); nextSibling.push(-1); lastChild.push(-1)
    if (lastChild[parentIndex] === -1) firstChild[parentIndex] = internalIndex
    else nextSibling[lastChild[parentIndex]] = internalIndex
    lastChild[parentIndex] = internalIndex
    stack.push(internalIndex)
    const bucket = nodesByKind.get(node.getKind())
    const isIdentifier = Node.isIdentifier(node)
    const name = bucket ? nodeName(node) : null
    localOwner.push(name ? node.compilerNode : localOwner[parentIndex])
    if (!bucket && !isIdentifier) return
    const line = lineCursor.lineAt(node.getStart())
    if (bucket) bucket.push({ node, line, name })
    if (isIdentifier) identifiers.push({ node, line, owner: localOwner[parentIndex] })
  })

  const groups = new Map(); const result = []
  for (const [syntaxKind, kind] of declarationKinds) {
    for (const { node, line, name } of nodesByKind.get(syntaxKind)) {
      if (!name) continue
      const qualifiedPath = semanticPath(node); const signature = semanticSignature(node)
      const group = `${qualifiedPath}:${kind}:${name}:${signature}`; const ordinal = groups.get(group) ?? 0; groups.set(group, ordinal + 1)
      const rel = slash(path.relative(file.getProject().__codegraphRoot, file.getFilePath()))
      result.push({ node, identity: { id: contentHash(`${rel}\0${qualifiedPath}\0${kind}\0${name}\0${signature}\0${ordinal}`).slice(0, 24), file: rel, name, kind, line, qualifiedPath, signature, ordinal } })
    }
  }
  const rel = slash(path.relative(file.getProject().__codegraphRoot, file.getFilePath()))
  const structuralStarted = performance.now()
  const internalSyntax = buildInternalGraphFromCollectedSyntax(file, rel, { nodes: internalNodes, firstChild: Int32Array.from(firstChild), nextSibling: Int32Array.from(nextSibling), identifiers })
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
      for (const node of context.nodesByFile.get(filePath) ?? []) context.byDeclaration.delete(node)
      const analysis = collectFileSyntax(file, file.getFullText(), context.lineCursor, context.semanticTiming)
      args.declarationCount = analysis.rows.length
      args.identifierCount = analysis.identifiers.length
      context.perFile.set(filePath, analysis)
      context.nodesByFile.set(filePath, analysis.rows.map((row) => row.node.compilerNode))
      for (const row of analysis.rows) context.byDeclaration.set(row.node.compilerNode, row.identity)
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
    for (const node of context.nodesByFile.get(filePath) ?? []) context.byDeclaration.delete(node)
    context.nodesByFile.delete(filePath)
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
  if (Node.isCallExpression(parent) && parent.getExpression() === ident) return true
  const grand = parent?.getParent()
  return Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ident && Node.isCallExpression(grand) && grand.getExpression() === parent
}

function resolveIdentifierEdges(identifiers, localByNode, context, identifierArgs, coverage, targetByIdentifier) {
  const edges = []

  for (const identifier of identifiers) {
    const { node: ident, line, owner } = identifier
    identifierArgs.total += 1
    const call = callExpressionForIdentifier(ident)
    if (coverage === EDGE_COVERAGE.CALLS && !call) continue
    const from = owner ? localByNode.get(owner) : null
    if (!from) { identifierArgs.noOwner += 1; continue }
    let symbol = ident.getSymbol?.()
    if (!symbol) { targetByIdentifier.set(ident.compilerNode, null); identifierArgs.symbolMissing += 1; continue }
    try {
      const alias = symbol.getAliasedSymbol()
      if (alias) { symbol = alias; identifierArgs.aliases += 1 }
    } catch {}
    const target = identityForSymbol(symbol, context, identifierArgs)
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

export function parsePartition(rel, source, knownFiles, context, profiler = null, edgeCoverage = EDGE_COVERAGE.COMPLETE, includeInternals = true, retainAnalysis = false) {
  const absolute = path.join(context.root, rel)
  const file = context.project.getSourceFile(absolute)
  if (!file) throw new Error(`source was not prefetched: ${rel}`)
  const analysis = ensureSemanticFile(context, file, profiler)
  const { rows } = analysis

  const exportArgs = { file: rel, exportsVisited: 0 }
  const exportProfile = profiler?.begin('exports', exportArgs)
  let started = performance.now()
  let nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const exportedIds = new Set()
  for (const declarations of file.getExportedDeclarations().values()) for (const declaration of declarations) {
    exportArgs.exportsVisited += 1
    const identity = identityForDeclaration(declaration, context)
    if (identity) exportedIds.add(identity.id)
  }
  if (context.semanticTiming) context.semanticTiming.exportsMs += Math.max(0, performance.now() - started - (context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs - nestedStarted))
  if (exportProfile) profiler.end(exportProfile)
  const symbols = rows.map(({ identity }) => ({ ...identity, exported: exportedIds.has(identity.id) }))
  const localByNode = new Map(rows.map(({ node, identity }) => [node.compilerNode, identity]))
  const targetByIdentifier = new Map()
  const identifierArgs = { file: rel, total: 0, noOwner: 0, symbolMissing: 0, aliases: 0, targetMissing: 0, selfTarget: 0, edges: 0, calls: 0, nonCalls: 0, declarationProbes: 0 }
  const identifierProfile = profiler?.begin('identifiers-symbol-resolution', identifierArgs)
  started = performance.now()
  nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const edges = resolveIdentifierEdges(analysis.identifiers, localByNode, context, identifierArgs, requireCoverage(edgeCoverage), targetByIdentifier)
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
    const base = slash(path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier)))
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map((ext) => base + ext), ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map((ext) => base + ext)]
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
    if (!identifier || typeof identifier.getKind !== 'function' || !Node.isIdentifier(identifier)) return null
    if (targetByIdentifier.has(identifier.compilerNode)) return targetByIdentifier.get(identifier.compilerNode)
    let symbol = identifier.getSymbol?.()
    if (!symbol) { targetByIdentifier.set(identifier.compilerNode, null); return null }
    try { symbol = symbol.getAliasedSymbol() ?? symbol } catch {}
    const target = identityForSymbol(symbol, context)?.id ?? null
    targetByIdentifier.set(identifier.compilerNode, target)
    return target
  }
  started = performance.now()
  nestedStarted = context.semanticTiming && context.semanticTiming.syntaxCollectionMs + context.semanticTiming.structuralCfgMs
  const semanticTargets = analysis.identifiers.map(({ node }) => resolveInternalTarget(node)).filter(Boolean).sort()
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
      if (symbol) internalGraph.owners.set(owner.id, 'symbolId', symbol.id)
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
  const partition = { file: rel, sourceHash, symbols, edges, dependencies: orderedDependencies, unresolved, internalFingerprint, ...(internalPartition ? { internalPartition } : {}) }
  if (!retainAnalysis) context.perFile.delete(file.getFilePath())
  return partition
}
