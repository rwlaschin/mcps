import test from 'node:test'
import assert from 'node:assert/strict'
import { Project } from 'ts-morph'
import { PrefetchedFileSystemHost } from '../prefetched-file-system.mjs'
import { parsePartition, prepareSemanticProject } from '../parser.mjs'

test('equivalence partition: mapped synchronous reads return the exact prefetched string without reading the delegate', () => {
  const delegate = { isCaseSensitive: () => true, readFileSync: () => { throw new Error('delegate source read') } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'export const a = "😀"\n']]), delegate)

  const result = host.readFileSync('/repo/src/a.ts', 'utf8')

  assert.equal(result, 'export const a = "😀"\n')
})

test('equivalence partition: mapped asynchronous reads return the exact prefetched string without reading the delegate', async () => {
  const delegate = { isCaseSensitive: () => true, readFile: async () => { throw new Error('delegate source read') } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'export const a = 1\n']]), delegate)

  const result = await host.readFile('/repo/src/a.ts', 'utf8')

  assert.equal(result, 'export const a = 1\n')
})

test('boundary value: an empty prefetched source is a cache hit rather than a delegate read', () => {
  let delegateReads = 0
  const delegate = { isCaseSensitive: () => true, readFileSync: () => { delegateReads += 1; return 'wrong' } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/empty.ts', '']]), delegate)

  const result = host.readFileSync('/repo/src/empty.ts')

  assert.deepEqual({ result, delegateReads }, { result: '', delegateReads: 0 })
})

test('equivalence partition: mapped file existence succeeds synchronously without consulting the delegate', () => {
  let delegateCalls = 0
  const delegate = { isCaseSensitive: () => true, fileExistsSync: () => { delegateCalls += 1; return false } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'a']]), delegate)

  const result = host.fileExistsSync('/repo/src/a.ts')

  assert.deepEqual({ result, delegateCalls }, { result: true, delegateCalls: 0 })
})

test('equivalence partition: mapped file existence succeeds asynchronously without consulting the delegate', async () => {
  let delegateCalls = 0
  const delegate = { isCaseSensitive: () => true, fileExists: async () => { delegateCalls += 1; return false } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'a']]), delegate)

  const result = await host.fileExists('/repo/src/a.ts')

  assert.deepEqual({ result, delegateCalls }, { result: true, delegateCalls: 0 })
})

test('domain analysis: an unmapped config read delegates with the original receiver and arguments', () => {
  const calls = []
  const delegate = { isCaseSensitive: () => true, readFileSync(file, encoding) { assert.equal(this, delegate); calls.push([file, encoding]); return '{"include":["src"]}' } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'a']]), delegate)

  const result = host.readFileSync('/repo/tsconfig.json', 'utf8')

  assert.deepEqual({ result, calls }, { result: '{"include":["src"]}', calls: [['/repo/tsconfig.json', 'utf8']] })
})

test('domain analysis: an unmapped library existence check delegates with the original receiver and arguments', async () => {
  const calls = []
  const delegate = { isCaseSensitive: () => true, async fileExists(file) { assert.equal(this, delegate); calls.push(file); return true } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'a']]), delegate)

  const result = await host.fileExists('/typescript/lib/lib.es2024.d.ts')

  assert.deepEqual({ result, calls }, { result: true, calls: ['/typescript/lib/lib.es2024.d.ts'] })
})

test('error guessing: an unmapped delegate error is rethrown as the same object', async () => {
  const failure = new Error('permission denied while reading library')
  const delegate = { isCaseSensitive: () => true, readFile: async () => { throw failure } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'a']]), delegate)

  const reading = host.readFile('/typescript/lib/lib.es2024.d.ts')

  await assert.rejects(reading, (error) => error === failure)
})

test('equivalence partition: a traversal source key is rejected before it can escape the project root', () => {
  const delegate = { isCaseSensitive: () => true }

  assert.throws(() => new PrefetchedFileSystemHost('/repo', new Map([['../outside.ts', 'secret']]), delegate), /project|root|relative|traversal/i)
})

test('equivalence partition: an absolute source key is rejected instead of being accepted as a second root', () => {
  const delegate = { isCaseSensitive: () => true }

  assert.throws(() => new PrefetchedFileSystemHost('/repo', new Map([['/other/source.ts', 'secret']]), delegate), /absolute|relative|project|root/i)
})

test('domain analysis: two relative keys that canonicalize to one project file are rejected', () => {
  const delegate = { isCaseSensitive: () => true }

  assert.throws(() => new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'first'], ['src/./a.ts', 'second']]), delegate), /collision|duplicate|canonical/i)
})

test('combinatorial: a case-sensitive delegate keeps differently-cased project files distinct', () => {
  const delegate = { isCaseSensitive: () => true, readFileSync: () => { throw new Error('delegate source read') } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/A.ts', 'upper'], ['src/a.ts', 'lower']]), delegate)

  const result = [host.readFileSync('/repo/src/A.ts'), host.readFileSync('/repo/src/a.ts')]

  assert.deepEqual(result, ['upper', 'lower'])
})

test('combinatorial: a case-insensitive delegate rejects source keys that differ only by case', () => {
  const delegate = { isCaseSensitive: () => false }

  assert.throws(() => new PrefetchedFileSystemHost('/repo', new Map([['src/A.ts', 'upper'], ['src/a.ts', 'lower']]), delegate), /collision|duplicate|case|canonical/i)
})

test('regression: an imported source inserted after its importer is resolved without any delegate source read and produces the same graph', () => {
  const delegatedReads = []
  const delegate = new (class {
    isCaseSensitive() { return true }
    getCurrentDirectory() { return '/repo' }
    fileExistsSync() { return false }
    readFileSync(file) { delegatedReads.push(file); throw new Error(`delegate source read: ${file}`) }
    directoryExistsSync() { return true }
    realpathSync(file) { return file }
    globSync() { return [] }
  })()
  const sources = new Map([
    ['src/consumer.ts', "import { value } from './value'; export function consume(){ return value() }\n"],
    ['src/value.ts', 'export function value(){ return 42 }\n'],
  ])
  const host = new PrefetchedFileSystemHost('/repo', sources, delegate)
  const project = new Project({ fileSystem: host, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true, moduleResolution: 100 } })
  for (const [relative, source] of sources) project.createSourceFile(`/repo/${relative}`, source, { overwrite: true })

  const context = prepareSemanticProject(project, '/repo')
  const consumer = parsePartition('src/consumer.ts', sources.get('src/consumer.ts'), new Set(sources.keys()), context)

  assert.deepEqual(
    { delegatedReads, dependencies: consumer.dependencies, edges: consumer.edges.length },
    { delegatedReads: [], dependencies: ['src/value.ts'], edges: 1 },
  )
})

test('domain analysis: upsert replaces a mapped source in place without permitting an external write', () => {
  let delegatedWrites = 0
  const delegate = { isCaseSensitive: () => true, writeFileSync: () => { delegatedWrites += 1 } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'export const value = 1\n']]), delegate)

  host.upsert('src/a.ts', 'export const value = 2\n')
  assert.throws(() => host.writeFileSync('/repo/src/a.ts', 'corrupt'), /prefetched source/i)

  assert.deepEqual({ source: host.readFileSync('/repo/src/a.ts', 'utf8'), delegatedWrites }, { source: 'export const value = 2\n', delegatedWrites: 0 })
})

test('domain analysis: remove deletes a mapped source in place without permitting an external delete first', () => {
  let delegatedDeletes = 0
  const delegate = { isCaseSensitive: () => true, fileExistsSync: () => false, deleteSync: () => { delegatedDeletes += 1 } }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'export const value = 1\n']]), delegate)

  assert.throws(() => host.deleteSync('/repo/src/a.ts'), /prefetched source/i)
  host.remove('src/a.ts')

  assert.deepEqual({ exists: host.fileExistsSync('/repo/src/a.ts'), delegatedDeletes }, { exists: false, delegatedDeletes: 0 })
})

test('equivalence partition: upsert rejects a traversal path without mutating the mapped source set', () => {
  const delegate = { isCaseSensitive: () => true, fileExistsSync: () => false }
  const host = new PrefetchedFileSystemHost('/repo', new Map([['src/a.ts', 'safe']]), delegate)

  assert.throws(() => host.upsert('../outside.ts', 'secret'), /project|root|relative|traversal/i)

  assert.equal(host.readFileSync('/repo/src/a.ts'), 'safe')
})
