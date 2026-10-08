import test from 'node:test'
import assert from 'node:assert/strict'
import { createSemanticProject, prepareSemanticProject, parsePartition } from '../parser.mjs'
import { createOneFileSemanticSession } from './one-file-semantic-prototype.mjs'

// Equivalence partitioning, domain analysis, and error guessing: a changed binding
// must not inherit the previous lookup, even when an unchanged outer name matches.
test('an incremental shadowing edit matches every Project partition byte and reuses untouched syntax', () => {
  const root = '/private/tmp/codegraph-direct-api-small-proof'
  const rel = 'example.ts'
  const initial = 'export function stable() { return 7 }\n\nexport function caller() { function target() { return 1 }; target(); target() }\n'
  const changed = 'export function stable() { return 7 }\n\nexport function caller() { function stable() { return 1 }; stable(); stable() }\n'
  const session = createOneFileSemanticSession(root, rel)
  session.parse(initial)
  const untouched = session.sourceFile.statements[0]
  const previousLookups = session.lookups
  const result = session.parse(changed)
  const oracle = parsePartition(rel, changed, new Set([rel]), prepareSemanticProject(createSemanticProject(root, new Map([[rel, changed]]), { skipLoadingLibFiles: true }), root))

  assert.notEqual(initial, changed)
  assert.equal(session.sourceFile.text, changed)
  assert.equal(session.sourceFile.statements[0], untouched)
  assert.notEqual(session.lookups, previousLookups)
  assert.equal(session.stats.sourceCreates, 0)
  assert.equal(session.stats.sourceUpdates, 1)
  assert.ok(session.stats.nodeCacheHits > 0)
  assert.ok(Buffer.isBuffer(result.internalPartition))
  assert.deepStrictEqual(result, oracle)
})

// All-pairs floor: TSX + deletion/restoration + warm cache; boundary analysis:
// changing one identifier inside an arrow callback must retain its call edges.
test('a TSX handler edit and restoration leave no stale output and retain owned lookups on a repeat', () => {
  const root = '/private/tmp/codegraph-direct-api-small-proof'
  const rel = 'example.tsx'
  const initial = 'export function target() { return 1 }\n\nexport function View() { return <button onClick={() => target()}>go</button> }\n'
  const changed = 'export function target() { return 1 }\n\nexport function View() { return <button onClick={() => missing()}>go</button> }\n'
  const session = createOneFileSemanticSession(root, rel)
  session.parse(initial)
  const editedResult = session.parse(changed)
  const editedOracle = parsePartition(rel, changed, new Set([rel]), prepareSemanticProject(createSemanticProject(root, new Map([[rel, changed]]), { skipLoadingLibFiles: true }), root))
  const editedText = session.sourceFile.text
  session.parse(initial)
  const restoredSource = session.sourceFile
  const restoredChecker = session.checker
  const restoredLookups = session.lookups
  const result = session.parse(initial)
  const oracle = parsePartition(rel, initial, new Set([rel]), prepareSemanticProject(createSemanticProject(root, new Map([[rel, initial]]), { skipLoadingLibFiles: true }), root))

  assert.equal(editedText, changed)
  assert.notEqual(editedText, initial)
  assert.equal(session.sourceFile, restoredSource)
  assert.equal(session.checker, restoredChecker)
  assert.equal(session.lookups, restoredLookups)
  assert.equal(session.stats.sourceCreates, 0)
  assert.equal(session.stats.sourceUpdates, 0)
  assert.equal(session.stats.programCreates, 0)
  assert.equal(session.stats.checkerCreates, 0)
  assert.ok(session.stats.symbolCacheHits > 0)
  assert.ok(Buffer.isBuffer(result.internalPartition))
  assert.deepStrictEqual({ edited: editedResult, restored: result }, { edited: editedOracle, restored: oracle })
})
