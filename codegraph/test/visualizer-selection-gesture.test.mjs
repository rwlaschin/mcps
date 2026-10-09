import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createVisualizerServer } from '../visualizer.mjs'

async function script(t) {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher }); t.after(() => server.watcher.close())
  const html = await new Promise(resolve => server.emit('request', Object.assign(new EventEmitter(), { url: '/', method: 'GET', headers: {} }), { setHeader() {}, end: resolve }))
  return html.match(/<script>([\s\S]*?)<\/script>/)[1]
}
async function gestures(t, view) {
  const source = await script(t); const svgHandlers = new Map(); const windowHandlers = new Map()
  const context = vm.createContext({ currentView: view, transform: { x: 0, y: 0, k: 1 }, isMouseDown: false, hasDragged: false, startMouse: {}, startPan: {}, nodeMap: new Map(), scheduleTransform() {}, centerView() {}, svg: { addEventListener(name, fn, options) { if (!svgHandlers.has(name)) svgHandlers.set(name, []); svgHandlers.get(name).push({ fn, capture: options === true || options?.capture === true }) }, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ left: 0, top: 0 }) }, window: { addEventListener: (name, fn) => windowHandlers.set(name, fn) } })
  vm.runInContext(source.slice(source.indexOf('window.focusNodeById ='), source.indexOf('document.getElementById("btn-top").onclick')), context)
  const click = () => { const event = { stopped: false, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, stopImmediatePropagation() { this.stopped = true } }; for (const handler of svgHandlers.get('click') ?? []) if (handler.capture) handler.fn(event); return !event.stopped }
  return { context, svgHandlers, windowHandlers, click, down: () => svgHandlers.get('mousedown')[0].fn({ clientX: 0, clientY: 0 }) }
}
for (const view of ['layered','heatmap','sunburst','chord','calltree','complexity']) test(`gesture domain ${view}: mouseup after drag suppresses the synthetic click before any descendant selection`, async t => {
  const c = await gestures(t, view); let selected = 'clicked'; let inspector = 'clicked details'
  c.down(); c.windowHandlers.get('mousemove')({ clientX: 4, clientY: 0 }); c.windowHandlers.get('mouseup')()
  if (c.click()) { selected = 'other'; inspector = 'other details' }
  assert.deepEqual({ selected, inspector, dragging: c.context.isMouseDown }, { selected: 'clicked', inspector: 'clicked details', dragging: false })
})
for (const { name, dx, dy, expected } of [
  { name: 'horizontal threshold equality permits click', dx: 3, dy: 0, expected: true },
  { name: 'vertical threshold equality permits click', dx: 0, dy: 3, expected: true },
  { name: 'horizontal above threshold suppresses click', dx: 4, dy: 0, expected: false },
  { name: 'vertical above threshold suppresses click', dx: 0, dy: 4, expected: false },
]) test(`boundary existing drag threshold: ${name}`, async t => { const c = await gestures(t, 'layered'); c.down(); c.windowHandlers.get('mousemove')({ clientX: dx, clientY: dy }); c.windowHandlers.get('mouseup')(); assert.equal(c.click(), expected) })
test('error guessing a fresh mousedown after drag restores deliberate selection', async t => { const c = await gestures(t, 'complexity'); c.down(); c.windowHandlers.get('mousemove')({ clientX: 4, clientY: 0 }); c.windowHandlers.get('mouseup')(); c.down(); c.windowHandlers.get('mouseup')(); assert.equal(c.click(), true) })

for (const from of ['complexity','calltree']) for (const view of ['layered','heatmap','sunburst','chord']) test(`lifecycle pairs: ${from} to ${view} releases summary property handlers and invalidates pending inspector`, async t => {
  const source = await script(t); const stale = () => {}; const canvas = { onmouseover: stale, onmouseout: stale, onpointermove: stale, onpointerleave: stale, onclick: stale }; const buttons = []; const elements = new Map()
  const context = vm.createContext({ currentView: view, currentFilter: 'all', hasPendingUpdate: false, canvas, summaryMode: from, summaryItems: [{ id: 'old' }], pinnedComplexityIndex: 1, hoveredComplexityIndex: 0, selectionVersion: 7, graphData: {}, heatmapData: {}, sunburstData: {}, chordData: {}, calltreeData: {}, complexityData: {}, document: { querySelectorAll: () => buttons, getElementById: id => { if (!elements.has(id)) elements.set(id, { style: {}, checked: false }); return elements.get(id) } }, renderGraph() {}, renderHeatmap() {}, renderSunburst() {}, renderChord() {} })
  vm.runInContext(source.slice(source.indexOf('function switchView('), source.indexOf('const inFlightFetches = new Map()')), context); context.switchView()
  assert.deepEqual({ handlers: ['onmouseover','onmouseout','onpointermove','onpointerleave','onclick'].map(name => canvas[name]), mode: context.summaryMode, items: context.summaryItems.length, pin: context.pinnedComplexityIndex, hover: context.hoveredComplexityIndex, version: context.selectionVersion }, { handlers: [null,null,null,null,null], mode: '', items: 0, pin: -1, hover: -1, version: 8 })
})
for (const { selected, expected } of [{ selected: 'parent', expected: 'parent' }, { selected: null, expected: 'child' }]) test(`Sunburst hover domain: ${selected ? 'selected inspector remains pinned inside its zone' : 'unselected hover preview remains available'}`, async t => {
  const source = await script(t); let inspector = 'parent'; const context = vm.createContext({ activeSelectedSunburstId: selected, sunburstNodeMap: new Map([['parent', { id: 'parent' }]]), nodeElements: new Map([['child',{ classList: { add() {} } }]]), hoveredArcElements: [], isNodeInSelectedZone: () => true, clearSunburstHover() {}, renderSunburstDetails: node => { inspector = node.id } })
  vm.runInContext(source.slice(source.indexOf('function highlightSunburstHover('), source.indexOf('function renderSunburstDetails(')), context); context.highlightSunburstHover({ id: 'child' })
  assert.equal(inspector, expected)
})

class Element {
  constructor(tag) { this.tagName = tag; this.dataset = {}; this.children = []; this.attributes = {}; this.style = {}; this.bounds = { left: 0, top: 0, width: 100, height: 50 }; this.listeners = new Map() }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  get firstChild() { return this.children[0] }
  getAttribute(name) { return this.attributes[name] ?? null }
  appendChild(child) { this.children.push(child); return child }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  set innerHTML(value) { this.children = [] }
  addEventListener(name, callback) { this.listeners.set(name, callback) }
  getBoundingClientRect() { return this.bounds }
  querySelector(selector) { return this.children.find(child => selector.includes('grid') ? child.attributes.role === 'grid' : child.tagName === 'rect') ?? null }
}
async function harness(t) {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher })
  t.after(() => server.watcher.close())
  const html = await new Promise(resolve => server.emit('request', Object.assign(new EventEmitter(), { url: '/', method: 'GET', headers: { host: '127.0.0.1' } }), Object.assign(new EventEmitter(), { setHeader() {}, end: resolve })))
  const canvas = new Element('g'); const details = new Element('div'); const search = { value: '' }
  const context = vm.createContext({ layeredNodeGroup: null, layeredRows: [], nodeElements: new Map(), activeHighlighted: [], canvas, currentView: 'complexity', currentFilter: 'most-called', complexityData: { generation: 'g1', columns: 2, rows: 1, functions: [
    { id: 'hot', ownerId: 1, symbolId: 'hot', name: 'hot', file: 'src/hot.ts', isMostCalled: true, color: '#f00', x: 0, y: 0, width: 48, height: 48 },
    { id: 'cold', ownerId: 2, symbolId: 'cold', name: 'cold', file: 'src/cold.ts', isMostCalled: false, color: '#f00', x: 50, y: 0, width: 48, height: 48 },
  ] }, calltreeData: null, summaryItems: [], summaryMode: 'complexity', summaryTargetMap: new Map(), selectionHistory: [], selectionVersion: 0, pinnedComplexityIndex: -1, hoveredComplexityIndex: -1, centerView() {}, fetchViewData: () => new Promise(() => {}), document: { createElementNS: (namespace, tag) => new Element(tag), createElement: tag => new Element(tag), getElementById: id => id === 'search-input' ? search : details } })
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const selection = script.slice(script.indexOf('function selectSummaryItem('), script.indexOf('// Fast indexed maps for O(1) lookups'))
  const renderer = script.slice(script.indexOf('function renderComplexity()'), script.indexOf('function loadSunburst'))
  const filtering = script.slice(script.indexOf('function applyFilter()'), script.indexOf('document.getElementById("search-input").addEventListener'))
  vm.runInContext(selection + renderer + filtering, context); context.renderComplexity()
  return { context, canvas, search, details }
}

test('Complexity interaction domain: actual pinned cell survives wheel zoom and pointer movement to another cell', async t => {
  const c = await harness(t); const source = await script(t); const svgHandlers = new Map(); const windowHandlers = new Map()
  Object.assign(c.context, { transform: { x: 0, y: 0, k: 1 }, isMouseDown: false, hasDragged: false, startMouse: {}, startPan: {}, nodeMap: new Map(), scheduleTransform() {}, svg: { addEventListener: (name, fn) => svgHandlers.set(name, fn), classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ left: 0, top: 0 }) }, window: { addEventListener: (name, fn) => windowHandlers.set(name, fn) } })
  vm.runInContext(source.slice(source.indexOf('window.focusNodeById ='), source.indexOf('document.getElementById("btn-top").onclick')), c.context)
  c.context.fetchViewData = () => Promise.resolve({ records: [{ record: 'details', forLoops: 0, functionCalls: 0, targetSymbolIds: [] }] }); c.canvas.onclick({ clientX: 10, clientY: 10 }); await Promise.resolve(); svgHandlers.get('wheel')({ clientX: 10, clientY: 10, deltaY: -10, preventDefault() {} }); c.canvas.onpointermove({ clientX: 60, clientY: 10 })
  assert.deepEqual({ pinned: c.context.pinnedComplexityIndex, selectionVersion: c.context.selectionVersion, inspected: c.details.children[1]?.children[1]?.textContent }, { pinned: 0, selectionVersion: 1, inspected: 'hot:?' })
})
test('error guessing old summary details cannot overwrite the inspector after switching to Layered', async t => {
  const c = await harness(t); const source = await script(t); let deliver
  c.context.fetchViewData = () => new Promise(resolve => { deliver = resolve })
  c.canvas.onclick({ clientX: 10, clientY: 10 })
  Object.assign(c.context, { currentView: 'layered', currentFilter: 'all', hasPendingUpdate: false, graphData: {}, heatmapData: {}, sunburstData: {}, chordData: {}, renderGraph() { c.details.textContent = 'Layered inspector' } })
  c.context.document.querySelectorAll = () => []
  vm.runInContext(source.slice(source.indexOf('function switchView('), source.indexOf('const inFlightFetches = new Map()')), c.context); c.context.switchView()
  deliver({ records: [{ record: 'details', forLoops: 5, functionCalls: 9, targetSymbolIds: [] }] }); await Promise.resolve()
  assert.deepEqual({ inspector: c.details.textContent, fields: c.details.children.length, mode: c.context.summaryMode, version: c.context.selectionVersion }, { inspector: 'Layered inspector', fields: 0, mode: '', version: 2 })
})
