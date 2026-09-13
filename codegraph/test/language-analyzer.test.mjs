import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CodeGraphEngine } from '../tool-engine.mjs'

const fixtureDirectory = new URL('./fixtures/typescript-analyzer-baseline/', import.meta.url)
const expected = JSON.parse(fs.readFileSync(new URL('expected.json', fixtureDirectory), 'utf8'))
const loadRegistry = () => import('../language-analyzer.mjs')
const loadTypeScriptAnalyzer = () => import('../typescript-language-analyzer.mjs')
const descriptor = (id, extensions, controlFiles = []) => ({
  id, extensions, controlFiles, cacheKey: `${id}-1`,
  createSourceMatcher() {}, createProvisionalResolver() {}, createSemanticWorker() {},
})
const copyFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-typescript-boundary-'))
  fs.cpSync(fixtureDirectory, root, { recursive: true })
  return root
}

test('equivalence partition: zero analyzers owns no source or control path', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [])
  assert.deepEqual(
    { source: registry.analyzerFor('src/main.ts') ?? null, control: registry.analyzerFor('tsconfig.json') ?? null, extensions: [...registry.extensions], controlFiles: [...registry.controlFiles] },
    { source: null, control: null, extensions: [], controlFiles: [] },
  )
})

test('equivalence partition: TypeScript and JavaScript suffixes route to one analyzer while unsupported files do not', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'], ['tsconfig.json', 'jsconfig.json'])])
  assert.deepEqual(
    ['main.ts', 'view.tsx', 'legacy.js', 'view.jsx', 'module.mts', 'module.cts', 'module.mjs', 'module.cjs', 'README.md'].map((file) => registry.analyzerFor(file)?.id ?? null),
    ['typescript', 'typescript', 'typescript', 'typescript', 'typescript', 'typescript', 'typescript', 'typescript', null],
  )
})

test('boundary analysis: duplicate extension ownership fails before either analyzer is usable', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('first', ['.ts']), () => descriptor('second', ['.ts'])]), /duplicate|already.*\.ts|\.ts.*owned/i)
})

test('performance regression: factories and registry iteration stay constant while routing ten thousand files', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  let factoryCalls = 0
  let iteratorCalls = 0
  const factories = new Proxy([
    () => { factoryCalls += 1; return descriptor('typescript', ['.ts']) },
    () => { factoryCalls += 1; return descriptor('javascript', ['.js']) },
  ], { get(target, key, receiver) { if (key === Symbol.iterator) iteratorCalls += 1; return Reflect.get(target, key, receiver) } })
  const registry = createLanguageAnalyzers('/repo', factories)
  const afterConstruction = { factoryCalls, iteratorCalls }
  let index = 0
  while (index < 10_000) { registry.analyzerFor(index % 2 ? `src/file-${index}.ts` : `src/file-${index}.js`); index += 1 }
  assert.deepEqual(
    { afterConstruction, afterRouting: { factoryCalls, iteratorCalls } },
    { afterConstruction: { factoryCalls: 2, iteratorCalls: 1 }, afterRouting: { factoryCalls: 2, iteratorCalls: 1 } },
  )
})

test('transaction boundary: staging a TypeScript edit does not advance visible state', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]) })
  await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const renamed = 2\n' }], 1)
  assert.deepEqual(
    { revision: resolver.snapshot().revision, symbols: resolver.snapshot().symbols.map(({ name }) => name) },
    { revision: 0, symbols: ['value'] },
  )
})

test('transaction boundary: commit publishes one staged TypeScript revision', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]) })
  const staged = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const renamed = 2\n' }], 1)
  resolver.commit(staged)
  assert.deepEqual(
    { revision: resolver.snapshot().revision, symbols: resolver.snapshot().symbols.map(({ name }) => name) },
    { revision: 1, symbols: ['renamed'] },
  )
})

test('transaction boundary: discard preserves the prior TypeScript revision', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]) })
  const staged = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const renamed = 2\n' }], 1)
  resolver.discard(staged)
  assert.deepEqual(
    { revision: resolver.snapshot().revision, symbols: resolver.snapshot().symbols.map(({ name }) => name) },
    { revision: 0, symbols: ['value'] },
  )
})

test('cache compatibility: a manifest without analyzer metadata remains valid for a TypeScript and JavaScript repository', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts', '.js'], ['tsconfig.json', 'jsconfig.json'])])
  assert.equal(registry.isManifestCompatible({ version: 3 }, ['src/value.ts', 'src/consumer.js', 'tsconfig.json']), true)
})

test('cache compatibility: a legacy TypeScript manifest cannot activate when another analyzer owns current source', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [
    () => descriptor('typescript', ['.ts', '.js'], ['tsconfig.json', 'jsconfig.json']),
    () => descriptor('go', ['.go'], ['go.mod', 'go.sum', 'go.work', 'go.work.sum']),
  ])
  assert.equal(registry.isManifestCompatible({ version: 3 }, ['src/value.ts', 'cmd/server/main.go', 'go.mod']), false)
})

test('parity fixture: TypeScript and JavaScript partition bytes and normalized manifest remain exact', async () => {
  const root = copyFixture()
  const engine = new CodeGraphEngine(root)
  try {
    const built = await engine.build()
    const manifest = engine.readGeneration(built.generation)
    const normalized = { version: manifest.version, root: '<root>', edgeCoverage: manifest.edgeCoverage, controlHashes: manifest.controlHashes, sources: manifest.sources, partitions: manifest.partitions, partitionHashes: manifest.partitionHashes }
    const consumer = fs.readFileSync(path.join(root, '.codegraph', 'partitions', `${manifest.partitions['src/consumer.js']}.json`))
    const value = fs.readFileSync(path.join(root, '.codegraph', 'partitions', `${manifest.partitions['src/value.ts']}.json`))
    assert.deepEqual(
      { normalized, consumerBytesEqual: consumer.equals(Buffer.from(expected.partitionBase64['src/consumer.js'], 'base64')), valueBytesEqual: value.equals(Buffer.from(expected.partitionBase64['src/value.ts'], 'base64')) },
      { normalized: expected.manifest, consumerBytesEqual: true, valueBytesEqual: true },
    )
  } finally {
    await engine.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('parity fixture: TypeScript and JavaScript validated query rows remain exact', async () => {
  const root = copyFixture()
  const engine = new CodeGraphEngine(root)
  try {
    await engine.build()
    const refs = await engine.queryBatch({ type: 'refs', name: 'value', resolved: true, limit: 200 })
    const deps = await engine.queryBatch({ type: 'deps', name: 'answer', resolved: true, limit: 200 })
    assert.deepEqual(
      { refs: refs.map(({ fromSymbol, toSymbol }) => `${fromSymbol.file}:${fromSymbol.line} -> ${toSymbol.file}:${toSymbol.line}`), deps: deps.map(({ fromSymbol, toSymbol, call }) => `${fromSymbol.file}:${fromSymbol.line} -> ${toSymbol.file}:${toSymbol.line}${call ? ' call' : ''}`) },
      { refs: [expected.mcpReceipts.refs], deps: [expected.mcpReceipts.deps] },
    )
  } finally {
    await engine.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
