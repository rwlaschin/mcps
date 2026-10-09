import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createVisualizerServer } from '../visualizer.mjs'

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.bounds = { left: 0, top: 0, width: 100, height: 50 }; this.listeners = new Map() }
  setAttribute(name, value) { this.attributes[name] = String(value) }
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
function marker(canvas) {
  const visible = canvas.children.filter(child => child.tagName === 'rect' && child.style.display !== 'none' && child.attributes.display !== 'none')
  return { count: visible.length, geometry: visible[0] ? ['x', 'y', 'width', 'height'].map(name => visible[0].getAttribute(name)) : null }
}

for (const { name, action } of [{ name: 'click', action: 'click' }, { name: 'Enter', action: 'Enter' }, { name: 'Space', action: ' ' }]) test(`selection equivalence: ${name} marks the exact dimmed cold cell without changing the hit grid`, async (t) => {
  const { context, canvas } = await harness(t)
  if (action === 'click') canvas.onclick({ clientX: 75, clientY: 25 })
  else { context.hoveredComplexityIndex = 1; canvas.listeners.get('keydown')({ key: action, preventDefault() {} }) }
  const rect = canvas.children.find(child => child.tagName === 'rect')
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex, pointerEvents: rect?.getAttribute('pointer-events') ?? rect?.style.pointerEvents ?? null, stroke: rect?.getAttribute('stroke') ?? rect?.style.stroke ?? null, strokeWidth: rect?.getAttribute('stroke-width') ?? rect?.style.strokeWidth ?? null, vectorEffect: rect?.getAttribute('vector-effect') ?? null, gridRects: canvas.querySelector('g[role="grid"]').children.filter(child => child.tagName === 'rect').length }, { marker: { count: 1, geometry: ['50', '0', '48', '48'] }, pin: 1, pointerEvents: 'none', stroke: 'var(--accent)', strokeWidth: '2', vectorEffect: 'non-scaling-stroke', gridRects: 0 })
})

test('selection boundary: choosing another cell moves the single marker instead of adding per-cell rectangles', async (t) => {
  const { context, canvas } = await harness(t)
  canvas.onclick({ clientX: 75, clientY: 25 }); canvas.onclick({ clientX: 25, clientY: 25 })
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex }, { marker: { count: 1, geometry: ['0', '0', '48', '48'] }, pin: 0 })
})

test('selection repaint domain: search and All preserve a selected dimmed cell and its world coordinates', async (t) => {
  const { context, canvas, search } = await harness(t)
  canvas.onclick({ clientX: 75, clientY: 25 }); search.value = 'hot'; context.applyFilter(); context.currentFilter = 'all'; search.value = ''; context.applyFilter()
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex, order: Array.from(context.summaryItems, item => item.id) }, { marker: { count: 1, geometry: ['50', '0', '48', '48'] }, pin: 1, order: ['hot', 'cold'] })
})

test('selection navigation domain: called-target selection and Back restore the marker through the actual shared selection entry point', async (t) => {
  const { context, canvas } = await harness(t)
  canvas.onclick({ clientX: 75, clientY: 25 }); context.selectSummaryItem(context.summaryItems[0], 'complexity'); context.selectionHistory.pop(); const previous = context.selectionHistory.at(-1); context.selectSummaryItem(previous.item, previous.mode, false)
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex }, { marker: { count: 1, geometry: ['50', '0', '48', '48'] }, pin: 1 })
})

test('selection missing-target exception: a function absent from the current grid hides the previous marker', async (t) => {
  const { context, canvas } = await harness(t)
  canvas.onclick({ clientX: 75, clientY: 25 }); context.selectSummaryItem({ id: 'missing', ownerId: 99, file: 'src/elsewhere.ts' }, 'complexity')
  assert.deepEqual(marker(canvas), { count: 0, geometry: null })
})

test('selection render reset: rerendering an empty Complexity view removes the obsolete marker and pin', async (t) => {
  const { context, canvas } = await harness(t)
  canvas.onclick({ clientX: 75, clientY: 25 }); context.complexityData.functions = []; context.renderComplexity()
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex }, { marker: { count: 0, geometry: null }, pin: -1 })
})

test('selection zoom boundary: a scaled hit grid selects the same world-space cold rectangle', async (t) => {
  const { context, canvas } = await harness(t)
  canvas.querySelector('g[role="grid"]').bounds = { left: 10, top: 20, width: 200, height: 100 }
  canvas.onclick({ clientX: 160, clientY: 70 })
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex }, { marker: { count: 1, geometry: ['50', '0', '48', '48'] }, pin: 1 })
})

test('selection failure exception: a failed internal-detail request leaves the selected marker visible', async (t) => {
  const { context, canvas, details } = await harness(t)
  context.fetchViewData = () => Promise.reject(new Error('detail unavailable'))
  canvas.onclick({ clientX: 75, clientY: 25 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ marker: marker(canvas), error: details.textContent }, { marker: { count: 1, geometry: ['50', '0', '48', '48'] }, error: 'Internal map unavailable: detail unavailable' })
})

test('selection hit boundary: clicking exactly beyond the last grid column preserves the existing pin and marker', async (t) => {
  const { context, canvas } = await harness(t)
  canvas.onclick({ clientX: 75, clientY: 25 }); canvas.onclick({ clientX: 100, clientY: 25 })
  assert.deepEqual({ marker: marker(canvas), pin: context.pinnedComplexityIndex }, { marker: { count: 1, geometry: ['50', '0', '48', '48'] }, pin: 1 })
})
