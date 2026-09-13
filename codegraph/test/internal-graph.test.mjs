import test from 'node:test'
import assert from 'node:assert/strict'
import { Node, Project } from 'ts-morph'
import { buildInternalGraph, buildInternalGraphFromCollectedSyntax, decodeInternalPartition, encodeInternalPartition, metricsForOwner } from '../internal-graph.mjs'
import { decodeSymbolPartition, GraphStore, openInternalPartition, symbolPartitionLayout, writeSymbolPartition } from '../store.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const graph = (source) => buildInternalGraph({ file: 'src/example.ts', source, compilerOptions: {} })

test('domain analysis: an empty function has entry-to-exit flow and literal baseline metrics', () => {
  const result = graph('export function empty() {}')
  assert.deepEqual(result.owners.map(({ kind, name, cyclomatic, branchCount, nestingDepth }) => ({ kind, name, cyclomatic, branchCount, nestingDepth })), [
    { kind: 'module', name: '<module>', cyclomatic: 1, branchCount: 0, nestingDepth: 0 },
    { kind: 'function', name: 'empty', cyclomatic: 1, branchCount: 0, nestingDepth: 0 },
  ])
})

test('domain analysis: nested closures own their decisions without increasing the parent metrics', () => {
  const result = graph('export function outer(v) { const inner = () => v ? 1 : 0; return inner() }')
  assert.deepEqual(result.owners.map(({ kind, name, cyclomatic, parentOwnerId }) => ({ kind, name, cyclomatic, parentOwnerId })), [
    { kind: 'module', name: '<module>', cyclomatic: 1, parentOwnerId: null },
    { kind: 'function', name: 'outer', cyclomatic: 1, parentOwnerId: 0 },
    { kind: 'arrow', name: 'inner', cyclomatic: 2, parentOwnerId: 1 },
  ])
})

test('domain analysis: a callback nested inside a generator yield receives its own owner', () => {
  const result = graph('export function* values() { yield Array.from({ length: 2 }, (_, index) => index) }')
  assert.deepEqual(result.owners.filter(({ kind }) => kind !== 'module').map(({ kind, cyclomatic }) => ({ kind, cyclomatic })), [{ kind: 'function', cyclomatic: 1 }, { kind: 'arrow', cyclomatic: 1 }])
})

test('domain analysis: if else, loop, switch, short circuit, and optional chain have literal complexity', () => {
  const result = graph('export function decide(a, xs, o) { if (a) return 1; for (const x of xs) { if (x) break } switch(a){case 1: a++; break; default: a--} return a && o?.value ? 2 : 3 }')
  const owner = result.owners.find(({ name }) => name === 'decide')
  assert.deepEqual({ cyclomatic: owner.cyclomatic, branchCount: owner.branchCount, nestingDepth: owner.nestingDepth }, { cyclomatic: 8, branchCount: 6, nestingDepth: 2 })
  const branching = result.nodes.filter((node) => node.ownerId === owner.id && new Set(result.edges.filter((edge) => edge.ownerId === owner.id && edge.from === node.id).map(({ to }) => to)).size > 1)
  assert.deepEqual(branching.map(({ kind }) => kind), ['condition', 'condition', 'condition', 'loop', 'condition', 'condition'])
})

test('equivalence partition: for-family loops carry the persisted for-loop flag while while-family loops do not', () => {
  const result = graph('export function loops(xs, object) { for (;;) { break } for (const key in object) { break } for (const value of xs) { break } while (false) {} do {} while (false) }')
  const owner = result.owners.find(({ name }) => name === 'loops')
  const loops = result.nodes.filter(({ ownerId, kind }) => ownerId === owner.id && kind === 'loop')
  assert.deepEqual({ flaggedForLoops: loops.filter(({ flags }) => flags === 1).length, unflaggedWhileLoops: loops.filter(({ flags }) => (flags ?? 0) === 0).length }, { flaggedForLoops: 3, unflaggedWhileLoops: 2 })
})

test('domain analysis: try catch finally routes a pending return through the finalizer', () => {
  const result = graph('export function guarded() { try { return work() } catch (error) { throw error } finally { cleanup() } }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  const ownedNodes = result.nodes.filter(({ ownerId }) => ownerId === owner.id)
  const byKind = (kind) => ownedNodes.find((node) => node.kind === kind)
  const finalizer = ownedNodes.find((node) => node.role === 'finalizer')
  const handler = ownedNodes.find((node) => node.role === 'handler')
  const edge = (from, to, kind) => result.edges.some((candidate) => candidate.ownerId === owner.id && candidate.from === from.id && candidate.to === to.id && candidate.kind === kind)
  assert.equal(edge(byKind('return'), byKind('call'), 'return'), true)
  assert.equal(edge(byKind('throw'), byKind('call'), 'throw'), true)
  assert.equal(result.edges.some((candidate) => candidate.ownerId === owner.id && candidate.to === handler.id && candidate.kind === 'exception'), true)
  assert.equal(result.edges.some((candidate) => candidate.ownerId === owner.id && candidate.from === finalizer.id && candidate.to === owner.exitNodeId && candidate.kind === 'finally'), true)
})

test('boundary value analysis: an empty catch contributes exactly one decision', () => {
  const result = graph('export function guarded() { try {} catch {} }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.deepEqual({ cyclomatic: owner.cyclomatic, branchCount: owner.branchCount }, { cyclomatic: 2, branchCount: 0 })
})

test('equivalence partitioning: one call protected by one catch contributes exactly one decision', () => {
  const result = graph('export function guarded() { try { first() } catch {} }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.deepEqual({ cyclomatic: owner.cyclomatic, branchCount: owner.branchCount }, { cyclomatic: 2, branchCount: 0 })
})

test('equivalence partitioning: three calls protected by one catch still contribute exactly one decision', () => {
  const result = graph('export function guarded() { try { first(); second(); third() } catch {} }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.deepEqual({ cyclomatic: owner.cyclomatic, branchCount: owner.branchCount }, { cyclomatic: 2, branchCount: 0 })
})

test('combinatorial analysis: two nested catches contribute exactly two decisions', () => {
  const result = graph('export function guarded() { try { try { work() } catch {} } catch {} }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.deepEqual({ cyclomatic: owner.cyclomatic, branchCount: owner.branchCount }, { cyclomatic: 3, branchCount: 0 })
})

test('boundary value analysis: try finally without a catch contributes no decision', () => {
  const result = graph('export function guarded() { try { work() } finally { cleanup() } }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.deepEqual({ cyclomatic: owner.cyclomatic, branchCount: owner.branchCount }, { cyclomatic: 1, branchCount: 0 })
})

test('equivalence partitioning: finally continuations preserve CFG edges without increasing complexity', () => {
  const result = graph('export function guarded(flag) { try { if (flag) return 1; work() } finally { cleanup() } return 0 }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.equal(owner.cyclomatic, 2)
  assert.ok(result.edges.some(({ ownerId, kind }) => ownerId === owner.id && kind === 'finally'))
})

test('domain analysis: optional calls retain decisions inside their arguments', () => {
  const result = graph('export function invoke(callback, left, right) { return callback?.(left ?? right) }')
  const owner = result.owners.find(({ name }) => name === 'invoke')
  assert.equal(owner.cyclomatic, 3)
})

test('error guessing: detailed exception edges remain stored after metrics ignore raw throw sites', () => {
  const result = graph('export function guarded() { try { first(); second(); third() } catch {} }')
  const owner = result.owners.find(({ name }) => name === 'guarded')
  assert.equal(result.edges.filter(({ ownerId, kind }) => ownerId === owner.id && kind === 'exception').length, 6)
})

test('domain analysis: unreachable syntax remains searchable but is excluded from metrics', () => {
  const result = graph('export function stop() { return 1; if (never) return 2 }')
  const owner = result.owners.find(({ name }) => name === 'stop')
  assert.deepEqual({ complexity: owner.cyclomatic, unreachableKinds: result.nodes.filter(({ ownerId, unreachable }) => ownerId === owner.id && unreachable).map(({ kind }) => kind) }, { complexity: 1, unreachableKinds: ['condition', 'return'] })
})

test('domain analysis: semantic call read and write relations can target symbols in another file', () => {
  const result = buildInternalGraph({ file: 'src/caller.ts', source: 'import { value, save } from "./target"; export function caller(){ value = save(value) }', compilerOptions: {}, resolveSymbol: (name) => ({ value: 'target-value', save: 'target-save' })[name] })
  assert.deepEqual(result.relations.map(({ kind, targetSymbolId }) => ({ kind, targetSymbolId })), [
    { kind: 'write', targetSymbolId: 'target-value' },
    { kind: 'call', targetSymbolId: 'target-save' },
    { kind: 'read', targetSymbolId: 'target-value' },
  ])
  for (const relation of result.relations) assert.equal(result.nodes.some((node) => node.id === relation.fromNode && node.ownerId === relation.ownerId), true)
})

test('domain analysis: unresolved dynamic calls remain nodes without invented semantic relations', () => {
  const result = graph('export function dynamic(target, key) { return target[key]() }')
  assert.deepEqual({ calls: result.nodes.filter(({ kind }) => kind === 'call').length, relations: result.relations }, { calls: 1, relations: [] })
})

test('domain analysis: semantic relations never change CFG-derived metrics', () => {
  const owner = { id: 0, entryNodeId: 0, exitNodeId: 1 }
  const nodes = [{ id: 0, ownerId: 0, kind: 'entry', unreachable: false }, { id: 1, ownerId: 0, kind: 'exit', unreachable: false }]
  const edges = [{ ownerId: 0, from: 0, to: 1, kind: 'next' }]
  assert.deepEqual(metricsForOwner(owner, nodes, edges, [{ fromNode: 0, targetSymbolId: 'external', kind: 'call' }]), { cyclomatic: 1, branchCount: 0, nestingDepth: 0 })
})

test('compatibility contract: nested-owner internal partition bytes retain their frozen digest', () => {
  const result = buildInternalGraph({ file: 'src/example.ts', source: 'export function outer(a){ return function inner(b){ return b ? a : b } }', resolveSymbol: (name) => ({ a: 'symbol-a', b: 'symbol-b' })[name] })
  const bytes = encodeInternalPartition({ ...result, compilerFingerprint: 'frozen-v1' })
  assert.deepEqual({ byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, { byteLength: 1108, sha256: 'e2f6a28a1ed82b09bca14cc8e9493bd088f2503e9e23574131bea0867c4454b4' })
})

test('compatibility contract: control-flow internal partition bytes retain their frozen digest', () => {
  const result = buildInternalGraph({ file: 'src/example.ts', source: 'export function choose(flag){ if(flag) return 1; return 0 }' })
  const bytes = encodeInternalPartition({ ...result, compilerFingerprint: 'frozen-v1' })
  assert.deepEqual({ byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, { byteLength: 813, sha256: 'b08fb0af9a99b6d31d14c7b1479297f655020f874008195e5b0a312aef2bbbef' })
})

test('compatibility contract: semantic-relation internal partition bytes retain their frozen digest', () => {
  const result = buildInternalGraph({ file: 'src/example.ts', source: 'export function save(value){ sink(value); return value }', resolveSymbol: (name) => ({ sink: 'symbol-sink', value: 'symbol-value' })[name] })
  const bytes = encodeInternalPartition({ ...result, compilerFingerprint: 'frozen-v1' })
  assert.deepEqual({ byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, { byteLength: 868, sha256: 'f98e1609f33c8ff16ac64721d64c9f38bd8e436200f74c04ed224b73a9634d63' })
})

test('boundary analysis: binary round trip preserves one owner, one node, one edge, and one relation', () => {
  const input = { compilerFingerprint: 'typescript-28', owners: [{ id: 0, kind: 'function', name: 'x', start: 0, end: 4, entryNodeId: 0, exitNodeId: 0, cyclomatic: 1, branchCount: 0, nestingDepth: 0 }], nodes: [{ id: 0, ownerId: 0, parentId: null, kind: 'entry', role: 'body', start: 0, end: 4, unreachable: false }], edges: [{ ownerId: 0, from: 0, to: 0, kind: 'next' }], relations: [{ ownerId: 0, fromNode: 0, targetSymbolId: 'symbol-x', kind: 'read' }] }
  assert.deepEqual(decodeInternalPartition(encodeInternalPartition(input), { compilerFingerprint: 'typescript-28' }), input)
})

test('allocation boundary: indexed partition view decodes only requested records', () => {
  const bytes = encodeInternalPartition({ compilerFingerprint: 'typescript-28', owners: [{ id: 0, kind: 'function', name: 'x', start: 0, end: 4, entryNodeId: 0, exitNodeId: 0, cyclomatic: 1, branchCount: 0, nestingDepth: 0 }], nodes: [{ id: 0, ownerId: 0, parentId: null, kind: 'entry', role: 'body', start: 0, end: 4, unreachable: false }], edges: [], relations: [] })
  const view = openInternalPartition(bytes, { compilerFingerprint: 'typescript-28' })
  assert.deepEqual({ counts: view.counts, owner: view.ownerAt(0).name, missing: view.ownerAt(1), nodes: [...view.nodes(0)].map(({ kind }) => kind), edges: [...view.edges(0)], relations: [...view.relations(0)] }, { counts: { owners: 1, nodes: 1, edges: 0, relations: 0 }, owner: 'x', missing: null, nodes: ['entry'], edges: [], relations: [] })
})

test('boundary analysis: decoder rejects zero bytes', () => {
  assert.throws(() => decodeInternalPartition(new Uint8Array(), { compilerFingerprint: 'typescript-28' }), /magic|header|truncated/i)
})

test('boundary analysis: decoder rejects every truncated byte length of a valid partition', async (t) => {
  const bytes = encodeInternalPartition({ compilerFingerprint: 'typescript-28', owners: [], nodes: [], edges: [], relations: [] })
  for (const length of [0, 1, bytes.length - 1]) await t.test(`length ${length}`, () => {
    assert.throws(() => decodeInternalPartition(bytes.subarray(0, length), { compilerFingerprint: 'typescript-28' }), /magic|header|length|truncated|checksum/i)
  })
})

test('error guessing: decoder rejects a checksum mutation', () => {
  const bytes = encodeInternalPartition({ compilerFingerprint: 'typescript-28', owners: [], nodes: [], edges: [], relations: [] })
  const corrupt = Uint8Array.from(bytes)
  corrupt[corrupt.length - 1] ^= 0xff
  assert.throws(() => decodeInternalPartition(corrupt, { compilerFingerprint: 'typescript-28' }), /checksum/i)
})

test('domain boundary: decoder rejects a compiler fingerprint mismatch', () => {
  const bytes = encodeInternalPartition({ compilerFingerprint: 'typescript-28', owners: [], nodes: [], edges: [], relations: [] })
  assert.throws(() => decodeInternalPartition(bytes, { compilerFingerprint: 'typescript-29' }), /compiler|fingerprint/i)
})

test('boundary analysis: UTF-16 ranges preserve emoji offsets at source EOF', () => {
  const result = graph('export const smile = () => "😀"')
  const owner = result.owners.find(({ kind }) => kind === 'arrow')
  assert.deepEqual({ start: owner.start, end: owner.end }, { start: 21, end: 31 })
})

test('equivalence partition: an unbound function expression receives the literal anonymous owner name', () => {
  const result = graph('consume(function () { return 1 })')
  assert.equal(result.owners.find(({ kind }) => kind === 'function').name, '<anonymous>')
})

test('domain analysis: an existing semantic source file builds packed non-materialized rows', () => {
  const project = new Project({ useInMemoryFileSystem: true })
  const sourceFile = project.createSourceFile('src/packed.ts', 'export function packed(){ return 1 }')
  const children = new Map([[sourceFile.compilerNode, []]])
  const identifiers = []
  sourceFile.forEachDescendant((node) => {
    children.set(node.compilerNode, [])
    children.get(node.getParent().compilerNode).push(node)
    if (Node.isIdentifier(node)) identifiers.push(node)
  })
  const result = buildInternalGraphFromCollectedSyntax(sourceFile, 'src/packed.ts', { children, identifiers })
  assert.deepEqual({ ownerCount: result.owners.length, firstOwner: result.owners.get(0).name, materialized: Array.isArray(result.owners) }, { ownerCount: 2, firstOwner: '<module>', materialized: false })
})

test('domain analysis: GraphStore round trips every persisted artifact and hydrates v2 overlay edges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-roundtrip-'))
  try {
    const store = new GraphStore(root)
    const partition = { file: 'src/a.ts', sourceHash: '', symbols: [], edges: [], dependencies: [], unresolved: [] }
    const partitionId = store.writePartition(partition)
    const internalBytes = Buffer.from('internal bytes')
    const internalId = store.writeInternalPartition(internalBytes)
    const sourceId = store.writeSource('export const a = 1\n')
    const generation = store.publish({ version: 3, partitions: { 'src/a.ts': partitionId }, internalPartitions: { 'src/a.ts': internalId }, sources: { 'src/a.ts': sourceId } })
    store.writeOverlay(generation.generation, { version: 2, generation: generation.generation, files: { 'src/a.ts': { edges: [{ from: 'a', to: 'b' }] } }, edges: [{ ignored: true }], ordered: true })
    assert.deepEqual({ partition: store.readPartition(partitionId), internal: store.readInternalPartition(internalId).toString(), source: store.readSource(sourceId), generation: store.readGeneration(generation.generation).generation, overlayEdges: store.readOverlay(generation.generation).edges }, { partition, internal: 'internal bytes', source: 'export const a = 1\n', generation: generation.generation, overlayEdges: [{ from: 'a', to: 'b' }] })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('boundary value analysis: a packed symbol partition preserves Unicode text split across shared chunks exactly', () => {
  const partition = {
    file: 'src/跨越.ts',
    sourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    symbols: [{ id: 'symbol-id', file: 'src/跨越.ts', name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa🚀suffix', kind: 'function', line: 7, qualifiedPath: 'class:Résumé', signature: '<T>(value:T):T', ordinal: 0, exported: true }],
    edges: [{ from: 'symbol-id', to: '目标-id', line: 8, call: true }],
    dependencies: ['src/依存.ts'],
    unresolved: [{ specifier: './欠落-🚀', candidates: ['src/欠落-🚀.ts', 'src/欠落-🚀/index.ts'] }],
  }
  const layout = symbolPartitionLayout(partition)
  const chunks = Array.from({ length: Math.ceil(layout.byteLength / 64) }, () => new Uint8Array(new SharedArrayBuffer(64)))

  writeSymbolPartition(partition, layout, chunks)

  assert.deepEqual(decodeSymbolPartition(chunks), partition)
})

test('equivalence partitioning: a packed partition remains identical after closing and reopening its store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-packed-reopen-'))
  const partition = { file: 'src/value.ts', sourceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbols: [{ id: 'value-id', file: 'src/value.ts', name: 'value', kind: 'variable', line: 1, qualifiedPath: '<module>', signature: '<>():number', ordinal: 0, exported: true }], edges: [], dependencies: [], unresolved: [] }
  try {
    const id = new GraphStore(root).writePartition(partition)

    const reopened = new GraphStore(root).readPartition(id)

    assert.deepEqual(reopened, partition)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('cache compatibility: a legacy JSON partition remains equivalent when opened by the packed-aware store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-symbol-json-'))
  const partition = { file: 'src/legacy.ts', sourceHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', symbols: [{ id: 'legacy-id', file: 'src/legacy.ts', name: 'legacy', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():void', ordinal: 0, exported: true }], edges: [{ from: 'legacy-id', to: 'target-id', line: 3, call: false }], dependencies: ['src/target.ts'], unresolved: [{ specifier: './gone', candidates: ['src/gone.ts'] }] }
  try {
    const store = new GraphStore(root)
    store.initialize()
    const contents = JSON.stringify(partition)
    const id = crypto.createHash('sha256').update(contents).digest('hex')
    fs.writeFileSync(path.join(store.partitions, `${id}.json`), contents)

    const reopened = new GraphStore(root).readPartition(id)

    assert.deepEqual(reopened, partition)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('alternate flow: GraphStore content-addressed writes reuse existing partition source and internal files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-reuse-'))
  try {
    const store = new GraphStore(root)
    const partitionFirst = store.writePartition({ file: 'a.ts' }); const partitionSecond = store.writePartition({ file: 'a.ts' })
    const internalFirst = store.writeInternalPartition(Buffer.from('x')); const internalSecond = store.writeInternalPartition(Buffer.from('x'))
    const sourceFirst = store.writeSource('x'); const sourceSecond = store.writeSource('x')
    assert.deepEqual({ samePartition: partitionFirst === partitionSecond, sameInternal: internalFirst === internalSecond, sameSource: sourceFirst === sourceSecond }, { samePartition: true, sameInternal: true, sameSource: true })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('error guessing: GraphStore rejects malformed internal IDs and mismatched overlay generations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-errors-'))
  try {
    const store = new GraphStore(root)
    assert.throws(() => store.readInternalPartition('../escape'), /invalid internal partition id/)
    assert.throws(() => store.writeOverlay('expected', { generation: 'wrong', files: {} }), /generation mismatch/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('alternate flow: GraphStore returns null for a missing overlay and empty donors for absent overlay storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-empty-'))
  try {
    const store = new GraphStore(root)
    assert.deepEqual({ overlay: store.readOverlay('missing'), donors: store.donorOverlayFiles('none') }, { overlay: null, donors: {} })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('error guessing: GraphStore surfaces malformed persisted overlay JSON instead of treating it as missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-malformed-overlay-'))
  try {
    const store = new GraphStore(root)
    store.initialize()
    fs.writeFileSync(path.join(root, '.codegraph', 'overlays', 'broken.json'), '{')
    assert.throws(() => store.readOverlay('broken'), /JSON|position|property name/i)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('domain analysis: GraphStore donor selection ignores excluded and legacy overlays and returns newest v2 files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-donors-'))
  try {
    const store = new GraphStore(root)
    store.initialize()
    fs.writeFileSync(path.join(root, '.codegraph', 'overlays', 'legacy.json'), JSON.stringify({ version: 1, files: { legacy: true } }))
    fs.writeFileSync(path.join(root, '.codegraph', 'overlays', 'usable.json'), JSON.stringify({ version: 2, files: { 'src/a.ts': { edges: [] } } }))
    fs.writeFileSync(path.join(root, '.codegraph', 'overlays', 'excluded.json'), JSON.stringify({ version: 2, files: { excluded: true } }))
    assert.deepEqual(store.donorOverlayFiles('excluded'), { 'src/a.ts': { edges: [] } })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('error guessing: GraphStore recovers CURRENT from the newest available generation and errors when none exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-current-'))
  try {
    const store = new GraphStore(root)
    assert.throws(() => store.readGeneration(), /no codegraph generation/)
    const older = store.publish({ marker: 'older' })
    const newer = store.publish({ marker: 'newer' })
    fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'missing-generation')
    assert.deepEqual({ recovered: store.readGeneration().generation, expected: newer.generation, differsFromOlder: newer.generation !== older.generation }, { recovered: newer.generation, expected: newer.generation, differsFromOlder: true })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('domain analysis: nested owners attach call and read relations to the innermost owning CFG nodes', () => {
  const result = buildInternalGraph({ file: 'src/nested.ts', source: 'export function outer(a){ consume(a); return function inner(b){ consume(b); return b } }', resolveSymbol: (name) => ({ consume: 'symbol-consume', a: 'symbol-a', b: 'symbol-b' })[name] })
  assert.deepEqual(result.relations.map(({ ownerId, fromNode, targetSymbolId, kind }) => ({ ownerId, fromNode, targetSymbolId, kind })), [
    { ownerId: 1, fromNode: 6, targetSymbolId: 'symbol-consume', kind: 'call' },
    { ownerId: 1, fromNode: 6, targetSymbolId: 'symbol-a', kind: 'read' },
    { ownerId: 2, fromNode: 11, targetSymbolId: 'symbol-consume', kind: 'call' },
    { ownerId: 2, fromNode: 11, targetSymbolId: 'symbol-b', kind: 'read' },
    { ownerId: 2, fromNode: 9, targetSymbolId: 'symbol-b', kind: 'read' },
  ])
})

test('domain boundary: overlapping statement and call ranges attach all call arguments to the smallest CFG node', () => {
  const result = buildInternalGraph({ file: 'src/overlap.ts', source: 'export function pair(a,b){ consume(a,b); return a }', resolveSymbol: (name) => ({ consume: 'symbol-consume', a: 'symbol-a', b: 'symbol-b' })[name] })
  assert.deepEqual(result.relations.map(({ fromNode, targetSymbolId, kind }) => ({ fromNode, targetSymbolId, kind })), [
    { fromNode: 6, targetSymbolId: 'symbol-consume', kind: 'call' },
    { fromNode: 6, targetSymbolId: 'symbol-a', kind: 'read' },
    { fromNode: 6, targetSymbolId: 'symbol-b', kind: 'read' },
    { fromNode: 4, targetSymbolId: 'symbol-a', kind: 'read' },
  ])
})

test('boundary analysis: identifiers at the first and last executable expression offsets remain inside their owner and node ranges', () => {
  const result = buildInternalGraph({ file: 'src/boundary.ts', source: 'export function edge(first,last){first;return last}', resolveSymbol: (name) => ({ first: 'symbol-first', last: 'symbol-last' })[name] })
  assert.deepEqual(result.relations.map(({ ownerId, fromNode, targetSymbolId, kind }) => ({ ownerId, fromNode, targetSymbolId, kind })), [
    { ownerId: 1, fromNode: 5, targetSymbolId: 'symbol-first', kind: 'read' },
    { ownerId: 1, fromNode: 4, targetSymbolId: 'symbol-last', kind: 'read' },
  ])
})

test('equivalence partition: resolvable identifiers outside nested executable owners emit no semantic relations', () => {
  const result = buildInternalGraph({ file: 'src/module.ts', source: 'const moduleValue = imported; export function inside(){ return 1 }', resolveSymbol: (name) => name === 'imported' ? 'symbol-imported' : null })
  assert.deepEqual(result.relations, [])
})

test('performance contract: identifier attachment reports bounded indexed candidate work instead of full owner and node scans', () => {
  const result = buildInternalGraph({
    file: 'src/indexed.ts',
    source: 'export function indexed(x){sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x);sink(x)}',
    resolveSymbol: (name) => name === 'x' ? 'symbol-x' : null,
    instrumentRelationLookup: true,
  })
  assert.deepEqual({ identifierLookups: result.lookupStats?.identifierLookups, ownerCandidateChecksBounded: result.lookupStats ? result.lookupStats.ownerCandidateChecks <= 80 : false, nodeCandidateChecksBounded: result.lookupStats ? result.lookupStats.nodeCandidateChecks <= 128 : false }, { identifierLookups: 16, ownerCandidateChecksBounded: true, nodeCandidateChecksBounded: true })
})

test('domain analysis: parameter and destructured-binding defaults branch before the function body in source order', () => {
  const result = graph('export function defaults(value = choose(), { nested = fallback() } = {}) { return value }')
  const owner = result.owners.find(({ name }) => name === 'defaults')
  assert.deepEqual({ metrics: { cyclomatic: owner.cyclomatic, branchCount: owner.branchCount, nestingDepth: owner.nestingDepth }, edges: result.edges.filter(({ ownerId }) => ownerId === owner.id).map(({ from, to, kind }) => ({ from, to, kind })) }, {
    metrics: { cyclomatic: 4, branchCount: 2, nestingDepth: 0 },
    edges: [
      { from: 4, to: 3, kind: 'return' },
      { from: 6, to: 4, kind: 'next' },
      { from: 5, to: 6, kind: 'true' },
      { from: 5, to: 4, kind: 'false' },
      { from: 7, to: 5, kind: 'true' },
      { from: 7, to: 5, kind: 'false' },
      { from: 9, to: 7, kind: 'next' },
      { from: 8, to: 9, kind: 'true' },
      { from: 8, to: 7, kind: 'false' },
      { from: 2, to: 8, kind: 'next' },
    ],
  })
})

test('allocation contract: packed production build encodes unchanged CFG without materialized record arrays or wrapper traversals', () => {
  const project = new Project({ useInMemoryFileSystem: true })
  const sourceFile = project.createSourceFile('src/packed-allocation.ts', 'export function choose(flag){ if(flag) return read(); return 0 }')
  const children = new Map([[sourceFile.compilerNode, []]])
  const identifiers = []
  const descendants = []
  sourceFile.forEachDescendant((node) => {
    descendants.push(node)
    children.set(node.compilerNode, [])
    children.get(node.getParent().compilerNode).push(node)
    if (Node.isIdentifier(node)) identifiers.push(node)
  })
  for (const node of descendants) {
    node.getChildren = () => { throw new Error(`wrapper child traversal from ${node.getKindName()}`) }
    node.getDescendantsOfKind = () => { throw new Error(`wrapper descendant traversal from ${node.getKindName()}`) }
  }
  const packed = buildInternalGraphFromCollectedSyntax(sourceFile, 'src/packed-allocation.ts', { children, identifiers }, (name) => ({ read: 'symbol-read', flag: 'symbol-flag' })[name])
  const decoded = decodeInternalPartition(encodeInternalPartition({ ...packed, compilerFingerprint: 'packed-v1' }), { compilerFingerprint: 'packed-v1' })
  assert.deepEqual({
    recordArrays: { owners: Array.isArray(packed.owners), nodes: Array.isArray(packed.nodes), edges: Array.isArray(packed.edges), relations: Array.isArray(packed.relations) },
    owners: decoded.owners.map(({ id, name, cyclomatic, branchCount, nestingDepth, nodeCount }) => ({ id, name, cyclomatic, branchCount, nestingDepth, nodeCount })),
    counts: { nodes: decoded.nodes.length, edges: decoded.edges.length, relations: decoded.relations.length },
    relations: decoded.relations,
  }, {
    recordArrays: { owners: false, nodes: false, edges: false, relations: false },
    owners: [
      { id: 0, name: '<module>', cyclomatic: 1, branchCount: 0, nestingDepth: 0, nodeCount: 2 },
      { id: 1, name: 'choose', cyclomatic: 2, branchCount: 1, nestingDepth: 1, nodeCount: 6 },
    ],
    counts: { nodes: 8, edges: 7, relations: 2 },
    relations: [
      { ownerId: 1, fromNode: 5, targetSymbolId: 'symbol-flag', kind: 'read' },
      { ownerId: 1, fromNode: 7, targetSymbolId: 'symbol-read', kind: 'call' },
    ],
  })
})

test('allocation contract: lazy partition view exposes fixed-width accessors without materializing record arrays', () => {
  const bytes = encodeInternalPartition({ compilerFingerprint: 'lazy-v1', owners: [{ id: 0, kind: 'function', name: 'lazy', start: 0, end: 1, entryNodeId: 0, exitNodeId: 1, cyclomatic: 1, branchCount: 0, nestingDepth: 0, firstNode: 0, nodeCount: 2 }], nodes: [{ id: 0, ownerId: 0, parentId: null, kind: 'entry', role: 'body', start: 0, end: 0, unreachable: false }, { id: 1, ownerId: 0, parentId: null, kind: 'exit', role: 'body', start: 1, end: 1, unreachable: false }], edges: [{ ownerId: 0, from: 0, to: 1, kind: 'next' }], relations: [] })
  const view = openInternalPartition(bytes, { compilerFingerprint: 'lazy-v1' })
  assert.deepEqual({ arrays: { owners: Array.isArray(view.owners), nodes: Array.isArray(view.nodes), edges: Array.isArray(view.edges), relations: Array.isArray(view.relations) }, counts: view.counts, owner: view.ownerAt(0).name, firstNode: view.nodeAt(0).kind, firstEdge: view.edgeAt(0).kind, missingRelation: view.relationAt(0) }, { arrays: { owners: false, nodes: false, edges: false, relations: false }, counts: { owners: 1, nodes: 2, edges: 1, relations: 0 }, owner: 'lazy', firstNode: 'entry', firstEdge: 'next', missingRelation: null })
})
