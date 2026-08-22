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

test('architectural boundary: MCP reads use the lightweight query path while index and refresh retain the watched v2 runtime', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const reads = source.slice(source.indexOf('call.codegraph_refs'), source.indexOf('call.codegraph_index'))
  const mutations = source.slice(source.indexOf('call.codegraph_index'), source.indexOf('call.codegraph_query'))

  assert.doesNotMatch(reads, /runtimeFor\s*\(/)
  assert.doesNotMatch(reads, /runCli\s*\(/)
  assert.match(mutations, /runtimeFor\s*\(/)
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

test('error guessing: configured root startup remains lightweight and stdin end closes runtimes query engines and light watchers', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const startup = source.slice(source.lastIndexOf('if (DEFAULT_ROOT)'))
  const shutdown = source.slice(source.indexOf("process.stdin.on('end'"), source.lastIndexOf('if (DEFAULT_ROOT)'))

  assert.deepEqual(
    { startupUsesHeavyRuntime: /runtimeFor\s*\(DEFAULT_ROOT\)/.test(startup), startupUsesLightQuery: /queryEngineFor\s*\(DEFAULT_ROOT\)/.test(startup), closesRuntimes: /runtimes/.test(shutdown), closesQueryEngines: /queryEngines/.test(shutdown), closesLightWatchers: /lightWatchers|stopLightWatcher/.test(shutdown) },
    { startupUsesHeavyRuntime: false, startupUsesLightQuery: true, closesRuntimes: true, closesQueryEngines: true, closesLightWatchers: true },
  )
})

test('error guessing: terminal polling watcher errors fail closed by promoting the watched root', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const polling = source.slice(source.indexOf('async function startPollingWatcher'), source.indexOf('function watchForChanges'))

  assert.match(polling, /watcher\.on\(['"]error['"],[\s\S]*promoteRuntime\s*\(root\)/)
})

test('domain analysis: mapped reads wait for an in-flight runtime promotion before answering', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const queryEngine = source.slice(source.indexOf('function queryEngineFor'), source.indexOf('const MAX_MCP_RESULTS'))

  assert.match(queryEngine, /runtimes\.get\(root\)|promotion/)
})

test('architectural boundary: first-read freshness hashes disk source content directly against generation source ids', () => {
  const mcp = fs.readFileSync(path.join(import.meta.dirname, '..', 'mcp.mjs'), 'utf8')
  const policy = fs.readFileSync(path.join(import.meta.dirname, '..', 'source-policy.mjs'), 'utf8')
  const freshness = mcp.slice(mcp.indexOf('diskMatchesGeneration'), mcp.indexOf('async function queryEngineFor'))
  const hashing = policy.slice(policy.indexOf('fileContentHash'), policy.indexOf('controlFileHashes'))

  assert.deepEqual(
    { hashesSha256: /createHash\(['"]sha256['"]\)[\s\S]*readFileSync|readFileSync[\s\S]*createHash\(['"]sha256['"]\)/.test(hashing), comparesGenerationSources: /generation\.sources|manifest\.sources/.test(freshness), rereadsStoredSourceBlob: /readSource\s*\(/.test(freshness) },
    { hashesSha256: true, comparesGenerationSources: true, rereadsStoredSourceBlob: false },
  )
})
