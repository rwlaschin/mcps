import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSemanticProject, parsePartition, prepareSemanticProject } from '../parser.mjs'

test('equivalence partition: a cold semantic project retains TypeScript standard library files', () => {
  const sources = new Map([['src/main.ts', 'export const value: Promise<number> = Promise.resolve(1)\n']])

  const project = createSemanticProject('/private/tmp/cg-parser-full-libs', sources)
  const hasStandardLibrary = project.getProgram().compilerObject.getSourceFiles().some(({ fileName }) => path.basename(fileName).startsWith('lib.') && fileName.endsWith('.d.ts'))

  assert.equal(hasStandardLibrary, true)
})

test('equivalence partition: a one-file semantic delta project skips TypeScript standard library files', () => {
  const sources = new Map([['src/main.ts', 'export const value: Promise<number> = Promise.resolve(1)\n']])

  const project = createSemanticProject('/private/tmp/cg-parser-delta-libs', sources, { skipLoadingLibFiles: true })
  const hasStandardLibrary = project.getProgram().compilerObject.getSourceFiles().some(({ fileName }) => path.basename(fileName).startsWith('lib.') && fileName.endsWith('.d.ts'))

  assert.equal(hasStandardLibrary, false)
})

test('combinatorial domain analysis: source AST export forms produce exact exported flags and cached bindings', () => {
  const root = '/private/tmp/cg-parser-export-bindings'
  const sources = new Map([
    ['src/main.ts', "export function direct(){}\nexport default function namedDefault(){}\nconst local=1\nexport { local as alias }\nexport { named as renamed, default as forwardedDefault } from './dep'\nexport * as space from './dep'\nexport * from './extra'\n"],
    ['src/dep.ts', 'export default function fallback(){}\nexport const named=1\n'],
    ['src/extra.ts', 'export const extra=1\n'],
  ])
  const context = prepareSemanticProject(createSemanticProject(root, sources), root)

  const partition = parsePartition('src/main.ts', sources.get('src/main.ts'), new Set(['src/main.ts', 'src/dep.ts', 'src/extra.ts']), context, null, 'complete', false)

  assert.deepEqual(
    {
      symbols: partition.symbols.map(({ id, name, exported }) => ({ id, name, exported })),
      bindings: partition.bindings,
    },
    {
      symbols: [
        { id: '8de99555eb8fdfc0f8134140', name: 'direct', exported: true },
        { id: '049263bac9fb883dd7854cff', name: 'namedDefault', exported: true },
        { id: '2d80308c3e8f0df2c394ded9', name: 'local', exported: true },
      ],
      bindings: [
        { kind: 'symbol', name: 'direct', target: '8de99555eb8fdfc0f8134140' },
        { kind: 'symbol', name: 'default', target: '049263bac9fb883dd7854cff' },
        { kind: 'symbol', name: 'alias', target: '2d80308c3e8f0df2c394ded9' },
        { kind: 'reexport', name: 'renamed', specifier: './dep', remote: 'named' },
        { kind: 'reexport', name: 'forwardedDefault', specifier: './dep', remote: 'default' },
        { kind: 'namespace', name: 'space', specifier: './dep' },
        { kind: 'star', specifier: './extra' },
      ],
    },
  )
})

test('hotpath architecture boundary: parsePartition never traverses getExportedDeclarations', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'parser.mjs'), 'utf8')

  assert.doesNotMatch(source, /\.getExportedDeclarations\s*\(/)
})

test('domain and error-guessing analysis: cached imports resolve calls and references without retargeting a shadowing parameter', () => {
  const root = '/private/tmp/cg-parser-cached-identifiers'
  const targetSource = 'export function a(){return 1}\n'
  const targetSources = new Map([['src/a.ts', targetSource]])
  const targetContext = prepareSemanticProject(createSemanticProject(root, targetSources), root)
  const target = parsePartition('src/a.ts', targetSource, new Set(['src/a.ts']), targetContext, null, 'complete', false)
  const changedSource = "import { a as remote } from './a'\nexport function usesImported(){ const selected=remote; return remote()+selected() }\nexport function shadowed(remote:()=>number){ return remote() }\n"
  const changedSources = new Map([['src/b.ts', changedSource]])
  const changedContext = prepareSemanticProject(createSemanticProject(root, changedSources, { skipLoadingLibFiles: true }), root)

  const changed = parsePartition('src/b.ts', changedSource, new Set(['src/a.ts', 'src/b.ts']), changedContext, null, 'complete', false, false, new Map([['src/a.ts', target]]))

  assert.deepEqual(changed.edges, [
    { from: '64f5a6566678a7f748799326', to: '3bdd027f2bd7f1dadf7f2e4a', line: 2, call: false },
    { from: '32c6819cd2a7972b10352de4', to: '3bdd027f2bd7f1dadf7f2e4a', line: 2, call: true },
    { from: '32c6819cd2a7972b10352de4', to: '64f5a6566678a7f748799326', line: 2, call: true },
  ])
})

test('hotpath architecture boundary: cached import lookup receives the unaliased symbol before alias expansion', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'parser.mjs'), 'utf8')
  const resolver = source.slice(source.indexOf('function resolveIdentifierEdges'), source.indexOf('export function parsePartition'))

  assert.deepEqual(
    {
      usesUnaliasedSymbol: resolver.includes('resolveMissing(ident, symbol)'),
      cachedBeforeAliasExpansion: resolver.indexOf('resolveMissing(ident, symbol)') < resolver.indexOf('expandAliasSymbol(symbol)'),
    },
    { usesUnaliasedSymbol: true, cachedBeforeAliasExpansion: true },
  )
})

test('domain analysis: delta mode resolves a type-only import and local interface without loading libraries', () => {
  const root = '/private/tmp/cg-parser-delta-type-references'
  const remoteSource = 'export interface Remote { value:number }\n'
  const remoteSources = new Map([['src/remote.ts', remoteSource]])
  const remoteContext = prepareSemanticProject(createSemanticProject(root, remoteSources), root)
  const remote = parsePartition('src/remote.ts', remoteSource, new Set(['src/remote.ts']), remoteContext, null, 'complete', false)
  const source = "import type { Remote } from './remote'\ninterface Local { remote: Remote }\nexport function read(value: Local){ return value.remote.value }\n"
  const sources = new Map([['src/changed.ts', source]])
  const context = prepareSemanticProject(createSemanticProject(root, sources, { skipLoadingLibFiles: true }), root)

  const partition = parsePartition('src/changed.ts', source, new Set(['src/remote.ts', 'src/changed.ts']), context, null, 'complete', false, false, new Map([['src/remote.ts', remote]]))

  assert.deepEqual(
    {
      symbols: partition.symbols.map(({ id, name, exported }) => ({ id, name, exported })),
      edges: partition.edges,
    },
    {
      symbols: [
        { id: '8bb3a69db678443f2aa70cf5', name: 'read', exported: true },
        { id: 'fb13ebaa814f06155015c0f0', name: 'Local', exported: false },
      ],
      edges: [
        { from: 'fb13ebaa814f06155015c0f0', to: '7378c0a5f1e603f956de10a1', line: 2, call: false },
        { from: '8bb3a69db678443f2aa70cf5', to: 'fb13ebaa814f06155015c0f0', line: 3, call: false },
      ],
    },
  )
})

test('hotpath architecture boundary: one shared helper expands only symbols carrying the TypeScript alias flag', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'parser.mjs'), 'utf8')
  const helperStart = source.indexOf('function expandAliasSymbol')
  const helperEnd = source.indexOf('\n}', helperStart) + 2
  const helper = source.slice(helperStart, helperEnd)

  assert.deepEqual(
    {
      helperExists: helperStart >= 0,
      guardsAliasFlag: helper.includes('symbol.getFlags() & ts.SymbolFlags.Alias'),
      aliasExpansionCalls: source.match(/\.getAliasedSymbol\s*\(/g)?.length ?? 0,
      sharedHelperOccurrences: source.match(/expandAliasSymbol\s*\(/g)?.length ?? 0,
    },
    { helperExists: true, guardsAliasFlag: true, aliasExpansionCalls: 1, sharedHelperOccurrences: 3 },
  )
})
