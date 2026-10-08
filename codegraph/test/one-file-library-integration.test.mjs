import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOneFileSemanticSession } from '../one-file-semantic-library.mjs'
import { createSemanticProject, createOneFileSemanticProject, prepareSemanticProject, parsePartition, contentHash } from '../parser.mjs'
import { SemanticCheckerWorker } from '../semantic-checker-worker.mjs'
import { decodeSymbolPartition } from '../store.mjs'

// Equivalence partitions, boundaries and all-pairs: zero/one imported targets,
// same/replaced dependency context, unchanged/equal-width/width-changing source.
for (const [name, dependency, initial, changed, replaceDependency, expectedHit] of [
  ['imported call survives an eligible edit with cached dependency facts', 'export function target() { return 7 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 1 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 2 }\n', false, 1],
  ['replacing a dependency row inside the same context invalidates imported targets', 'export function target() { return 7 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 1 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 2 }\n', true, 0],
  ['a two-digit literal rebuilds positions with cached dependency facts', 'export function target() { return 7 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 1 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 20 }\n', false, 0],
  ['unchanged source reuses analysis with cached dependency facts', 'export function target() { return 7 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 1 }\n', 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 1 }\n', false, 1],
  ['zero remains an eligible numeric token at the value boundary', 'export function target() { return 7 }\n', 'function proof() { return 1 }\n', 'function proof() { return 0 }\n', false, 1],
  ['an identifier replacing the numeric token invalidates analysis', 'export function target() { return 7 }\n', 'function proof() { return 1 }\n', 'function proof() { return x }\n', false, 0],
  ['an empty return expression invalidates analysis', 'export function target() { return 7 }\n', 'function proof() { return 1 }\n', 'function proof() { return   }\n', false, 0],
  ['a syntax error replacing the numeric token rebuilds output', 'export function target() { return 7 }\n', 'function proof() { return 1 }\n', 'function proof() { return @ }\n', false, 0],
]) test(name, () => {
  const root = '/private/tmp/codegraph-library-integration-direct'
  const known = new Set(['a.ts', 'dep.ts'])
  const dep = parsePartition('dep.ts', dependency, known, prepareSemanticProject(createSemanticProject(root, new Map([['dep.ts', dependency]]), { skipLoadingLibFiles: true }), root))
  const cached = { 'dep.ts': dep }
  const session = createOneFileSemanticSession(root, 'a.ts')
  session.parse(initial, known, cached)
  if (replaceDependency) {
    const replacement = 'export function other() { return 7 }\n'
    cached['dep.ts'] = parsePartition('dep.ts', replacement, known, prepareSemanticProject(createSemanticProject(root, new Map([['dep.ts', replacement]]), { skipLoadingLibFiles: true }), root))
  }
  const actual = session.parse(changed, known, cached)
  const expected = parsePartition('a.ts', changed, known, prepareSemanticProject(createOneFileSemanticProject(root, new Map([['a.ts', changed]])), root), null, 'complete', true, true, cached)
  assert.deepStrictEqual(actual, expected)
  assert.equal(session.stats.analysisCacheHits, expectedHit)
})

// Error guessing/domain analysis: actual worker transport, multi-file retained
// generation, repeated edit, dependency switch, unlink/re-add, and config switch.
for (const [scenario, expectedHit] of [['warm', 1], ['dependency', 0], ['unlink', 0], ['config', 0], ['root', 0]]) test(`the real worker preserves complete output after ${scenario} transition`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-library-worker-'))
  const worker = new SemanticCheckerWorker()
  t.after(async () => { await worker.dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  const dependency = 'export function target() { return 7 }\n'
  const initial = 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 1 }\n'
  const second = 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 2 }\n'
  const changed = 'import { target } from "./dep"; export function caller() { return target() }\nfunction proof() { return 3 }\n'
  const known = new Set(['a.ts', 'dep.ts'])
  let activeRoot = root
  const initialContext = prepareSemanticProject(createSemanticProject(root, new Map([['a.ts', initial], ['dep.ts', dependency]])), root)
  const initialPartition = parsePartition('a.ts', initial, known, initialContext)
  const depPartition = parsePartition('dep.ts', dependency, known, initialContext)
  await worker.hydrate({ root, generation: 'base', sources: [['a.ts', initial], ['dep.ts', dependency]], sourceBlobs: { 'a.ts': contentHash(initial), 'dep.ts': contentHash(dependency) }, partitions: { 'a.ts': initialPartition, 'dep.ts': depPartition }, internalFingerprints: { 'a.ts': initialPartition.internalFingerprint, 'dep.ts': depPartition.internalFingerprint } })
  const run = async (file, source, type = 'change') => {
    const pool = new SharedArrayBuffer(4096 + 300 * 65536)
    let output
    const result = await worker.validate({ root: activeRoot, sourceDir: root, revision: 1, baseGeneration: 'base', changes: [{ type, path: file, source }], partitionPool: pool }, progress => {
      const record = progress.partitions[0]
      const bytes = Buffer.from(pool, 4096 + record.offset, record.length)
      output = { ...decodeSymbolPartition(bytes.subarray(0, record.symbolLength)), internalPartition: Buffer.from(bytes.subarray(record.symbolLength)) }
    })
    if (output) output.internalFingerprint = result.partitionReceipts[0].internalFingerprint
    return { result, output }
  }
  await run('a.ts', second)
  let cached = { 'a.ts': initialPartition, 'dep.ts': depPartition }
  if (scenario === 'dependency') {
    const replacement = 'export function other() { return 7 }\n'
    await run('dep.ts', replacement)
    cached['dep.ts'] = parsePartition('dep.ts', replacement, known, prepareSemanticProject(createOneFileSemanticProject(root, new Map([['dep.ts', replacement]])), root), null, 'complete', true, true, cached)
  }
  if (scenario === 'unlink') await run('a.ts', undefined, 'unlink')
  if (scenario === 'config') fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2020"}}')
  if (scenario === 'root') { activeRoot = path.join(root, 'other-root'); fs.mkdirSync(activeRoot) }
  const { result, output } = await run('a.ts', changed, scenario === 'unlink' ? 'add' : 'change')
  const expected = parsePartition('a.ts', changed, known, prepareSemanticProject(createOneFileSemanticProject(activeRoot, new Map([['a.ts', changed]])), activeRoot), null, 'complete', true, true, cached)
  assert.deepStrictEqual(output, expected)
  assert.deepStrictEqual(Object.keys(result.sourceBlobs), ['a.ts'])
  assert.equal(result.workCounters.dependentSourcesRead, 0)
  assert.equal(result.semanticSessionStats.analysisCacheHits, expectedHit)
})
