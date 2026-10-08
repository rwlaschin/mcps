import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { createSemanticProject, parsePartition, prepareSemanticProject } from '../parser.mjs'
import { resolveCachedImport } from '../cached-binding-resolver.mjs'

test('state transitions: repeated target signature changes replace the prior repaired edge after publication and reopen', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repaired-edge-replacement-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), "import { target } from './target'\nexport function caller(){ return target('one') }\n")
  const retained = new CodeGraphEngine(root, { cacheDir: '.retained' })
  const opened = []
  context.after(async () => { await retained.dispose(); await Promise.all(opened.map((engine) => engine.dispose())) })
  await retained.build()

  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(value: string): string { return value }\n')
  const added = await retained.reconcile()
  await added.validation
  const addedGraph = (await retained.queryBatch({ type: 'graph', generation: added.generation, limit: 20 }))[0]
  const addedById = new Map(addedGraph.symbols.map((symbol) => [symbol.id, symbol]))
  const addedOpened = new CodeGraphEngine(root, { cacheDir: '.retained' })
  opened.push(addedOpened)
  const addedReopened = (await addedOpened.queryBatch({ type: 'graph', generation: added.generation, limit: 20 }))[0]
  const addedReopenedById = new Map(addedReopened.symbols.map((symbol) => [symbol.id, symbol]))

  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(value: number): number { return value }\n')
  const changedOnce = await retained.reconcile()
  await changedOnce.validation
  const onceGraph = (await retained.queryBatch({ type: 'graph', generation: changedOnce.generation, limit: 20 }))[0]
  const onceById = new Map(onceGraph.symbols.map((symbol) => [symbol.id, symbol]))
  const onceOpened = new CodeGraphEngine(root, { cacheDir: '.retained' })
  opened.push(onceOpened)
  const onceReopened = (await onceOpened.queryBatch({ type: 'graph', generation: changedOnce.generation, limit: 20 }))[0]
  const onceReopenedById = new Map(onceReopened.symbols.map((symbol) => [symbol.id, symbol]))
  const cleanOnce = new CodeGraphEngine(root, { cacheDir: '.clean-once' })
  opened.push(cleanOnce)
  const cleanOnceBuild = await cleanOnce.build()
  const cleanOnceGraph = (await cleanOnce.queryBatch({ type: 'graph', generation: cleanOnceBuild.generation, limit: 20 }))[0]
  const cleanOnceById = new Map(cleanOnceGraph.symbols.map((symbol) => [symbol.id, symbol]))

  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(value: boolean): boolean { return value }\n')
  const changedTwice = await retained.reconcile()
  await changedTwice.validation
  const twiceGraph = (await retained.queryBatch({ type: 'graph', generation: changedTwice.generation, limit: 20 }))[0]
  const twiceById = new Map(twiceGraph.symbols.map((symbol) => [symbol.id, symbol]))
  const twiceOpened = new CodeGraphEngine(root, { cacheDir: '.retained' })
  opened.push(twiceOpened)
  const twiceReopened = (await twiceOpened.queryBatch({ type: 'graph', generation: changedTwice.generation, limit: 20 }))[0]
  const twiceReopenedById = new Map(twiceReopened.symbols.map((symbol) => [symbol.id, symbol]))
  const cleanTwice = new CodeGraphEngine(root, { cacheDir: '.clean-twice' })
  opened.push(cleanTwice)
  const cleanTwiceBuild = await cleanTwice.build()
  const cleanTwiceGraph = (await cleanTwice.queryBatch({ type: 'graph', generation: cleanTwiceBuild.generation, limit: 20 }))[0]
  const cleanTwiceById = new Map(cleanTwiceGraph.symbols.map((symbol) => [symbol.id, symbol]))

  assert.deepEqual({
    added: addedGraph.edges.map((edge) => ({ from: addedById.get(edge.from)?.name, to: addedById.get(edge.to)?.name, signature: addedById.get(edge.to)?.signature, call: edge.call })),
    addedPatchCount: retained.readGeneration(added.generation).edgePatches?.length ?? 0,
    addedDangling: addedGraph.unresolvedEdges,
    addedReopened: addedReopened.edges.map((edge) => ({ from: addedReopenedById.get(edge.from)?.name, to: addedReopenedById.get(edge.to)?.name, signature: addedReopenedById.get(edge.to)?.signature, call: edge.call })),
    once: onceGraph.edges.map((edge) => ({ from: onceById.get(edge.from)?.name, to: onceById.get(edge.to)?.name, signature: onceById.get(edge.to)?.signature, call: edge.call })),
    onceClean: cleanOnceGraph.edges.map((edge) => ({ from: cleanOnceById.get(edge.from)?.name, to: cleanOnceById.get(edge.to)?.name, signature: cleanOnceById.get(edge.to)?.signature, call: edge.call })),
    oncePatchCount: retained.readGeneration(changedOnce.generation).edgePatches?.length ?? 0,
    onceDangling: onceGraph.unresolvedEdges,
    onceReopened: onceReopened.edges.map((edge) => ({ from: onceReopenedById.get(edge.from)?.name, to: onceReopenedById.get(edge.to)?.name, signature: onceReopenedById.get(edge.to)?.signature, call: edge.call })),
    twice: twiceGraph.edges.map((edge) => ({ from: twiceById.get(edge.from)?.name, to: twiceById.get(edge.to)?.name, signature: twiceById.get(edge.to)?.signature, call: edge.call })),
    twiceClean: cleanTwiceGraph.edges.map((edge) => ({ from: cleanTwiceById.get(edge.from)?.name, to: cleanTwiceById.get(edge.to)?.name, signature: cleanTwiceById.get(edge.to)?.signature, call: edge.call })),
    twicePatchCount: retained.readGeneration(changedTwice.generation).edgePatches?.length ?? 0,
    twiceDangling: twiceGraph.unresolvedEdges,
    twiceReopened: twiceReopened.edges.map((edge) => ({ from: twiceReopenedById.get(edge.from)?.name, to: twiceReopenedById.get(edge.to)?.name, signature: twiceReopenedById.get(edge.to)?.signature, call: edge.call })),
  }, {
    added: [{ from: 'caller', to: 'target', signature: '<>(value:string):string', call: true }],
    addedPatchCount: 1,
    addedDangling: [],
    addedReopened: [{ from: 'caller', to: 'target', signature: '<>(value:string):string', call: true }],
    once: [{ from: 'caller', to: 'target', signature: '<>(value:number):number', call: true }],
    onceClean: [{ from: 'caller', to: 'target', signature: '<>(value:number):number', call: true }],
    oncePatchCount: 1,
    onceDangling: [],
    onceReopened: [{ from: 'caller', to: 'target', signature: '<>(value:number):number', call: true }],
    twice: [{ from: 'caller', to: 'target', signature: '<>(value:boolean):boolean', call: true }],
    twiceClean: [{ from: 'caller', to: 'target', signature: '<>(value:boolean):boolean', call: true }],
    twicePatchCount: 1,
    twiceDangling: [],
    twiceReopened: [{ from: 'caller', to: 'target', signature: '<>(value:boolean):boolean', call: true }],
  })
})

test('domain analysis: a target ID change replaces an unchanged importer native edge instead of retaining a dangling old endpoint', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-edge-replacement-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(value: string): string { return value }\n')
  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), "import { target } from './target'\nexport function caller(){ return target('one') }\n")
  const retained = new CodeGraphEngine(root, { cacheDir: '.retained' })
  const clean = new CodeGraphEngine(root, { cacheDir: '.clean' })
  context.after(async () => { await Promise.all([retained.dispose(), clean.dispose()]) })
  await retained.build()

  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(value: number): number { return value }\n')
  const changed = await retained.reconcile()
  await changed.validation
  const cleanBuild = await clean.build()
  const retainedGraph = (await retained.queryBatch({ type: 'graph', generation: changed.generation, limit: 20 }))[0]
  const cleanGraph = (await clean.queryBatch({ type: 'graph', generation: cleanBuild.generation, limit: 20 }))[0]
  const retainedById = new Map(retainedGraph.symbols.map((symbol) => [symbol.id, symbol]))
  const cleanById = new Map(cleanGraph.symbols.map((symbol) => [symbol.id, symbol]))

  assert.deepEqual({
    retained: retainedGraph.edges.map((edge) => ({ from: retainedById.get(edge.from)?.name, to: retainedById.get(edge.to)?.name, signature: retainedById.get(edge.to)?.signature, call: edge.call })),
    clean: cleanGraph.edges.map((edge) => ({ from: cleanById.get(edge.from)?.name, to: cleanById.get(edge.to)?.name, signature: cleanById.get(edge.to)?.signature, call: edge.call })),
    dangling: retainedGraph.unresolvedEdges,
  }, {
    retained: [{ from: 'caller', to: 'target', signature: '<>(value:number):number', call: true }],
    clean: [{ from: 'caller', to: 'target', signature: '<>(value:number):number', call: true }],
    dangling: [],
  })
})

test('boundary multiplicity: a repaired import matching one native edge preserves both same-key source uses', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-same-key-multiplicity-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(){ return 1 }\n')
  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), "import { target } from './target'\nimport { relayed } from './barrel'\nexport function caller(){ target(); relayed() }\n")
  const retained = new CodeGraphEngine(root, { cacheDir: '.retained' })
  const clean = new CodeGraphEngine(root, { cacheDir: '.clean' })
  context.after(async () => { await Promise.all([retained.dispose(), clean.dispose()]) })
  await retained.build()

  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { target as relayed } from './target'\n")
  const added = await retained.reconcile()
  await added.validation
  const cleanBuild = await clean.build()
  const retainedGraph = (await retained.queryBatch({ type: 'graph', generation: added.generation, limit: 20 }))[0]
  const cleanGraph = (await clean.queryBatch({ type: 'graph', generation: cleanBuild.generation, limit: 20 }))[0]
  const retainedById = new Map(retainedGraph.symbols.map((symbol) => [symbol.id, symbol]))
  const cleanById = new Map(cleanGraph.symbols.map((symbol) => [symbol.id, symbol]))

  assert.deepEqual({
    retained: retainedGraph.edges.map((edge) => ({ from: retainedById.get(edge.from)?.name, to: retainedById.get(edge.to)?.name, line: edge.line, call: edge.call })),
    clean: cleanGraph.edges.map((edge) => ({ from: cleanById.get(edge.from)?.name, to: cleanById.get(edge.to)?.name, line: edge.line, call: edge.call })),
    dangling: retainedGraph.unresolvedEdges,
  }, {
    retained: [
      { from: 'caller', to: 'target', line: 3, call: true },
      { from: 'caller', to: 'target', line: 3, call: true },
    ],
    clean: [
      { from: 'caller', to: 'target', line: 3, call: true },
      { from: 'caller', to: 'target', line: 3, call: true },
    ],
    dangling: [],
  })
})

test('state transition: changing an importer removes its prior repaired owner edge instead of publishing a dangling patch', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repaired-owner-removal-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), "import { target } from './target'\nexport function caller(){ return target() }\n")
  const retained = new CodeGraphEngine(root, { cacheDir: '.retained' })
  const clean = new CodeGraphEngine(root, { cacheDir: '.clean' })
  context.after(async () => { await Promise.all([retained.dispose(), clean.dispose()]) })
  await retained.build()
  fs.writeFileSync(path.join(root, 'src', 'target.ts'), 'export function target(){ return 1 }\n')
  const repaired = await retained.reconcile()
  await repaired.validation

  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), 'export function renamed(){ return 0 }\n')
  const changed = await retained.reconcile()
  await changed.validation
  const cleanBuild = await clean.build()
  const retainedGraph = (await retained.queryBatch({ type: 'graph', generation: changed.generation, limit: 20 }))[0]
  const cleanGraph = (await clean.queryBatch({ type: 'graph', generation: cleanBuild.generation, limit: 20 }))[0]

  assert.deepEqual({
    retainedEdges: retainedGraph.edges,
    cleanEdges: cleanGraph.edges,
    retainedDangling: retainedGraph.unresolvedEdges,
    patchCount: retained.readGeneration(changed.generation).edgePatches?.length ?? 0,
  }, { retainedEdges: [], cleanEdges: [], retainedDangling: [], patchCount: 0 })
})

test('combinatorial routes: default alias namespace and re-export patches all replace their old target IDs', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-patch-replacement-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export { default, named as alias } from './base'\nexport * as space from './base'\n")
  fs.writeFileSync(path.join(root, 'src', 'importer.ts'), "import primary, { alias, space } from './barrel'\nimport * as namespace from './base'\nexport function caller(){ primary('x'); alias('x'); space.named('x'); namespace.named('x') }\n")
  const retained = new CodeGraphEngine(root, { cacheDir: '.retained' })
  const clean = new CodeGraphEngine(root, { cacheDir: '.clean' })
  context.after(async () => { await Promise.all([retained.dispose(), clean.dispose()]) })
  await retained.build()
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export default function primary(value: string): string { return value }\nexport function named(value: string): string { return value }\n')
  const added = await retained.reconcile()
  await added.validation

  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export default function primary(value: number): number { return value }\nexport function named(value: number): number { return value }\n')
  const changed = await retained.reconcile()
  await changed.validation
  const cleanBuild = await clean.build()
  const retainedGraph = (await retained.queryBatch({ type: 'graph', generation: changed.generation, limit: 30 }))[0]
  const cleanGraph = (await clean.queryBatch({ type: 'graph', generation: cleanBuild.generation, limit: 30 }))[0]
  const retainedById = new Map(retainedGraph.symbols.map((symbol) => [symbol.id, symbol]))
  const cleanById = new Map(cleanGraph.symbols.map((symbol) => [symbol.id, symbol]))

  assert.deepEqual({
    retained: retainedGraph.edges.map((edge) => ({ from: retainedById.get(edge.from)?.name, to: retainedById.get(edge.to)?.name, signature: retainedById.get(edge.to)?.signature, call: edge.call })).sort((left, right) => left.to.localeCompare(right.to)),
    clean: cleanGraph.edges.map((edge) => ({ from: cleanById.get(edge.from)?.name, to: cleanById.get(edge.to)?.name, signature: cleanById.get(edge.to)?.signature, call: edge.call })).sort((left, right) => left.to.localeCompare(right.to)),
    dangling: retainedGraph.unresolvedEdges,
    patchCount: retained.readGeneration(changed.generation).edgePatches?.length ?? 0,
  }, {
    retained: [
      { from: 'caller', to: 'named', signature: '<>(value:number):number', call: true },
      { from: 'caller', to: 'named', signature: '<>(value:number):number', call: true },
      { from: 'caller', to: 'named', signature: '<>(value:number):number', call: true },
      { from: 'caller', to: 'primary', signature: '<>(value:number):number', call: true },
    ],
    clean: [
      { from: 'caller', to: 'named', signature: '<>(value:number):number', call: true },
      { from: 'caller', to: 'named', signature: '<>(value:number):number', call: true },
      { from: 'caller', to: 'named', signature: '<>(value:number):number', call: true },
      { from: 'caller', to: 'primary', signature: '<>(value:number):number', call: true },
    ],
    dangling: [],
    patchCount: 4,
  })
})

test('equivalence partition: export default expression publishes a resolvable cached default binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-default-expression-'))
  const source = 'const selected = () => 1\nexport default selected\n'
  const sources = new Map([['src/value.ts', source]])
  const context = prepareSemanticProject(createSemanticProject(root, sources), root)
  const partition = parsePartition('src/value.ts', source, new Set(['src/value.ts']), context)

  assert.deepEqual(
    resolveCachedImport(new Map([['src/value.ts', partition]]), 'src/consumer.ts', { specifier: './value', remote: 'default' }),
    { id: 'eaa752546403cae48d7cea4d', file: 'src/value.ts', name: 'selected', kind: 'variable', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
  )
})

test('domain rule: export star does not forward the source module default binding', () => {
  const files = new Map([
    ['src/value.ts', { bindings: [{ kind: 'symbol', name: 'default', target: 'default-id' }], symbols: [{ id: 'default-id', file: 'src/value.ts', name: 'primary', kind: 'function' }] }],
    ['src/barrel.ts', { bindings: [{ kind: 'star', specifier: './value' }], symbols: [] }],
  ])

  assert.equal(resolveCachedImport(files, 'src/consumer.ts', { specifier: './barrel', remote: 'default' }), null)
})

test('domain rule: duplicate export-star candidates keep an ambiguous name unresolved', () => {
  const files = new Map([
    ['src/left.ts', { bindings: [{ kind: 'symbol', name: 'shared', target: 'left-id' }], symbols: [{ id: 'left-id', file: 'src/left.ts', name: 'shared', kind: 'function' }] }],
    ['src/right.ts', { bindings: [{ kind: 'symbol', name: 'shared', target: 'right-id' }], symbols: [{ id: 'right-id', file: 'src/right.ts', name: 'shared', kind: 'function' }] }],
    ['src/barrel.ts', { bindings: [{ kind: 'star', specifier: './left' }, { kind: 'star', specifier: './right' }], symbols: [] }],
  ])

  assert.equal(resolveCachedImport(files, 'src/consumer.ts', { specifier: './barrel', remote: 'shared' }), null)
})

test('semantic shape: cached static-member resolution uses the real method name and qualified path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-static-shape-'))
  const source = 'export class Worker { static run(){ return 1 } }\n'
  const sources = new Map([['src/worker.ts', source]])
  const context = prepareSemanticProject(createSemanticProject(root, sources), root)
  const partition = parsePartition('src/worker.ts', source, new Set(['src/worker.ts']), context)

  const resolved = resolveCachedImport(new Map([['src/worker.ts', partition]]), 'src/consumer.ts', { specifier: './worker', remote: 'Worker' }, 'run')

  assert.deepEqual(resolved && { file: resolved.file, name: resolved.name, kind: resolved.kind, qualifiedPath: resolved.qualifiedPath }, { file: 'src/worker.ts', name: 'run', kind: 'method', qualifiedPath: 'class:Worker' })
})

test('compatibility boundary: packed symbol schema v2 with the prior TypeScript cache key is rejected before adoption and safely rebuilt', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v2-cache-rejection-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1\n')
  const writer = new CodeGraphEngine(root, { cacheDir: '.cache' })
  const opened = []
  context.after(async () => { await writer.dispose(); await Promise.all(opened.map((engine) => engine.dispose())) })
  const built = await writer.build()
  const current = writer.readGeneration(built.generation)
  const currentPartitionId = current.partitions['src/value.ts']
  const legacyBytes = Buffer.from(fs.readFileSync(path.join(root, '.cache', 'partitions', `${currentPartitionId}.bin`)))
  legacyBytes.writeUInt32LE(2, 4)
  const legacyPartitionId = crypto.createHash('sha256').update(legacyBytes).digest('hex')
  fs.writeFileSync(path.join(root, '.cache', 'partitions', `${legacyPartitionId}.bin`), legacyBytes)
  const legacy = writer.store.publish({
    ...current,
    analyzers: { typescript: 'typescript-1' },
    partitions: { 'src/value.ts': legacyPartitionId },
    partitionHashes: { 'src/value.ts': legacyPartitionId },
  })
  await writer.dispose()

  const reader = new CodeGraphEngine(root, { cacheDir: '.cache' })
  opened.push(reader)
  const adoptedBeforeReconcile = reader.validatedGeneration
  const reconciled = await reader.reconcile()
  const graph = (await reader.queryBatch({ type: 'graph', generation: reconciled.generation, limit: 20 }))[0]

  assert.deepEqual({
    adoptedBeforeReconcile,
    rebuiltGenerationDiffers: reconciled.generation !== legacy.generation,
    analyzerMetadata: reader.readGeneration(reconciled.generation).analyzers,
    symbols: graph.symbols.map(({ file, name }) => ({ file, name })),
  }, {
    adoptedBeforeReconcile: null,
    rebuiltGenerationDiffers: true,
    analyzerMetadata: { typescript: 'typescript-2' },
    symbols: [{ file: 'src/value.ts', name: 'value' }],
  })
})
