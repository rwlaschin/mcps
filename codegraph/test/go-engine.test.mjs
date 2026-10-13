import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodeGraphEngine } from '../tool-engine.mjs'

test('equivalence partition: a Go-only repository publishes its function through the existing graph', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-only-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  assert.deepEqual(engine.snapshot().symbols.map(({ file, name }) => ({ file, name })), [{ file: 'main.go', name: 'main' }])
})

test('all-pairs and domain analysis: TypeScript include patterns do not hide Go in a mixed repository', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-mixed-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"include":["src/*.ts"]}')
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  fs.writeFileSync(path.join(root, 'src', 'web.ts'), 'export function webOnly() { return 1 }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  assert.deepEqual(Object.keys(engine.readGeneration().sources).sort(), ['main.go', 'src/web.ts'])
})

test('boundary analysis: a one-file Go edit validates exactly that file and preserves peer symbols', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-one-edit-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() { helper() }\n')
  fs.writeFileSync(path.join(root, 'helper.go'), 'package main\nfunc helper() int { return 1 }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const result = engine.applyChanges([{ type: 'change', path: 'helper.go', source: 'package main\nfunc helper() int { return 2 }\n' }])
  const validated = await result.validation
  assert.deepEqual({ mode: validated.validationMode, files: validated.validatedFiles, names: engine.snapshot().symbols.map(({ name }) => name).sort(), cachedReferencesVisited: validated.workCounters.cachedReferencesVisited, changedSourcesParsed: validated.workCounters.changedSourcesParsed, dependentSourcesRead: validated.workCounters.dependentSourcesRead }, { mode: 'delta', files: ['helper.go'], names: ['helper', 'main'], cachedReferencesVisited: 0, changedSourcesParsed: 1, dependentSourcesRead: 0 })
})

test('error guessing: a Go-only generation contains a proven same-package call', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-call-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() { helper() }\n')
  fs.writeFileSync(path.join(root, 'helper.go'), 'package main\nfunc helper() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual(graph.edges.filter(({ call }) => call).map(({ from, to }) => ({ from: names.get(from), to: names.get(to) })), [{ from: 'main', to: 'helper' }])
})

test('all-pairs: a TypeScript edit in a mixed repository retains the Go partition', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mixed-ts-edit-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  fs.writeFileSync(path.join(root, 'web.ts'), 'export function webOnly() { return 1 }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const priorGoPartition = engine.readGeneration().partitions['main.go']
  const validated = await engine.applyChanges([{ type: 'change', path: 'web.ts', source: 'export function webOnly() { return 2 }\n' }]).validation
  assert.deepEqual({ mode: validated.validationMode, files: validated.validatedFiles, goPartitionRetained: engine.readGeneration().partitions['main.go'] === priorGoPartition }, { mode: 'delta', files: ['web.ts'], goPartitionRetained: true })
})

test('all-pairs: a Go edit in a mixed repository retains the TypeScript partition', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mixed-go-edit-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  fs.writeFileSync(path.join(root, 'web.ts'), 'export function webOnly() { return 1 }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const priorTsPartition = engine.readGeneration().partitions['web.ts']
  const validated = await engine.applyChanges([{ type: 'change', path: 'main.go', source: 'package main\nfunc main() { var x = 1; _ = x }\n' }]).validation
  assert.deepEqual({ mode: validated.validationMode, files: validated.validatedFiles, tsPartitionRetained: engine.readGeneration().partitions['web.ts'] === priorTsPartition }, { mode: 'delta', files: ['main.go'], tsPartitionRetained: true })
})

test('error guessing: a fresh engine hydrates persisted Go rows and validates only the changed file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-hydrate-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() { helper() }\n')
  fs.writeFileSync(path.join(root, 'helper.go'), 'package main\nfunc helper() int { return 1 }\n')
  const builder = new CodeGraphEngine(root)
  await builder.build()
  await builder.dispose()
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  const validated = await engine.applyChanges([{ type: 'change', path: 'helper.go', source: 'package main\nfunc helper() int { return 2 }\n' }]).validation
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual({ mode: validated.validationMode, files: validated.validatedFiles, calls: graph.edges.filter(({ call }) => call).map(({ from, to }) => ({ from: names.get(from), to: names.get(to) })) }, { mode: 'delta', files: ['helper.go'], calls: [{ from: 'main', to: 'helper' }] })
})

test('domain analysis: deleting and readding a Go target restores its cached caller without parsing the caller', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-readd-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() { helper() }\n')
  fs.writeFileSync(path.join(root, 'helper.go'), 'package main\nfunc helper() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  await engine.applyChanges([{ type: 'unlink', path: 'helper.go' }]).validation
  const validated = await engine.applyChanges([{ type: 'add', path: 'helper.go', source: 'package main\nfunc helper() {}\n' }]).validation
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual({ files: validated.validatedFiles, calls: graph.edges.filter(({ call }) => call).map(({ from, to }) => ({ from: names.get(from), to: names.get(to) })) }, { files: ['helper.go'], calls: [{ from: 'main', to: 'helper' }] })
})

test('equivalence partition: an import alias resolves a proven local module function', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-alias-'))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nimport alias "example.com/app/lib"\nfunc main() { alias.Run() }\n')
  fs.writeFileSync(path.join(root, 'lib', 'run.go'), 'package lib\nfunc Run() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual(graph.edges.filter(({ call }) => call).map(({ from, to }) => ({ from: names.get(from), to: names.get(to) })), [{ from: 'main', to: 'Run' }])
})

test('error guessing: a local receiver shadowing an import does not call that imported function', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-shadow-'))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nimport alias "example.com/app/lib"\nfunc main() { alias := struct{ Run func() }{Run: func(){}}; alias.Run() }\n')
  fs.writeFileSync(path.join(root, 'lib', 'run.go'), 'package lib\nfunc Run() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const graph = engine.snapshot()
  const importedRun = graph.symbols.find(({ file, name }) => file === 'lib/run.go' && name === 'Run')
  assert.deepEqual(graph.edges.filter(({ call, to }) => call && to === importedRun.id), [])
})

test('boundary analysis: malformed Go syntax fails without publishing a replacement generation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-malformed-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const generation = engine.store.currentGeneration()
  await assert.rejects(engine.applyChanges([{ type: 'change', path: 'main.go', source: 'package main\nfunc main( {\n' }]).validation, /syntax|parse|malformed|invalid/i)
  assert.equal(engine.store.currentGeneration(), generation)
})

test('domain analysis: build-constrained and cgo sources do not enter the supported Go generation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-unsupported-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  fs.writeFileSync(path.join(root, 'tagged.go'), '//go:build custom\n\npackage main\nfunc tagged() {}\n')
  fs.writeFileSync(path.join(root, 'cgo.go'), 'package main\nimport "C"\nfunc nativeOnly() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  assert.deepEqual(Object.keys(engine.readGeneration().sources), ['main.go'])
})

test('domain analysis: explicit local and package receivers resolve methods while generic receivers remain conservative', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-receiver-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\ntype User struct {}\nfunc (user User) Greeting() {}\nvar Global User\nfunc main() { var user User; user.Greeting(); Global.Greeting() }\ntype Box[T any] struct {}\nfunc (box Box[T]) Method() {}\nfunc generic() { var box Box[int]; box.Method(); Method() }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual({ calls: graph.edges.filter(({ call }) => call).map(({ from, to }) => ({ from: names.get(from), to: names.get(to) })), genericMethodKind: graph.symbols.find(({ name }) => name === 'Method').kind }, { calls: [{ from: 'main', to: 'Greeting' }, { from: 'main', to: 'Greeting' }], genericMethodKind: 'method' })
})

test('error guessing: two same-package declarations with the same name do not create a guessed call', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-ambiguous-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() { helper() }\n')
  fs.writeFileSync(path.join(root, 'first.go'), 'package main\nfunc helper() {}\n')
  fs.writeFileSync(path.join(root, 'second.go'), 'package main\nfunc helper() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  assert.deepEqual(engine.snapshot().edges.filter(({ call }) => call), [])
})

test('domain analysis: renaming an exported Go target drops the cached imported call', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-rename-'))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nimport "example.com/app/lib"\nfunc main() { lib.Run() }\n')
  fs.writeFileSync(path.join(root, 'lib', 'run.go'), 'package lib\nfunc Run() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const validated = await engine.applyChanges([{ type: 'change', path: 'lib/run.go', source: 'package lib\nfunc Renamed() {}\n' }]).validation
  assert.deepEqual({ files: validated.validatedFiles, calls: engine.snapshot().edges.filter(({ call }) => call) }, { files: ['lib/run.go'], calls: [] })
})

test('error guessing: a pinned Go symbol query retains its old generation after an edit publishes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-pin-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc oldName() {}\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const pinned = engine.pinQuery({ type: 'symbols', file: 'main.go' })
  await engine.applyChanges([{ type: 'change', path: 'main.go', source: 'package main\nfunc newName() {}\n' }]).validation
  const rows = []
  for await (const row of pinned.rows) rows.push(row.name)
  assert.deepEqual(rows, ['oldName'])
})

test('domain analysis: Go if and else return arms are reachable and switch metrics count case alternatives', async () => {
  const { buildGoFileFacts } = await import('../go-language-analyzer.mjs')
  const { internal } = await buildGoFileFacts('main.go', 'package main\nfunc choose(flag bool) int {\n if flag {\n  return 1\n } else {\n  return 2\n }\n}\nfunc chooseCase(value int) int {\n switch value {\n case 1: return 1\n case 2: return 2\n default: return 0\n }\n}\n')
  const condition = internal.nodes.find(({ kind }) => kind === 'condition')
  const owner = internal.owners.find(({ name }) => name === 'choose')
  const switchOwner = internal.owners.find(({ name }) => name === 'chooseCase')
  assert.deepEqual({ metrics: { cyclomatic: owner.cyclomatic, branchCount: owner.branchCount, nestingDepth: owner.nestingDepth }, switchMetrics: { cyclomatic: switchOwner.cyclomatic, branchCount: switchOwner.branchCount, nestingDepth: switchOwner.nestingDepth }, returns: internal.nodes.filter(({ kind, ownerId }) => kind === 'return' && ownerId === owner.id).map(({ line, unreachable }) => ({ line, unreachable: Boolean(unreachable) })), arms: internal.edges.filter(({ from }) => from === condition.id).map(({ kind, to }) => ({ kind, line: internal.nodes[to].line })).sort((left, right) => left.line - right.line) }, { metrics: { cyclomatic: 2, branchCount: 1, nestingDepth: 1 }, switchMetrics: { cyclomatic: 3, branchCount: 1, nestingDepth: 1 }, returns: [{ line: 4, unreachable: false }, { line: 6, unreachable: false }], arms: [{ kind: 'true', line: 4 }, { kind: 'false', line: 6 }] })
})

test('error guessing: Go break and continue target the loop while code after the loop remains reachable', async () => {
  const { buildGoFileFacts } = await import('../go-language-analyzer.mjs')
  const { internal } = await buildGoFileFacts('main.go', 'package main\nfunc loop(flag bool) {\n for flag {\n  if flag { break }\n  continue\n }\n helper()\n}\n')
  assert.deepEqual({ jumps: internal.edges.filter(({ kind }) => kind === 'break' || kind === 'continue').map(({ from, to, kind }) => ({ from: internal.nodes[from].line, to: internal.nodes[to].line, kind })).sort((left, right) => left.from - right.from), afterLoop: internal.nodes.filter(({ kind, line }) => kind === 'call' && line === 7).map(({ unreachable }) => Boolean(unreachable)) }, { jumps: [{ from: 4, to: 7, kind: 'break' }, { from: 5, to: 3, kind: 'continue' }], afterLoop: [false] })
})

test('domain analysis: a return in a nested Go function does not make its outer continuation unreachable', async () => {
  const { buildGoFileFacts, createGoLanguageAnalyzer } = await import('../go-language-analyzer.mjs')
  const { decodeInternalPartition } = await import('../store.mjs')
  const source = 'package main\nfunc outer() {\n fn := func() { helper(); return }\n fn()\n helper()\n}\nfunc helper() {}\n'
  const { internal } = await buildGoFileFacts('main.go', source)
  const owner = internal.owners.find(({ name }) => name === 'outer')
  const nested = internal.owners.find(({ name }) => name === '<anonymous>')
  const root = path.resolve(import.meta.dirname, '..')
  const worker = createGoLanguageAnalyzer(root).createSemanticWorker()
  try {
    const result = await worker.index({ root, sources: [['main.go', source]], sourceBlobs: {} })
    const partition = result.partitions['main.go']
    const names = new Map(partition.symbols.map(({ id, name }) => [id, name]))
    const encodedInternal = decodeInternalPartition(partition.internalPartition)
    assert.deepEqual({ nestedHasOuterParent: nested.parentOwnerId === owner.id, nestedHasNoNamedSymbol: nested.symbolId === undefined, outerCalls: internal.nodes.filter(({ ownerId, kind }) => ownerId === owner.id && kind === 'call').map(({ line, unreachable }) => ({ line, unreachable: Boolean(unreachable) })), namedCalls: partition.edges.filter(({ call }) => call).map(({ from, to, line }) => ({ from: names.get(from), to: names.get(to), line })), nestedRelationTargets: encodedInternal.relations.filter(({ ownerId }) => ownerId === nested.id).map(({ targetSymbolId }) => names.get(targetSymbolId)) }, { nestedHasOuterParent: true, nestedHasNoNamedSymbol: true, outerCalls: [{ line: 4, unreachable: false }, { line: 5, unreachable: false }], namedCalls: [{ from: 'outer', to: 'helper', line: 3 }, { from: 'outer', to: 'helper', line: 5 }], nestedRelationTargets: ['helper'] })
  } finally { await worker.dispose() }
})

test('error guessing: a fresh mixed engine can edit Go then TypeScript while retaining the other partition', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-mixed-hydrate-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  fs.writeFileSync(path.join(root, 'web.ts'), 'export function webOnly() { return 1 }\n')
  const builder = new CodeGraphEngine(root)
  await builder.build()
  const priorTsPartition = builder.readGeneration().partitions['web.ts']
  await builder.dispose()
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  const goValidated = await engine.applyChanges([{ type: 'change', path: 'main.go', source: 'package main\nfunc main() { var x = 1; _ = x }\n' }]).validation
  const tsPartitionRetained = engine.readGeneration().partitions['web.ts'] === priorTsPartition
  const priorGoPartition = engine.readGeneration().partitions['main.go']
  const tsValidated = await engine.applyChanges([{ type: 'change', path: 'web.ts', source: 'export function webOnly() { return 2 }\n' }]).validation
  assert.deepEqual({ goFiles: goValidated.validatedFiles, tsFiles: tsValidated.validatedFiles, names: engine.snapshot().symbols.map(({ name }) => name).sort(), tsPartitionRetained, goPartitionRetained: engine.readGeneration().partitions['main.go'] === priorGoPartition }, { goFiles: ['main.go'], tsFiles: ['web.ts'], names: ['main', 'webOnly'], tsPartitionRetained: true, goPartitionRetained: true })
})

test('domain analysis: rebuilding a mixed control context leaves the next Go edit usable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-control-rebuild-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
  fs.writeFileSync(path.join(root, 'web.ts'), 'export function webOnly() { return 1 }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/rebuilt\n\ngo 1.22\n')
  await engine.build()
  const validated = await engine.applyChanges([{ type: 'change', path: 'main.go', source: 'package main\nfunc main() { var x = 1; _ = x }\n' }]).validation
  assert.deepEqual({ mode: validated.validationMode, files: validated.validatedFiles, names: engine.snapshot().symbols.map(({ name }) => name).sort() }, { mode: 'delta', files: ['main.go'], names: ['main', 'webOnly'] })
})

test('domain analysis: named results and every multi-name local declaration shadow package symbols', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-local-shadow-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc Value() int { return 1 }\nfunc B() int { return 2 }\nconst C = 3\nfunc result() (Value int) { return Value }\nfunc variables() { var a, B int; _ = a; _ = B }\nfunc constants() { const a, C = 1, 2; _ = a; _ = C }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual(graph.edges.map(({ from, to, call }) => ({ from: names.get(from), to: names.get(to), call })), [])
})

test('error guessing: unknown and generic local receivers never borrow package receiver types or bare methods', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-unknown-receiver-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\ntype User struct {}\nfunc (user User) M() {}\nvar x User\ntype T struct {}\nfunc (value T) M() {}\nfunc M() {}\nfunc Dynamic(x interface{ M() }) { x.M() }\nfunc Generic[T interface{ M() }](x T) { x.M() }\nfunc factory() struct{ Field interface{ M() } } { return struct{ Field interface{ M() } }{} }\nfunc Chained() { f := factory(); f.Field.M() }\n')
  const engine = new CodeGraphEngine(root)
  t.after(async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  await engine.build()
  const graph = engine.snapshot()
  const names = new Map(graph.symbols.map(({ id, name }) => [id, name]))
  assert.deepEqual(graph.edges.map(({ from, to, call }) => ({ from: names.get(from), to: names.get(to), call })), [{ from: 'Chained', to: 'factory', call: true }])
})
