import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { buildInternalGraph, encodeInternalPartition } from '../internal-graph.mjs'
import { GraphStore } from '../store.mjs'
import { DaemonQueryEngine } from '../daemon-query-engine.mjs'
import { createVisualizerServer } from '../visualizer.mjs'

// Generated size is fixture construction, not a performance claim. The real syntax/CFG partition is persisted and validated.
function largePartition(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inspector-large-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = 'export function large(){let total=0;for(let i=0;i<1;i++){total++;}for(let j=0;j<1;j++){total++;}' + 'total++;'.repeat(2001) + '} export function other(){for(let k=0;k<1;k++){k++;}}'
  const internal = buildInternalGraph({ file: 'src/large.ts', source, compilerOptions: {} })
  internal.relations = [
    { ownerId: 2, fromNode: internal.owners[2].entryNodeId, kind: 'call', targetSymbolId: 'target-a' },
    { ownerId: 2, fromNode: internal.owners[2].entryNodeId, kind: 'call', targetSymbolId: 'target-a' },
    { ownerId: 2, fromNode: internal.owners[2].entryNodeId, kind: 'call', targetSymbolId: 'target-b' },
    { ownerId: 2, fromNode: internal.owners[2].entryNodeId, kind: 'call', targetSymbolId: 'target-b' },
    { ownerId: 2, fromNode: internal.owners[2].entryNodeId, kind: 'read', targetSymbolId: 'not-a-call' },
    { ownerId: 1, fromNode: internal.owners[1].entryNodeId, kind: 'call', targetSymbolId: 'other-owner-target' },
  ]
  const store = new GraphStore(root)
  const partition = store.writeInternalPartition(encodeInternalPartition(internal))
  const generation = store.publish({ version: 3, partitions: {}, internalPartitions: { 'src/large.ts': partition }, sources: {} }).generation
  const engine = new DaemonQueryEngine(root, { cacheFactory: () => ({ dispose() {} }), engineFactory: () => { throw new Error('parser fallback forbidden') } })
  t.after(() => engine.dispose())
  return { engine, internal, generation }
}

test('large-owner boundary: focused details work beyond 2000 real syntax and CFG records with exact owner-local counts', async (t) => {
  const { engine, internal, generation } = largePartition(t)
  const rows = await engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, generation, limit: 2000 })
  assert.deepEqual({ beyondCap: internal.owners[2].nodeCount > 2000, rows }, { beyondCap: true, rows: [{ record: 'details', ownerId: 2, forLoops: 2, functionCalls: 4, targetSymbolIds: ['target-a', 'target-b'] }] })
})

test('unchanged map boundary: the same large indexed owner still rejects a full map above the 2000-record limit', async (t) => {
  const { engine, generation } = largePartition(t)
  await assert.rejects(engine.queryBatch({ type: 'internals', operation: 'map', file: 'src/large.ts', owner: { id: 2 }, generation, limit: 2000 }), /node records exceeds requested limit 2000; narrow the query/)
})

test('owner isolation: default-generation details of the other owner exclude every large-function loop and call', async (t) => {
  const { engine } = largePartition(t)
  assert.deepEqual(await engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 1 }, limit: 2000 }), [{ record: 'details', ownerId: 1, forLoops: 1, functionCalls: 1, targetSymbolIds: ['other-owner-target'] }])
})

for (const { name, file, owner, message } of [
  { name: 'missing file', file: 'src/missing.ts', owner: { id: 2 }, message: /no internal partition/ },
  { name: 'missing owner', file: 'src/large.ts', owner: { id: 99 }, message: /owner not found/ },
  { name: 'absent owner selector', file: 'src/large.ts', owner: undefined, message: /requires.*owner|owner.*required/ },
]) test(`details invalid partition: ${name} preserves an explicit error`, async (t) => {
  const { engine } = largePartition(t)
  await assert.rejects(engine.queryBatch({ type: 'internals', operation: 'details', file, owner, limit: 2000 }), message)
})

test('details cancellation boundary: an already-aborted request preserves the existing empty result', async (t) => {
  const { engine } = largePartition(t)
  const controller = new AbortController(); const reason = new Error('cancel selected details'); controller.abort(reason)
  assert.deepEqual(await engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, limit: 2000 }, { signal: controller.signal }), [])
})

test('acquired-view invalid partition: a missing details method rejects instead of claiming empty success and releases its lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inspector-cache-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let releases = 0
  const engine = new DaemonQueryEngine(root, { cacheFactory: () => ({ acquireInternal: () => ({ value: {}, release() { releases += 1 } }), dispose() {} }) })
  t.after(() => engine.dispose())
  let message; try { await engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, generation: 'g1', limit: 2000 }) } catch (error) { message = error.message }
  assert.deepEqual({ explicitUnsupported: /details.*(?:unsupported|not supported|unavailable)|(?:unsupported|not supported|unavailable).*details/.test(message ?? ''), releases }, { explicitUnsupported: true, releases: 1 })
})

test('focused endpoint contract: internals requests one owner details record with the unchanged generation envelope and limit', async (t) => {
  const watcher = Object.assign(new EventEmitter(), { close() {} }); const queries = []
  const server = createVisualizerServer('/test/root', { watch: () => watcher, streamQuery: async function* (_root, query) { queries.push(query); yield { record: 'details', ownerId: 2, forLoops: 2, functionCalls: 4, targetSymbolIds: ['target-a', 'target-b'] } } })
  t.after(() => server.watcher.close())
  const response = await new Promise(resolve => {
    const request = Object.assign(new EventEmitter(), { url: '/internals?file=src/large.ts&ownerId=2&generation=g1', method: 'GET', headers: { host: '127.0.0.1' } })
    const result = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } })
    server.emit('request', request, result)
  })
  assert.deepEqual({ response, queries }, { response: { status: 200, body: { generation: 'g1', records: [{ record: 'details', ownerId: 2, forLoops: 2, functionCalls: 4, targetSymbolIds: ['target-a', 'target-b'] }] } }, queries: [{ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, generation: 'g1', limit: 2000 }] })
})

test('acquired-view supported partition: details dispatch returns the compact row and releases its lease once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inspector-cache-details-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let releases = 0
  const engine = new DaemonQueryEngine(root, { cacheFactory: () => ({ acquireInternal: () => ({ value: { details: () => [{ record: 'details', ownerId: 2, forLoops: 0, functionCalls: 0, targetSymbolIds: [] }] }, release() { releases += 1 } }), dispose() {} }) })
  t.after(() => engine.dispose())
  const rows = await engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, generation: 'g1', limit: 2000 })
  assert.deepEqual({ rows, releases }, { rows: [{ record: 'details', ownerId: 2, forLoops: 0, functionCalls: 0, targetSymbolIds: [] }], releases: 1 })
})

test('historical generation domain: details stay on the selected immutable partition after CURRENT advances', async (t) => {
  const { engine, generation } = largePartition(t)
  const store = new GraphStore(engine.root)
  const next = buildInternalGraph({ file: 'src/large.ts', source: 'export function large(){} export function other(){}', compilerOptions: {} })
  const id = store.writeInternalPartition(encodeInternalPartition(next)); store.publish({ version: 3, partitions: {}, internalPartitions: { 'src/large.ts': id }, sources: {} })
  assert.deepEqual(await engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, generation, limit: 2000 }), [{ record: 'details', ownerId: 2, forLoops: 2, functionCalls: 4, targetSymbolIds: ['target-a', 'target-b'] }])
})

class DetailElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = '' }
  append(...children) { this.children.push(...children) }
  appendChild(child) { this.children.push(child); return child }
  replaceChildren(...children) { this.children = children }
  get firstChild() { return this.children[0] }
}
async function inspector(t, record) {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher }); t.after(() => server.watcher.close())
  const html = await new Promise(resolve => server.emit('request', Object.assign(new EventEmitter(), { url: '/', method: 'GET', headers: { host: '127.0.0.1' } }), Object.assign(new EventEmitter(), { setHeader() {}, end: resolve })))
  const details = new DetailElement('div')
  const item = { id: 'large', ownerId: 2, name: 'large', file: 'src/large.ts', line: 7, cyclomatic: 6, branchCount: 5, nestingDepth: 2 }
  const context = vm.createContext({ currentView: 'complexity', pinnedComplexityIndex: 0, summaryItems: [item], canvas: { querySelector: () => null }, details, selectionHistory: [], selectionVersion: 0, complexityData: { generation: 'g1' }, calltreeData: null, summaryTargetMap: new Map([['target-a', { id: 'target-a', ownerId: 3, name: 'targetA', file: 'src/a.ts', line: 9 }]]), fetchViewData: () => Promise.resolve({ records: [record] }), document: { getElementById: () => details, createElement: tag => new DetailElement(tag) } })
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  vm.runInContext(script.slice(script.indexOf('function selectSummaryItem('), script.indexOf('canvas.addEventListener("click"')), context)
  context.selectSummaryItem(item, 'complexity'); await new Promise(resolve => setImmediate(resolve))
  return { context, details }
}

test('client compact response: inspector preserves selected metrics and displays total call occurrences separately from unique navigation targets', async (t) => {
  const { details } = await inspector(t, { record: 'details', ownerId: 2, forLoops: 2, functionCalls: 4, targetSymbolIds: ['target-a', 'missing-target'] })
  assert.deepEqual({ metrics: details.children[2]?.children.map(field => field.children[1].textContent), counts: details.children[3]?.children[1]?.children.map(field => field.children[1].textContent), targets: details.children[4]?.children.map(element => element.textContent || element.children[0]?.textContent) }, { metrics: [6, 2, 5], counts: [2, 4], targets: ['Called functions (2)', 'targetA:9', 'missing-target (unavailable)'] })
})

test('client no-call partition: compact zero counts render the existing empty navigation message', async (t) => {
  const { details } = await inspector(t, { record: 'details', ownerId: 2, forLoops: 0, functionCalls: 0, targetSymbolIds: [] })
  assert.deepEqual({ counts: details.children[3]?.children[1]?.children.map(field => field.children[1].textContent), targets: details.children[4]?.children.map(element => element.textContent) }, { counts: [0, 0], targets: ['Called functions (0)', 'No internal function calls'] })
})


for (const stage of ['nodes', 'relations']) test(`details cancellation interaction: abort during ${stage} scanning preserves the caller reason`, async (t) => {
  const { engine, internal } = largePartition(t)
  let observations = 0
  const reason = new Error('abort while scanning selected owner')
  // Deterministic cancellation delivery: two dispatch checks precede owner iterator checks.
  const signal = { reason, get aborted() { observations += 1; return observations > (stage === 'nodes' ? 2 : internal.owners[2].nodeCount + 2) } }
  await assert.rejects(engine.queryBatch({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, limit: 2000 }, { signal }), reason)
})

test('client race error guessing: a late old compact response cannot replace the newer selected inspector', async (t) => {
  const { context, details } = await inspector(t, { record: 'details', ownerId: 2, forLoops: 0, functionCalls: 0, targetSymbolIds: [] })
  let oldReady; let newReady
  const oldResponse = new Promise(resolve => { oldReady = resolve }); const newResponse = new Promise(resolve => { newReady = resolve })
  const pending = [oldResponse, newResponse]; context.fetchViewData = () => pending.shift()
  context.selectSummaryItem({ ownerId: 2, name: 'old', line: 7, file: 'src/old.ts' }, 'complexity')
  context.selectSummaryItem({ ownerId: 3, name: 'new', line: 9, file: 'src/new.ts' }, 'complexity')
  newReady({ records: [{ record: 'details', ownerId: 3, forLoops: 0, functionCalls: 0, targetSymbolIds: [] }] }); await new Promise(resolve => setImmediate(resolve))
  oldReady({ records: [{ record: 'details', ownerId: 2, forLoops: 99, functionCalls: 99, targetSymbolIds: ['old-target'] }] }); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ name: details.children[1]?.children[1]?.textContent, counts: details.children[3]?.children[1]?.children.map(field => field.children[1].textContent) }, { name: 'new:9', counts: [0, 0] })
})

test('client history navigation: actual called-target and Back buttons restore the original compact inspector', async (t) => {
  const { context, details } = await inspector(t, { record: 'details', ownerId: 2, forLoops: 2, functionCalls: 4, targetSymbolIds: ['target-a'] })
  details.children[4].children[1].onclick(); await new Promise(resolve => setImmediate(resolve))
  details.children[4].children[0].onclick(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ name: details.children[1].children[1].textContent, counts: details.children[3].children[1].children.map(field => field.children[1].textContent), history: Array.from(context.selectionHistory, entry => entry.item.name) }, { name: 'large:7', counts: [2, 4], history: ['large'] })
})

test('details pre-abort public contract: async pinQuery returns the existing empty metadata and rows envelope', async (t) => {
  const { engine } = largePartition(t)
  const controller = new AbortController(); controller.abort(new Error('already cancelled'))
  assert.deepEqual(await engine.pinQuery({ type: 'internals', operation: 'details', file: 'src/large.ts', owner: { id: 2 }, limit: 2000 }, { signal: controller.signal }), { metadata: {}, graph: null, rows: [] })
})
