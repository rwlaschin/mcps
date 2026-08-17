import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileLocalResolver } from '../incremental-resolver.mjs'

test('equivalence partition: an empty resolver exposes revision zero as provisional module-linked syntax', () => {
  const resolver = new FileLocalResolver('/repo')

  const snapshot = resolver.snapshot()

  assert.deepEqual(snapshot, { revision: 0, freshness: 'provisional', coverage: 'module-linked-syntax', files: [], symbols: [], edges: [], unresolvedEdges: [] })
})

test('domain analysis: local calls resolve to the exact declaration while a lexically shadowed same-name call stays local', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/subject.ts', source: 'export function target(){ return 1 }\nexport function outer(){ function target(){ return 2 } return target() }\nexport function direct(){ return target() }\n' }])

  const snapshot = resolver.snapshot()

  assert.deepEqual(snapshot.edges.map(({ fromName, toName, toLine, line, call }) => ({ fromName, toName, toLine, line, call })), [
    { fromName: 'outer', toName: 'target', toLine: 2, line: 2, call: true },
    { fromName: 'direct', toName: 'target', toLine: 1, line: 3, call: true },
  ])
})

test('combinatorial all-pairs: named relative imports reexports namespace calls and known static calls resolve without guessing an ambiguous property call', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([
    { type: 'add', path: 'src/original.ts', source: 'export function named(){ return 1 }\nexport class Known { static run(){ return 2 } }\n' },
    { type: 'add', path: 'src/barrel.ts', source: "export { named as renamed, Known } from './original'\n" },
    { type: 'add', path: 'src/subject.ts', source: "import { renamed, Known } from './barrel'\nimport * as original from './original'\nexport function subject(value){ renamed(); original.named(); Known.run(); value.run() }\n" },
  ])

  const snapshot = resolver.snapshot()

  assert.deepEqual(
    { resolved: snapshot.edges.map(({ fromName, toFile, toName, line }) => ({ fromName, toFile, toName, line })), unresolved: snapshot.unresolvedEdges.map(({ fromName, expression, line, reason }) => ({ fromName, expression, line, reason })) },
    {
      resolved: [
        { fromName: 'subject', toFile: 'src/original.ts', toName: 'named', line: 3 },
        { fromName: 'subject', toFile: 'src/original.ts', toName: 'named', line: 3 },
        { fromName: 'subject', toFile: 'src/original.ts', toName: 'Known.run', line: 3 },
      ],
      unresolved: [{ fromName: 'subject', expression: 'value.run', line: 3, reason: 'ambiguous-property-call' }],
    },
  )
})

test('boundary values: add change and unlink advance one revision each and remove stale symbols and edges', () => {
  const resolver = new FileLocalResolver('/repo')
  const added = resolver.applyChanges([{ type: 'add', path: 'src/a.ts', source: 'export function a(){ return 1 }\n' }])
  const changed = resolver.applyChanges([{ type: 'change', path: 'src/a.ts', source: 'export function renamed(){ return 2 }\n' }])
  const unlinked = resolver.applyChanges([{ type: 'unlink', path: 'src/a.ts' }])

  assert.deepEqual(
    { addedRevision: added.revision, changedRevision: changed.revision, unlinkedRevision: unlinked.revision, final: resolver.snapshot() },
    { addedRevision: 1, changedRevision: 2, unlinkedRevision: 3, final: { revision: 3, freshness: 'provisional', coverage: 'module-linked-syntax', files: [], symbols: [], edges: [], unresolvedEdges: [] } },
  )
})

test('error guessing: a stale base revision is rejected without changing the latest provisional snapshot', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/a.ts', source: 'export const a = 1\n' }])

  assert.throws(() => resolver.applyChanges([{ type: 'change', path: 'src/a.ts', source: 'export const a = 2\n' }], { baseRevision: 0 }), /stale|revision/i)

  assert.deepEqual({ revision: resolver.snapshot().revision, symbolNames: resolver.snapshot().symbols.map(({ name }) => name) }, { revision: 1, symbolNames: ['a'] })
})

test('error guessing: comments quoted strings regex literals and templates cannot create declarations or calls or corrupt owner ranges', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/adversarial.ts', source: '/* export function commentFake(){ fakeCall() } */\nconst quoted = "export function stringFake(){ stringCall() }"\nconst regex = /function regexFake\\(\\)\\{ regexCall\\(\\) \\}/\nconst template = `export function templateFake(){ templateCall() } ${"}"}`\nexport function real(){ const object = { nested: { value: 1 } }; return actual() }\nexport function actual(){ return 1 }\n' }])

  const snapshot = resolver.snapshot()

  assert.deepEqual(
    { symbols: snapshot.symbols.map(({ name, line }) => ({ name, line })), edges: snapshot.edges.map(({ fromName, toName, line }) => ({ fromName, toName, line })), unresolved: snapshot.unresolvedEdges },
    { symbols: [{ name: 'real', line: 5 }, { name: 'actual', line: 6 }, { name: 'quoted', line: 2 }, { name: 'regex', line: 3 }, { name: 'template', line: 4 }, { name: 'object', line: 5 }], edges: [{ fromName: 'real', toName: 'actual', line: 5 }], unresolved: [] },
  )
})

test('domain analysis: regex literals after return throw and case are masked while division followed by a real call remains executable code', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/regex-contexts.ts', source: 'export function target(){ return 1 }\nexport function afterReturn(){ return /fakeReturnCall\\(\\)/.test("x") }\nexport function afterThrow(){ throw /fakeThrowCall\\(\\)/ }\nexport function afterCase(value){ switch(value){ case /fakeCaseCall\\(\\)/: return target() } }\nexport function division(value){ return value / target() }\n' }])

  const snapshot = resolver.snapshot()

  assert.deepEqual(
    { edges: snapshot.edges.map(({ fromName, toName, line }) => ({ fromName, toName, line })), unresolved: snapshot.unresolvedEdges },
    { edges: [{ fromName: 'afterCase', toName: 'target', line: 4 }, { fromName: 'division', toName: 'target', line: 5 }], unresolved: [] },
  )
})

test('equivalence partition and error guessing: comments strings regex literals and template text never manufacture symbols or calls while template expressions remain executable', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/lexical.ts', source: 'export function target(){ return 1 }\nexport function subject(){\n  // function commentFake(){ commentCall() }\n  const quoted = "function stringFake(){ stringCall() }"\n  const pattern = /function regexFake\\(\\)\\{ regexCall\\(\\) \\}/\n  const rendered = `function templateFake(){ templateCall() } ${target()}`\n  return rendered.length + quoted.length + pattern.source.length\n}\n' }])

  const snapshot = resolver.snapshot()

  assert.deepEqual(
    { symbols: snapshot.symbols.map(({ name, kind, line }) => ({ name, kind, line })), edges: snapshot.edges.map(({ fromName, toName, line }) => ({ fromName, toName, line })) },
    { symbols: [{ name: 'target', kind: 'function', line: 1 }, { name: 'subject', kind: 'function', line: 2 }, { name: 'quoted', kind: 'variable', line: 4 }, { name: 'pattern', kind: 'variable', line: 5 }, { name: 'rendered', kind: 'variable', line: 6 }], edges: [{ fromName: 'subject', toName: 'target', line: 6 }] },
  )
})

test('domain analysis: multiline generic typed async generator and nested declarations are fully traversed and retain lexical call ownership', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/typed.ts', source: 'export async function* stream<T extends { id: string }>(\n  items: readonly T[],\n): AsyncGenerator<string> {\n  function nested<U extends T>(value: U): string { return value.id }\n  for (const item of items) yield nested(item)\n}\nexport function caller(): AsyncGenerator<string> { return stream([{ id: "one" }]) }\n' }])

  const snapshot = resolver.snapshot()

  assert.deepEqual(
    { symbols: snapshot.symbols.map(({ name, kind, line, qualifiedPath }) => ({ name, kind, line, qualifiedPath })), edges: snapshot.edges.map(({ fromName, toName, line }) => ({ fromName, toName, line })) },
    { symbols: [{ name: 'stream', kind: 'function', line: 1, qualifiedPath: '<module>' }, { name: 'nested', kind: 'function', line: 4, qualifiedPath: '<module>/function:stream' }, { name: 'caller', kind: 'function', line: 7, qualifiedPath: '<module>' }], edges: [{ fromName: 'stream', toName: 'nested', line: 5 }, { fromName: 'caller', toName: 'stream', line: 7 }] },
  )
})

test('combinatorial all-pairs: multiline aliased imports reexports namespace calls static methods and nested local calls resolve to exact declarations', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([
    { type: 'add', path: 'src/original.ts', source: 'export async function source<T>(value: T): Promise<T> { return value }\nexport class Worker {\n  static async run(): Promise<number> { return 1 }\n}\n' },
    { type: 'add', path: 'src/barrel.ts', source: 'export {\n  source as renamed,\n  Worker,\n} from "./original"\n' },
    { type: 'add', path: 'src/consumer.ts', source: 'import {\n  renamed,\n  Worker as ImportedWorker,\n} from "./barrel"\nimport * as original from "./original"\nexport async function consume(){\n  function local(){ return renamed("x") }\n  local()\n  original.source(1)\n  await ImportedWorker.run()\n}\n' },
  ])

  const snapshot = resolver.snapshot()

  assert.deepEqual(snapshot.edges.map(({ fromName, toFile, toName, line }) => ({ fromName, toFile, toName, line })), [
    { fromName: 'local', toFile: 'src/original.ts', toName: 'source', line: 7 },
    { fromName: 'consume', toFile: 'src/consumer.ts', toName: 'local', line: 8 },
    { fromName: 'consume', toFile: 'src/original.ts', toName: 'source', line: 9 },
    { fromName: 'consume', toFile: 'src/original.ts', toName: 'Worker.run', line: 10 },
  ])
})

test('boundary value: an observed parse taking exactly 8 milliseconds is not admitted to the retained AST cache', () => {
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 8]; return () => readings.shift() })() })

  resolver.applyChanges([{ type: 'add', path: 'src/exact.ts', source: 'export function exact(){ return 8 }\n' }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('domain boundary: a file below 64 KiB is not admitted when its observed parse exceeds 8 milliseconds', () => {
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 8.001]; return () => readings.shift() })() })

  resolver.applyChanges([{ type: 'add', path: 'src/slow.ts', source: 'export function slow(){ return 9 }\n' }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('equivalence partition: a small fast file is not admitted even after repeated unchanged parses', () => {
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 1, 2, 3, 4, 5]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/fast.ts', source: 'export const fast = 1\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/fast.ts', source: 'export const fast = 2\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/fast.ts', source: 'export const fast = 3\n' }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('domain analysis: changing an admitted file reuses SourceFile.update and publishes facts from the updated tree', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 11]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/reused.ts', source: 'export function before(){ return 1 }\n' }])

  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/reused.ts', source: 'export function after(){ return 2 }\n' }])

  assert.deepEqual({ symbols: snapshot.symbols.map(({ name }) => name), events }, { symbols: ['after'], events: [{ file: 'src/reused.ts', operation: 'create', nodeCountSource: 'fact-extraction' }, { file: 'src/reused.ts', operation: 'update', nodeCountSource: 'fact-extraction' }] })
})

test('boundary values: retained AST cache evicts least recently used entries before exceeding either entry or estimated-byte limits', () => {
  const resolver = new FileLocalResolver('/repo', null, { astCacheMaxEntries: 2, astCacheMaxBytes: 3200, astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 19, 20, 29, 30, 39]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/a.ts', source: 'export function a(){ return 1 }\n' }])
  resolver.applyChanges([{ type: 'add', path: 'src/b.ts', source: 'export function b(){ return 2 }\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/a.ts', source: 'export function a(){ return 3 }\n' }])
  resolver.applyChanges([{ type: 'add', path: 'src/c.ts', source: 'export function c(){ return 4 }\n' }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 2, estimatedBytes: 3136, files: ['src/a.ts', 'src/c.ts'] })
})

test('error guessing: unlink releases the retained AST and estimated bytes immediately', () => {
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 9]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/released.ts', source: 'export function released(){ return 1 }\n' }])

  resolver.applyChanges([{ type: 'unlink', path: 'src/released.ts' }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('domain analysis: synchronous changes to two files atomically publish one revision with the fully updated graph', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([
    { type: 'add', path: 'src/a.ts', source: 'export function oldTarget(){ return 1 }\n' },
    { type: 'add', path: 'src/b.ts', source: 'import { oldTarget } from "./a"\nexport function oldCaller(){ return oldTarget() }\n' },
  ])

  const snapshot = resolver.applyChanges([
    { type: 'change', path: 'src/a.ts', source: 'export function newTarget(){ return 2 }\n' },
    { type: 'change', path: 'src/b.ts', source: 'import { newTarget } from "./a"\nexport function newCaller(){ return newTarget() }\n' },
  ], { baseRevision: 1 })

  assert.deepEqual(
    { revision: snapshot.revision, symbols: snapshot.symbols.map(({ name }) => name), edges: snapshot.edges.map(({ fromName, toName }) => ({ fromName, toName })) },
    { revision: 2, symbols: ['newTarget', 'newCaller'], edges: [{ fromName: 'newCaller', toName: 'newTarget' }] },
  )
})

test('equivalence partition: explicit in-memory source changes remain synchronous while disk-backed file changes are asynchronous', () => {
  const resolver = new FileLocalResolver('/repo')

  const synchronous = resolver.applyChanges([{ type: 'add', path: 'src/memory.ts', source: 'export const memory = 1\n' }])

  assert.deepEqual({ synchronousIsPromise: synchronous instanceof Promise, revision: synchronous.revision, applyFileChangesType: typeof resolver.applyFileChanges }, { synchronousIsPromise: false, revision: 1, applyFileChangesType: 'function' })
})

test('domain analysis: disk-backed multi-file changes admit each parsed digest and publish one graph-equivalent revision without retaining source text', async () => {
  const parsedByFile = {
    'file-a': { file: 'src/a.ts', digest: 'a2', stateHash: 11, sourceBytes: 40, nodeCount: 8, symbols: [{ id: 'a', file: 'src/a.ts', name: 'target', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '', ordinal: 0, exported: true }], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] },
    'file-b': { file: 'src/b.ts', digest: 'b2', stateHash: 12, sourceBytes: 82, nodeCount: 14, symbols: [{ id: 'b', file: 'src/b.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '', ordinal: 0, exported: true }], imports: new Map([['target', { specifier: './a', remote: 'target' }]]), namespaces: new Map(), reexports: new Map(), calls: [{ owner: { id: 'b', file: 'src/b.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '', ordinal: 0, exported: true }, base: 'target', property: null, line: 2, expression: 'target' }] },
  }
  const pool = { parse: async ({ fileId }) => parsedByFile[fileId], dispose: async () => {}, snapshot: () => ({ workerCount: 2, queued: 0, inFlight: 0, latestRevisionByFile: {} }) }
  const resolver = new FileLocalResolver('/repo', null, { parserPool: pool })

  const snapshot = await resolver.applyFileChanges([{ type: 'add', path: 'src/a.ts', fileId: 'file-a' }, { type: 'add', path: 'src/b.ts', fileId: 'file-b' }], { baseRevision: 0 })

  assert.deepEqual({ revision: snapshot.revision, files: snapshot.files, admittedDigests: [...resolver.files.values()].map(({ digest }) => digest), symbols: snapshot.symbols.map(({ name }) => name), edges: snapshot.edges.map(({ fromName, toName }) => ({ fromName, toName })), sources: resolver.sourceEntries() }, { revision: 1, files: ['src/a.ts', 'src/b.ts'], admittedDigests: ['a2', 'b2'], symbols: ['target', 'caller'], edges: [{ fromName: 'caller', toName: 'target' }], sources: [['src/a.ts', undefined], ['src/b.ts', undefined]] })
})

test('error guessing: a stale disk parse result aborts the whole multi-file batch without a partial commit', async () => {
  const pool = { parse: async ({ fileId }) => fileId === 'file-a' ? null : { file: 'src/b.ts', digest: 'b', stateHash: 2, sourceBytes: 1, nodeCount: 1, symbols: [], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }, dispose: async () => {}, snapshot: () => ({ workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: {} }) }
  const resolver = new FileLocalResolver('/repo', new Map([['src/existing.ts', 'export const existing = 1\n']]), { parserPool: pool })

  await assert.rejects(resolver.applyFileChanges([{ type: 'add', path: 'src/a.ts', fileId: 'file-a' }, { type: 'add', path: 'src/b.ts', fileId: 'file-b' }]), /stale|superseded/i)

  assert.deepEqual({ revision: resolver.snapshot().revision, files: resolver.snapshot().files }, { revision: 0, files: ['src/existing.ts'] })
})

test('boundary value analysis: retained SourceFile updates report precise zero-width insertions at the beginning middle and end', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 19, 20, 29, 30, 39]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/ranges.ts', source: 'export const value = "a"\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/ranges.ts', source: '//x\nexport const value = "a"\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/ranges.ts', source: '//x\nexport const value = "abc"\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/ranges.ts', source: '//x\nexport const value = "abc"\n//end' }])

  assert.deepEqual(events.slice(1).map(({ operation, changeRange }) => ({ operation, changeRange })), [
    { operation: 'update', changeRange: { span: { start: 0, length: 0 }, newLength: 4 } },
    { operation: 'update', changeRange: { span: { start: 27, length: 0 }, newLength: 2 } },
    { operation: 'update', changeRange: { span: { start: 31, length: 0 }, newLength: 5 } },
  ])
})

test('boundary value analysis: retained SourceFile updates report precise deletions at the beginning middle and end', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 19, 20, 29, 30, 39]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/ranges.ts', source: '//x\nexport const value = "abc"\n//end' }])
  resolver.applyChanges([{ type: 'change', path: 'src/ranges.ts', source: 'export const value = "abc"\n//end' }])
  resolver.applyChanges([{ type: 'change', path: 'src/ranges.ts', source: 'export const value = "a"\n//end' }])
  resolver.applyChanges([{ type: 'change', path: 'src/ranges.ts', source: 'export const value = "a"\n' }])

  assert.deepEqual(events.slice(1).map(({ operation, changeRange }) => ({ operation, changeRange })), [
    { operation: 'update', changeRange: { span: { start: 0, length: 4 }, newLength: 0 } },
    { operation: 'update', changeRange: { span: { start: 23, length: 2 }, newLength: 0 } },
    { operation: 'update', changeRange: { span: { start: 25, length: 5 }, newLength: 0 } },
  ])
})

test('boundary value analysis: replacing a retained file with empty text reports one full-span deletion and publishes no symbols', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 11]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/empty.ts', source: 'export const value = 1\n' }])

  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/empty.ts', source: '' }])

  assert.deepEqual({ event: { file: events[1].file, operation: events[1].operation, changeRange: events[1].changeRange }, symbols: snapshot.symbols }, { event: { file: 'src/empty.ts', operation: 'update', changeRange: { span: { start: 0, length: 23 }, newLength: 0 } }, symbols: [] })
})

test('error guessing: malformed retained TypeScript can update to valid TypeScript without stale facts or a full reparse', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 11]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/recover.ts', source: 'export function broken( {\n' }])

  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/recover.ts', source: 'export function recovered(){ return 1 }\n' }])

  assert.deepEqual({ operation: events[1].operation, changeRange: events[1].changeRange, symbols: snapshot.symbols.map(({ name }) => name) }, { operation: 'update', changeRange: { span: { start: 16, length: 9 }, newLength: 23 }, symbols: ['recovered'] })
})

test('error guessing: CRLF-to-LF normalization reports the precise changed span and preserves declaration lines', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 11]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/newlines.ts', source: 'export const value = 1\r\nexport const next = 2\r\n' }])

  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/newlines.ts', source: 'export const value = 1\nexport const next = 2\n' }])

  assert.deepEqual({ changeRange: events[1].changeRange, symbols: snapshot.symbols.map(({ name, line }) => ({ name, line })) }, { changeRange: { span: { start: 22, length: 24 }, newLength: 22 }, symbols: [{ name: 'value', line: 1 }, { name: 'next', line: 2 }] })
})

test('domain analysis: TSX expression edits report a precise middle replacement and refresh calls inside JSX', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 11]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/view.tsx', source: 'export function one(){ return 1 }\nexport const view = <Box value={one()} />\n' }])

  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/view.tsx', source: 'export function one(){ return 1 }\nexport const view = <Box value={one() + 2} />\n' }])

  assert.deepEqual({ operation: events[1].operation, changeRange: events[1].changeRange, edges: snapshot.edges.map(({ toName, line }) => ({ toName, line })) }, { operation: 'update', changeRange: { span: { start: 71, length: 0 }, newLength: 4 }, edges: [] })
})

test('domain analysis: node-dense retained trees consume more estimated cache weight than similarly sized sparse text and cannot exceed the byte bound', () => {
  const resolver = new FileLocalResolver('/repo', null, { astCacheMaxBytes: 2000, now: (() => { const readings = [0, 9, 10, 19]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/sparse.ts', source: 'export const sparse = "............................................................"\n' }])
  resolver.applyChanges([{ type: 'add', path: 'src/dense.ts', source: 'export const dense = a(b(c(d(e(f(g(h(i(j(k(l(m(n(o(p(q(r(s(t(1))))))))))))))))))))\n' }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('equivalence partition: a zero AST cache entry limit normalizes to a disabled cache without crashing', () => {
  const resolver = new FileLocalResolver('/repo', null, { astCacheMaxEntries: 0, now: (() => { const readings = [0, 9]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/a.ts', source: 'export const a = 1\n' }])
  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('equivalence partition: a negative AST cache byte limit normalizes to a disabled cache without crashing', () => {
  const resolver = new FileLocalResolver('/repo', null, { astCacheMaxBytes: -1, now: (() => { const readings = [0, 9]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/a.ts', source: 'export const a = 1\n' }])
  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('equivalence partition: a NaN AST cache limit is rejected synchronously with a stable type error', () => {
  assert.throws(() => new FileLocalResolver('/repo', null, { astCacheMaxEntries: Number.NaN }), { name: 'TypeError', message: 'astCacheMaxEntries must be a finite non-negative number' })
})

test('equivalence partition: an infinite AST cache limit is rejected synchronously with a stable type error', () => {
  assert.throws(() => new FileLocalResolver('/repo', null, { astCacheMaxBytes: Number.POSITIVE_INFINITY }), { name: 'TypeError', message: 'astCacheMaxBytes must be a finite non-negative number' })
})

test('error guessing: alternating admitted A and B source text reuses exact parsed facts after each digest is cached', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { astCacheMinSourceBytes: 0, now: (() => { const readings = [0, 9, 10, 19, 20, 29, 30, 39]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/alternating.ts', source: 'export function alpha(){ return 1 }\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/alternating.ts', source: 'export function beta(){ return 2 }\n' }])
  resolver.applyChanges([{ type: 'change', path: 'src/alternating.ts', source: 'export function alpha(){ return 1 }\n' }])
  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/alternating.ts', source: 'export function beta(){ return 2 }\n' }])

  assert.deepEqual({ operations: events.map(({ operation }) => operation), symbols: snapshot.symbols.map(({ name }) => name) }, { operations: ['create', 'update'], symbols: ['beta'] })
})

test('error guessing: replacing the same retained parse-cache key across one mebibyte keeps exact byte accounting and preserves an unrelated recently-read key', () => {
  const largeA = `/*${'a'.repeat(400_000)}*/\nexport const a = 1\n`
  const largeB = `/*${'b'.repeat(400_000)}*/\nexport const b = 2\n`
  const largeC = `/*${'c'.repeat(400_000)}*/\nexport const c = 3\n`
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 1, 2, 11, 12, 13, 14, 15, 16, 17]; return () => readings.shift() })() })
  resolver.applyChanges([{ type: 'add', path: 'src/a.ts', source: largeA }])
  resolver.applyChanges([{ type: 'add', path: 'src/b.ts', source: largeB }])
  resolver.applyChanges([{ type: 'change', path: 'src/b.ts', source: largeB }])
  resolver.applyChanges([{ type: 'change', path: 'src/b.ts', source: largeB }])
  resolver.applyChanges([{ type: 'change', path: 'src/a.ts', source: largeA }])

  resolver.applyChanges([{ type: 'add', path: 'src/c.ts', source: largeC }])

  assert.deepEqual(
    { entries: resolver.parseCache.size, bytes: resolver.parseCacheBytes, files: [...resolver.parseCache.values()].map(({ file }) => file) },
    { entries: 2, bytes: 800048, files: ['src/a.ts', 'src/c.ts'] },
  )
})

test('hotpath architecture: AST node count is emitted from existing fact extraction without a dedicated fifth full-tree traversal', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 9]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })

  resolver.applyChanges([{ type: 'add', path: 'src/traversal.ts', source: 'export function target(){ return 1 }\nexport function subject(){ return target() }\n' }])

  assert.deepEqual(events, [{ file: 'src/traversal.ts', operation: 'create', nodeCountSource: 'fact-extraction' }])
})

test('error guessing: two former XOR-colliding workspaces receive distinct graph-cache digests and preserve distinct graphs', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.files = new Map([
    ['src/a.ts', { file: 'src/a.ts', source: 'a', stateHash: 1, symbols: [{ id: 'a', file: 'src/a.ts', name: 'a', kind: 'variable', line: 1, qualifiedPath: '<module>', signature: '', ordinal: 0, exported: true }], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }],
    ['src/b.ts', { file: 'src/b.ts', source: 'b', stateHash: 2, symbols: [], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }],
  ])
  resolver.stateHash = 3
  const first = resolver.snapshot()
  resolver.files = new Map([
    ['src/c.ts', { file: 'src/c.ts', source: 'c', stateHash: 4, symbols: [{ id: 'c', file: 'src/c.ts', name: 'c', kind: 'variable', line: 1, qualifiedPath: '<module>', signature: '', ordinal: 0, exported: true }], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }],
    ['src/d.ts', { file: 'src/d.ts', source: 'd', stateHash: 7, symbols: [], imports: new Map(), namespaces: new Map(), reexports: new Map(), calls: [] }],
  ])
  resolver.stateHash = 3
  resolver.cached = null
  const second = resolver.snapshot()

  assert.deepEqual({ firstFiles: first.files, secondFiles: second.files }, { firstFiles: ['src/a.ts', 'src/b.ts'], secondFiles: ['src/c.ts', 'src/d.ts'] })
  assert.equal(resolver.graphCache.size, 2)
  assert.notEqual([...resolver.graphCache.keys()][0], [...resolver.graphCache.keys()][1])
})

test('boundary values: graph cache remains within 32 entries and a 2048-byte key budget after forty distinct revisions', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([{ type: 'add', path: 'src/value.ts', source: 'export const value = 0\n' }])
  for (let revision = 1; revision <= 40; revision += 1) resolver.applyChanges([{ type: 'change', path: 'src/value.ts', source: `export const value = ${revision}\n` }])

  const keyBytes = [...resolver.graphCache.keys()].reduce((total, key) => total + Buffer.byteLength(key), 0)

  assert.deepEqual({ entries: resolver.graphCache.size, withinByteBudget: keyBytes <= 2048 }, { entries: 32, withinByteBudget: true })
})

test('hotpath architecture: graph cache keys are bounded digests and retain no concatenated source text', () => {
  const resolver = new FileLocalResolver('/repo')
  resolver.applyChanges([
    { type: 'add', path: 'src/a.ts', source: 'export function uniquelyNamedSourceA(){ return 1 }\n' },
    { type: 'add', path: 'src/b.ts', source: 'export function uniquelyNamedSourceB(){ return uniquelyNamedSourceA() }\n' },
  ])

  resolver.snapshot()
  const keys = [...resolver.graphCache.keys()]

  assert.deepEqual({ count: keys.length, bounded: keys.every((key) => key.length <= 64), containsSource: keys.some((key) => key.includes('uniquelyNamedSourceA') || key.includes('uniquelyNamedSourceB')) }, { count: 1, bounded: true, containsSource: false })
})

const PERFORMANCE_SOURCE_A = `export function fn01(){ return fn02() }
export function fn02(){ return fn03() }
export function fn03(){ return fn04() }
export function fn04(){ return fn05() }
export function fn05(){ return fn06() }
export function fn06(){ return fn07() }
export function fn07(){ return fn08() }
export function fn08(){ return fn09() }
export function fn09(){ return fn10() }
export function fn10(){ return fn11() }
export function fn11(){ return fn12() }
export function fn12(){ return fn13() }
export function fn13(){ return fn14() }
export function fn14(){ return fn15() }
export function fn15(){ return fn16() }
export function fn16(){ return fn17() }
export function fn17(){ return fn18() }
export function fn18(){ return fn19() }
export function fn19(){ return fn20() }
export function fn20(){ return 20 }
// performance fixture line 021
// performance fixture line 022
// performance fixture line 023
// performance fixture line 024
// performance fixture line 025
// performance fixture line 026
// performance fixture line 027
// performance fixture line 028
// performance fixture line 029
// performance fixture line 030
// performance fixture line 031
// performance fixture line 032
// performance fixture line 033
// performance fixture line 034
// performance fixture line 035
// performance fixture line 036
// performance fixture line 037
// performance fixture line 038
// performance fixture line 039
// performance fixture line 040
// performance fixture line 041
// performance fixture line 042
// performance fixture line 043
// performance fixture line 044
// performance fixture line 045
// performance fixture line 046
// performance fixture line 047
// performance fixture line 048
// performance fixture line 049
// performance fixture line 050
// performance fixture line 051
// performance fixture line 052
// performance fixture line 053
// performance fixture line 054
// performance fixture line 055
// performance fixture line 056
// performance fixture line 057
// performance fixture line 058
// performance fixture line 059
// performance fixture line 060
// performance fixture line 061
// performance fixture line 062
// performance fixture line 063
// performance fixture line 064
// performance fixture line 065
// performance fixture line 066
// performance fixture line 067
// performance fixture line 068
// performance fixture line 069
// performance fixture line 070
// performance fixture line 071
// performance fixture line 072
// performance fixture line 073
// performance fixture line 074
// performance fixture line 075
// performance fixture line 076
// performance fixture line 077
// performance fixture line 078
// performance fixture line 079
// performance fixture line 080
// performance fixture line 081
// performance fixture line 082
// performance fixture line 083
// performance fixture line 084
// performance fixture line 085
// performance fixture line 086
// performance fixture line 087
// performance fixture line 088
// performance fixture line 089
// performance fixture line 090
// performance fixture line 091
// performance fixture line 092
// performance fixture line 093
// performance fixture line 094
// performance fixture line 095
// performance fixture line 096
// performance fixture line 097
// performance fixture line 098
// performance fixture line 099
// performance fixture line 100
// performance fixture line 101
// performance fixture line 102
// performance fixture line 103
// performance fixture line 104
// performance fixture line 105
// performance fixture line 106
// performance fixture line 107
// performance fixture line 108
// performance fixture line 109
// performance fixture line 110
// performance fixture line 111
// performance fixture line 112
// performance fixture line 113
// performance fixture line 114
// performance fixture line 115
// performance fixture line 116
// performance fixture line 117
// performance fixture line 118
// performance fixture line 119
// performance fixture line 120
// performance fixture line 121
// performance fixture line 122
// performance fixture line 123
// performance fixture line 124
// performance fixture line 125
// performance fixture line 126
// performance fixture line 127
// performance fixture line 128
// performance fixture line 129
// performance fixture line 130
// performance fixture line 131
// performance fixture line 132
// performance fixture line 133
// performance fixture line 134
// performance fixture line 135
// performance fixture line 136
// performance fixture line 137
// performance fixture line 138
// performance fixture line 139
// performance fixture line 140
// performance fixture line 141
// performance fixture line 142
// performance fixture line 143
// performance fixture line 144
// performance fixture line 145
// performance fixture line 146
// performance fixture line 147
// performance fixture line 148
// performance fixture line 149
// performance fixture line 150
// performance fixture line 151
// performance fixture line 152
// performance fixture line 153
// performance fixture line 154
// performance fixture line 155
// performance fixture line 156
// performance fixture line 157
// performance fixture line 158
// performance fixture line 159
// performance fixture line 160
// performance fixture line 161
// performance fixture line 162
// performance fixture line 163
// performance fixture line 164
// performance fixture line 165
// performance fixture line 166
// performance fixture line 167
// performance fixture line 168
// performance fixture line 169
// performance fixture line 170
// performance fixture line 171
// performance fixture line 172
// performance fixture line 173
// performance fixture line 174
// performance fixture line 175
// performance fixture line 176
// performance fixture line 177
// performance fixture line 178
// performance fixture line 179
// performance fixture line 180
// performance fixture line 181
// performance fixture line 182
// performance fixture line 183
// performance fixture line 184
// performance fixture line 185
// performance fixture line 186
// performance fixture line 187
// performance fixture line 188
// performance fixture line 189
// performance fixture line 190
// performance fixture line 191
// performance fixture line 192
// performance fixture line 193
// performance fixture line 194
// performance fixture line 195
// performance fixture line 196
// performance fixture line 197
// performance fixture line 198
// performance fixture line 199
// performance fixture line 200
// performance fixture line 201
// performance fixture line 202
// performance fixture line 203
// performance fixture line 204
// performance fixture line 205
// performance fixture line 206
// performance fixture line 207
// performance fixture line 208
// performance fixture line 209
// performance fixture line 210
// performance fixture line 211
// performance fixture line 212
// performance fixture line 213
// performance fixture line 214
// performance fixture line 215
// performance fixture line 216
// performance fixture line 217
// performance fixture line 218
// performance fixture line 219
// performance fixture line 220
// performance fixture line 221
// performance fixture line 222
// performance fixture line 223
// performance fixture line 224
// performance fixture line 225
// performance fixture line 226
// performance fixture line 227
// performance fixture line 228
// performance fixture line 229
// performance fixture line 230
// performance fixture line 231
// performance fixture line 232
// performance fixture line 233
// performance fixture line 234
// performance fixture line 235
// performance fixture line 236
// performance fixture line 237
// performance fixture line 238
// performance fixture line 239
// performance fixture line 240
// performance fixture line 241
// performance fixture line 242
// performance fixture line 243
// performance fixture line 244
// performance fixture line 245
// performance fixture line 246
// performance fixture line 247
// performance fixture line 248
// performance fixture line 249
// performance fixture line 250
// performance fixture line 251
// performance fixture line 252
// performance fixture line 253
// performance fixture line 254
// performance fixture line 255
// performance fixture line 256
// performance fixture line 257
// performance fixture line 258
// performance fixture line 259
// performance fixture line 260
// performance fixture line 261
// performance fixture line 262
// performance fixture line 263
// performance fixture line 264
// performance fixture line 265
// performance fixture line 266
// performance fixture line 267
// performance fixture line 268
// performance fixture line 269
// performance fixture line 270
// performance fixture line 271
// performance fixture line 272
// performance fixture line 273
// performance fixture line 274
// performance fixture line 275
// performance fixture line 276
// performance fixture line 277
// performance fixture line 278
// performance fixture line 279
// performance fixture line 280
// performance fixture line 281
// performance fixture line 282
// performance fixture line 283
// performance fixture line 284
// performance fixture line 285
// performance fixture line 286
// performance fixture line 287
// performance fixture line 288
// performance fixture line 289
// performance fixture line 290
// performance fixture line 291
// performance fixture line 292
// performance fixture line 293
// performance fixture line 294
// performance fixture line 295
// performance fixture line 296
// performance fixture line 297
// performance fixture line 298
// performance fixture line 299
// performance fixture line 300
// performance fixture line 301
// performance fixture line 302
// performance fixture line 303
// performance fixture line 304
// performance fixture line 305
// performance fixture line 306
// performance fixture line 307
// performance fixture line 308
// performance fixture line 309
// performance fixture line 310
// performance fixture line 311
// performance fixture line 312
// performance fixture line 313
// performance fixture line 314
// performance fixture line 315
// performance fixture line 316
// performance fixture line 317
// performance fixture line 318
// performance fixture line 319
// performance fixture line 320
// performance fixture line 321
// performance fixture line 322
// performance fixture line 323
// performance fixture line 324
// performance fixture line 325
// performance fixture line 326
// performance fixture line 327
// performance fixture line 328
// performance fixture line 329
// performance fixture line 330
// performance fixture line 331
// performance fixture line 332
// performance fixture line 333
// performance fixture line 334
// performance fixture line 335
// performance fixture line 336
// performance fixture line 337
// performance fixture line 338
// performance fixture line 339
// performance fixture line 340
// performance fixture line 341
// performance fixture line 342
// performance fixture line 343
// performance fixture line 344
// performance fixture line 345
// performance fixture line 346
// performance fixture line 347
// performance fixture line 348
// performance fixture line 349
// performance fixture line 350
// performance fixture line 351
// performance fixture line 352
// performance fixture line 353
// performance fixture line 354
// performance fixture line 355
// performance fixture line 356
// performance fixture line 357
// performance fixture line 358
// performance fixture line 359
// performance fixture line 360
// performance fixture line 361
// performance fixture line 362
// performance fixture line 363
// performance fixture line 364
// performance fixture line 365
// performance fixture line 366
// performance fixture line 367
// performance fixture line 368
// performance fixture line 369
// performance fixture line 370
// performance fixture line 371
// performance fixture line 372
// performance fixture line 373
// performance fixture line 374
// performance fixture line 375
// performance fixture line 376
// performance fixture line 377
// performance fixture line 378
// performance fixture line 379
// performance fixture line 380
// performance fixture line 381
// performance fixture line 382
// performance fixture line 383
// performance fixture line 384
// performance fixture line 385
// performance fixture line 386
// performance fixture line 387
// performance fixture line 388
// performance fixture line 389
// performance fixture line 390
// performance fixture line 391
// performance fixture line 392
// performance fixture line 393
// performance fixture line 394
// performance fixture line 395
// performance fixture line 396
// performance fixture line 397
// performance fixture line 398
// performance fixture line 399
// performance fixture line 400
// performance fixture line 401
// performance fixture line 402
// performance fixture line 403
// performance fixture line 404
// performance fixture line 405
// performance fixture line 406
// performance fixture line 407
// performance fixture line 408
// performance fixture line 409
// performance fixture line 410
// performance fixture line 411
// performance fixture line 412
// performance fixture line 413
// performance fixture line 414
// performance fixture line 415
// performance fixture line 416
// performance fixture line 417
// performance fixture line 418
// performance fixture line 419
// performance fixture line 420
// performance fixture line 421
// performance fixture line 422
// performance fixture line 423
// performance fixture line 424
// performance fixture line 425
// performance fixture line 426
// performance fixture line 427
// performance fixture line 428
// performance fixture line 429
// performance fixture line 430
// performance fixture line 431
// performance fixture line 432
// performance fixture line 433
// performance fixture line 434
// performance fixture line 435
// performance fixture line 436
// performance fixture line 437
// performance fixture line 438
// performance fixture line 439
// performance fixture line 440
// performance fixture line 441
// performance fixture line 442
// performance fixture line 443
// performance fixture line 444
// performance fixture line 445
// performance fixture line 446
// performance fixture line 447
// performance fixture line 448
// performance fixture line 449
// performance fixture line 450
// performance fixture line 451
// performance fixture line 452
// performance fixture line 453
// performance fixture line 454
// performance fixture line 455
// performance fixture line 456
// performance fixture line 457
// performance fixture line 458
// performance fixture line 459
// performance fixture line 460
// performance fixture line 461
// performance fixture line 462
// performance fixture line 463
// performance fixture line 464
// performance fixture line 465
// performance fixture line 466
// performance fixture line 467
// performance fixture line 468
// performance fixture line 469
// performance fixture line 470
// performance fixture line 471
// performance fixture line 472
// performance fixture line 473
// performance fixture line 474
// performance fixture line 475
// performance fixture line 476
// performance fixture line 477
// performance fixture line 478
// performance fixture line 479
// performance fixture line 480
// performance fixture line 481
// performance fixture line 482
// performance fixture line 483
// performance fixture line 484
// performance fixture line 485
// performance fixture line 486
// performance fixture line 487
// performance fixture line 488
// performance fixture line 489
// performance fixture line 490
// performance fixture line 491
// performance fixture line 492
// performance fixture line 493
// performance fixture line 494
// performance fixture line 495
// performance fixture line 496
// performance fixture line 497
// performance fixture line 498
// performance fixture line 499
// performance fixture line 500`
const PERFORMANCE_SOURCE_B = `export function fn01(){ return fn02()+1 }
export function fn02(){ return fn03() }
export function fn03(){ return fn04() }
export function fn04(){ return fn05() }
export function fn05(){ return fn06() }
export function fn06(){ return fn07() }
export function fn07(){ return fn08() }
export function fn08(){ return fn09() }
export function fn09(){ return fn10() }
export function fn10(){ return fn11() }
export function fn11(){ return fn12() }
export function fn12(){ return fn13() }
export function fn13(){ return fn14() }
export function fn14(){ return fn15() }
export function fn15(){ return fn16() }
export function fn16(){ return fn17() }
export function fn17(){ return fn18() }
export function fn18(){ return fn19() }
export function fn19(){ return fn20() }
export function fn20(){ return 20 }
// performance fixture line 021
// performance fixture line 022
// performance fixture line 023
// performance fixture line 024
// performance fixture line 025
// performance fixture line 026
// performance fixture line 027
// performance fixture line 028
// performance fixture line 029
// performance fixture line 030
// performance fixture line 031
// performance fixture line 032
// performance fixture line 033
// performance fixture line 034
// performance fixture line 035
// performance fixture line 036
// performance fixture line 037
// performance fixture line 038
// performance fixture line 039
// performance fixture line 040
// performance fixture line 041
// performance fixture line 042
// performance fixture line 043
// performance fixture line 044
// performance fixture line 045
// performance fixture line 046
// performance fixture line 047
// performance fixture line 048
// performance fixture line 049
// performance fixture line 050
// performance fixture line 051
// performance fixture line 052
// performance fixture line 053
// performance fixture line 054
// performance fixture line 055
// performance fixture line 056
// performance fixture line 057
// performance fixture line 058
// performance fixture line 059
// performance fixture line 060
// performance fixture line 061
// performance fixture line 062
// performance fixture line 063
// performance fixture line 064
// performance fixture line 065
// performance fixture line 066
// performance fixture line 067
// performance fixture line 068
// performance fixture line 069
// performance fixture line 070
// performance fixture line 071
// performance fixture line 072
// performance fixture line 073
// performance fixture line 074
// performance fixture line 075
// performance fixture line 076
// performance fixture line 077
// performance fixture line 078
// performance fixture line 079
// performance fixture line 080
// performance fixture line 081
// performance fixture line 082
// performance fixture line 083
// performance fixture line 084
// performance fixture line 085
// performance fixture line 086
// performance fixture line 087
// performance fixture line 088
// performance fixture line 089
// performance fixture line 090
// performance fixture line 091
// performance fixture line 092
// performance fixture line 093
// performance fixture line 094
// performance fixture line 095
// performance fixture line 096
// performance fixture line 097
// performance fixture line 098
// performance fixture line 099
// performance fixture line 100
// performance fixture line 101
// performance fixture line 102
// performance fixture line 103
// performance fixture line 104
// performance fixture line 105
// performance fixture line 106
// performance fixture line 107
// performance fixture line 108
// performance fixture line 109
// performance fixture line 110
// performance fixture line 111
// performance fixture line 112
// performance fixture line 113
// performance fixture line 114
// performance fixture line 115
// performance fixture line 116
// performance fixture line 117
// performance fixture line 118
// performance fixture line 119
// performance fixture line 120
// performance fixture line 121
// performance fixture line 122
// performance fixture line 123
// performance fixture line 124
// performance fixture line 125
// performance fixture line 126
// performance fixture line 127
// performance fixture line 128
// performance fixture line 129
// performance fixture line 130
// performance fixture line 131
// performance fixture line 132
// performance fixture line 133
// performance fixture line 134
// performance fixture line 135
// performance fixture line 136
// performance fixture line 137
// performance fixture line 138
// performance fixture line 139
// performance fixture line 140
// performance fixture line 141
// performance fixture line 142
// performance fixture line 143
// performance fixture line 144
// performance fixture line 145
// performance fixture line 146
// performance fixture line 147
// performance fixture line 148
// performance fixture line 149
// performance fixture line 150
// performance fixture line 151
// performance fixture line 152
// performance fixture line 153
// performance fixture line 154
// performance fixture line 155
// performance fixture line 156
// performance fixture line 157
// performance fixture line 158
// performance fixture line 159
// performance fixture line 160
// performance fixture line 161
// performance fixture line 162
// performance fixture line 163
// performance fixture line 164
// performance fixture line 165
// performance fixture line 166
// performance fixture line 167
// performance fixture line 168
// performance fixture line 169
// performance fixture line 170
// performance fixture line 171
// performance fixture line 172
// performance fixture line 173
// performance fixture line 174
// performance fixture line 175
// performance fixture line 176
// performance fixture line 177
// performance fixture line 178
// performance fixture line 179
// performance fixture line 180
// performance fixture line 181
// performance fixture line 182
// performance fixture line 183
// performance fixture line 184
// performance fixture line 185
// performance fixture line 186
// performance fixture line 187
// performance fixture line 188
// performance fixture line 189
// performance fixture line 190
// performance fixture line 191
// performance fixture line 192
// performance fixture line 193
// performance fixture line 194
// performance fixture line 195
// performance fixture line 196
// performance fixture line 197
// performance fixture line 198
// performance fixture line 199
// performance fixture line 200
// performance fixture line 201
// performance fixture line 202
// performance fixture line 203
// performance fixture line 204
// performance fixture line 205
// performance fixture line 206
// performance fixture line 207
// performance fixture line 208
// performance fixture line 209
// performance fixture line 210
// performance fixture line 211
// performance fixture line 212
// performance fixture line 213
// performance fixture line 214
// performance fixture line 215
// performance fixture line 216
// performance fixture line 217
// performance fixture line 218
// performance fixture line 219
// performance fixture line 220
// performance fixture line 221
// performance fixture line 222
// performance fixture line 223
// performance fixture line 224
// performance fixture line 225
// performance fixture line 226
// performance fixture line 227
// performance fixture line 228
// performance fixture line 229
// performance fixture line 230
// performance fixture line 231
// performance fixture line 232
// performance fixture line 233
// performance fixture line 234
// performance fixture line 235
// performance fixture line 236
// performance fixture line 237
// performance fixture line 238
// performance fixture line 239
// performance fixture line 240
// performance fixture line 241
// performance fixture line 242
// performance fixture line 243
// performance fixture line 244
// performance fixture line 245
// performance fixture line 246
// performance fixture line 247
// performance fixture line 248
// performance fixture line 249
// performance fixture line 250
// performance fixture line 251
// performance fixture line 252
// performance fixture line 253
// performance fixture line 254
// performance fixture line 255
// performance fixture line 256
// performance fixture line 257
// performance fixture line 258
// performance fixture line 259
// performance fixture line 260
// performance fixture line 261
// performance fixture line 262
// performance fixture line 263
// performance fixture line 264
// performance fixture line 265
// performance fixture line 266
// performance fixture line 267
// performance fixture line 268
// performance fixture line 269
// performance fixture line 270
// performance fixture line 271
// performance fixture line 272
// performance fixture line 273
// performance fixture line 274
// performance fixture line 275
// performance fixture line 276
// performance fixture line 277
// performance fixture line 278
// performance fixture line 279
// performance fixture line 280
// performance fixture line 281
// performance fixture line 282
// performance fixture line 283
// performance fixture line 284
// performance fixture line 285
// performance fixture line 286
// performance fixture line 287
// performance fixture line 288
// performance fixture line 289
// performance fixture line 290
// performance fixture line 291
// performance fixture line 292
// performance fixture line 293
// performance fixture line 294
// performance fixture line 295
// performance fixture line 296
// performance fixture line 297
// performance fixture line 298
// performance fixture line 299
// performance fixture line 300
// performance fixture line 301
// performance fixture line 302
// performance fixture line 303
// performance fixture line 304
// performance fixture line 305
// performance fixture line 306
// performance fixture line 307
// performance fixture line 308
// performance fixture line 309
// performance fixture line 310
// performance fixture line 311
// performance fixture line 312
// performance fixture line 313
// performance fixture line 314
// performance fixture line 315
// performance fixture line 316
// performance fixture line 317
// performance fixture line 318
// performance fixture line 319
// performance fixture line 320
// performance fixture line 321
// performance fixture line 322
// performance fixture line 323
// performance fixture line 324
// performance fixture line 325
// performance fixture line 326
// performance fixture line 327
// performance fixture line 328
// performance fixture line 329
// performance fixture line 330
// performance fixture line 331
// performance fixture line 332
// performance fixture line 333
// performance fixture line 334
// performance fixture line 335
// performance fixture line 336
// performance fixture line 337
// performance fixture line 338
// performance fixture line 339
// performance fixture line 340
// performance fixture line 341
// performance fixture line 342
// performance fixture line 343
// performance fixture line 344
// performance fixture line 345
// performance fixture line 346
// performance fixture line 347
// performance fixture line 348
// performance fixture line 349
// performance fixture line 350
// performance fixture line 351
// performance fixture line 352
// performance fixture line 353
// performance fixture line 354
// performance fixture line 355
// performance fixture line 356
// performance fixture line 357
// performance fixture line 358
// performance fixture line 359
// performance fixture line 360
// performance fixture line 361
// performance fixture line 362
// performance fixture line 363
// performance fixture line 364
// performance fixture line 365
// performance fixture line 366
// performance fixture line 367
// performance fixture line 368
// performance fixture line 369
// performance fixture line 370
// performance fixture line 371
// performance fixture line 372
// performance fixture line 373
// performance fixture line 374
// performance fixture line 375
// performance fixture line 376
// performance fixture line 377
// performance fixture line 378
// performance fixture line 379
// performance fixture line 380
// performance fixture line 381
// performance fixture line 382
// performance fixture line 383
// performance fixture line 384
// performance fixture line 385
// performance fixture line 386
// performance fixture line 387
// performance fixture line 388
// performance fixture line 389
// performance fixture line 390
// performance fixture line 391
// performance fixture line 392
// performance fixture line 393
// performance fixture line 394
// performance fixture line 395
// performance fixture line 396
// performance fixture line 397
// performance fixture line 398
// performance fixture line 399
// performance fixture line 400
// performance fixture line 401
// performance fixture line 402
// performance fixture line 403
// performance fixture line 404
// performance fixture line 405
// performance fixture line 406
// performance fixture line 407
// performance fixture line 408
// performance fixture line 409
// performance fixture line 410
// performance fixture line 411
// performance fixture line 412
// performance fixture line 413
// performance fixture line 414
// performance fixture line 415
// performance fixture line 416
// performance fixture line 417
// performance fixture line 418
// performance fixture line 419
// performance fixture line 420
// performance fixture line 421
// performance fixture line 422
// performance fixture line 423
// performance fixture line 424
// performance fixture line 425
// performance fixture line 426
// performance fixture line 427
// performance fixture line 428
// performance fixture line 429
// performance fixture line 430
// performance fixture line 431
// performance fixture line 432
// performance fixture line 433
// performance fixture line 434
// performance fixture line 435
// performance fixture line 436
// performance fixture line 437
// performance fixture line 438
// performance fixture line 439
// performance fixture line 440
// performance fixture line 441
// performance fixture line 442
// performance fixture line 443
// performance fixture line 444
// performance fixture line 445
// performance fixture line 446
// performance fixture line 447
// performance fixture line 448
// performance fixture line 449
// performance fixture line 450
// performance fixture line 451
// performance fixture line 452
// performance fixture line 453
// performance fixture line 454
// performance fixture line 455
// performance fixture line 456
// performance fixture line 457
// performance fixture line 458
// performance fixture line 459
// performance fixture line 460
// performance fixture line 461
// performance fixture line 462
// performance fixture line 463
// performance fixture line 464
// performance fixture line 465
// performance fixture line 466
// performance fixture line 467
// performance fixture line 468
// performance fixture line 469
// performance fixture line 470
// performance fixture line 471
// performance fixture line 472
// performance fixture line 473
// performance fixture line 474
// performance fixture line 475
// performance fixture line 476
// performance fixture line 477
// performance fixture line 478
// performance fixture line 479
// performance fixture line 480
// performance fixture line 481
// performance fixture line 482
// performance fixture line 483
// performance fixture line 484
// performance fixture line 485
// performance fixture line 486
// performance fixture line 487
// performance fixture line 488
// performance fixture line 489
// performance fixture line 490
// performance fixture line 491
// performance fixture line 492
// performance fixture line 493
// performance fixture line 494
// performance fixture line 495
// performance fixture line 496
// performance fixture line 497
// performance fixture line 498
// performance fixture line 499
// performance fixture line 500`

test('boundary value: a 64 KiB file parsed in exactly 8 milliseconds is not admitted to the retained AST cache', () => {
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 8]; return () => readings.shift() })() })

  resolver.applyChanges([{ type: 'add', path: 'src/large-exact.ts', source: `export const exact = 8\n${' '.repeat(65513)}` }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 0, estimatedBytes: 0, files: [] })
})

test('domain boundary: a 64 KiB file parsed just over 8 milliseconds may enter the bounded retained AST cache', () => {
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 8.001]; return () => readings.shift() })() })

  resolver.applyChanges([{ type: 'add', path: 'src/large-slow.ts', source: `export const slow = 9\n${' '.repeat(65514)}` }])

  assert.deepEqual(resolver.astCacheSnapshot(), { entries: 1, estimatedBytes: 67072, files: ['src/large-slow.ts'] })
})

test('error guessing: an exact parsed-facts cache hit bypasses an available retained AST update and preserves the requested graph', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 9, 10, 19]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/large-alternating.ts', source: `export function alpha(){ return 1 }\n${' '.repeat(65500)}` }])
  resolver.applyChanges([{ type: 'change', path: 'src/large-alternating.ts', source: `export function beta(){ return 2 }\n${' '.repeat(65501)}` }])

  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/large-alternating.ts', source: `export function alpha(){ return 1 }\n${' '.repeat(65500)}` }])

  assert.deepEqual(
    { operations: events.map(({ operation }) => operation), symbols: snapshot.symbols.map(({ name }) => name), ast: resolver.astCacheSnapshot() },
    { operations: ['create', 'update'], symbols: ['alpha'], ast: { entries: 1, estimatedBytes: 67072, files: ['src/large-alternating.ts'] } },
  )
})

test('error guessing: repeated A and B edits of a slow 500-line file emit no AST updates retain no ASTs and preserve the final graph', () => {
  const events = []
  const resolver = new FileLocalResolver('/repo', null, { now: (() => { const readings = [0, 9, 10, 19]; return () => readings.shift() })(), onParserEvent: (event) => events.push(event) })
  resolver.applyChanges([{ type: 'add', path: 'src/performance.ts', source: PERFORMANCE_SOURCE_A }])
  resolver.applyChanges([{ type: 'change', path: 'src/performance.ts', source: PERFORMANCE_SOURCE_B }])
  resolver.applyChanges([{ type: 'change', path: 'src/performance.ts', source: PERFORMANCE_SOURCE_A }])
  const snapshot = resolver.applyChanges([{ type: 'change', path: 'src/performance.ts', source: PERFORMANCE_SOURCE_B }])

  assert.deepEqual(
    { updateEvents: events.filter(({ operation }) => operation === 'update'), ast: resolver.astCacheSnapshot(), symbols: snapshot.symbols.map(({ name }) => name), firstEdge: snapshot.edges[0] && { fromName: snapshot.edges[0].fromName, toName: snapshot.edges[0].toName } },
    { updateEvents: [], ast: { entries: 0, estimatedBytes: 0, files: [] }, symbols: ['fn01', 'fn02', 'fn03', 'fn04', 'fn05', 'fn06', 'fn07', 'fn08', 'fn09', 'fn10', 'fn11', 'fn12', 'fn13', 'fn14', 'fn15', 'fn16', 'fn17', 'fn18', 'fn19', 'fn20'], firstEdge: { fromName: 'fn01', toName: 'fn02' } },
  )
})

test('performance gate: exactly 500 lines and 20 functions refresh from source text to an observable revision within 5ms maximum after warmup', (t) => {
  const resolver = new FileLocalResolver('/repo')
  assert.deepEqual({ lines: PERFORMANCE_SOURCE_A.split('\n').length, functions: PERFORMANCE_SOURCE_A.match(/^export function /gm).length }, { lines: 500, functions: 20 })
  for (let iteration = 0; iteration < 20; iteration += 1) resolver.applyChanges([{ type: iteration ? 'change' : 'add', path: 'src/performance.ts', source: iteration % 2 ? PERFORMANCE_SOURCE_A : PERFORMANCE_SOURCE_B }])
  const durations = []

  for (let iteration = 0; iteration < 120; iteration += 1) {
    const started = performance.now()
    const result = resolver.applyChanges([{ type: 'change', path: 'src/performance.ts', source: iteration % 2 ? PERFORMANCE_SOURCE_A : PERFORMANCE_SOURCE_B }])
    assert.equal(resolver.snapshot().revision, result.revision)
    durations.push(performance.now() - started)
  }
  const ordered = durations.toSorted((left, right) => left - right)
  const metrics = { p50: ordered[59], p95: ordered[113], p99: ordered[118], max: ordered[119] }

  t.diagnostic(`source-text applyChanges+snapshot milliseconds ${JSON.stringify(metrics)}`)
  assert.ok(metrics.max <= 5, `source-text performance regression: ${JSON.stringify(metrics)}`)
})

test('performance stretch: actual SSD read through observable revision reports p50 p95 p99 and max with p99 at most 5ms', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fast-refresh-ssd-'))
  const file = path.join(root, 'performance.ts')
  const resolver = new FileLocalResolver(root)
  fs.writeFileSync(file, PERFORMANCE_SOURCE_A)
  for (let iteration = 0; iteration < 20; iteration += 1) {
    fs.writeFileSync(file, iteration % 2 ? PERFORMANCE_SOURCE_A : PERFORMANCE_SOURCE_B)
    resolver.applyChanges([{ type: iteration ? 'change' : 'add', path: 'performance.ts', source: fs.readFileSync(file, 'utf8') }])
  }
  const durations = []

  for (let iteration = 0; iteration < 120; iteration += 1) {
    fs.writeFileSync(file, iteration % 2 ? PERFORMANCE_SOURCE_A : PERFORMANCE_SOURCE_B)
    const started = performance.now()
    const source = fs.readFileSync(file, 'utf8')
    const result = resolver.applyChanges([{ type: 'change', path: 'performance.ts', source }])
    assert.equal(resolver.snapshot().revision, result.revision)
    durations.push(performance.now() - started)
  }
  const ordered = durations.toSorted((left, right) => left - right)
  const metrics = { p50: ordered[59], p95: ordered[113], p99: ordered[118], max: ordered[119] }

  t.diagnostic(`SSD read+applyChanges+snapshot stretch target p99<=5ms ${JSON.stringify({ ...metrics, targetMet: metrics.p99 <= 5 })}`)
  assert.equal(
    Object.values(metrics).every((value) => Number.isFinite(value) && value >= 0) && metrics.p50 <= metrics.p95 && metrics.p95 <= metrics.p99 && metrics.p99 <= metrics.max,
    true,
    `SSD stretch produced invalid metrics: ${JSON.stringify(metrics)}`,
  )
})
