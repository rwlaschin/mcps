import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createVisualizerServer } from '../visualizer.mjs'

// DOM construction is harness plumbing; graph inputs and expected coordinates are explicit below.
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.parentNode = null; this.classes = new Set(); this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name) } }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.classes = new Set(String(value).split(' ')); if (name === 'id') this.id = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child }
  remove() { this.parentNode?.removeChild(this) }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; children.forEach(child => this.appendChild(child)) }
  set innerHTML(value) { this.html = value; this.replaceChildren() }
  get innerHTML() { return this.html ?? '' }
  addEventListener() {}
  querySelectorAll(selector) { const result = []; for (const child of this.children) { if (selector === '.node-card' && child.classes.has('node-card')) result.push(child); result.push(...child.querySelectorAll(selector)) } return result }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
async function client(t, nodes, edges = [], transform = { x: 0, y: 0, k: 1 }) {
  const watcher = Object.assign(new EventEmitter(), { close() {} }); const server = createVisualizerServer('/test/root', { watch: () => watcher }); t.after(() => server.watcher.close())
  const html = await new Promise(resolve => server.emit('request', Object.assign(new EventEmitter(), { url: '/', method: 'GET', headers: {} }), { setHeader() {}, end: resolve }))
  const canvas = new Element('g'); const svg = new Element('svg'); svg.clientWidth = 100; svg.clientHeight = 100; svg.getBoundingClientRect = () => ({ width: svg.clientWidth, height: svg.clientHeight, left: 0, top: 0 })
  const elements = new Map(); const frames = []; const listeners = new Map()
  const document = { createElementNS: (_ns, tag) => new Element(tag), getElementById(id) { const find = element => element.id === id ? element : element.children.map(find).find(Boolean); return find(canvas) ?? (elements.has(id) ? elements.get(id) : (elements.set(id, Object.assign(new Element(), { value: '' })), elements.get(id))) }, querySelectorAll: () => [] }
  const context = vm.createContext({ canvas, svg, document, window: { innerWidth: 100, innerHeight: 100, addEventListener: (name, fn) => listeners.set(name, fn) }, requestAnimationFrame: fn => (frames.push(fn), frames.length), cancelAnimationFrame() {}, performance: { now: () => 0 }, graphData: { nodes, edges }, currentView: 'layered', currentFilter: 'all', transform, rafPending: false, console })
  const declarations = html.slice(html.indexOf('let activeSelectedId = null;'), html.indexOf('function centerView('))
  const render = html.slice(html.indexOf('function formatLoc('), html.indexOf('function renderHeatmap('))
  const filter = html.slice(html.indexOf('function applyFilter()'), html.indexOf('document.getElementById("search-input").addEventListener'))
  vm.runInContext(declarations + render + filter, context)
  const run = source => vm.runInContext(source, context)
  const flush = () => { let remaining = 20; while (frames.length && remaining-- > 0) frames.shift()(300); assert.ok(remaining > 0, 'RAF queue must settle') }
  context.renderGraph(); flush()
  return { context, canvas, svg, document, run, flush, frames, listeners, ids: () => Array.from(run('nodeElements.keys()')).sort() }
}
const row = [
  { id: 'a', name: 'a', file: 'src/a.ts', line: 1, inDegree: 0, outDegree: 0, color: '#fff', isOrphan: true },
  { id: 'b', name: 'b', file: 'src/b.ts', line: 2, inDegree: 0, outDegree: 0, color: '#fff', isOrphan: true },
  { id: 'c', name: 'c', file: 'src/c.ts', line: 3, inDegree: 0, outDegree: 0, color: '#fff', isOrphan: true },
  { id: 'd', name: 'd', file: 'src/d.ts', line: 4, inDegree: 0, outDegree: 0, color: '#fff', isOrphan: true },
]

// Read painted geometry rather than production metadata; this also catches accidental full-width leftovers.
function descendants(element) { return element.children.filter(child => child.style.display !== "none" && child.attributes.display !== "none").flatMap(child => [child, ...descendants(child)]) }
function paint(canvas) {
  const elements = descendants(canvas)
  return {
    fills: elements.filter(el => el.tagName === 'rect' && el.classes.has('layer-band')).map(el => ({ geometry: ['x','y','width','height'].map(key => Number(el.attributes[key])), stroke: el.attributes.stroke ?? el.style.stroke })),
    borders: elements.filter(el => el.tagName === 'path' && el.classes.has('layer-band')).map(el => ({ coordinates: (el.attributes.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number), phase: Number(el.attributes['stroke-dashoffset'] ?? 0) })),
    headers: elements.filter(el => el.tagName === 'line').map(el => ['x1','y1','x2','y2'].map(key => Number(el.attributes[key]))),
  }
}
for (const { name, transform, fills, borders, headers } of [
  { name: 'middle slice preserves both dash phases without false vertical borders', transform: { x: -500, y: 0, k: 1 }, fills: [{ geometry: [284,70,532,62], stroke: 'none' }], borders: [{ coordinates: [284,70,816,70], phase: 0 }, { coordinates: [816,132,284,132], phase: 2 }], headers: [[284,56,816,56]] },
  { name: 'one world unit pan preserves phase at fixed world coordinates', transform: { x: -501, y: 0, k: 1 }, fills: [{ geometry: [285,70,532,62], stroke: 'none' }], borders: [{ coordinates: [285,70,817,70], phase: 1 }, { coordinates: [817,132,285,132], phase: 1 }], headers: [[285,56,817,56]] },
  { name: 'original left edge remains a real vertical border', transform: { x: 0, y: 0, k: 1 }, fills: [{ geometry: [12,70,304,62], stroke: 'none' }], borders: [{ coordinates: [12,70,316,70], phase: 0 }, { coordinates: [316,132,12,132], phase: 2 }, { coordinates: [12,132,12,70], phase: 2 }], headers: [[18,56,316,56]] },
  { name: 'true right edge appears only at the original band end', transform: { x: -1100, y: 0, k: 1 }, fills: [{ geometry: [884,70,252,62], stroke: 'none' }], borders: [{ coordinates: [884,70,1136,70], phase: 0 }, { coordinates: [1136,70,1136,132], phase: 0 }, { coordinates: [1136,132,884,132], phase: 2 }], headers: [[884,56,1124,56]] },
  { name: 'nonunit zoom keeps padding and border phase in world units', transform: { x: -1000, y: 0, k: 2 }, fills: [{ geometry: [284,70,482,62], stroke: 'none' }], borders: [{ coordinates: [284,70,766,70], phase: 0 }, { coordinates: [766,132,284,132], phase: 0 }], headers: [[284,56,766,56]] },
]) test(`boundary/domain decorations: ${name}`, async t => {
  const c = await client(t, structuredClone(row), [], transform)
  assert.deepEqual(paint(c.canvas), { fills, borders, headers })
})

test('boundary band-only intersection retains lower stroke after the last card is outside', async t => {
  const c = await client(t, structuredClone(row), [], { x: -500, y: -345, k: 1 })
  assert.deepEqual({ mounted: c.ids(), paint: paint(c.canvas) }, { mounted: [], paint: { fills: [{ geometry: [284,129,532,3], stroke: 'none' }], borders: [{ coordinates: [816,132,284,132], phase: 2 }], headers: [] } })
})
test('boundary band-only intersection retains upper stroke before the first card enters', async t => {
  const c = await client(t, structuredClone(row), [], { x: -500, y: 240, k: 1 })
  assert.deepEqual({ mounted: c.ids(), paint: paint(c.canvas) }, { mounted: [], paint: { fills: [{ geometry: [284,70,532,6], stroke: 'none' }], borders: [{ coordinates: [284,70,816,70], phase: 0 }], headers: [[284,56,816,56]] } })
})
test('equivalence offscreen decorations disappear while complete row positions remain', async t => {
  const c = await client(t, structuredClone(row), [], { x: -500, y: -1000, k: 1 })
  assert.deepEqual({ paint: paint(c.canvas), positions: c.run('posMap.size'), rows: c.run('layeredRows.length'), stats: c.document.getElementById('stat-symbols').textContent }, { paint: { fills: [], borders: [], headers: [] }, positions: 4, rows: 1, stats: 4 })
})

test('error guessing decoration pan does not enumerate rows or read offscreen node arrays', async t => {
  const c = await client(t, structuredClone(row), [], { x: -500, y: 0, k: 1 })
  c.run('const firstRow=layeredRows[0]; layeredRows=new Proxy([firstRow,{ y:1000, band:{...firstRow.band,y:991,group:null}, get nodes(){ throw new Error("offscreen row nodes inspected") } }],{get(target,key){if(key===Symbol.iterator || key==="forEach" || key==="map")throw new Error("all rows enumerated");return Reflect.get(target,key)}}); transform.x=-501; scheduleTransform()')
  c.flush()
  assert.deepEqual(paint(c.canvas).headers, [[285,56,817,56]])
})
test('error guessing pending decoration frame cannot repopulate another view canvas', async t => {
  const c = await client(t, structuredClone(row)); c.run('transform.x=-500; scheduleTransform(); currentView="heatmap"; canvas.replaceChildren()'); c.flush()
  assert.deepEqual(paint(c.canvas), { fills: [], borders: [], headers: [] })
})
test('domain remount recreates original clipped decoration phases after leaving its row', async t => {
  const c = await client(t, structuredClone(row), [], { x: -500, y: 0, k: 1 }); c.run('transform.y=-1000; scheduleTransform()'); c.flush(); c.run('transform.y=0; scheduleTransform()'); c.flush()
  assert.deepEqual(paint(c.canvas), { fills: [{ geometry: [284,70,532,62], stroke: 'none' }], borders: [{ coordinates: [284,70,816,70], phase: 0 }, { coordinates: [816,132,284,132], phase: 2 }], headers: [[284,56,816,56]] })
})
