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

test('entry points and MCP tool names remain available', () => {
  for (const file of ['cli.mjs', 'mcp.mjs']) assert.equal(fs.existsSync(path.join(import.meta.dirname, '..', file)), true)
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  for (const name of ['codegraph_refs', 'codegraph_callers', 'codegraph_deps', 'codegraph_dead', 'codegraph_index']) assert.match(source, new RegExp(name))
})

test('standard MCP graph tools execute through the v2 runtime instead of the legacy CLI', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const standardCalls = source.slice(source.indexOf('call.codegraph_refs'), source.indexOf('call.codegraph_index'))

  assert.match(standardCalls, /runtime\.engine\.(snapshot|query)/)
  assert.doesNotMatch(standardCalls, /runCli\s*\(/)
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

test('architectural boundary: complete graph consumers await enrichment while callers retain the eager call-only path', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const refs = source.slice(source.indexOf('call.codegraph_refs'), source.indexOf('call.codegraph_deps'))
  const deps = source.slice(source.indexOf('call.codegraph_deps'), source.indexOf('call.codegraph_callers'))
  const callers = source.slice(source.indexOf('call.codegraph_callers'), source.indexOf('call.codegraph_dead'))
  const dead = source.slice(source.indexOf('call.codegraph_dead'), source.indexOf('call.codegraph_index'))

  assert.deepEqual(
    { refsComplete: /snapshotComplete|edgeCoverage:\s*['"]complete['"]/.test(refs), depsComplete: /snapshotComplete|edgeCoverage:\s*['"]complete['"]/.test(deps), callersComplete: /snapshotComplete|edgeCoverage:\s*['"]complete['"]/.test(callers), deadComplete: /snapshotComplete|edgeCoverage:\s*['"]complete['"]/.test(dead) },
    { refsComplete: true, depsComplete: false, callersComplete: false, deadComplete: true },
  )
})

test('architectural boundary: MCP query forwards explicit consistency and returns freshness coverage revision and validated generation metadata', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const queryCall = source.slice(source.indexOf('call.codegraph_query'), source.indexOf("const send ="))

  assert.match(queryCall, /consistency/)
  assert.match(queryCall, /freshness/)
  assert.match(queryCall, /coverage/)
  assert.match(queryCall, /revision/)
  assert.match(queryCall, /validatedGeneration/)
})

test('architectural boundary: explicit generation remains validated and cannot be combined with provisional latest consistency', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const queryCall = source.slice(source.indexOf('call.codegraph_query'), source.indexOf("const send ="))

  assert.match(queryCall, /generation/)
  assert.match(queryCall, /validated/)
  assert.match(queryCall, /latest/)
})

test('architectural boundary: MCP deps pins graph locations rows and metadata through one atomic query handle', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const deps = source.slice(source.indexOf('call.codegraph_deps'), source.indexOf('call.codegraph_callers'))

  assert.match(deps, /pinQuery/)
  assert.match(deps, /metadata/)
  assert.doesNotMatch(deps, /engine\.snapshot\(\)/)
  assert.doesNotMatch(deps, /engine\.query\(/)
})
