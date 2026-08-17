import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { Project, Node, SyntaxKind } from 'ts-morph'
import { RealFileSystemHost } from '@ts-morph/common'
import { PrefetchedFileSystemHost } from './prefetched-file-system.mjs'

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

function collectFileSyntax(file, source, lineCursor) {
  const nodesByKind = new Map([...declarationKinds.keys()].map((syntaxKind) => [syntaxKind, []]))
  const identifiers = []
  lineCursor.reset(source)
  file.forEachDescendant((node) => {
    const bucket = nodesByKind.get(node.getKind())
    const isIdentifier = Node.isIdentifier(node)
    if (!bucket && !isIdentifier) return
    const line = lineCursor.lineAt(node.getStart())
    if (bucket) bucket.push({ node, line })
    if (isIdentifier) identifiers.push({ node, line })
  })

  const groups = new Map(); const result = []
  for (const [syntaxKind, kind] of declarationKinds) {
    for (const { node, line } of nodesByKind.get(syntaxKind)) {
      const name = nodeName(node); if (!name) continue
      const qualifiedPath = semanticPath(node); const signature = semanticSignature(node)
      const group = `${qualifiedPath}:${kind}:${name}:${signature}`; const ordinal = groups.get(group) ?? 0; groups.set(group, ordinal + 1)
      const rel = slash(path.relative(file.getProject().__codegraphRoot, file.getFilePath()))
      result.push({ node, identity: { id: contentHash(`${rel}\0${qualifiedPath}\0${kind}\0${name}\0${signature}\0${ordinal}`).slice(0, 24), file: rel, name, kind, line, qualifiedPath, signature, ordinal } })
    }
  }
  return { rows: result, identifiers }
}

export function prepareSemanticProject(project, root, profiler = null) {
  project.__codegraphRoot = root
  const byDeclaration = new Map(); const perFile = new Map(); const lineCursor = new LineCursor()
  for (const file of project.getSourceFiles()) {
    const rel = slash(path.relative(root, file.getFilePath()))
    const args = { file: rel, descendantTraversals: 1, declarationCount: 0, identifierCount: 0 }
    const profile = profiler?.begin('collect-file-syntax', args)
    try {
      const analysis = collectFileSyntax(file, file.getFullText(), lineCursor)
      args.declarationCount = analysis.rows.length
      args.identifierCount = analysis.identifiers.length
      perFile.set(file.getFilePath(), analysis)
      for (const row of analysis.rows) byDeclaration.set(row.node.compilerNode, row.identity)
    } finally {
      lineCursor.clear()
      if (profile) profiler.end(profile)
    }
  }
  return { project, root, byDeclaration, perFile, lineCursor }
}

function identityForSymbol(symbol, context, identifierArgs) {
  for (const declaration of symbol?.getDeclarations?.() ?? []) {
    identifierArgs.declarationProbes += 1
    const identity = context.byDeclaration.get(declaration.compilerNode)
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

function resolveIdentifierEdges(identifiers, localByNode, context, identifierArgs, edgeCoverage) {
  const edges = []
  const enclosing = (node) => {
    for (let cur = node.getParent(); cur; cur = cur.getParent()) {
      const identity = localByNode.get(cur.compilerNode)
      if (identity) return identity
    }
    return null
  }

  for (const identifier of identifiers) {
    const { node: ident, line } = identifier
    identifierArgs.total += 1
    const call = callExpressionForIdentifier(ident)
    if (edgeCoverage === 'calls' && !call) continue
    const from = enclosing(ident)
    if (!from) { identifierArgs.noOwner += 1; continue }
    let symbol = ident.getSymbol?.()
    if (!symbol) { identifierArgs.symbolMissing += 1; continue }
    try {
      const alias = symbol.getAliasedSymbol()
      if (alias) { symbol = alias; identifierArgs.aliases += 1 }
    } catch {}
    const target = identityForSymbol(symbol, context, identifierArgs)
    if (!target) { identifierArgs.targetMissing += 1; continue }
    if (target.id === from.id) { identifierArgs.selfTarget += 1; continue }
    edges.push({ from: from.id, to: target.id, line, call })
    identifierArgs.edges += 1
    if (call) identifierArgs.calls += 1
    else identifierArgs.nonCalls += 1
  }
  return edges
}

export function parsePartition(rel, source, knownFiles, context, profiler = null, edgeCoverage = 'complete') {
  const absolute = path.join(context.root, rel)
  const file = context.project.getSourceFile(absolute)
  if (!file) throw new Error(`source was not prefetched: ${rel}`)
  const analysis = context.perFile.get(file.getFilePath())
  if (!analysis) throw new Error(`source analysis was not prepared: ${rel}`)
  const { rows } = analysis

  const exportArgs = { file: rel, exportsVisited: 0 }
  const exportProfile = profiler?.begin('exports', exportArgs)
  const exportedIds = new Set()
  for (const declarations of file.getExportedDeclarations().values()) for (const declaration of declarations) {
    exportArgs.exportsVisited += 1
    const identity = context.byDeclaration.get(declaration.compilerNode)
    if (identity) exportedIds.add(identity.id)
  }
  if (exportProfile) profiler.end(exportProfile)
  const symbols = rows.map(({ identity }) => ({ ...identity, exported: exportedIds.has(identity.id) }))
  const localByNode = new Map(rows.map(({ node, identity }) => [node.compilerNode, identity]))
  const identifierArgs = { file: rel, total: 0, noOwner: 0, symbolMissing: 0, aliases: 0, targetMissing: 0, selfTarget: 0, edges: 0, calls: 0, nonCalls: 0, declarationProbes: 0 }
  const identifierProfile = profiler?.begin('identifiers-symbol-resolution', identifierArgs)
  const edges = resolveIdentifierEdges(analysis.identifiers, localByNode, context, identifierArgs, edgeCoverage)
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
  const partition = { file: rel, sourceHash, symbols, edges, dependencies: [...new Set(dependencies)].sort(), unresolved }
  context.perFile.delete(file.getFilePath())
  return partition
}
