import ts from '@ts-morph/common/dist/typescript.js'
import path from 'node:path'
import { createRawSemanticProject } from './one-file-semantic-library.mjs'
export { encodeInternalPartition, decodeInternalPartition, INTERNAL_SCHEMA_VERSION } from './store.mjs'

const { SyntaxKind } = ts
const assignments = new Set(Array.from({ length: SyntaxKind.LastAssignment - SyntaxKind.FirstAssignment + 1 }, (_, i) => SyntaxKind.FirstAssignment + i))
const decisions = new Set(['&&', '||', '??'])
const logicalAssignments = new Set(['&&=', '||=', '??='])
const flowKinds = new Set(['next', 'true', 'false', 'case', 'default', 'back', 'break', 'continue', 'return', 'throw', 'exception', 'finally'])
class Rows {
  constructor(rows = []) { this.rows = rows }
  get length() { return this.rows.length }
  push(row) { this.rows.push(row); return row }
  get(index) { return this.rows[index] }
  set(index, key, value) { this.rows[index][key] = value }
  filter(fn) { return this.rows.filter(fn) }
  map(fn) { return this.rows.map(fn) }
  find(fn) { return this.rows.find(fn) }
  forEach(fn) { return this.rows.forEach(fn) }
  [Symbol.iterator]() { return this.rows[Symbol.iterator]() }
}
const executableKind = (node) => {
  if ((node?.compilerNode.kind === SyntaxKind.SourceFile)) return 'module'
  if ((node?.compilerNode.kind === SyntaxKind.ArrowFunction)) return 'arrow'
  if ((node?.compilerNode.kind === SyntaxKind.MethodDeclaration)) return 'method'
  if ((node?.compilerNode.kind === SyntaxKind.Constructor)) return 'constructor'
  if ((node?.compilerNode.kind === SyntaxKind.GetAccessor)) return 'getter'
  if ((node?.compilerNode.kind === SyntaxKind.SetAccessor)) return 'setter'
  if ((node?.compilerNode.kind === SyntaxKind.ClassStaticBlockDeclaration)) return 'static-block'
  if ((node?.compilerNode.kind === SyntaxKind.PropertyDeclaration) && node.getInitializer()) return 'field-initializer'
  if ((node?.compilerNode.kind === SyntaxKind.FunctionDeclaration) || (node?.compilerNode.kind === SyntaxKind.FunctionExpression)) return 'function'
  return null
}
const ownerName = (node) => {
  if ((node?.compilerNode.kind === SyntaxKind.SourceFile)) return '<module>'
  if ((node?.compilerNode.kind === SyntaxKind.Constructor)) return 'constructor'
  if ((node?.compilerNode.kind === SyntaxKind.ClassStaticBlockDeclaration)) return '<static>'
  return node.getName?.() || node.getParent?.()?.getName?.() || '<anonymous>'
}
const location = (file, node) => {
  const start = node.compilerNode.getStart(file.compilerNode); const end = node.compilerNode.end
  const a = file.compilerNode.getLineAndCharacterOfPosition(start); const b = file.compilerNode.getLineAndCharacterOfPosition(end)
  return { start, end, line: a.line + 1, column: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 }
}
const nodeKind = (node) => {
  const kind = node.getKind()
  if (kind === SyntaxKind.IfStatement || kind === SyntaxKind.ConditionalExpression || kind === SyntaxKind.SwitchStatement || kind === SyntaxKind.BinaryExpression && decisions.has(node.getOperatorToken().getText()) || node.getQuestionDotTokenNode?.()) return 'condition'
  switch (kind) {
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.DoStatement: return 'loop'
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause: return 'case'
    case SyntaxKind.CallExpression: return 'call'
    case SyntaxKind.ReturnStatement: return 'return'
    case SyntaxKind.ThrowStatement: return 'throw'
    case SyntaxKind.BreakStatement: return 'break'
    case SyntaxKind.ContinueStatement: return 'continue'
    case SyntaxKind.AwaitExpression: return 'await'
    case SyntaxKind.YieldExpression: return 'yield'
    case SyntaxKind.BinaryExpression: return assignments.has(node.getOperatorToken().getKind()) ? 'assignment' : null
    case SyntaxKind.Block:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.ModuleBlock:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.NotEmittedStatement:
    case SyntaxKind.TryStatement:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.WithStatement: return 'statement'
    default: return null
  }
}

export function metricsForOwner(owner, nodes, edges) {
  const ids = new Set(); let catchHandlers = 0; let finalizers = 0
  for (const node of nodes) if (node.ownerId === owner.id && !node.unreachable) { ids.add(node.id); if (node.role === 'handler') catchHandlers += 1; if (node.role === 'finalizer') finalizers += 1 }
  const flow = edges.filter((edge) => edge.ownerId === owner.id && ids.has(edge.from) && ids.has(edge.to) && flowKinds.has(edge.kind))
  const undirected = new Map([...ids].map((id) => [id, new Set()])); const outgoing = new Map()
  let ignoredEdges = 0; let finallyEdges = 0
  for (const { from, to, kind } of flow) {
    undirected.get(from).add(to); undirected.get(to).add(from)
    if (kind === 'exception') ignoredEdges += 1
    else if (kind === 'finally') finallyEdges += 1
    else { if (!outgoing.has(from)) outgoing.set(from, new Set()); outgoing.get(from).add(to) }
  }
  ignoredEdges += Math.max(0, finallyEdges - finalizers)
  let components = 0; const seen = new Set()
  for (const id of ids) if (!seen.has(id)) { components += 1; const stack = [id]; seen.add(id); while (stack.length) for (const next of undirected.get(stack.pop())) if (!seen.has(next)) { seen.add(next); stack.push(next) } }
  return { cyclomatic: Math.max(1, flow.length - ignoredEdges - ids.size + 2 * components + catchHandlers), branchCount: [...outgoing.values()].filter((targets) => targets.size > 1).length, nestingDepth: owner.nestingDepth ?? 0 }
}

function collectSyntax(sourceFile) {
  const nodes = [sourceFile]
  const firstChild = [-1]
  const nextSibling = [-1]
  const lastChild = [-1]
  const stack = [0]
  const identifiers = []
  sourceFile.forEachDescendant((node) => {
    const parent = node.getParent()
    while (stack.length && nodes[stack.at(-1)] !== parent) stack.pop()
    const parentIndex = stack.at(-1)
    const index = nodes.length
    nodes.push(node); firstChild.push(-1); nextSibling.push(-1); lastChild.push(-1)
    if (lastChild[parentIndex] === -1) firstChild[parentIndex] = index
    else nextSibling[lastChild[parentIndex]] = index
    lastChild[parentIndex] = index
    stack.push(index)
    if ((node?.compilerNode.kind === SyntaxKind.Identifier)) identifiers.push(node)
  })
  return { nodes, firstChild: Int32Array.from(firstChild), nextSibling: Int32Array.from(nextSibling), identifiers }
}

function attachRelations(sourceFile, graph, identifiers, resolveSymbol, instrumentRelationLookup = false) {
  const { owners, nodes, relations } = graph
  const lookupStats = instrumentRelationLookup ? { identifierLookups: 0, ownerCandidateChecks: 0, nodeCandidateChecks: 0 } : null
  const executableOwners = [...owners].filter(({ kind }) => kind !== 'module').sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.id - b.id)
  const ownerStarts = Uint32Array.from(executableOwners, ({ start }) => start)
  const ownerEnds = Uint32Array.from(executableOwners, ({ end }) => end)
  const ownerIds = Uint32Array.from(executableOwners, ({ id }) => id)
  const nodeBuckets = new Map(executableOwners.map(({ id }) => [id, []]))
  for (const node of nodes) if (!['entry', 'exit'].includes(node.kind)) nodeBuckets.get(node.ownerId)?.push(node)
  const nodeRanges = new Map()
  for (const [ownerId, records] of nodeBuckets) {
    records.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.id - b.id)
    const starts = Uint32Array.from(records, ({ start }) => start); const ends = Uint32Array.from(records, ({ end }) => end); const ids = Uint32Array.from(records, ({ id }) => id); const prefixMaxEnd = new Uint32Array(records.length)
    let maximum = 0
    for (let index = 0; index < records.length; index += 1) { maximum = Math.max(maximum, ends[index]); prefixMaxEnd[index] = maximum }
    nodeRanges.set(ownerId, { starts, ends, ids, prefixMaxEnd })
  }
  const upperBound = (values, target) => {
    let low = 0; let high = values.length
    while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= target) low = middle + 1; else high = middle }
    return low
  }
  const ownerAt = (start, end) => {
    for (let index = upperBound(ownerStarts, start) - 1; index >= 0; index -= 1) {
      if (lookupStats) lookupStats.ownerCandidateChecks += 1
      if (end <= ownerEnds[index]) return ownerIds[index]
    }
    return null
  }
  const nodeAt = (ownerId, start, end) => {
    const ranges = nodeRanges.get(ownerId); if (!ranges) return null
    let best = null; let bestSpan = Infinity
    for (let index = upperBound(ranges.starts, start) - 1; index >= 0 && ranges.prefixMaxEnd[index] >= end; index -= 1) {
      if (lookupStats) lookupStats.nodeCandidateChecks += 1
      if (end > ranges.ends[index]) continue
      const span = ranges.ends[index] - ranges.starts[index]
      if (span < bestSpan) { best = ranges.ids[index]; bestSpan = span }
    }
    return best
  }
  if (resolveSymbol) for (const entry of identifiers) {
    const ident = entry.node ?? entry
    const targetSymbolId = resolveSymbol(ident) ?? resolveSymbol(ident.getText()); if (!targetSymbolId) continue
    const start = ident.getStart(); const end = ident.getEnd(); const ownerId = ownerAt(start, end); if (ownerId === null) continue
    const fromNode = nodeAt(ownerId, start, end); if (fromNode === null) continue
    if (lookupStats) lookupStats.identifierLookups += 1
    const parent = ident.getParent(); const grand = parent?.getParent(); const call = (parent?.compilerNode.kind === SyntaxKind.CallExpression) && parent.getExpression() === ident || (parent?.compilerNode.kind === SyntaxKind.PropertyAccessExpression) && parent.getNameNode() === ident && (grand?.compilerNode.kind === SyntaxKind.CallExpression) && grand.getExpression() === parent
    const write = (parent?.compilerNode.kind === SyntaxKind.BinaryExpression) && parent.getLeft() === ident && assignments.has(parent.getOperatorToken().getKind())
    relations.push({ ownerId, fromNode, targetSymbolId, kind: write ? 'write' : call ? 'call' : 'read' })
  }
  if (lookupStats) graph.lookupStats = lookupStats
  return graph
}

function graphFromSourceFile(sourceFile, file, syntax, resolveSymbol, packed = false, { instrumentRelationLookup = false, structuralCache = null } = {}) {
  const owners = new Rows(); const nodes = new Rows(); const edges = new Rows(); const relations = new Rows(); const ownerStack = []; const built = new Set()
  let activeFacts = null; let activeNodeStart = 0
  if (structuralCache) { structuralCache.stats.rebuiltOwners = 0; structuralCache.stats.reusedOwners = 0 }
  const syntaxIndex = syntax.nodes ? new WeakMap(syntax.nodes.map((node, index) => [node, index])) : null
  const childrenOf = syntax.children
    ? (node) => syntax.children.get(node.compilerNode) ?? []
    : (node) => {
        const result = []
        for (let index = syntax.firstChild[syntaxIndex.get(node)]; index !== -1; index = syntax.nextSibling[index]) result.push(syntax.nodes[index])
        return result
      }
  const addNode = (ownerId, ast, kind, role = 'body', parentId = null, unreachable = false, flags = 0) => {
    if (activeFacts) activeFacts.nodes.push({ anchor: ast.compilerNode, row: { parentId: parentId === null ? null : parentId - activeNodeStart, kind, role, unreachable, ...(flags ? { flags } : {}) } })
    const node = { id: nodes.length, ownerId, parentId, kind, role, ...location(sourceFile, ast), symbolId: null, unreachable, ...(flags ? { flags } : {}) }; nodes.push(node); return node
  }
  const addEdge = (ownerId, from, to, kind) => { if (from !== null && to !== null) edges.push({ ownerId, from, to, kind }) }
  const body = (statement) => (statement?.compilerNode.kind === SyntaxKind.Block) ? statement.getStatements() : [statement]
  const buildOwner = (root, explicitParent = ownerStack.at(-1) ?? null) => {
    if (built.has(root.compilerNode)) return
    built.add(root.compilerNode)
    const id = owners.length
    const ownerNodeStart = nodes.length; const ownerEdgeStart = edges.length
    const retained = structuralCache?.owners.get(root.compilerNode)
    if (retained) {
      const owner = { ...retained.owner, id, symbolId: null, parentOwnerId: explicitParent, name: ownerName(root), file, ...location(sourceFile, root), entryNodeId: ownerNodeStart + retained.owner.entryNodeId, exitNodeId: ownerNodeStart + retained.owner.exitNodeId, firstNode: ownerNodeStart }
      owners.push(owner)
      for (const fact of retained.nodes) {
        const node = { ...fact.row, id: nodes.length, ownerId: id, parentId: fact.row.parentId === null ? null : ownerNodeStart + fact.row.parentId, ...location(sourceFile, { compilerNode: fact.anchor }), symbolId: null }
        nodes.push(node)
      }
      for (const edge of retained.edges) edges.push({ ownerId: id, from: ownerNodeStart + edge.from, to: ownerNodeStart + edge.to, kind: edge.kind })
      structuralCache.stats.reusedOwners += 1
      for (const nested of retained.nestedOwners) buildOwner(root.session.wrap(nested), id)
      return
    }
    if (structuralCache) structuralCache.stats.rebuiltOwners += 1
    const facts = structuralCache ? { owner: null, nodes: [], edges: [], nestedOwners: [] } : null
    activeFacts = facts; activeNodeStart = ownerNodeStart
    const owner = { id, symbolId: null, parentOwnerId: explicitParent, kind: executableKind(root), name: ownerName(root), file, ...location(sourceFile, root), entryNodeId: null, exitNodeId: null, cyclomatic: 1, branchCount: 0, nestingDepth: 0 }
    owners.push(owner); ownerStack.push(id)
    const entry = addNode(id, root, 'entry'); const exit = addNode(id, root, 'exit'); owner.entryNodeId = entry.id; owner.exitNodeId = exit.id
    const loopStack = []; const labelStack = []; const nestedOwners = []
    const expression = (ast, next, unreachable = false, depth = 0) => {
      if (!ast) return next
      const compilerNode = ast.compilerNode
      const astKind = compilerNode.kind
      if (ast !== root && executableKind(ast)) { nestedOwners.push(ast); return next }
      const optional = Boolean(ast.getQuestionDotTokenNode?.())
      if (optional) {
        const node = addNode(id, ast, 'condition', 'condition', null, unreachable); const evaluated = addNode(id, ast, astKind === SyntaxKind.CallExpression ? 'call' : 'statement', 'operand', node.id, unreachable); owner.nestingDepth = Math.max(owner.nestingDepth, depth + 1)
        let evaluatedEntry = evaluated.id; const children = childrenOf(ast)
        for (let index = children.length - 1; index > 0; index -= 1) evaluatedEntry = expression(children[index], evaluatedEntry, unreachable, depth + 1)
        addEdge(id, evaluated.id, next, 'next'); addEdge(id, node.id, evaluatedEntry, 'true'); addEdge(id, node.id, next, 'false')
        return expression(children[0], node.id, unreachable, depth)
      }
      if (astKind === SyntaxKind.ConditionalExpression || astKind === SyntaxKind.BinaryExpression && (decisions.has(ast.getOperatorToken().getText()) || logicalAssignments.has(ast.getOperatorToken().getText()))) {
        const node = addNode(id, ast, 'condition', 'condition', null, unreachable); owner.nestingDepth = Math.max(owner.nestingDepth, depth + 1)
        if (astKind === SyntaxKind.ConditionalExpression) { const yes = expression(ast.getWhenTrue(), next, unreachable, depth + 1); const no = expression(ast.getWhenFalse(), next, unreachable, depth + 1); addEdge(id, node.id, yes, 'true'); addEdge(id, node.id, no, 'false'); return expression(ast.getCondition(), node.id, unreachable, depth) }
        const right = expression(ast.getRight(), next, unreachable, depth + 1); const and = ['&&', '&&='].includes(ast.getOperatorToken().getText()); addEdge(id, node.id, right, and ? 'true' : 'false'); addEdge(id, node.id, next, and ? 'false' : 'true'); return expression(ast.getLeft(), node.id, unreachable, depth)
      }
      const kind = nodeKind(ast)
      if (kind) {
        const node = addNode(id, ast, kind, kind === 'condition' ? 'condition' : 'body', null, unreachable); addEdge(id, node.id, next, 'next')
        let first = node.id
        for (const child of [...childrenOf(ast)].reverse()) first = expression(child, first, unreachable, depth)
        return first
      }
      let first = next; const children = childrenOf(ast)
      for (let index = children.length - 1; index >= 0; index -= 1) first = expression(children[index], first, unreachable, depth)
      return first
    }
    const statements = (items, next, unreachable = false, depth = 0) => {
      const dead = []; let stopped = unreachable
      for (const item of items) { dead.push(stopped); if ((item?.compilerNode.kind === SyntaxKind.ReturnStatement) || (item?.compilerNode.kind === SyntaxKind.ThrowStatement) || (item?.compilerNode.kind === SyntaxKind.BreakStatement) || (item?.compilerNode.kind === SyntaxKind.ContinueStatement)) stopped = true }
      let first = next
      for (let index = items.length - 1; index >= 0; index -= 1) first = statement(items[index], first, dead[index], depth)
      return first
    }
    const statement = (ast, next, unreachable, depth) => {
      if (ast !== root && executableKind(ast)) { nestedOwners.push(ast); return next }
      if ((ast?.compilerNode.kind === SyntaxKind.Block)) return statements(ast.getStatements(), next, unreachable, depth)
      if ((ast?.compilerNode.kind === SyntaxKind.IfStatement)) {
        const node = addNode(id, ast, 'condition', 'condition', null, unreachable); owner.nestingDepth = Math.max(owner.nestingDepth, depth + 1)
        const yes = statements(body(ast.getThenStatement()), next, unreachable, depth + 1); const otherwise = ast.getElseStatement(); const no = otherwise ? statements(body(otherwise), next, unreachable, depth + 1) : next
        addEdge(id, node.id, yes, 'true'); addEdge(id, node.id, no, 'false'); return expression(ast.getExpression(), node.id, unreachable, depth)
      }
      if ((ast?.compilerNode.kind === SyntaxKind.WhileStatement) || (ast?.compilerNode.kind === SyntaxKind.DoStatement) || (ast?.compilerNode.kind === SyntaxKind.ForStatement) || (ast?.compilerNode.kind === SyntaxKind.ForInStatement) || (ast?.compilerNode.kind === SyntaxKind.ForOfStatement)) {
        const isForLoop = (ast?.compilerNode.kind === SyntaxKind.ForStatement) || (ast?.compilerNode.kind === SyntaxKind.ForInStatement) || (ast?.compilerNode.kind === SyntaxKind.ForOfStatement)
        const node = addNode(id, ast, 'loop', 'condition', null, unreachable, isForLoop ? 1 : 0); owner.nestingDepth = Math.max(owner.nestingDepth, depth + 1)
        let continueTarget = node.id
        if ((ast?.compilerNode.kind === SyntaxKind.ForStatement) && ast.getIncrementor()) continueTarget = expression(ast.getIncrementor(), node.id, unreachable, depth + 1)
        loopStack.push({ breakTarget: next, continueTarget }); const first = statements(body(ast.getStatement()), continueTarget, unreachable, depth + 1); loopStack.pop()
        addEdge(id, node.id, first, 'true'); addEdge(id, node.id, next, 'false'); return expression(ast.getExpression?.() ?? ast.getCondition?.(), node.id, unreachable, depth)
      }
      if ((ast?.compilerNode.kind === SyntaxKind.SwitchStatement)) {
        const node = addNode(id, ast, 'condition', 'condition', null, unreachable); owner.nestingDepth = Math.max(owner.nestingDepth, depth + 1); let fallthrough = next; let hasDefault = false
        loopStack.push({ breakTarget: next, continueTarget: null })
        for (const clause of [...ast.getCaseBlock().getClauses()].reverse()) { const clauseNode = addNode(id, clause, 'case', 'body', node.id, unreachable); const first = statements(clause.getStatements(), fallthrough, unreachable, depth + 1); addEdge(id, clauseNode.id, first, 'next'); addEdge(id, node.id, clauseNode.id, (clause?.compilerNode.kind === SyntaxKind.DefaultClause) ? 'default' : 'case'); hasDefault ||= (clause?.compilerNode.kind === SyntaxKind.DefaultClause); fallthrough = clauseNode.id }
        loopStack.pop(); if (!hasDefault) addEdge(id, node.id, next, 'false'); return expression(ast.getExpression(), node.id, unreachable, depth)
      }
      if ((ast?.compilerNode.kind === SyntaxKind.TryStatement)) {
        const finalBlock = ast.getFinallyBlock(); const catchClause = ast.getCatchClause()
        const finalMarker = finalBlock ? addNode(id, finalBlock, 'statement', 'finalizer', null, unreachable) : null
        const finalEntry = finalBlock ? statements(finalBlock.getStatements(), finalMarker.id, unreachable, depth + 1) : next
        if (finalMarker) addEdge(id, finalMarker.id, next, 'finally')
        const edgeStart = edges.length
        const catchMarker = catchClause ? addNode(id, catchClause, 'statement', 'handler', null, unreachable) : null
        const catchEntry = catchClause ? statements(catchClause.getBlock().getStatements(), finalEntry, unreachable, depth + 1) : null
        if (catchMarker) addEdge(id, catchMarker.id, catchEntry, 'next')
        const tryEdgeStart = edges.length
        const tryEntry = statements(ast.getTryBlock().getStatements(), finalEntry, unreachable, depth + 1)
        if (catchMarker) {
          for (const candidate of edges.rows.slice(tryEdgeStart)) {
            const source = nodes.get(candidate.from)
            if (source && source.ownerId === id && ['call', 'await', 'assignment', 'statement'].includes(source.kind)) addEdge(id, source.id, catchMarker.id, 'exception')
          }
        }
        if (finalMarker) {
          const abruptTargets = []
          for (const candidate of edges.rows.slice(edgeStart)) if (candidate.ownerId === id && ['return', 'throw', 'break', 'continue'].includes(candidate.kind)) {
            abruptTargets.push(candidate.to); candidate.to = finalEntry
          }
          for (const target of new Set(abruptTargets)) if (!edges.rows.some((candidate) => candidate.from === finalMarker.id && candidate.to === target && candidate.kind === 'finally')) addEdge(id, finalMarker.id, target, 'finally')
        }
        return tryEntry
      }
      if ((ast?.compilerNode.kind === SyntaxKind.ReturnStatement) || (ast?.compilerNode.kind === SyntaxKind.ThrowStatement)) { const kind = (ast?.compilerNode.kind === SyntaxKind.ReturnStatement) ? 'return' : 'throw'; const node = addNode(id, ast, kind, 'body', null, unreachable); addEdge(id, node.id, exit.id, kind); return expression(ast.getExpression?.(), node.id, unreachable, depth) }
      if ((ast?.compilerNode.kind === SyntaxKind.BreakStatement) || (ast?.compilerNode.kind === SyntaxKind.ContinueStatement)) { const kind = (ast?.compilerNode.kind === SyntaxKind.BreakStatement) ? 'break' : 'continue'; const node = addNode(id, ast, kind, 'body', null, unreachable); const target = kind === 'break' ? loopStack.at(-1)?.breakTarget : loopStack.at(-1)?.continueTarget; addEdge(id, node.id, target ?? next, kind); return node.id }
      if ((ast?.compilerNode.kind === SyntaxKind.LabeledStatement)) { labelStack.push(ast.getLabel().getText()); const first = statement(ast.getStatement(), next, unreachable, depth); labelStack.pop(); return first }
      const node = addNode(id, ast, nodeKind(ast) ?? 'statement', 'body', null, unreachable); addEdge(id, node.id, next, 'next')
      let first = node.id
      const children = childrenOf(ast).filter((child) => !(child?.compilerNode.kind === SyntaxKind.ModuleBlock || (child?.compilerNode !== undefined && ts.isStatementOrBlock(child.compilerNode) && child.compilerNode.kind !== SyntaxKind.MissingDeclaration && child.compilerNode.kind !== SyntaxKind.NamespaceExportDeclaration)))
      for (let index = children.length - 1; index >= 0; index -= 1) first = expression(children[index], first, unreachable, depth)
      return first
    }
    const rootBody = (root?.compilerNode.kind === SyntaxKind.SourceFile) ? null : (root?.compilerNode.kind === SyntaxKind.PropertyDeclaration) ? root.getInitializer() : root.getBody?.()
    let first = (root?.compilerNode.kind === SyntaxKind.SourceFile) ? statements(root.getStatements(), exit.id) : (rootBody?.compilerNode.kind === SyntaxKind.Block) ? statements(rootBody.getStatements(), exit.id) : expression(rootBody, exit.id)
    const parameterDefaults = []
    for (const parameter of root.getParameters?.() ?? []) {
      if (parameter.getInitializer?.()) parameterDefaults.push(parameter)
      const pending = [...childrenOf(parameter)].reverse()
      while (pending.length) {
        const candidate = pending.pop()
        if ((candidate?.compilerNode.kind === SyntaxKind.BindingElement) && candidate.getInitializer?.()) parameterDefaults.push(candidate)
        const nested = childrenOf(candidate)
        for (let index = nested.length - 1; index >= 0; index -= 1) pending.push(nested[index])
      }
    }
    for (const parameter of [...parameterDefaults].reverse()) {
      const condition = addNode(id, parameter, 'condition', 'initializer', null, false); const initialized = expression(parameter.getInitializer(), first, false, 1)
      addEdge(id, condition.id, initialized, 'true'); addEdge(id, condition.id, first, 'false'); first = condition.id
    }
    addEdge(id, entry.id, first, 'next')
    const owned = nodes.rows.slice(ownerNodeStart); const ownedEdges = edges.rows.slice(ownerEdgeStart)
    owner.firstNode = owned[0].id; owner.nodeCount = owned.length
    Object.assign(owner, metricsForOwner(owner, owned, ownedEdges))
    if (structuralCache) {
      facts.owner = { kind: owner.kind, name: owner.name, entryNodeId: owner.entryNodeId - ownerNodeStart, exitNodeId: owner.exitNodeId - ownerNodeStart, nodeCount: owner.nodeCount, cyclomatic: owner.cyclomatic, branchCount: owner.branchCount, nestingDepth: owner.nestingDepth }
      for (let index = ownerEdgeStart; index < edges.length; index += 1) { const edge = edges.get(index); facts.edges.push({ from: edge.from - ownerNodeStart, to: edge.to - ownerNodeStart, kind: edge.kind }) }
      for (const nested of nestedOwners) facts.nestedOwners.push(nested.compilerNode)
      structuralCache.owners.set(root.compilerNode, facts)
    }
    activeFacts = null
    ownerStack.pop()
    for (const nested of nestedOwners) buildOwner(nested, id)
  }
  buildOwner(sourceFile)
  const graph = { owners, nodes, edges, relations }
  if (!resolveSymbol) {
    if (instrumentRelationLookup) graph.lookupStats = { identifierLookups: 0, ownerCandidateChecks: 0, nodeCandidateChecks: 0 }
    if (packed) return graph
    return { owners: [...owners], nodes: [...nodes], edges: [...edges], relations: [...relations], ...(graph.lookupStats ? { lookupStats: graph.lookupStats } : {}) }
  }
  attachRelations(sourceFile, graph, syntax.identifiers, resolveSymbol, instrumentRelationLookup)
  if (packed) return graph
  return { owners: [...owners], nodes: [...nodes], edges: [...edges], relations: [...relations], ...(graph.lookupStats ? { lookupStats: graph.lookupStats } : {}) }
}

export function buildInternalGraph({ file, source, compilerOptions = {}, resolveSymbol, instrumentRelationLookup = false }) {
  const root = path.parse(path.resolve(file)).root
  const project = createRawSemanticProject(root, new Map([[path.relative(root, path.resolve(file)), source]]), { allowJs: true, ...compilerOptions }, null, { loadLibFiles: true })
  const sourceFile = project.getSourceFile(path.resolve(file))
  return graphFromSourceFile(sourceFile, file, collectSyntax(sourceFile), resolveSymbol, false, { instrumentRelationLookup })
}
export function buildInternalGraphFromCollectedSyntax(sourceFile, file, syntax, resolveSymbol, options) { return graphFromSourceFile(sourceFile, file, syntax, resolveSymbol, true, options) }
export function addInternalGraphRelations(sourceFile, graph, identifiers, resolveSymbol) { return attachRelations(sourceFile, graph, identifiers, resolveSymbol) }
