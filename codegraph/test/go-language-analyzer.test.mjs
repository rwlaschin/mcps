import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const fixtureRoot = path.resolve(import.meta.dirname, 'fixtures/go-project')
const loadGoAnalyzer = () => import('../go-language-analyzer.mjs')
const hash = (source) => crypto.createHash('sha256').update(source).digest('hex')
const sources = () => new Map([
  ['cmd/app/main.go', fs.readFileSync(path.join(fixtureRoot, 'cmd/app/main.go'), 'utf8')],
  ['model/user.go', fs.readFileSync(path.join(fixtureRoot, 'model/user.go'), 'utf8')],
  ['service/service.go', fs.readFileSync(path.join(fixtureRoot, 'service/service.go'), 'utf8')],
])

async function indexFixture() {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const analyzer = createGoLanguageAnalyzer(fixtureRoot)
  const worker = analyzer.createSemanticWorker()
  const input = sources()
  const result = await worker.index({ root: fixtureRoot, sources: [...input], sourceBlobs: Object.fromEntries([...input].map(([file, source]) => [file, hash(source)])) })
  await worker.dispose()
  return result
}

test('equivalence partition: Go analyzer declares only Go source and Go workspace controls', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const analyzer = createGoLanguageAnalyzer(fixtureRoot)

  assert.deepEqual(
    { id: analyzer.id, extensions: [...analyzer.extensions], controlFiles: [...analyzer.controlFiles] },
    { id: 'go', extensions: ['.go'], controlFiles: ['go.mod', 'go.sum', 'go.work'] },
  )
})

test('domain analysis: real Go semantic indexing emits types functions and methods with stable public kinds', async () => {
  const result = await indexFixture()
  const symbols = Object.values(result.partitions).flatMap((partition) => partition.symbols).map(({ file, name, kind }) => ({ file, name, kind })).sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`))

  assert.deepEqual(symbols, [
    { file: 'cmd/app/main.go', name: 'main', kind: 'function' },
    { file: 'model/user.go', name: 'Greeting', kind: 'method' },
    { file: 'model/user.go', name: 'NewUser', kind: 'function' },
    { file: 'model/user.go', name: 'User', kind: 'type' },
    { file: 'service/service.go', name: 'Welcome', kind: 'function' },
    { file: 'service/service.go', name: 'helper', kind: 'function' },
  ])
})

test('equivalence partition: Go export flags follow identifier visibility rather than file location', async () => {
  const result = await indexFixture()
  const exports = Object.values(result.partitions).flatMap((partition) => partition.symbols).map(({ name, exported }) => ({ name, exported })).sort((left, right) => left.name.localeCompare(right.name))

  assert.deepEqual(exports, [
    { name: 'Greeting', exported: true },
    { name: 'main', exported: false },
    { name: 'NewUser', exported: true },
    { name: 'User', exported: true },
    { name: 'Welcome', exported: true },
    { name: 'helper', exported: false },
  ])
})

test('domain analysis: Go package imports become normalized in-project file dependencies without standard-library noise', async () => {
  const result = await indexFixture()
  const dependencies = Object.fromEntries(Object.entries(result.partitions).map(([file, partition]) => [file, partition.dependencies]))

  assert.deepEqual(dependencies, {
    'cmd/app/main.go': ['service/service.go'],
    'model/user.go': [],
    'service/service.go': ['model/user.go'],
  })
})

test('domain analysis: Go calls resolve across packages and receiver methods to existing symbol identifiers', async () => {
  const result = await indexFixture()
  const symbols = Object.values(result.partitions).flatMap((partition) => partition.symbols)
  const names = new Map(symbols.map((symbol) => [symbol.id, symbol.name]))
  const calls = Object.values(result.partitions).flatMap((partition) => partition.edges).filter((edge) => edge.call).map((edge) => `${names.get(edge.from)} -> ${names.get(edge.to)}`).sort()

  assert.deepEqual(calls, ['Welcome -> Greeting', 'Welcome -> NewUser', 'main -> Welcome'])
})

test('error guessing: missing Go helper or toolchain fails explicitly instead of publishing empty partitions', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const analyzer = createGoLanguageAnalyzer(fixtureRoot, { command: path.join(fixtureRoot, 'missing-go-helper') })
  const worker = analyzer.createSemanticWorker()

  await assert.rejects(worker.index({ root: fixtureRoot, sources: [], sourceBlobs: {} }), /go.*(?:helper|toolchain|spawn|ENOENT)|ENOENT.*go/i)
  await worker.dispose()
})

test('error guessing: malformed helper output rejects the operation rather than returning a partial generation', async () => {
  const { validateGoAnalyzerResult } = await loadGoAnalyzer()

  assert.throws(() => validateGoAnalyzerResult({ partitions: { 'model/user.go': { file: 'wrong.go', symbols: [], edges: [], dependencies: [] } } }, ['model/user.go']), /partition|membership|wrong\.go/i)
})

test('domain analysis: a leaf edit reparses its package without invalidating unrelated packages', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const analyzer = createGoLanguageAnalyzer(fixtureRoot)
  const worker = analyzer.createSemanticWorker()
  const input = sources()
  await worker.index({ root: fixtureRoot, sources: [...input], sourceBlobs: Object.fromEntries([...input].map(([file, source]) => [file, hash(source)])) })
  const changedSource = input.get('cmd/app/main.go').replace('"Ada"', '"Grace"')
  const result = await worker.validate({ root: fixtureRoot, revision: 1, changes: [{ type: 'change', path: 'cmd/app/main.go', source: changedSource }] })
  await worker.dispose()

  assert.deepEqual(result.validatedFiles, ['cmd/app/main.go'])
})

test('domain analysis: an exported package edit validates its complete reverse-import cascade', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const analyzer = createGoLanguageAnalyzer(fixtureRoot)
  const worker = analyzer.createSemanticWorker()
  const input = sources()
  await worker.index({ root: fixtureRoot, sources: [...input], sourceBlobs: Object.fromEntries([...input].map(([file, source]) => [file, hash(source)])) })
  const changedSource = input.get('model/user.go').replace('Greeting() string', 'Greeting(prefix string) string').replace('return "hello " + user.Name', 'return prefix + user.Name')
  const result = await worker.validate({ root: fixtureRoot, revision: 1, changes: [{ type: 'change', path: 'model/user.go', source: changedSource }] })
  await worker.dispose()

  assert.deepEqual(result.validatedFiles, ['cmd/app/main.go', 'model/user.go', 'service/service.go'])
})

test('error guessing: restoring an edited Go file produces the exact original partitions', async () => {
  const original = await indexFixture()
  const second = await indexFixture()

  assert.deepEqual(second.partitions, original.partitions)
})
