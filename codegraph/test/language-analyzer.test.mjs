import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
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

test('domain analysis: staging one TypeScript body edit reports only that file as parsed and resolved and every peer as reused', async () => {
  const events = []
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', {
    sources: new Map([
      ['src/exported.ts', 'export function target(){ return 1 }\n'],
      ['src/importer.ts', "import { target } from './exported'\nexport function caller(){ return target() }\n"],
      ['src/unrelated.ts', 'export const unrelated = 1\n'],
    ]),
    onWork: (event) => events.push(event),
  })

  await resolver.stageChanges([{ type: 'change', path: 'src/exported.ts', source: 'export function target(){ return 2 }\n' }], 1)

  assert.deepEqual(events, [{
    type: 'work',
    mutationFile: 'src/exported.ts',
    parsedFiles: ['src/exported.ts'],
    resolvedFiles: ['src/exported.ts'],
    reusedFiles: ['src/importer.ts', 'src/unrelated.ts'],
    fullRebuild: false,
  }])
})

test('error guessing: a staged TypeScript edit shares the caller-owned parser pool and neither discard nor wrapper disposal owns it', async () => {
  let disposals = 0
  const parserPool = { dispose: async () => { disposals += 1 } }
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', {
    sources: new Map([['src/value.ts', 'export const value = 1\n']]),
    parserPool,
  })
  const staged = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const value = 2\n' }], 1)
  const shared = staged.next.parserPool === parserPool

  resolver.discard(staged)
  await resolver.dispose()

  assert.deepEqual({ shared, disposals }, { shared: true, disposals: 0 })
})

test('error guessing: repeated TypeScript stage and discard cycles leave the current snapshot unchanged without accumulating staged symbols', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]) })

  const first = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const first = 2\n' }], 1)
  resolver.discard(first)
  const second = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const second = 3\n' }], 1)
  resolver.discard(second)

  assert.deepEqual(
    { revision: resolver.snapshot().revision, symbols: resolver.snapshot().symbols.map(({ name }) => name) },
    { revision: 0, symbols: ['value'] },
  )
})

test('error guessing: an internally owned parser pool is shared by discarded forks and disposed exactly once by repeated wrapper disposal', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]) })
  const first = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const first = 2\n' }], 1)
  const parserPool = first.next.parserPool
  const originalDispose = parserPool.dispose.bind(parserPool)
  let disposals = 0
  parserPool.dispose = async () => { disposals += 1; await originalDispose() }
  resolver.discard(first)
  const second = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const second = 3\n' }], 1)
  const shared = second.next.parserPool === parserPool
  resolver.discard(second)

  await resolver.dispose()
  await resolver.dispose()

  assert.deepEqual({ shared, disposals }, { shared: true, disposals: 1 })
})

test('error guessing: committing one sibling stage makes its same-base sibling stale without losing the first commit', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]) })
  const first = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const first = 2\n' }], 1)
  const stale = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const stale = 3\n' }], 1)

  resolver.commit(first)
  assert.throws(() => resolver.commit(stale), /stale|base revision|revision/i)

  assert.deepEqual(
    { revision: resolver.snapshot().revision, symbols: resolver.snapshot().symbols.map(({ name }) => name) },
    { revision: 1, symbols: ['first'] },
  )
})

test('boundary analysis: one hundred sequential stage and commit cycles keep the next fork rooted in one flat map', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 0\n']]) })
  for (let revision = 1; revision <= 100; revision += 1) {
    const staged = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: `export const value = ${revision}\n` }], revision)
    resolver.commit(staged)
  }

  const probe = await resolver.stageChanges([{ type: 'change', path: 'src/value.ts', source: 'export const value = 101\n' }], 101)

  assert.deepEqual(
    { revision: resolver.snapshot().revision, baseIsFlatMap: probe.next.files.base instanceof Map, stagedChangeCount: probe.next.files.changes.size },
    { revision: 100, baseIsFlatMap: true, stagedChangeCount: 1 },
  )
})

test('combinatorial worker boundary: disk-backed analyzer staging sends four files through the existing configured three-worker pool', async () => {
  const dispatches = []
  const parserPool = {
    parse: async (request) => {
      dispatches.push(request)
      return { file: request.path, digest: `${request.fileId}-digest`, stateHash: 1, sourceBytes: 1, nodeCount: 1, symbols: [], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }
    },
    dispose: async () => {},
    snapshot: () => ({ workerCount: 3, queued: 0, inFlight: 0, latestRevisionByFile: {} }),
  }
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map(), parserPool })

  const staged = await resolver.stageFileChanges([
    { type: 'add', path: 'src/a.ts', fileId: 'a' },
    { type: 'add', path: 'src/b.ts', fileId: 'b' },
    { type: 'add', path: 'src/c.ts', fileId: 'c' },
    { type: 'add', path: 'src/d.ts', fileId: 'd' },
  ], 1)

  assert.deepEqual(
    { dispatches, pool: staged.next.parserPool.snapshot() },
    {
      dispatches: [
        { path: 'src/a.ts', fileId: 'a', revision: 1 },
        { path: 'src/b.ts', fileId: 'b', revision: 1 },
        { path: 'src/c.ts', fileId: 'c', revision: 1 },
        { path: 'src/d.ts', fileId: 'd', revision: 1 },
      ],
      pool: { workerCount: 3, queued: 0, inFlight: 0, latestRevisionByFile: {} },
    },
  )
})

test('boundary analysis: disk-backed analyzer staging sends one changed file through the shared pool exactly once', async () => {
  const dispatches = []
  const parserPool = {
    parse: async (request) => {
      dispatches.push(request)
      return { file: 'src/value.ts', digest: 'value-2', stateHash: 2, sourceBytes: 1, nodeCount: 1, symbols: [], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }
    },
    dispose: async () => {},
    snapshot: () => ({ workerCount: 3, queued: 0, inFlight: 0, latestRevisionByFile: {} }),
  }
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const resolver = createTypeScriptLanguageAnalyzer().createProvisionalResolver('/repo', { sources: new Map([['src/value.ts', 'export const value = 1\n']]), parserPool })

  await resolver.stageFileChanges([{ type: 'change', path: 'src/value.ts', fileId: 'value-file' }], 1)

  assert.deepEqual(dispatches, [{ path: 'src/value.ts', fileId: 'value-file', revision: 1 }])
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

// Equivalence, boundary, all-pairs, error-guessing and domain analysis:
// count zero/one/many × current/missing/stale metadata × TS-only/mixed ownership.
for (const { name, manifest, counts, compatible } of [
  { name: 'one active TypeScript owner accepts its matching cache key', manifest: { analyzers: { typescript: 'typescript-1' } }, counts: [['typescript', 1]], compatible: true },
  { name: 'many active TypeScript owners reject a stale cache key', manifest: { analyzers: { typescript: 'typescript-0' } }, counts: [['typescript', 30]], compatible: false },
  { name: 'an active TypeScript owner rejects a missing cache key', manifest: { analyzers: {} }, counts: [['typescript', 1]], compatible: false },
  { name: 'zero Go owners ignore a stale inactive Go cache key', manifest: { analyzers: { typescript: 'typescript-1', go: 'go-0' } }, counts: [['typescript', 1], ['go', 0]], compatible: true },
  { name: 'one active Go owner rejects its stale cache key', manifest: { analyzers: { typescript: 'typescript-1', go: 'go-0' } }, counts: [['typescript', 1], ['go', 1]], compatible: false },
  { name: 'mixed active owners accept both matching cache keys', manifest: { analyzers: { typescript: 'typescript-1', go: 'go-1' } }, counts: [['typescript', 1], ['go', 1]], compatible: true },
  { name: 'legacy metadata accepts TypeScript with inactive Go', manifest: { version: 3 }, counts: [['typescript', 1], ['go', 0]], compatible: true },
  { name: 'legacy metadata rejects an active Go owner', manifest: { version: 3 }, counts: [['typescript', 1], ['go', 1]], compatible: false },
  { name: 'empty maintained counts accept an empty generation', manifest: { analyzers: {} }, counts: [], compatible: true },
]) {
  test(`maintained analyzer counts: ${name}`, async () => {
    const { createLanguageAnalyzers } = await loadRegistry()
    const registry = createLanguageAnalyzers('/repo', [
      () => descriptor('typescript', ['.ts', '.js'], ['tsconfig.json', 'jsconfig.json']),
      () => descriptor('go', ['.go'], ['go.mod']),
    ])
    // Any accidental file-based lookup must fail, even when counts are valid.
    registry.metadata = () => { throw new Error('maintained counts traversed file metadata') }
    assert.equal(registry.isManifestCompatible(manifest, new Map(counts)), compatible)
  })
}

test('parity fixture: TypeScript and JavaScript partition bytes and normalized manifest remain exact', async () => {
  const root = copyFixture()
  const engine = new CodeGraphEngine(root)
  try {
    const built = await engine.build()
    const manifest = engine.readGeneration(built.generation)
    const normalized = { version: manifest.version, root: '<root>', edgeCoverage: manifest.edgeCoverage, controlHashes: manifest.controlHashes, sources: manifest.sources, partitions: manifest.partitions, partitionHashes: manifest.partitionHashes }
    const consumer = fs.readFileSync(path.join(root, '.codegraph', 'partitions', `${manifest.partitions['src/consumer.js']}.bin`))
    const value = fs.readFileSync(path.join(root, '.codegraph', 'partitions', `${manifest.partitions['src/value.ts']}.bin`))
    assert.deepEqual(
      {
        normalized,
        consumerBytes: { length: consumer.length, sha256: crypto.createHash('sha256').update(consumer).digest('hex') },
        valueBytes: { length: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex') },
      },
      {
        normalized: {
          version: 3,
          root: '<root>',
          edgeCoverage: 'calls',
          controlHashes: { '.codegraphignore': null, '.gitignore': null, 'jsconfig.json': null, 'tsconfig.json': '1a22b637accf1f26f81e94ab1258c0db7170540528901798e2fd3092e1316c02' },
          sources: { 'src/consumer.js': 'c5e915d0fb921a3d7bd814f8d3177644d74739bf813158718a4987fefb0ef56b', 'src/value.ts': '2a9e716674599fe9c4ea3cd995dfd5f129e256308e13ca7c551e17b61e01bec0' },
          partitions: { 'src/consumer.js': 'c280820eb7bb6f184f8cda2ae35d7713b8c92471767dfa59f2d60784832fee66', 'src/value.ts': 'b8f565e21e07782b5cb7ed4994bbdf67e64819ff26b6fc91e22d2c0c3f1aba11' },
          partitionHashes: { 'src/consumer.js': 'c280820eb7bb6f184f8cda2ae35d7713b8c92471767dfa59f2d60784832fee66', 'src/value.ts': 'b8f565e21e07782b5cb7ed4994bbdf67e64819ff26b6fc91e22d2c0c3f1aba11' },
        },
        consumerBytes: { length: 306, sha256: 'c280820eb7bb6f184f8cda2ae35d7713b8c92471767dfa59f2d60784832fee66' },
        valueBytes: { length: 354, sha256: 'b8f565e21e07782b5cb7ed4994bbdf67e64819ff26b6fc91e22d2c0c3f1aba11' },
      },
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

test('equivalence partition: null analyzer collection is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', null), /analyzers|factories|array/i)
})

test('equivalence partition: undefined analyzer collection is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', undefined), /analyzers|factories|array/i)
})

test('equivalence partition: non-array analyzer collection is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', { id: 'typescript' }), /analyzers|factories|array/i)
})

test('boundary analysis: one analyzer owns its source and control paths', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts'], ['tsconfig.json'])])
  assert.deepEqual(
    { source: registry.analyzerFor('src/main.ts').id, control: registry.analyzerFor('tsconfig.json').id },
    { source: 'typescript', control: 'typescript' },
  )
})

test('boundary analysis: many analyzers route each owned path and reject unsupported paths', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [
    () => descriptor('typescript', ['.ts'], ['tsconfig.json']),
    () => descriptor('javascript', ['.js'], ['jsconfig.json']),
    () => descriptor('third', ['.third'], ['third.config']),
  ])
  assert.deepEqual(
    ['a.ts', 'b.js', 'c.third', 'tsconfig.json', 'jsconfig.json', 'third.config', 'README.md'].map((file) => registry.analyzerFor(file)?.id ?? null),
    ['typescript', 'javascript', 'third', 'typescript', 'javascript', 'third', null],
  )
})

test('equivalence partition: missing descriptor id is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.id
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /id|descriptor|analyzer/i)
})

test('equivalence partition: null descriptor id is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), id: null })]), /id|descriptor|analyzer/i)
})

test('equivalence partition: non-string descriptor id is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), id: 7 })]), /id|descriptor|analyzer/i)
})

test('boundary analysis: empty descriptor id is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('', ['.ts'])]), /id|descriptor|analyzer/i)
})

test('equivalence partition: missing extensions are rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.extensions
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /extension|descriptor|analyzer/i)
})

test('equivalence partition: null extensions are rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), extensions: null })]), /extension|descriptor|analyzer/i)
})

test('equivalence partition: non-array extensions are rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), extensions: '.ts' })]), /extension|descriptor|analyzer/i)
})

test('boundary analysis: zero extensions are valid and own no source path', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const registry = createLanguageAnalyzers('/repo', [() => descriptor('controls-only', [], ['controls.json'])])
  assert.deepEqual({ source: registry.analyzerFor('a.ts') ?? null, control: registry.analyzerFor('controls.json').id }, { source: null, control: 'controls-only' })
})

test('equivalence partition: malformed extension is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['ts'])]), /extension|\.ts/i)
})

test('boundary analysis: duplicate extension inside one descriptor is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts', '.ts'])]), /duplicate|extension|\.ts/i)
})

test('equivalence partition: null extension entry is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', [null])]), /extension|descriptor|analyzer/i)
})

test('equivalence partition: non-string extension entry is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', [7])]), /extension|descriptor|analyzer/i)
})

test('boundary analysis: empty extension entry is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', [''])]), /extension|descriptor|analyzer/i)
})

test('equivalence partition: missing controls are rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.controlFiles
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /control|descriptor|analyzer/i)
})

test('equivalence partition: null controls are rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), controlFiles: null })]), /control|descriptor|analyzer/i)
})

test('equivalence partition: non-array controls are rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), controlFiles: 'tsconfig.json' })]), /control|descriptor|analyzer/i)
})

test('boundary analysis: duplicate control inside one descriptor is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts'], ['tsconfig.json', 'tsconfig.json'])]), /duplicate|control|tsconfig/i)
})

test('boundary analysis: duplicate control across descriptors is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('first', ['.ts'], ['project.json']), () => descriptor('second', ['.js'], ['project.json'])]), /duplicate|control|project/i)
})

test('equivalence partition: null control entry is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts'], [null])]), /control|descriptor|analyzer/i)
})

test('equivalence partition: non-string control entry is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts'], [7])]), /control|descriptor|analyzer/i)
})

test('boundary analysis: empty control entry is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('typescript', ['.ts'], [''])]), /control|descriptor|analyzer/i)
})

test('domain analysis: duplicate analyzer id is rejected even when paths do not overlap', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => descriptor('same', ['.ts']), () => descriptor('same', ['.js'])]), /duplicate|id|same/i)
})

test('equivalence partition: missing cache key is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.cacheKey
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /cache|descriptor|analyzer/i)
})

test('equivalence partition: null cache key is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), cacheKey: null })]), /cache|descriptor|analyzer/i)
})

test('equivalence partition: non-string cache key is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), cacheKey: 1 })]), /cache|descriptor|analyzer/i)
})

test('equivalence partition: missing or invalid cache key is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), cacheKey: '' })]), /cache|descriptor|analyzer/i)
})

test('equivalence partition: missing semantic worker factory is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.createSemanticWorker
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /semantic|worker|descriptor|analyzer/i)
})

test('equivalence partition: non-function semantic worker factory is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), createSemanticWorker: true })]), /semantic|worker|descriptor|analyzer/i)
})

test('equivalence partition: missing source matcher factory is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.createSourceMatcher
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /source|recognition|matcher|descriptor|analyzer/i)
})

test('equivalence partition: non-function source matcher factory is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), createSourceMatcher: [] })]), /source|recognition|matcher|descriptor|analyzer/i)
})

test('equivalence partition: missing provisional resolver factory is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const value = descriptor('typescript', ['.ts']); delete value.createProvisionalResolver
  assert.throws(() => createLanguageAnalyzers('/repo', [() => value]), /provisional|stage|resolver|descriptor|analyzer/i)
})

test('equivalence partition: non-function provisional resolver factory is rejected', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  assert.throws(() => createLanguageAnalyzers('/repo', [() => ({ ...descriptor('typescript', ['.ts']), createProvisionalResolver: 'resolver' })]), /provisional|stage|resolver|descriptor|analyzer/i)
})

test('error guessing: inactive analyzer runtime is never initialized while routing active files', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  let inactiveWorkerCalls = 0
  let inactiveResolverCalls = 0
  const registry = createLanguageAnalyzers('/repo', [
    () => descriptor('typescript', ['.ts'], ['tsconfig.json']),
    () => ({ ...descriptor('inactive', ['.inactive'], ['inactive.json']), createSemanticWorker() { inactiveWorkerCalls += 1 }, createProvisionalResolver() { inactiveResolverCalls += 1 } }),
  ])
  registry.analyzerFor('src/main.ts')
  registry.analyzerFor('tsconfig.json')
  assert.deepEqual({ inactiveWorkerCalls, inactiveResolverCalls }, { inactiveWorkerCalls: 0, inactiveResolverCalls: 0 })
})

test('domain analysis: successful all-analyzer transaction commits every staged revision exactly once', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const events = []
  const registry = createLanguageAnalyzers('/repo', [
    () => ({ ...descriptor('first', ['.one']), createProvisionalResolver() { return { async stageChanges() { events.push('stage first'); return 'first staged' }, commit(value) { events.push(`commit ${value}`) }, discard(value) { events.push(`discard ${value}`) } } } }),
    () => ({ ...descriptor('second', ['.two']), createProvisionalResolver() { return { async stageChanges() { events.push('stage second'); return 'second staged' }, commit(value) { events.push(`commit ${value}`) }, discard(value) { events.push(`discard ${value}`) } } } }),
  ])
  const staged = await registry.stageAll({ first: ['a.one'], second: ['b.two'] })
  registry.commitAll(staged)
  assert.deepEqual(events, ['stage first', 'stage second', 'commit first staged', 'commit second staged'])
})

test('error guessing: peer staging failure discards every successful staged analyzer and commits none', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  const events = []
  const registry = createLanguageAnalyzers('/repo', [
    () => ({ ...descriptor('first', ['.one']), createProvisionalResolver() { return { async stageChanges() { events.push('stage first'); return 'first staged' }, commit() { events.push('commit first') }, discard(value) { events.push(`discard ${value}`) } } } }),
    () => ({ ...descriptor('second', ['.two']), createProvisionalResolver() { return { async stageChanges() { events.push('stage second'); throw new Error('second failed') }, commit() { events.push('commit second') }, discard() { events.push('discard second') } } } }),
  ])
  await assert.rejects(registry.stageAll({ first: ['a.one'], second: ['b.two'] }), /second failed/)
  assert.deepEqual(events, ['stage first', 'stage second', 'discard first staged'])
})

test('error guessing: double commit cannot advance an analyzer transaction twice', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  let commits = 0
  const registry = createLanguageAnalyzers('/repo', [() => ({ ...descriptor('only', ['.one']), createProvisionalResolver() { return { async stageChanges() { return 'staged' }, commit() { commits += 1 }, discard() {} } } })])
  const staged = await registry.stageAll({ only: ['a.one'] })
  registry.commitAll(staged)
  assert.throws(() => registry.commitAll(staged), /consumed|committed|stale/i)
  assert.equal(commits, 1)
})

test('error guessing: commit after discard cannot advance visible analyzer state', async () => {
  const { createLanguageAnalyzers } = await loadRegistry()
  let commits = 0
  let discards = 0
  const registry = createLanguageAnalyzers('/repo', [() => ({ ...descriptor('only', ['.one']), createProvisionalResolver() { return { async stageChanges() { return 'staged' }, commit() { commits += 1 }, discard() { discards += 1 } } } })])
  const staged = await registry.stageAll({ only: ['a.one'] })
  registry.discardAll(staged)
  assert.throws(() => registry.commitAll(staged), /consumed|discarded|stale/i)
  assert.deepEqual({ commits, discards }, { commits: 0, discards: 1 })
})

test('domain analysis: TypeScript descriptor owns recognition workers partitions internals cache inputs and invalidation', async () => {
  const { createTypeScriptLanguageAnalyzer } = await loadTypeScriptAnalyzer()
  const analyzer = createTypeScriptLanguageAnalyzer('/repo')
  assert.deepEqual(
    {
      id: analyzer.id,
      extensions: analyzer.extensions,
      controls: analyzer.controlFiles,
      cacheKey: analyzer.cacheKey,
      sourceMatcher: typeof analyzer.createSourceMatcher,
      provisionalResolver: typeof analyzer.createProvisionalResolver,
      semanticWorker: typeof analyzer.createSemanticWorker,
      partition: typeof analyzer.createPartition,
      internals: typeof analyzer.createInternalPartition,
      cacheInputs: typeof analyzer.cacheInputs,
      invalidation: typeof analyzer.invalidate,
    },
    {
      id: 'typescript',
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
      controls: ['tsconfig.json', 'jsconfig.json'],
      cacheKey: 'typescript-2',
      sourceMatcher: 'function',
      provisionalResolver: 'function',
      semanticWorker: 'function',
      partition: 'function',
      internals: 'function',
      cacheInputs: 'function',
      invalidation: 'function',
    },
  )
})
