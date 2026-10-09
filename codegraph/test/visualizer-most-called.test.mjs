import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import * as graph from '../visualizer-graph.mjs'
import { createVisualizerServer } from '../visualizer.mjs'

for (const { name, raw, options, ids } of [
  { name: 'zero positive degrees', raw: { symbols: [{ id: 'a', name: 'run', kind: 'function', file: 'src/a.ts' }], edges: [] }, options: {}, ids: [] },
  { name: 'small positive set includes maximum ties', raw: { symbols: [{ id: 'a', name: 'run', kind: 'function', file: 'src/a.ts' }, { id: 'b', name: 'save', kind: 'function', file: 'src/b.ts' }, { id: 'c', name: 'read', kind: 'function', file: 'src/c.ts' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] }, options: {}, ids: ['b', 'c'] },
  { name: 'noncall eligible edge preserves Layered ranking', raw: { symbols: [{ id: 'a', name: 'run', kind: 'function', file: 'src/a.ts' }, { id: 'b', name: 'save', kind: 'function', file: 'src/b.ts' }], edges: [{ from: 'a', to: 'b', call: false }] }, options: {}, ids: ['b'] },
  { name: 'excluded test caller contributes no incoming degree', raw: { symbols: [{ id: 'a', name: 'testRun', kind: 'function', file: 'src/a.test.ts' }, { id: 'b', name: 'save', kind: 'function', file: 'src/b.ts' }], edges: [{ from: 'a', to: 'b' }] }, options: {}, ids: [] },
  { name: 'Include Tests restores eligible test caller', raw: { symbols: [{ id: 'a', name: 'testRun', kind: 'function', file: 'src/a.test.ts' }, { id: 'b', name: 'save', kind: 'function', file: 'src/b.ts' }], edges: [{ from: 'a', to: 'b' }] }, options: { includeTests: true }, ids: ['b'] },
]) test(`equivalence ranking: ${name}`, () => {
  assert.deepEqual(Array.from(graph.mostCalledSymbolIds(raw, options)).sort(), ids)
})

for (const view of ['heatmap', 'sunburst', 'chord']) test(`domain aggregation: ${view} ranks a contained function rather than caller traffic or duplicate call sites`, () => {
  const raw = { symbols: [
    { id: 'a', name: 'run', kind: 'function', file: 'callers/a.ts' },
    { id: 'b', name: 'invoke', kind: 'function', file: 'callers/b.ts' },
    { id: 'hot', name: 'hot', kind: 'function', file: 'hot/hot.ts' },
    { id: 'cold', name: 'cold', kind: 'function', file: 'cold/cold.ts' },
    { id: 'excluded', name: 'Interface', kind: 'interface', file: 'src/type.ts' },
  ], edges: [{ from: 'a', to: 'hot' }, { from: 'b', to: 'hot', call: false }, { from: 'a', to: 'cold' }, { from: 'a', to: 'cold' }, { from: 'excluded', to: 'cold' }, { from: 'missing', to: 'cold' }] }
  const result = view === 'heatmap' ? graph.buildHeatmapData(raw) : view === 'sunburst' ? graph.buildSunburstData(raw) : graph.buildChordData(raw)
  const nodes = view === 'heatmap' ? result.files : view === 'sunburst' ? result.nodes.filter(node => node.type === 'symbol') : result.modules
  const marked = nodes.filter(node => node.isMostCalled).map(node => view === 'heatmap' ? node.file : view === 'sunburst' ? node.id : node.name).sort()
  assert.deepEqual(marked, view === 'heatmap' ? ['hot/hot.ts'] : ['hot'])
})

test('domain summary boundary: Call Tree membership comes from the complete graph before depth hides the hottest function', () => {
  const raw = { symbols: [{ id: 'root', name: 'root', kind: 'function', file: 'src/root.ts' }, { id: 'low', name: 'low', kind: 'function', file: 'src/low.ts' }, { id: 'hot', name: 'hot', kind: 'function', file: 'src/hot.ts' }], edges: [{ from: 'root', to: 'low' }, { from: 'root', to: 'hot' }, { from: 'low', to: 'hot' }] }
  const result = graph.buildCallTreeData({ roots: ['root'], owners: [{ symbolId: 'root', name: 'root' }, { symbolId: 'low', name: 'low' }, { symbolId: 'hot', name: 'hot' }], edges: [{ from: 'root', to: 'low' }, { from: 'low', to: 'hot' }] }, { depth: 1, mostCalledIds: graph.mostCalledSymbolIds(raw) })
  assert.deepEqual(result.nodes.map(node => ({ id: node.id, marked: node.isMostCalled })), [{ id: 'root', marked: false }, { id: 'low', marked: false }])
})

test('domain summary boundary: Complexity caps do not promote an unranked or graph-missing function', () => {
  const result = graph.buildComplexityData([{ symbolId: 'unknown', name: 'unknown', file: 'src/a.ts', cyclomatic: 99 }, { symbolId: 'hot', name: 'hot', file: 'src/b.ts', cyclomatic: 1 }], { maxFunctions: 1, mostCalledIds: new Set(['hot']) })
  assert.deepEqual(result.functions.map(item => ({ id: item.id, marked: item.isMostCalled })), [{ id: 'unknown', marked: false }])
})

function request(server, url) {
  return new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { url, method: 'GET', headers: { host: '127.0.0.1' } })
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }) } })
    server.emit('request', req, res)
  })
}
async function page(t) {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher })
  t.after(() => server.watcher.close())
  return (await request(server, '/')).body
}

for (const { filter, query, expected } of [
  { filter: 'most-called', query: '', expected: ['1', '0.06'] },
  { filter: 'most-called', query: 'cold', expected: ['0.06', '0.06'] },
  { filter: 'all', query: '', expected: ['', ''] },
]) test(`client Call Tree partition: ${filter} with search '${query}' dims in place without reordering cards`, async (t) => {
  const html = await page(t)
  const source = html.slice(html.indexOf('function applyFilter()'), html.indexOf('document.getElementById("search-input").addEventListener'))
  const cards = [{ dataset: { summaryIndex: '0' }, style: { opacity: '0.06' } }, { dataset: { summaryIndex: '1' }, style: { opacity: '0.06' } }]
  const canvas = { children: cards, querySelectorAll: () => cards }
  const context = vm.createContext({ currentView: 'calltree', currentFilter: filter, canvas, summaryItems: [{ id: 'hot', name: 'hot', file: 'src/hot.ts', isMostCalled: true }, { id: 'cold', name: 'cold', file: 'src/cold.ts', isMostCalled: false }], calltreeData: {}, complexityData: null, graphData: null, nodeElements: new Map(), document: { getElementById: () => ({ value: query }), querySelectorAll: () => cards } })
  vm.runInContext(source, context); context.applyFilter()
  assert.deepEqual({ opacity: cards.map(card => card.style.opacity ?? ''), indices: cards.map(card => card.dataset.summaryIndex) }, { opacity: expected, indices: ['0', '1'] })
})

for (const route of ['/calltree', '/complexity']) test(`route cache domain: ${route} loads ranking once and retains metrics-only summary behavior`, async (t) => {
  const queries = []
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher, streamQuery: async function* (_root, query) {
    queries.push(query)
    if (query.type === 'graph') { yield { symbols: [{ id: 'a', name: 'run', kind: 'function', file: 'src/a.ts' }, { id: 'hot', name: 'hot', kind: 'function', file: 'src/hot.ts' }, { id: 'cold', name: 'cold', kind: 'function', file: 'src/cold.ts' }], edges: [{ from: 'a', to: 'hot' }] }; return }
    yield { generation: 'g1', roots: ['hot', 'cold'], owners: [{ symbolId: 'hot', name: 'hot', file: 'src/hot.ts', cyclomatic: 2 }, { symbolId: 'cold', name: 'cold', file: 'src/cold.ts', cyclomatic: 3 }], edges: [] }
  } })
  t.after(() => server.watcher.close())
  const first = await request(server, route)
  const second = await request(server, route)
  const data = JSON.parse(second.body)
  const items = data.nodes ?? data.functions
  assert.deepEqual({ statuses: [first.status, second.status], membership: items.map(item => ({ id: item.id, marked: item.isMostCalled })).sort((a, b) => a.id.localeCompare(b.id)), queryTypes: queries.map(query => query.type).sort(), metricsOnly: queries.filter(query => query.type === 'internal-summaries').map(query => query.metricsOnly ?? false) }, { statuses: [200, 200], membership: [{ id: 'cold', marked: false }, { id: 'hot', marked: true }], queryTypes: ['graph', 'internal-summaries', 'internal-summaries'], metricsOnly: route === '/complexity' ? [true, true] : [false, false] })
})

for (const route of ['/calltree', '/complexity']) test(`route failure partition: ${route} reports graph ranking failure instead of substituting another rank`, async (t) => {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher, streamQuery: async function* (_root, query) {
    if (query.type === 'graph') throw new Error('ranking graph failed')
    yield { owners: [{ symbolId: 'a', name: 'run', file: 'src/a.ts' }], roots: ['a'], edges: [] }
  } })
  t.after(() => server.watcher.close())
  const result = await request(server, route)
  assert.deepEqual({ status: result.status, body: JSON.parse(result.body) }, { status: 500, body: { error: 'ranking graph failed' } })
})

test('boundary threshold: ten positive degrees include all symbols tied at the second ranked degree', () => {
  const raw = { symbols: [
    { id: 'p', name: 'p', kind: 'function', file: 'src/p.ts' }, { id: 'q', name: 'q', kind: 'function', file: 'src/q.ts' }, { id: 'r', name: 'r', kind: 'function', file: 'src/r.ts' },
    { id: 'a', name: 'a', kind: 'function', file: 'src/a.ts' }, { id: 'b', name: 'b', kind: 'function', file: 'src/b.ts' }, { id: 'c', name: 'c', kind: 'function', file: 'src/c.ts' }, { id: 'd', name: 'd', kind: 'function', file: 'src/d.ts' }, { id: 'e', name: 'e', kind: 'function', file: 'src/e.ts' }, { id: 'f', name: 'f', kind: 'function', file: 'src/f.ts' }, { id: 'g', name: 'g', kind: 'function', file: 'src/g.ts' }, { id: 'h', name: 'h', kind: 'function', file: 'src/h.ts' }, { id: 'i', name: 'i', kind: 'function', file: 'src/i.ts' }, { id: 'j', name: 'j', kind: 'function', file: 'src/j.ts' },
  ], edges: [{ from: 'p', to: 'a' }, { from: 'q', to: 'a' }, { from: 'r', to: 'a' }, { from: 'p', to: 'b' }, { from: 'q', to: 'b' }, { from: 'p', to: 'c' }, { from: 'q', to: 'c' }, { from: 'p', to: 'd' }, { from: 'p', to: 'e' }, { from: 'p', to: 'f' }, { from: 'p', to: 'g' }, { from: 'p', to: 'h' }, { from: 'p', to: 'i' }, { from: 'p', to: 'j' }] }
  assert.deepEqual(Array.from(graph.mostCalledSymbolIds(raw)).sort(), ['a', 'b', 'c'])
})

test('exception aggregation: Sunburst root and every ancestor are unranked when no eligible symbol has an incoming edge', () => {
  const result = graph.buildSunburstData({ symbols: [{ id: 'isolated', name: 'isolated', kind: 'function', file: 'src/nested/a.ts' }], edges: [] })
  assert.deepEqual(result.nodes.filter(node => node.isMostCalled).map(node => node.id), [])
})

for (const { view, property, expected } of [
  { view: 'layered', property: 'display', expected: ['block', 'none'] },
  { view: 'heatmap', property: 'opacity', expected: ['1', '0.06'] },
  { view: 'sunburst', property: 'opacity', expected: ['1', '0.06'] },
  { view: 'chord', property: 'opacity', expected: ['1', '0.08'] },
]) test(`client view equivalence: ${view} Most Called emphasizes only marked data`, async (t) => {
  const html = await page(t)
  const source = html.slice(html.indexOf('function applyFilter()'), html.indexOf('document.getElementById("search-input").addEventListener'))
  const hot = { style: {}, classList: { add() {}, remove() {} } }; const cold = { style: {}, classList: { add() {}, remove() {} } }; const canvas = {}; const nodes = [{ id: "hot", isMostCalled: true }, { id: "cold", isMostCalled: false }]
  const context = vm.createContext({ canvas, layeredNodeGroup: { parentNode: canvas }, layeredRows: [{ y: 79, nodes, band: { x: 12, y: 70, width: 692, height: 62, group: { children: Array.from({ length: 5 }, () => ({ style: {}, setAttribute() {} })) } } }], layeredDecorations: { children: [] }, layeredHeaders: [], layeredVisibleNodeIds: new Set(), layeredSelectedIds: new Set(), transform: { x: 0, y: 0, k: 1 }, svg: { clientWidth: 600, clientHeight: 200 }, NODE_WIDTH: 200, NODE_HEIGHT: 44, NODE_SPACING_X: 216, PADDING_X: 120, currentView: view, currentFilter: 'most-called', activeSelectedId: null, graphData: { nodes: [{ id: 'hot', isMostCalled: true }, { id: 'cold', isMostCalled: false }], edges: [] }, heatmapData: { files: [{ file: 'hot', isMostCalled: true }, { file: 'cold', isMostCalled: false }] }, sunburstData: { nodes: [{ id: 'hot', isMostCalled: true }, { id: 'cold', isMostCalled: false }] }, chordData: { modules: [{ name: 'hot', isMostCalled: true }, { name: 'cold', isMostCalled: false }], chords: [] }, nodeElements: new Map([['hot', hot], ['cold', cold]]), document: { getElementById: id => id === 'search-input' ? { value: '' } : null, querySelectorAll: () => [], querySelector: () => null } })
  vm.runInContext(html.slice(html.indexOf('function reconcileLayeredViewport()'), html.indexOf('window.addEventListener("resize"')) + source, context); context.applyFilter()
  assert.deepEqual([hot.style[property], cold.style[property]], expected)
})

class DomElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.attributes = {} }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  appendChild(child) { this.children.push(child) }
  replaceChildren(...children) { this.children = children }
  set innerHTML(value) { this.children = [] }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50 } }
  querySelector(selector) { return this.children.find(child => child.attributes.role === 'grid') ?? null }
}
for (const { filter, query, paths } of [
  { filter: 'most-called', query: '', paths: [{ d: 'M0,0h48v48h-48Z', opacity: '1' }, { d: 'M50,0h48v48h-48Z', opacity: '0.06' }] },
  { filter: 'most-called', query: 'cold', paths: [{ d: 'M0,0h48v48h-48ZM50,0h48v48h-48Z', opacity: '0.06' }] },
  { filter: 'all', query: '', paths: [{ d: 'M0,0h48v48h-48ZM50,0h48v48h-48Z', opacity: '1' }] },
]) test(`client Complexity render domain: ${filter} search '${query}' preserves cell positions and cold-cell selection`, async (t) => {
  const html = await page(t)
  const render = html.slice(html.indexOf('function renderComplexity()'), html.indexOf('function loadSunburst'))
  const filterSource = html.slice(html.indexOf('function applyFilter()'), html.indexOf('document.getElementById("search-input").addEventListener'))
  const canvas = new DomElement('g')
  let selected
  const context = vm.createContext({ layeredNodeGroup: null, layeredRows: [], nodeElements: new Map(), activeHighlighted: [], canvas, currentView: 'complexity', currentFilter: 'most-called', complexityData: { columns: 2, rows: 1, functions: [{ id: 'hot', symbolId: 'hot', name: 'hot', file: 'src/hot.ts', isMostCalled: true, color: '#f00', x: 0, y: 0, width: 48, height: 48 }, { id: 'cold', symbolId: 'cold', name: 'cold', file: 'src/cold.ts', isMostCalled: false, color: '#f00', x: 50, y: 0, width: 48, height: 48 }] }, summaryItems: [], summaryMode: '', summaryTargetMap: null, selectionHistory: ['previous'], pinnedComplexityIndex: -1, hoveredComplexityIndex: -1, centerView() {}, selectSummaryItem: (item, mode) => { selected = { id: item.id, mode } }, document: { createElementNS: (namespace, tag) => new DomElement(tag), getElementById: () => ({ value: query }) } })
  vm.runInContext(filterSource + render, context); context.renderComplexity(); context.currentFilter = filter; context.applyFilter()
  canvas.onclick({ clientX: 75, clientY: 25 })
  assert.deepEqual({ paths: canvas.children[0].children.map(path => ({ d: path.attributes.d, opacity: path.style.opacity })), order: Array.from(context.summaryItems, item => item.id), pinnedIndex: context.pinnedComplexityIndex, selected }, { paths, order: ['hot', 'cold'], pinnedIndex: 1, selected: { id: 'cold', mode: 'complexity' } })
})

test('client loading exception: Most Called before a cold Complexity grid loads does not throw or reorder pending data', async (t) => {
  const html = await page(t)
  const source = html.slice(html.indexOf('function applyFilter()'), html.indexOf('document.getElementById("search-input").addEventListener'))
  const context = vm.createContext({ currentView: 'complexity', currentFilter: 'most-called', summaryItems: [], canvas: { querySelector: () => null }, document: { getElementById: () => ({ value: '' }) } })
  vm.runInContext(source, context)
  assert.doesNotThrow(() => context.applyFilter())
})
