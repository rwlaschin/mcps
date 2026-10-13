import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { GraphStore, encodeInternalPartition, decodeSymbolPartition } from './store.mjs'
import { EDGE_COVERAGE } from './edge-coverage.mjs'
import { ParserApartmentPool } from './parser-apartment-pool.mjs'
import { openPartitionPool, createBatchWriter, persistWorkerPartition } from './semantic-checker-worker.mjs'
import { controlFileHashes } from './source-policy.mjs'
import { createCachedReferenceIndex, updateCachedGraphFacts, cachedUnresolvedEdges, cachedPublicationEdgePatches } from './cached-binding-resolver.mjs'
import { PublicationFacts } from './publication-facts.mjs'

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex')
const grammarPath = new URL('./vendor/tree-sitter-go.wasm', import.meta.url)
const require = createRequire(import.meta.url)
let sharedRuntime

async function initialize(options = {}) {
  const runtimeAsset = options.runtimeAsset ?? path.join(path.dirname(require.resolve('web-tree-sitter')), 'web-tree-sitter.wasm')
  if (!fs.existsSync(runtimeAsset)) throw new Error(`Go runtime missing: ${runtimeAsset}`)
  const grammarAsset = options.grammarAsset ?? grammarPath
  const bytes = fs.readFileSync(grammarAsset)
  const metadata = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).codegraph.goGrammar
  if (hash(bytes) !== metadata.sha256) throw new Error('Go grammar language mismatch or corrupt WASM')
  const { Parser, Language } = await import('web-tree-sitter')
  await Parser.init({ locateFile: () => runtimeAsset })
  const language = await Language.load(bytes)
  const parser = new Parser()
  parser.setLanguage(language)
  return parser
}

const field = (node, name) => node.childForFieldName(name)
const typeName = (text) => /^\*?([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?)$/u.exec(text?.trim() ?? '')?.[1] ?? null
const exported = (name) => /^\p{Lu}/u.test(name)
const UNKNOWN_TYPE = { name: null }
const location = (node) => { const start = node.startPosition; const end = node.endPosition; return { start: node.startIndex, end: node.endIndex, line: start.row + 1, column: start.column + 1, endLine: end.row + 1, endColumn: end.column + 1 } }
const builtin = new Set(['append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover', 'true', 'false', 'nil', 'iota'])

export async function buildGoFileFacts(file, source, parser) {
  if (typeof source !== 'string') throw new TypeError('Go source must be supplied')
  parser ??= await (sharedRuntime ??= initialize())
  const tree = parser.parse(source)
  if (!tree || tree.rootNode.hasError) { tree?.delete(); throw new Error(`invalid Go syntax: ${file}`) }
  let packageNode
  for (const node of tree.rootNode.namedChildren) if (node.type === 'package_clause') { packageNode = node; break }
  const packageName = packageNode?.namedChildren[0]?.text
  if (!packageName) { tree.delete(); throw new Error(`Go package missing: ${file}`) }
  const facts = { file, sourceHash: hash(source), packageName, symbols: [], declarations: [], imports: [], references: [], internal: { file, owners: [], nodes: [], edges: [], relations: [] } }
  const declarationNodes = new Set()
  const declarationsByNode = new Map()
  const cfgNodes = new Map()
  const makeSymbol = (node, name, kind, receiver = '', signature = '') => {
    const qualifiedPath = receiver ? `package:${packageName}/type:${receiver}` : `package:${packageName}`
    const ordinal = name === 'init' ? facts.symbols.length : 0
    const symbol = { id: hash(`${file}\0${qualifiedPath}\0${kind}\0${name}\0${signature}\0${ordinal}`).slice(0, 24), file, name, kind, line: node.startPosition.row + 1, qualifiedPath, signature, ordinal, exported: exported(name) }
    facts.symbols.push(symbol)
    return symbol
  }
  for (const node of tree.rootNode.namedChildren) {
    const type = node.type
    if (type === 'import_declaration') {
      const gather = (n) => {
        if (n.type === 'import_spec') {
          const p = field(n, 'path'); const specifier = p?.text.slice(1, -1)
          const alias = field(n, 'name')?.text ?? null
          facts.imports.push({ specifier, alias }); return
        }
        for (const child of n.namedChildren) gather(child)
      }
      gather(node)
    }
    if (type === 'function_declaration' || type === 'method_declaration') {
      const name = field(node, 'name'); const receiverNode = field(node, 'receiver')
      const receiverDecl = receiverNode?.namedChildren[0]
      const receiverType = field(receiverDecl ?? node, 'type')
      const receiver = typeName(receiverType?.text?.replace(/\[[\s\S]*\]/, '')) ?? (type === 'method_declaration' ? '<unresolved>' : '')
      const result = field(node, 'result')?.text ?? ''
      let resultType = typeName(result)
      for (const parameter of field(node, 'type_parameters')?.namedChildren ?? []) for (const formal of parameter.childrenForFieldName('name')) if (formal.text === resultType) resultType = null
      const signature = `${receiverNode?.text ?? ''}${field(node, 'parameters')?.text ?? ''} ${result}`
      const symbol = makeSymbol(node, name.text, receiver ? 'method' : 'function', receiver, signature)
      declarationNodes.add(name.id)
      declarationsByNode.set(node.id, symbol)
      facts.declarations.push({ key: receiver ? `${receiver}.${name.text}` : name.text, symbol, result: resultType, interface: false })
    }
    if (type === 'type_declaration' || type === 'var_declaration' || type === 'const_declaration') {
      for (const spec of node.namedChildren) {
        if (!['type_spec', 'type_alias', 'var_spec', 'const_spec'].includes(spec.type)) continue
        const names = spec.childrenForFieldName('name'); if (!names.length) continue
        const specType = field(spec, 'type')
        const kind = type === 'type_declaration' ? specType?.type === 'interface_type' ? 'interface' : 'type' : 'variable'
        for (const name of names) { const symbol = makeSymbol(spec, name.text, kind, '', specType?.text ?? ''); declarationNodes.add(name.id); facts.declarations.push({ key: name.text, symbol, result: null, interface: kind === 'interface' }) }
      }
    }
  }
  const importByName = new Map()
  for (const item of facts.imports) if (item.alias) importByName.set(item.alias, item.specifier)
  const typeExpression = (node, scope) => {
    if (!node) return null
    const type = node.type
    if (type === 'identifier' || type === 'type_identifier') { const name = node.text; const bound = lookup(scope, name); return bound ? bound.type ?? UNKNOWN_TYPE : { name } }
    if (type === 'selector_expression') {
      const operand = field(node, 'operand'); const name = field(node, 'field')?.text
      const bound = lookup(scope, operand?.text)
      if (operand?.type === 'identifier' && !bound && importByName.has(operand.text)) return { name, specifier: importByName.get(operand.text), qualifier: operand.text }
      if (operand?.type === 'identifier' && !bound) return { name, qualifier: operand.text }
      return null
    }
    if (type === 'pointer_type' || type === 'unary_expression') return typeExpression(node.namedChildren[node.namedChildCount - 1], scope)
    if (type === 'composite_literal') return typeExpression(field(node, 'type'), scope)
    if (type === 'call_expression') {
      const fn = field(node, 'function')
      const candidate = typeExpression(fn, scope)
      return candidate ? { ...candidate, returned: true } : null
    }
    if (type === 'qualified_type') { const children = node.namedChildren; return { name: field(node, 'name')?.text ?? children[1]?.text, specifier: importByName.get(children[0]?.text) } }
    return null
  }
  const lookup = (scope, name) => { for (let s = scope; s; s = s.parent) if (s.values.has(name)) return s.values.get(name); return null }
  const walk = (node, scope, owner, nesting = 0) => {
    const type = node.type
    if (owner && ['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement'].includes(type)) { nesting += 1; if (nesting > owner.nestingDepth) owner.nestingDepth = nesting }
    if (['block', 'if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'communication_case', 'expression_case', 'type_case'].includes(type)) scope = { parent: scope, values: new Map() }
    if (type === 'function_declaration' || type === 'method_declaration' || type === 'func_literal') {
      scope = { parent: scope, values: new Map() }
      const name = field(node, 'name')?.text ?? '<anonymous>'
      const symbol = declarationsByNode.get(node.id)
      const id = facts.internal.owners.length
      const position = location(node)
      owner = { id, symbolId: symbol?.id, fromSymbolId: symbol?.id ?? owner?.fromSymbolId, parentOwnerId: owner?.id ?? null, kind: type === 'method_declaration' ? 'method' : 'function', name, file, ...position, entryNodeId: 0, exitNodeId: 0, cyclomatic: 1, branchCount: 0, nestingDepth: 0, firstNode: facts.internal.nodes.length, nodeCount: 0 }
      facts.internal.owners.push(owner)
      owner.entryNodeId = facts.internal.nodes.length
      facts.internal.nodes.push({ id: owner.entryNodeId, ownerId: id, kind: 'entry', ...position })
      const bindParameters = (group) => { if (!group) return; for (const p of group.namedChildren) { const t = typeExpression(field(p, 'type'), scope); for (const child of p.namedChildren) if (child.type === 'identifier') { declarationNodes.add(child.id); scope.values.set(child.text, { type: t }) } } }
      for (const parameter of field(node, 'type_parameters')?.namedChildren ?? []) for (const formal of parameter.childrenForFieldName('name')) { declarationNodes.add(formal.id); scope.values.set(formal.text, { type: UNKNOWN_TYPE }) }
      bindParameters(field(node, 'parameters')); bindParameters(field(node, 'receiver'))
      const result = field(node, 'result')
      if (result?.type === 'parameter_list') bindParameters(result)
      for (const child of node.namedChildren) if (child.type !== 'identifier') walk(child, scope, owner, nesting)
      owner.exitNodeId = facts.internal.nodes.length
      facts.internal.nodes.push({ id: owner.exitNodeId, ownerId: id, kind: 'exit', ...position })
      buildFlow(owner, facts.internal, field(node, 'body'), cfgNodes)
      return
    }
    if (['short_var_declaration', 'var_spec', 'const_spec', 'range_clause'].includes(type)) {
      if (owner) { const row = { id: facts.internal.nodes.length, ownerId: owner.id, kind: 'assignment', ...location(node) }; facts.internal.nodes.push(row); cfgNodes.set(node.id, row) }
      const left = field(node, 'left') ?? field(node, 'name')
      const right = field(node, 'right') ?? field(node, 'value')
      if (right) walk(right, scope, owner, nesting)
      const names = type === 'var_spec' || type === 'const_spec' ? node.childrenForFieldName('name') : left?.type === 'identifier' ? [left] : left?.namedChildren ?? []
      const values = right?.type === 'expression_list' ? right.namedChildren : right ? [right] : []
      const declaredType = field(node, 'type')
      for (let i = 0; i < names.length; i += 1) if (names[i].type === 'identifier') { declarationNodes.add(names[i].id); scope.values.set(names[i].text, { type: typeExpression(declaredType, scope) ?? typeExpression(values[i], scope) }) }
      return
    }
    let internalNode
    if (owner) {
      const kind = { if_statement: 'condition', for_statement: 'loop', expression_switch_statement: 'condition', type_switch_statement: 'condition', select_statement: 'condition', expression_case: 'case', type_case: 'case', communication_case: 'case', default_case: 'case', call_expression: 'call', return_statement: 'return', break_statement: 'break', continue_statement: 'continue', assignment_statement: 'assignment', inc_statement: 'assignment', dec_statement: 'assignment', short_var_declaration: 'assignment', go_statement: 'statement', defer_statement: 'statement', goto_statement: 'statement', fallthrough_statement: 'statement', labeled_statement: 'statement' }[type] ?? (type === 'binary_expression' && /^(\&\&|\|\|)$/.test(field(node, 'operator')?.text ?? '') ? 'condition' : null)
      if (kind) {
        internalNode = { id: facts.internal.nodes.length, ownerId: owner.id, kind, ...location(node), syntax: type, text: type === 'goto_statement' || type === 'labeled_statement' ? node.namedChildren[0]?.text : null }
        facts.internal.nodes.push(internalNode)
        cfgNodes.set(node.id, internalNode)
      }
    }
    if (owner && !declarationNodes.has(node.id)) {
      if (type === 'selector_expression') {
        const operand = field(node, 'operand'); const member = field(node, 'field')
        const local = operand?.type === 'identifier' ? lookup(scope, operand.text) : null
        const specifier = !local && operand?.type === 'identifier' ? importByName.get(operand.text) : null
        const receiver = specifier ? null : typeExpression(operand, scope) ?? UNKNOWN_TYPE
        const parent = node.parent
        const call = parent?.type === 'call_expression' && field(parent, 'function')?.id === node.id
        facts.references.push({ from: owner.fromSymbolId, line: member.startPosition.row + 1, call, name: member.text, specifier, qualifier: !local && operand?.type === 'identifier' ? operand.text : null, receiver, nodeId: internalNode?.id ?? facts.internal.nodes.length - 1, ownerId: owner.id })
        if (operand) walk(operand, scope, owner, nesting)
        return
      }
      if (type === 'identifier' || type === 'type_identifier') {
        const name = node.text
        if (!builtin.has(name) && !lookup(scope, name) && !importByName.has(name)) {
          const parent = node.parent
          const parentType = parent?.type
          if (!['package_clause', 'import_spec', 'parameter_declaration', 'field_declaration', 'labeled_statement', 'goto_statement'].includes(parentType)) {
            const call = parentType === 'call_expression' && field(parent, 'function')?.id === node.id
            facts.references.push({ from: owner.fromSymbolId, line: node.startPosition.row + 1, call, name, specifier: null, receiver: null, nodeId: internalNode?.id ?? facts.internal.nodes.length - 1, ownerId: owner.id })
          }
        }
      }
    }
    for (const child of node.namedChildren) walk(child, scope, owner, nesting)
  }
  try { walk(tree.rootNode, { parent: null, values: new Map() }, null); return facts } finally { tree.delete() }
}

function buildFlow(owner, graph, body, nodes) {
  const edgeStart = graph.edges.length
  const edgeKeys = new Set()
  const add = (from, to, kind = 'next') => { const key = `${from}:${to}:${kind}`; if (!edgeKeys.has(key)) { edgeKeys.add(key); graph.edges.push({ ownerId: owner.id, from, to, kind }) } }
  const link = (incoming, to) => { for (const predecessor of incoming) add(predecessor.id, to, predecessor.kind) }
  const end = (id, kind = 'next') => [{ id, kind }]
  const labels = new Map(); const pendingGotos = []
  const sequence = (children, incoming, context) => { let exits = incoming; for (const child of children) exits = flow(child, exits, context); return exits }
  const flow = (node, incoming, context = {}) => {
    if (!node) return incoming
    const type = node.type
    if (type === 'func_literal') return incoming
    const row = nodes.get(node.id)
    if (row && row.ownerId !== owner.id) return incoming
    if (type === 'block' || type === 'statement_list') return sequence(node.namedChildren, incoming, context)
    if (type === 'if_statement') {
      let exits = flow(field(node, 'initializer'), incoming, context)
      exits = flow(field(node, 'condition'), exits, context)
      link(exits, row.id)
      const consequent = flow(field(node, 'consequence'), end(row.id, 'true'), context)
      const alternate = field(node, 'alternative')
      const other = alternate ? flow(alternate, end(row.id, 'false'), context) : end(row.id, 'false')
      return [...consequent, ...other]
    }
    if (type === 'for_statement') {
      let exits = incoming
      let clause
      for (const child of node.namedChildren) { const childType = child.type; if (childType === 'for_clause' || childType === 'range_clause') { clause = child; break } }
      const clauseType = clause?.type
      if (clauseType === 'for_clause') exits = flow(field(clause, 'initializer'), exits, context)
      else if (clause) exits = flow(clause, exits, context)
      link(exits, row.id)
      const breaks = []; const continues = []
      let tail = flow(field(node, 'body'), end(row.id, 'true'), { ...context, breaks, continues })
      if (clauseType === 'for_clause') tail = flow(field(clause, 'update'), [...tail, ...continues], context)
      else tail = [...tail, ...continues]
      for (const item of tail) add(item.id, row.id, item.kind === 'continue' ? 'continue' : 'back')
      const hasCondition = clauseType === 'range_clause' || clauseType === 'for_clause' && field(clause, 'condition') || !clause && node.namedChildren.some(child => child.type !== 'block')
      return hasCondition ? [...end(row.id, 'false'), ...breaks] : breaks
    }
    if (['expression_switch_statement', 'type_switch_statement', 'select_statement'].includes(type)) {
      link(incoming, row.id)
      const cases = []
      for (const child of node.namedChildren) if (['expression_case', 'type_case', 'communication_case', 'default_case'].includes(child.type)) cases.push(child)
      const breaks = []; const tails = []; let falls = []
      for (const clause of cases) {
        const caseRow = nodes.get(clause.id)
        const kind = clause.type === 'default_case' ? 'default' : 'case'
        link([...end(row.id, kind), ...falls], caseRow.id)
        falls = []
        const result = sequence(clause.namedChildren, end(caseRow.id), { ...context, breaks, falls })
        for (const item of result) tails.push(item)
      }
      if (!cases.some(clause => clause.type === 'default_case')) tails.push(...end(row.id, 'false'))
      return [...tails, ...breaks]
    }
    if (type === 'labeled_statement') {
      labels.set(node.namedChildren[0]?.text, row.id)
      link(incoming, row.id)
      let exits = end(row.id)
      const childCount = node.namedChildCount
      for (let index = 1; index < childCount; index += 1) exits = flow(node.namedChild(index), exits, context)
      return exits
    }
    if (type === 'goto_statement') { link(incoming, row.id); pendingGotos.push({ from: row.id, label: node.namedChildren[0]?.text }); return [] }
    if (type === 'break_statement' || type === 'continue_statement' || type === 'fallthrough_statement') {
      link(incoming, row.id)
      const bucket = type === 'break_statement' ? context.breaks : type === 'continue_statement' ? context.continues : context.falls
      if (bucket) bucket.push({ id: row.id, kind: type === 'break_statement' ? 'break' : type === 'continue_statement' ? 'continue' : 'next' })
      return []
    }
    if (type === 'binary_expression' && row?.kind === 'condition') {
      const left = flow(field(node, 'left'), incoming, context); link(left, row.id)
      const operator = field(node, 'operator')?.text
      const right = flow(field(node, 'right'), end(row.id, operator === '&&' ? 'true' : 'false'), context)
      return [...right, ...end(row.id, operator === '&&' ? 'false' : 'true')]
    }
    const exits = sequence(node.namedChildren, incoming, context)
    if (!row) return exits
    link(exits, row.id)
    if (row.kind === 'return') { add(row.id, owner.exitNodeId, 'return'); return [] }
    if (row.kind === 'call' && field(node, 'function')?.text === 'panic') { add(row.id, owner.exitNodeId, 'throw'); return [] }
    return end(row.id)
  }
  const exits = flow(body, end(owner.entryNodeId))
  link(exits, owner.exitNodeId)
  for (const jump of pendingGotos) if (labels.has(jump.label)) add(jump.from, labels.get(jump.label))
  const outgoing = new Map()
  for (let edgeIndex = edgeStart; edgeIndex < graph.edges.length; edgeIndex += 1) { const edge = graph.edges[edgeIndex]; if (edge.ownerId === owner.id) { let bucket = outgoing.get(edge.from); if (!bucket) outgoing.set(edge.from, bucket = new Set()); bucket.add(edge.to) } }
  const reachable = new Set([owner.entryNodeId]); const pending = [owner.entryNodeId]
  while (pending.length) for (const id of outgoing.get(pending.pop()) ?? []) if (!reachable.has(id)) { reachable.add(id); pending.push(id) }
  let reachableEdges = 0
  for (let edgeIndex = edgeStart; edgeIndex < graph.edges.length; edgeIndex += 1) { const edge = graph.edges[edgeIndex]; if (edge.ownerId === owner.id && reachable.has(edge.from) && reachable.has(edge.to)) reachableEdges += 1 }
  owner.cyclomatic = Math.max(1, reachableEdges - reachable.size + 2)
  owner.branchCount = 0
  for (const [from, targets] of outgoing) if (reachable.has(from) && targets.size > 1) owner.branchCount += 1
  owner.nodeCount = 0
  for (let i = owner.firstNode; i <= owner.exitNodeId; i += 1) if (graph.nodes[i].ownerId === owner.id) { graph.nodes[i].unreachable = !reachable.has(i); owner.nodeCount += 1 }
}

const packageKey = (file) => path.posix.dirname(file)
const acceptsGoSource = (source) => !/^\s*\/\/(?:go:build|\s*\+build)\b/m.test(source.split(/\bpackage\s/)[0]) && !/\bimport\s*(?:"C"|\([\s\S]*?(?:^|\n)\s*(?:[\w.]+\s+)?"C")/m.test(source)

class GoSemanticWorker {
  constructor(root, options) {
    this.root = root; this.options = options; this.parser = null; this.closed = false; this.pool = null; this.operation = 0
    this.facts = new Map(); this.partitions = new Map(); this.names = new Map(); this.packages = new Map(); this.directoryPackages = new Map(); this.subscribers = new Map(); this.entries = new Map(); this.baseGeneration = null
  }
  runtimeState() { return { initialized: Boolean(this.parser), parserCount: this.parser ? 1 : 0, disposed: this.closed } }
  async prepare() {
    if (this.closed) throw new Error('Go analyzer disposed')
    if (!this.parser) this.parser = await initialize(this.options)
    const baseExecArgv = []
    for (const argument of process.execArgv) if (argument.startsWith('--cpu-prof') || argument.startsWith('--heap-prof')) baseExecArgv.push(argument)
    if (!this.pool) this.pool = new ParserApartmentPool(this.root, { workerURL: new URL('./go-parser-worker.mjs', import.meta.url), baseExecArgv, workerCount: this.options.structuralCount, timeoutMs: baseExecArgv.length ? 0 : undefined, parseSource: ({ file, source }) => buildGoFileFacts(file, source, this.parser) })
  }
  modulePaths() {
    this.modules = new Map()
    const mod = path.join(this.root, 'go.mod')
    if (fs.existsSync(mod)) { const name = /^module\s+(\S+)/m.exec(fs.readFileSync(mod, 'utf8'))?.[1]; if (name) this.modules.set(name, '.') }
    const work = path.join(this.root, 'go.work')
    if (fs.existsSync(work)) {
      const text = fs.readFileSync(work, 'utf8')
      const uses = /\buse\s*\(([\s\S]*?)\)/m.exec(text)?.[1] ?? /\buse\s+([^\n]+)/m.exec(text)?.[1] ?? ''
      for (const raw of uses.split(/\r?\n/)) { const directory = raw.trim().replace(/^"|"$/g, ''); if (!directory || directory.startsWith('//')) continue; const target = path.resolve(this.root, directory, 'go.mod'); if (fs.existsSync(target)) { const name = /^module\s+(\S+)/m.exec(fs.readFileSync(target, 'utf8'))?.[1]; if (name) this.modules.set(name, path.relative(this.root, path.dirname(target)).split(path.sep).join('/') || '.') } }
    }
  }
  importDirectory(specifier) {
    for (const [name, directory] of this.modules) if (specifier === name || specifier.startsWith(`${name}/`)) return path.posix.normalize(path.posix.join(directory, specifier.slice(name.length)))
    return null
  }
  importPackage(specifier) {
    const directory = this.importDirectory(specifier)
    const names = this.directoryPackages.get(directory)
    let result = null
    for (const name of names ?? []) if (!name.endsWith('_test')) { if (result !== null) return null; result = `${directory}\0${name}` }
    return result
  }
  namespace(facts) { return `${packageKey(facts.file)}\0${facts.packageName}` }
  qualifierImport(file, qualifier) {
    let result = null
    for (const imported of this.facts.get(file)?.imports ?? []) {
      const pkg = this.importPackage(imported.specifier)
      const name = pkg?.slice(pkg.lastIndexOf('\0') + 1)
      if (imported.alias === qualifier || imported.alias === null && name === qualifier) { if (result !== null) return null; result = imported.specifier }
    }
    return result
  }
  key(pkg, name) { return `${pkg}\0${name}` }
  register(facts, remove = false) {
    const pkg = this.namespace(facts)
    if (!remove) { const directory = packageKey(facts.file); let names = this.directoryPackages.get(directory); if (!names) this.directoryPackages.set(directory, names = new Set()); names.add(facts.packageName) }
    let files = this.packages.get(pkg)
    if (!files && !remove) this.packages.set(pkg, files = new Set())
    if (remove) { files?.delete(facts.file); if (!files?.size) { this.packages.delete(pkg); const names = this.directoryPackages.get(packageKey(facts.file)); names?.delete(facts.packageName); if (!names?.size) this.directoryPackages.delete(packageKey(facts.file)) } } else files.add(facts.file)
    for (const declaration of facts.declarations) {
      const key = this.key(pkg, declaration.key)
      let bucket = this.names.get(key)
      if (!bucket && !remove) this.names.set(key, bucket = new Map())
      if (remove) { bucket?.delete(declaration.symbol.id); if (!bucket?.size) this.names.delete(key) }
      else bucket.set(declaration.symbol.id, declaration)
    }
  }
  single(pkg, name, external = false) {
    const bucket = this.names.get(this.key(pkg, name))
    if (bucket?.size !== 1) return null
    const declaration = bucket.values().next().value
    return external && !declaration.symbol.exported ? null : declaration
  }
  resolve(file, reference, dependencies) {
    const qualifierSpecifier = reference.qualifier ? this.qualifierImport(file, reference.qualifier) : null
    const referenceSpecifier = reference.specifier ?? qualifierSpecifier
    let pkg = referenceSpecifier ? this.importPackage(referenceSpecifier) : this.namespace(this.facts.get(file))
    let name = reference.name
    let external = Boolean(referenceSpecifier)
    if (referenceSpecifier) dependencies.add(`\0package\0${this.importDirectory(referenceSpecifier)}`)
    const remember = (p, n) => { const key = this.key(p, n); dependencies.add(key); return this.single(p, n, external) }
    if (reference.receiver && !qualifierSpecifier) {
      const receiver = reference.receiver
      const receiverSpecifier = receiver.specifier ?? (receiver.qualifier ? this.qualifierImport(file, receiver.qualifier) : null)
      pkg = receiverSpecifier ? this.importPackage(receiverSpecifier) : this.namespace(this.facts.get(file))
      if (receiverSpecifier) dependencies.add(`\0package\0${this.importDirectory(receiverSpecifier)}`)
      external = Boolean(receiverSpecifier)
      if (pkg === null || !receiver.name) return null
      let receiverName = receiver.name
      if (receiver.returned) {
        const constructor = remember(pkg, receiverName)
        if (!constructor?.result) return null
        receiverName = constructor.result
      }
      let declaredType = remember(pkg, receiverName)
      if (declaredType?.symbol.kind === 'variable') {
        receiverName = typeName(declaredType.symbol.signature)
        if (!receiverName) return null
        declaredType = remember(pkg, receiverName)
      }
      if (!declaredType || declaredType.interface) return null
      name = `${receiverName}.${reference.name}`
    }
    if (pkg === null) return null
    const result = remember(pkg, name)
    if (result || referenceSpecifier || reference.receiver) return result
    let dotted = null
    for (const imported of this.facts.get(file)?.imports ?? []) if (imported.alias === '.') {
      const p = this.importPackage(imported.specifier); if (p === null) continue
      const key = this.key(p, name); dependencies.add(key)
      const candidate = this.single(p, name, true)
      if (candidate) { if (dotted) return null; dotted = candidate }
    }
    return dotted
  }
  unsubscribe(entry) { for (const key of entry.dependencies) { const bucket = this.subscribers.get(key); bucket?.delete(entry); if (!bucket?.size) this.subscribers.delete(key) } }
  subscribe(entry) { for (const key of entry.dependencies) { let bucket = this.subscribers.get(key); if (!bucket) this.subscribers.set(key, bucket = new Set()); bucket.add(entry) } }
  materialize(facts) {
    const partition = { file: facts.file, sourceHash: facts.sourceHash, symbols: facts.symbols, edges: [], dependencies: [], unresolved: [], bindings: [], references: [] }
    for (const declaration of facts.declarations) partition.bindings.push({ kind: 'symbol', name: declaration.key, target: declaration.symbol.id, remote: JSON.stringify({ go: true, result: declaration.result, interface: declaration.interface }) })
    const dependentFiles = new Set()
    for (const imported of facts.imports) {
      const pkg = this.importPackage(imported.specifier)
      if (!pkg || !this.packages.has(pkg)) partition.unresolved.push({ specifier: imported.specifier, candidates: [] })
      else for (const file of this.packages.get(pkg)) if (file !== facts.file) dependentFiles.add(file)
      partition.bindings.push({ kind: 'namespace', name: imported.alias ?? '', specifier: imported.specifier })
    }
    const entries = []
    for (let ordinal = 0; ordinal < facts.references.length; ordinal += 1) {
      const reference = facts.references[ordinal]
      if (!reference.from) continue
      const entry = { file: facts.file, ordinal: partition.references.length, reference, dependencies: new Set(), edge: null, base: null }
      const target = this.resolve(facts.file, reference, entry.dependencies)
      if (target) {
        entry.edge = { from: reference.from, to: target.symbol.id, line: reference.line, call: reference.call }; entry.base = entry.edge
        partition.edges.push(entry.edge)
        if (target.symbol.file !== facts.file) dependentFiles.add(target.symbol.file)
        facts.internal.relations.push({ ownerId: reference.ownerId, fromNode: reference.nodeId, targetSymbolId: target.symbol.id, kind: reference.call ? 'call' : 'read' })
      } else partition.unresolved.push({ specifier: `${reference.specifier ?? facts.packageName}:${reference.name}`, candidates: [] })
      partition.references.push({ from: reference.from, specifier: 'go', remote: JSON.stringify({ ...reference, baseTo: entry.base?.to ?? null }), namespace: false, property: null, line: reference.line, call: reference.call })
      entries.push(entry); this.subscribe(entry)
    }
    for (const file of dependentFiles) partition.dependencies.push(file)
    this.entries.set(facts.file, entries)
    partition.internalFingerprint = hash(`go\0${facts.sourceHash}`)
    partition.internalPartition = encodeInternalPartition({ compilerFingerprint: partition.internalFingerprint, ...facts.internal })
    this.partitions.set(facts.file, partition)
    return partition
  }
  async parseSources(sources) {
    await this.prepare()
    this.operation += 1
    const pending = []
    for (const [file, source] of sources) pending.push(this.pool.parse({ mode: 'structural', path: file, fileId: file, revision: this.operation, source }))
    return Promise.all(pending)
  }
  transport(request, partitions, onProgress, metadata) {
    if (!request.partitionPool) return { ...metadata, partitions: Object.fromEntries(partitions) }
    const pool = openPartitionPool(request.partitionPool)
    const summary = { completedFiles: partitions.size, remainingFiles: 0, maximumTraversalsPerFile: partitions.size ? 1 : 0 }
    const diagnostics = { recordsAttempted: 0, recordsStreamed: 0, recordsPersisted: 0, bytesCopied: 0, wraparounds: 0, capacityFailures: 0, transportMs: 0, parseMs: metadata.parseMs ?? 0, structuralJobsDispatched: partitions.size, structuralWorkersUsed: this.pool?.workers.length ?? 0 }
    const batches = createBatchWriter(++this.operation, pool, summary, diagnostics, onProgress)
    const receipts = []; let ordinal = 0; let store
    for (const [file, partition] of partitions) {
      const { internalPartition, internalFingerprint, ...symbolPartition } = partition
      const streamed = batches.writePartition(file, ordinal++, symbolPartition, internalPartition)
      if (streamed) receipts.push({ file, sourceHash: partition.sourceHash, writer: 'engine', serializedLength: streamed.symbolLength + streamed.internalLength, chunkCount: 1, symbolLength: streamed.symbolLength, internalLength: streamed.internalLength, symbolChunkCount: 1, internalChunkCount: 0, internalFingerprint })
      else { store ??= new GraphStore(request.root, request.cacheDir); receipts.push(persistWorkerPartition(store, file, partition.sourceHash, symbolPartition, internalPartition, internalFingerprint)); diagnostics.recordsPersisted += 1 }
    }
    batches.flush(true)
    return { ...metadata, partitionReceipts: receipts, poolDiagnostics: diagnostics, semanticTraversalSummary: summary }
  }
  async index(request, onProgress) {
    if (this.closed) throw new Error('Go analyzer disposed')
    const started = performance.now()
    const parsed = request.sources.length ? await this.parseSources(request.sources) : []
    this.facts.clear(); this.partitions.clear(); this.names.clear(); this.packages.clear(); this.directoryPackages.clear(); this.entries.clear(); this.subscribers.clear()
    this.modulePaths()
    for (const facts of parsed) { this.facts.set(facts.file, facts); this.register(facts) }
    for (const facts of parsed) this.materialize(facts)
    this.graphIndex = createCachedReferenceIndex(this.partitions, [], true)
    this.publicationFacts = new PublicationFacts({ unresolvedEdges: cachedUnresolvedEdges(this.graphIndex), edgePatches: cachedPublicationEdgePatches(this.graphIndex), rawUnresolvedBeforeCount: this.graphIndex.unresolved.length })
    this.baseGeneration = request.generation ?? null
    this.sourceBlobs = { ...request.sourceBlobs }
    return this.transport(request, this.partitions, onProgress, { mode: 'full', sourceBlobs: this.sourceBlobs, parseMs: performance.now() - started })
  }
  async hydrate(request) {
    if (this.closed) throw new Error('Go analyzer disposed')
    this.modulePaths()
    this.facts.clear(); this.partitions.clear(); this.names.clear(); this.packages.clear(); this.directoryPackages.clear(); this.entries.clear(); this.subscribers.clear()
    for (const [file, partition] of Object.entries(request.partitions)) {
      const packageName = /^package:([^/]+)/.exec(partition.symbols[0]?.qualifiedPath ?? '')?.[1] ?? path.posix.basename(packageKey(file))
      const facts = { file, packageName, sourceHash: partition.sourceHash, symbols: partition.symbols, declarations: [], imports: [], references: [] }
      const symbolsById = new Map()
      for (const symbol of partition.symbols) symbolsById.set(symbol.id, symbol)
      for (const binding of partition.bindings ?? []) {
        if (binding.kind === 'namespace') facts.imports.push({ specifier: binding.specifier, alias: binding.name || null })
        else if (binding.kind === 'symbol') { const meta = JSON.parse(binding.remote ?? '{}'); const symbol = symbolsById.get(binding.target); if (symbol) facts.declarations.push({ key: binding.name, symbol, result: meta.result, interface: meta.interface }) }
      }
      for (const reference of partition.references ?? []) if (reference.specifier === 'go') facts.references.push(JSON.parse(reference.remote))
      this.facts.set(file, facts); this.partitions.set(file, partition); this.register(facts)
    }
    const patches = new Map()
    for (const patch of request.edgePatches ?? []) patches.set(patch.key, patch)
    for (const [file, facts] of this.facts) {
      const entries = []
      const edgesByKey = new Map()
      for (const edge of this.partitions.get(file).edges) edgesByKey.set(`${edge.from}\0${edge.to}\0${edge.line}\0${edge.call}`, edge)
      for (let ordinal = 0; ordinal < facts.references.length; ordinal += 1) {
        const reference = facts.references[ordinal]; const entry = { file, ordinal, reference, dependencies: new Set(), edge: null, base: null }
        const target = this.resolve(file, reference, entry.dependencies)
        const base = reference.baseTo ? edgesByKey.get(`${reference.from}\0${reference.baseTo}\0${reference.line}\0${reference.call}`) : null
        entry.base = base ?? null; entry.edge = patches.get(`${file}\0${ordinal}`)?.edge ?? (target ? { from: reference.from, to: target.symbol.id, line: reference.line, call: reference.call } : null)
        entries.push(entry); this.subscribe(entry)
      }
      this.entries.set(file, entries)
    }
    this.graphIndex = createCachedReferenceIndex(this.partitions, request.edgePatches, true)
    this.publicationFacts = new PublicationFacts({ unresolvedEdges: cachedUnresolvedEdges(this.graphIndex), edgePatches: cachedPublicationEdgePatches(this.graphIndex), rawUnresolvedBeforeCount: this.graphIndex.unresolved.length })
    this.sourceBlobs = { ...request.sourceBlobs }; this.baseGeneration = request.generation
    return { mode: 'full', sourceBlobs: this.sourceBlobs, partitions: Object.fromEntries(this.partitions) }
  }
  async validate(request, onProgress) {
    if (this.closed) throw new Error('Go analyzer disposed')
    if (request.basePartitionIds) {
      const partitions = {}
      for (const [file, id] of Object.entries(request.basePartitionIds)) partitions[file] = decodeSymbolPartition(fs.readFileSync(path.join(request.partitionDir, `${id}.bin`)))
      await this.hydrate({ ...request, partitions, generation: request.baseGeneration, sourceBlobs: request.baseSourceBlobs, edgePatches: request.baseEdgePatches })
    }
    if (this.baseGeneration !== request.baseGeneration) throw new Error('Go generation mismatch')
    const changes = request.changes ?? []
    const sources = []
    for (const change of changes) if (change.type !== 'unlink') {
      let source = change.source
      if (typeof source !== 'string') { const id = change.contentDigest ?? change.sourceHash ?? change.hash; if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid Go source blob id'); source = fs.readFileSync(path.join(request.sourceDir, id), 'utf8'); if (hash(source) !== id) throw new Error('Go source blob digest mismatch') }
      sources.push([change.path, source])
    }
    const started = performance.now(); const parsed = sources.length ? await this.parseSources(sources) : []
    if (sources.length) { const store = new GraphStore(request.root, request.cacheDir); for (const [, source] of sources) store.writeSource(source) }
    const parsedByFile = new Map()
    for (const facts of parsed) parsedByFile.set(facts.file, facts)
    const partitions = new Map(); const sourceBlobs = {}; const tombstones = []; const repairs = []; const groups = []; const touched = new Set()
    const rawUnresolvedBeforeCount = this.graphIndex.unresolved.length
    for (const change of changes) {
      const previous = this.facts.get(change.path); const next = parsedByFile.get(change.path)
      if (!previous || !next || previous.packageName !== next.packageName) for (const entry of this.subscribers.get(`\0package\0${packageKey(change.path)}`) ?? []) if (entry.file !== change.path) touched.add(entry)
      const previousDeclarations = new Map(); const nextDeclarations = new Map()
      for (const declaration of previous?.declarations ?? []) previousDeclarations.set(declaration.key, declaration)
      for (const declaration of next?.declarations ?? []) nextDeclarations.set(declaration.key, declaration)
      const changedDeclaration = (before, after) => !before || !after || before.symbol.id !== after.symbol.id || before.result !== after.result || before.interface !== after.interface || previous.packageName !== next.packageName
      for (const [key, declaration] of previousDeclarations) if (changedDeclaration(declaration, nextDeclarations.get(key))) for (const entry of this.subscribers.get(this.key(this.namespace(previous), key)) ?? []) if (entry.file !== change.path) touched.add(entry)
      for (const [key, declaration] of nextDeclarations) if (changedDeclaration(previousDeclarations.get(key), declaration)) for (const entry of this.subscribers.get(this.key(this.namespace(next), key)) ?? []) if (entry.file !== change.path) touched.add(entry)
      for (const entry of this.entries.get(change.path) ?? []) this.unsubscribe(entry)
      this.entries.delete(change.path)
      if (previous) this.register(previous, true)
      if (next) { this.facts.set(change.path, next); this.register(next); partitions.set(change.path, this.materialize(next)); sourceBlobs[change.path] = next.sourceHash; this.sourceBlobs[change.path] = next.sourceHash }
      else { this.facts.delete(change.path); this.partitions.delete(change.path); delete this.sourceBlobs[change.path]; tombstones.push(change.path) }
      const changedRepairs = []
      for (const entry of touched) {
        this.unsubscribe(entry); entry.dependencies.clear()
        const target = this.resolve(entry.file, entry.reference, entry.dependencies)
        const edge = target ? { from: entry.reference.from, to: target.symbol.id, line: entry.reference.line, call: entry.reference.call } : null
        this.subscribe(entry)
        if (entry.edge?.to !== edge?.to) { const repair = { key: `${entry.file}\0${entry.ordinal}`, file: entry.file, base: entry.base, edge }; repairs.push(repair); changedRepairs.push(repair); entry.edge = edge }
      }
      const publication = updateCachedGraphFacts(this.graphIndex, this.partitions, change.path, changedRepairs)
      this.publicationFacts.apply({ publicationChanges: publication, edgePatches: changedRepairs }, change.path)
      for (const group of publication.groups) groups.push(group)
    }
    const workCounters = { changedSourcesParsed: parsed.length, dependentSourcesRead: 0, dependentSourcesParsed: 0, dependentSourcesValidated: 0, rebuiltPartitionCount: parsed.length, cachedReferencesVisited: touched.size }
    const result = { mode: 'delta', revision: request.revision, baseGeneration: request.baseGeneration, sourceBlobs, tombstones, edgePatches: repairs, publicationChanges: { groups, rawUnresolvedBeforeCount }, workCounters, internalBuildCount: parsed.length, internalRebuiltFiles: [...partitions.keys()], internalReusedFiles: [], parseMs: performance.now() - started }
    result.unresolvedEdges = this.publicationFacts.publication.unresolved
    result.publicationEdgePatches = this.publicationFacts.publication.patches
    return this.transport(request, partitions, onProgress, result)
  }
  advanceGeneration(expectedGeneration, generation) { if (this.baseGeneration !== expectedGeneration) throw new Error('Go generation acknowledgement mismatch'); this.baseGeneration = generation; return { generation } }
  referenceOverlay(request) { const files = {}; for (const file of request.staleFiles ?? []) { const edges = []; for (const entry of this.entries.get(file) ?? []) if (entry.edge && !entry.edge.call) edges.push(entry.edge); files[file] = { edges } } return { generation: request.generation, files } }
  async dispose() { if (this.closed) return; this.closed = true; this.parser?.delete(); this.parser = null; await this.pool?.dispose(); this.pool = null; this.facts.clear(); this.partitions.clear(); this.names.clear(); this.subscribers.clear(); this.entries.clear(); this.packages.clear() }
}

export function createGoLanguageAnalyzer(root, options = {}) {
  return {
    id: 'go', extensions: ['.go'], controlFiles: ['go.mod', 'go.work', 'go.sum'], cacheKey: 'go-tree-sitter-1', sourceMembership: true,
    createSourceMatcher(analyzerRoot = root) { return { isSourceRelative: (file) => file.endsWith('.go'), acceptsSource(file, source = fs.readFileSync(path.resolve(analyzerRoot, file), 'utf8')) { return acceptsGoSource(source) } } },
    createSemanticWorker: (workerOptions = {}) => new GoSemanticWorker(root, { ...options, ...workerOptions }),
    createProvisionalResolver() { let current = new Map(); let revision = 0; return { async stageChanges(changes) { return { changes, baseRevision: revision, consumed: false } }, async stageFileChanges(changes) { return this.stageChanges(changes) }, commit(staged) { if (staged.consumed || staged.baseRevision !== revision) throw new Error('stale Go resolver stage'); staged.consumed = true; for (const change of staged.changes) { if (change.type === 'unlink') current.delete(change.path); else current.set(change.path, change.source) } revision += 1; return { parsedFiles: [] } }, discard(staged) { if (staged.consumed) throw new Error('consumed Go resolver stage'); staged.consumed = true }, snapshot: () => ({ revision, files: current }), dispose: () => current.clear() } },
    cacheInputs: (analyzerRoot = root) => controlFileHashes(analyzerRoot, { controlFiles: ['go.mod', 'go.work', 'go.sum'] }),
    invalidate: (file) => file.endsWith('.go') || file === 'go.mod' || file === 'go.work' || file === 'go.sum',
  }
}
