import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const invoke = (arguments_) => {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_internals', arguments: arguments_ } }) + '\n'
  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  return JSON.parse(result.stdout.trim())
}

test('equivalence partition: tools list declares one discriminated codegraph_internals tool', () => {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', input: request, timeout: 10_000 })
  const response = JSON.parse(result.stdout.trim())
  const tool = response.result.tools.find(({ name }) => name === 'codegraph_internals')
  assert.deepEqual({ count: response.result.tools.filter(({ name }) => name === 'codegraph_internals').length, operations: tool.inputSchema.properties.operation.enum, required: tool.inputSchema.required }, { count: 1, operations: ['map', 'search', 'paths', 'metrics'], required: ['operation', 'file'] })
})

const invalidLimits = [0, 2001, '1', 1.5, null]
for (const limit of invalidLimits) test(`boundary analysis: codegraph_internals rejects limit ${JSON.stringify(limit)}`, () => {
  const response = invoke({ root: process.cwd(), operation: 'search', file: 'src/a.ts', match: { nodeKind: 'call' }, limit })
  assert.deepEqual({ isError: response.result.isError, mentionsLimit: /limit/i.test(response.result.content[0].text) }, { isError: true, mentionsLimit: true })
})

const invalidPathLimits = [
  { field: 'maxDepth', value: 0 }, { field: 'maxDepth', value: 101 }, { field: 'maxDepth', value: '1' }, { field: 'maxDepth', value: 1.5 }, { field: 'maxDepth', value: null },
  { field: 'maxPaths', value: 0 }, { field: 'maxPaths', value: 21 }, { field: 'maxPaths', value: '1' }, { field: 'maxPaths', value: 1.5 }, { field: 'maxPaths', value: null },
]
for (const { field, value } of invalidPathLimits) test(`boundary analysis: paths rejects ${field} ${JSON.stringify(value)}`, () => {
  const response = invoke({ root: process.cwd(), operation: 'paths', file: 'src/a.ts', owner: { id: 0 }, from: { id: 0 }, to: { id: 1 }, [field]: value })
  assert.deepEqual({ isError: response.result.isError, namesField: new RegExp(field, 'i').test(response.result.content[0].text) }, { isError: true, namesField: true })
})

test('equivalence partition: map rejects a missing owner', () => {
  const response = invoke({ root: process.cwd(), operation: 'map', file: 'src/a.ts' })
  assert.deepEqual({ isError: response.result.isError, namesOwner: /owner/i.test(response.result.content[0].text) }, { isError: true, namesOwner: true })
})

test('equivalence partition: search rejects an empty match', () => {
  const response = invoke({ root: process.cwd(), operation: 'search', file: 'src/a.ts', match: {} })
  assert.deepEqual({ isError: response.result.isError, namesMatch: /match/i.test(response.result.content[0].text) }, { isError: true, namesMatch: true })
})

test('error guessing: an out-of-root file is rejected before any partition read', () => {
  const response = invoke({ root: process.cwd(), operation: 'metrics', file: '../outside.ts', owner: { id: 0 } })
  assert.deepEqual({ isError: response.result.isError, namesRoot: /root|outside|path/i.test(response.result.content[0].text) }, { isError: true, namesRoot: true })
})

test('equivalence partition: unknown operation fields are rejected', () => {
  const response = invoke({ root: process.cwd(), operation: 'metrics', file: 'src/a.ts', owner: { id: 0 }, maxDepth: 3 })
  assert.deepEqual({ isError: response.result.isError, namesField: /maxDepth|field/i.test(response.result.content[0].text) }, { isError: true, namesField: true })
})
