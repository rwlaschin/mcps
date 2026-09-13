import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { qualifiedQuery } from '../query-target.mjs'

test('visualizer only consumes the streaming query client', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'visualizer.mjs'), 'utf8')
  assert.doesNotMatch(source, /tool-engine|source-policy|chokidar|\\.codegraph/)
  assert.match(source, /query-client/)
})

test('legacy query shapes retain file qualifiers', () => {
  assert.deepEqual(qualifiedQuery('src/a.ts:same'), { file: 'src/a.ts', name: 'same' })
  assert.deepEqual(qualifiedQuery('src/a.ts'), { file: 'src/a.ts' })
  assert.deepEqual(qualifiedQuery('same'), { name: 'same' })
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
