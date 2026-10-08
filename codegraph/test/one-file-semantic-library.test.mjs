import test from 'node:test'
import assert from 'node:assert/strict'
import { createSemanticProject, prepareSemanticProject, parsePartition } from '../parser.mjs'
import { createOneFileSemanticSession } from '../one-file-semantic-library.mjs'

// Boundary analysis and error guessing: a prefix insertion changes positions of
// compiler nodes that TypeScript reuses. Cached names/text must stay valid too.
test('a prefix insertion updates every partition byte for a reused declaration', () => {
  const root = '/private/tmp/codegraph-library-small-proof'
  const rel = 'example.ts'
  const initial = 'export function target() { return 7 }\n\nexport function caller() { target() }\n'
  const changed = '// 🦉 prefix\nexport function target() { return 7 }\n\nexport function caller() { target() }\n'
  const session = createOneFileSemanticSession(root, rel)
  session.parse(initial)
  const previous = session.sourceFile.statements[1]
  const result = session.parse(changed)
  const oracle = parsePartition(rel, changed, new Set([rel]), prepareSemanticProject(createSemanticProject(root, new Map([[rel, changed]]), { skipLoadingLibFiles: true }), root))
  assert.equal(session.sourceFile.statements[1], previous)
  assert.equal(session.stats.sourceUpdates, 1)
  assert.deepStrictEqual(result, oracle)
})

// Equivalence partitioning and domain analysis: an inner binding shadows an
// outer binding while JSX references the inner function. Changed lookup scope
// must invalidate independently from unchanged structural caches.
test('renaming a nested JSX binding into a shadowed name preserves complete output', () => {
  const root = '/private/tmp/codegraph-library-small-proof'
  const rel = 'example.tsx'
  const initial = 'export function target() { return 7 }\n\nexport function View() { function local() { return 1 }; return <button onClick={() => local()}>go</button> }\n'
  const changed = 'export function target() { return 7 }\n\nexport function View() { function target() { return 1 }; return <button onClick={() => target()}>go</button> }\n'
  const session = createOneFileSemanticSession(root, rel)
  session.parse(initial)
  const previousLookups = session.lookups
  const result = session.parse(changed)
  const oracle = parsePartition(rel, changed, new Set([rel]), prepareSemanticProject(createSemanticProject(root, new Map([[rel, changed]]), { skipLoadingLibFiles: true }), root))
  assert.notEqual(session.lookups, previousLookups)
  assert.deepStrictEqual(result, oracle)
})

// Combinatorial coverage: TSX × restoration × repeated source. Error guessing:
// the A→B→A sequence must discard B's symbols yet reuse the repeated A checker.
test('restoring a JSX call then repeating it retains no stale edited binding', () => {
  const root = '/private/tmp/codegraph-library-small-proof'
  const rel = 'example.tsx'
  const initial = 'export function target() { return 7 }\n\nexport function View() { return <button onClick={() => target()}>go</button> }\n'
  const changed = 'export function target() { return 7 }\n\nexport function View() { return <button onClick={() => missing()}>go</button> }\n'
  const session = createOneFileSemanticSession(root, rel)
  const oracle = source => parsePartition(rel, source, new Set([rel]), prepareSemanticProject(createSemanticProject(root, new Map([[rel, source]]), { skipLoadingLibFiles: true }), root))
  session.parse(initial)
  const edited = session.parse(changed)
  const restored = session.parse(initial)
  const checker = session.checker
  const result = session.parse(initial)
  assert.equal(session.checker, checker)
  assert.equal(session.stats.sourceUpdates, 0)
  assert.equal(session.stats.programCreates, 0)
  assert.deepStrictEqual({ edited, restored, repeated: result }, { edited: oracle(changed), restored: oracle(initial), repeated: oracle(initial) })
})

// Boundary/domain analysis: same-width numeric edits keep graph positions;
// a rename, width change, or changed file membership must rebuild analysis.
test('numeric return edits reuse complete analysis until syntax or membership invalidates it', () => {
  const root = '/private/tmp/codegraph-library-small-proof'
  const rel = 'example.ts'
  const initial = 'export function caller() { return proof() }\nfunction proof() { return 1 }\n'
  const second = 'export function caller() { return proof() }\nfunction proof() { return 2 }\n'
  const third = 'export function caller() { return proof() }\nfunction proof() { return 3 }\n'
  const fourth = 'export function caller() { return proof() }\nfunction proof() { return 4 }\n'
  const renamed = 'export function caller() { return proof() }\nfunction other() { return 4 }\n'
  const wider = 'export function caller() { return proof() }\nfunction other() { return 40 }\n'
  const oracle = (source, known = new Set([rel])) => parsePartition(rel, source, known, prepareSemanticProject(createSemanticProject(root, new Map([[rel, source]]), { skipLoadingLibFiles: true }), root))
  const session = createOneFileSemanticSession(root, rel)
  session.parse(initial)
  const secondResult = session.parse(second)
  const secondStats = session.stats
  const thirdResult = session.parse(third)
  const thirdStats = session.stats
  const fourthResult = session.parse(fourth)
  const fourthStats = session.stats
  const renamedResult = session.parse(renamed)
  const renamedStats = session.stats
  const widerResult = session.parse(wider)
  const widerStats = session.stats
  const membershipSession = createOneFileSemanticSession(root, rel)
  membershipSession.parse(initial)
  membershipSession.parse(fourth)
  const membershipResult = membershipSession.parse(fourth, new Set([rel, 'dep.ts']))
  const membershipStats = membershipSession.stats
  assert.deepStrictEqual({ second: secondResult, third: thirdResult, fourth: fourthResult, membership: membershipResult, renamed: renamedResult, wider: widerResult }, { second: oracle(second), third: oracle(third), fourth: oracle(fourth), membership: oracle(fourth, new Set([rel, 'dep.ts'])), renamed: oracle(renamed), wider: oracle(wider) })
  assert.deepStrictEqual([secondStats.analysisCacheHits, thirdStats.analysisCacheHits, fourthStats.analysisCacheHits], [1, 1, 1])
  assert.deepStrictEqual([secondStats.programCreates, thirdStats.programCreates, fourthStats.programCreates], [0, 0, 0])
  assert.deepStrictEqual([secondStats.checkerCreates, thirdStats.checkerCreates, fourthStats.checkerCreates], [0, 0, 0])
  assert.deepStrictEqual([membershipStats.analysisCacheHits, renamedStats.analysisCacheHits, widerStats.analysisCacheHits], [0, 0, 0])
  assert.equal(membershipStats.programCreates, 1)
})
