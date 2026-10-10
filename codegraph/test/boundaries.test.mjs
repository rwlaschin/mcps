import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { createService } from '../mcp-server.mjs'
import { qualifiedQuery } from '../query-target.mjs'

const typescriptQueryMetadata = { extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] }

test('visualizer only consumes the streaming query client', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'visualizer.mjs'), 'utf8')
  assert.doesNotMatch(source, /tool-engine|source-policy|chokidar|\\.codegraph/)
  assert.match(source, /query-client/)
})

test('legacy query shapes retain file qualifiers', () => {
  assert.deepEqual(qualifiedQuery('src/a.ts:same', typescriptQueryMetadata), { file: 'src/a.ts', name: 'same' })
  assert.deepEqual(qualifiedQuery('src/a.ts', typescriptQueryMetadata), { file: 'src/a.ts' })
  assert.deepEqual(qualifiedQuery('same', typescriptQueryMetadata), { name: 'same' })
})

test('visualizer aborts the child query on request or response disconnect', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'visualizer.mjs'), 'utf8')
  assert.match(source, /req\.once\('aborted', abort\)/)
  assert.match(source, /res\.once\('close', abort\)/)
  assert.match(source, /signal: controller\.signal/)
})

test('architecture contract: MCP exposes internals without replacing existing tool declarations', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp-server.mjs'), 'utf8')
  assert.deepEqual({ internals: /codegraph_internals/.test(source), refs: /codegraph_refs/.test(source), deps: /codegraph_deps/.test(source), callers: /codegraph_callers/.test(source), dead: /codegraph_dead/.test(source) }, { internals: true, refs: true, deps: true, callers: true, dead: true })
})

test('domain analysis: qualified targets use analyzer-owned fake extensions', () => {
  assert.deepEqual(qualifiedQuery('src/card.widget:render', { extensions: ['.widget'] }), { file: 'src/card.widget', name: 'render' })
})

test('architecture contract: shared modules contain no language-routing literals or analyzer-id branches', () => {
  const files = ['source-policy.mjs', 'query-target.mjs', 'tool-engine.mjs', 'mcp-server.mjs', 'mcp-runtime.mjs', 'visualizer.mjs']
  const violations = []
  for (const file of files) {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8')
    const executable = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (/\[['"]\.(?:go|ts|tsx|js|jsx|mts|cts|mjs|cjs)['"]/.test(executable) || /(?:extname|extension|suffix)[\s\S]{0,120}['"]\.(?:go|ts|tsx|js|jsx|mts|cts|mjs|cjs)['"]/.test(executable)) violations.push(`${file}: extension routing`)
    if (/(?:basename|control|watch)[\s\S]{0,120}['"](?:go\.(?:mod|sum|work)|tsconfig\.json|jsconfig\.json)['"]/.test(executable)) violations.push(`${file}: control routing`)
    if (/(?:\.id|analyzerId)\s*={2,3}\s*['"](?:go|typescript|javascript)['"]/.test(executable)) violations.push(`${file}: analyzer id branch`)
  }
  assert.deepEqual(violations, [])
})

test('architecture contract: every durable generation publication carries analyzer metadata', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'tool-engine.mjs'), 'utf8')
  const publications = [...source.matchAll(/store\.publish\(\{([\s\S]*?)\}\)/g)].map((match) => match[1])
  assert.deepEqual({ count: publications.length, missingMetadata: publications.filter((publication) => !/\banalyzers\s*:/.test(publication)).length }, { count: 2, missingMetadata: 0 })
})

test('architecture contract: qualified and unqualified mmap activation validates analyzer metadata before acquire', () => {
  const toolEngine = fs.readFileSync(path.join(import.meta.dirname, '..', 'tool-engine.mjs'), 'utf8')
  const mcpServer = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp-server.mjs'), 'utf8')
  assert.deepEqual(
    { tool: /isManifestCompatible[\s\S]*mmapQueryCache\.acquire/.test(toolEngine), mcp: /isManifestCompatible[\s\S]*(?:queryCacheFor|DaemonQueryEngine)/.test(mcpServer) },
    { tool: true, mcp: true },
  )
})

test('documentation contract: CodeGraph performance and cache rules remain complete', () => {
  const file = path.join(import.meta.dirname, '..', 'AGENTS.md')
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const required = [
    'Scope: this file applies only to the CodeGraph directory.',
    'This local contract supplements the parent verified-orchestration contract.',
    '## mmap / SSPL traversal',
    'No decode, deserialization, or locale comparator in the traversal hot path.',
    'Writer and reader comparators must be symmetric and locale-independent.',
    '## Changed-file-only invalidation',
    'Never compute an export-surface fingerprint or reverse dependency closure for a single-file edit.',
    'Never skip dependent work only after already paying its cost.',
    'Current generations store complete partitions so a single-file update can patch exact edge and dangling-reference records from cached facts.',
    '## Incremental cache integrity',
    'No whole-workspace cache key guaranteed to miss on mutation.',
    'Never clone or reparse every source for one staged edit.',
    'Retain and patch indexes and cached facts.',
    'One changed or deleted file never reads, parses, scans, resolves, or validates dependent source files.',
    'Consult cached facts, patch exact edge/status records, and report dangling references.',
    'No unbounded copy-on-write overlay ancestry.',
    'Reject stale staged commits.',
    '## Parser workers',
    'Never bypass the worker pool.',
    'Cold and legitimate multi-file batches parallelize with CPU-1 by default or exactly 3 configured workers.',
    'A one-file edit dispatches exactly one parser job.',
    'Profiled worker CPU and heap destinations are unique; trace output is process-wide.',
    'Profiled parser requests have no timeout.',
    '## DRY indexes and derivations',
    'Do not duplicate reverse indexes, resolver matchers, or profiler artifact derivation.',
    '## Truthful cache receipts',
    'Never report cache reuse when upstream work was recomputed.',
    'On incremental paths, every applicable retained cache and index must be used; none may be ignored or rebuilt.',
    '## Deterministic CI gates',
    'Use deterministic counters and invariants; never gate CI on wall-clock thresholds.',
    '## Performance profiling process',
    'Use an external script against a real repository and real code path.',
    'Measure cold and warm separately.',
    'Capture a baseline before each fix and a post-fix profile of the exact same problem.',
    'Use standard V8 CPU, heap, and trace profiles.',
    'Run profiles outside the sandbox with host process access.',
    'Allow runs longer than 60 seconds and impose no arbitrary profile cap.',
    'Inspect hot paths, allocations, and garbage collection.',
    'Obtain independent scope, design, and effectiveness review after every stage.',
    'Run focused tests during slices and the full suite once at the end.',
  ]

  assert.deepEqual(required.filter((phrase) => !source.includes(phrase)), [])
})

// All-pairs/domain analysis: metadata compatibility × qualified/unqualified target.
for (const { name, cacheKey, symbol, text, isError, engineFactory } of [
  { name: 'matching metadata with an unqualified target serves pinned references', cacheKey: 'typescript-2', symbol: 'value', text: 'consumer.ts:1 -> value.ts:1', isError: false, engineFactory: async root => new CodeGraphEngine(root) },
  { name: 'matching metadata with a qualified target serves pinned references', cacheKey: 'typescript-2', symbol: 'value.ts:value', text: 'consumer.ts:1 -> value.ts:1', isError: false, engineFactory: async root => new CodeGraphEngine(root) },
  { name: 'stale metadata with an unqualified target reconciles before serving references', cacheKey: 'typescript-0', symbol: 'value', text: 'error: admission reconciliation required', isError: true, engineFactory: async () => ({ reconcile: async () => { throw new Error('admission reconciliation required') }, dispose: async () => {} }) },
  { name: 'stale metadata with a qualified target reconciles before serving references', cacheKey: 'typescript-0', symbol: 'value.ts:value', text: 'error: admission reconciliation required', isError: true, engineFactory: async () => ({ reconcile: async () => { throw new Error('admission reconciliation required') }, dispose: async () => {} }) },
]) {
  test(`analyzer admission: ${name}`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-analyzer-admission-')))
    fs.writeFileSync(path.join(root, 'value.ts'), 'export const value = 41\n')
    fs.writeFileSync(path.join(root, 'consumer.ts'), "import { value } from './value'; export function read(){ return value }\n")
    const engine = new CodeGraphEngine(root)
    await engine.build()
    await engine.snapshotComplete()
    const manifest = engine.readGeneration()
    const manifestPath = path.join(root, '.codegraph/generations', `${manifest.generation}.json`)
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, analyzers: { typescript: cacheKey } }))
    await engine.dispose()
    const service = createService({ workerCount: 1, engineFactory })
    try {
      const reply = await service.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_refs', arguments: { root, symbol } } }, { owner: {} })
      assert.deepEqual({ text: reply.result.content[0].text, isError: reply.result.isError === true }, { text, isError })
    } finally {
      await service.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
