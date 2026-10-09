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
for (const { name, transform, expected } of [
  { name: 'right padding stops just before second card', transform: { x: 0, y: 0, k: 1 }, expected: ['a'] },
  { name: 'right boundary equality includes second card', transform: { x: -20, y: 0, k: 1 }, expected: ['a', 'b'] },
  { name: 'left boundary equality retains first partial card', transform: { x: -536, y: 0, k: 1 }, expected: ['a', 'b', 'c', 'd'] },
  { name: 'left boundary just beyond first card removes it', transform: { x: -536.01, y: 0, k: 1 }, expected: ['b', 'c', 'd'] },
  { name: 'top boundary equality retains row', transform: { x: 0, y: -339, k: 1 }, expected: ['a'] },
  { name: 'top boundary just beyond row removes it', transform: { x: 0, y: -339.01, k: 1 }, expected: [] },
  { name: 'bottom boundary equality includes row', transform: { x: 0, y: 237, k: 1 }, expected: ['a'] },
  { name: 'bottom boundary just before row excludes it', transform: { x: 0, y: 237.01, k: 1 }, expected: [] },
  { name: 'zoom padding remains in world units', transform: { x: -140, y: 0, k: 2 }, expected: ['a', 'b'] },
]) test(`boundary/all-pairs viewport: ${name}`, async t => { const c = await client(t, structuredClone(row), [], transform); assert.deepEqual(c.ids(), expected) })

test('equivalence empty graph mounts no cards and keeps empty complete indexes', async t => { const c = await client(t, []); assert.deepEqual({ ids: c.ids(), nodes: c.run('nodeMap.size'), positions: c.run('posMap.size') }, { ids: [], nodes: 0, positions: 0 }) })
test('domain viewport mounting preserves every complete position and statistic', async t => {
  const c = await client(t, structuredClone(row)); assert.deepEqual({ mounted: c.ids(), positions: JSON.parse(c.run('JSON.stringify(Array.from(posMap, ([id,p]) => [id,p.x,p.y]))')), count: c.document.getElementById('stat-symbols').textContent }, { mounted: ['a'], positions: [['a', 120, 79], ['b', 336, 79], ['c', 552, 79], ['d', 768, 79]], count: 4 })
})
test('domain pan remount uses current filter instead of stale card appearance', async t => {
  const c = await client(t, structuredClone(row)); c.run('currentFilter="most-called"; applyFilter(); transform.x=-600; scheduleTransform()'); c.flush(); assert.deepEqual({ ids: c.ids(), display: Array.from(c.run('nodeElements.values()'), element => element.style.display) }, { ids: ['b', 'c', 'd'], display: ['none', 'none', 'none'] })
})
test('domain resize expands mounted columns without changing complete geometry', async t => { const c = await client(t, structuredClone(row)); c.svg.clientWidth = 400; c.listeners.get('resize')(); c.flush(); assert.deepEqual(c.ids(), ['a', 'b', 'c']) })
test('error guessing pending Layered frame never mounts cards into another view', async t => { const c = await client(t, structuredClone(row)); c.run('transform.x=-600; scheduleTransform(); currentView="heatmap"; nodeElements.clear(); canvas.replaceChildren()'); c.flush(); assert.deepEqual({ ids: c.ids(), children: c.canvas.children.length }, { ids: [], children: 0 }) })
test('domain offscreen violation endpoints still produce their complete edge', async t => { const c = await client(t, structuredClone(row), [{ from: 'a', to: 'd', isViolation: true }]); c.run('currentFilter="violations"; applyFilter()'); assert.deepEqual({ mounted: c.ids(), edgeGroups: c.document.getElementById('edge-layer').children.length }, { mounted: ['a'], edgeGroups: 1 }) })
test('domain offscreen selection retains edges and remounts highlighted neighbor', async t => { const c = await client(t, structuredClone(row), [{ from: 'a', to: 'd' }]); c.run('selectNode(nodeMap.get("d")); transform.x=-600; scheduleTransform()'); c.flush(); assert.deepEqual({ ids: c.ids(), selected: c.run('activeSelectedId'), highlighted: c.run('nodeElements.get("d").classList.contains("highlighted")'), edges: c.document.getElementById('edge-layer').children.length, detached: c.run('activeHighlighted.some(el => !el.parentNode)') }, { ids: ['b', 'c', 'd'], selected: 'd', highlighted: true, edges: 1, detached: false }) })
test('error guessing transform frame never traverses the complete source node array', async t => { const c = await client(t, structuredClone(row)); c.run('graphData.nodes = new Proxy(graphData.nodes, {get(target,key){if(key===Symbol.iterator || key==="length") throw new Error("full graph visited during transform"); return Reflect.get(target,key)}}); transform.x=-600; scheduleTransform()'); c.flush(); assert.deepEqual(c.ids(), ['b', 'c', 'd']) })

test('domain selected-neighbor lookup visits each adjacency list once per filter update', async t => {
  const c = await client(t, structuredClone(row), [{ from: 'a', to: 'd' }]); c.run('selectNode(nodeMap.get("d")); var incomingReads=0,outgoingReads=0; const oldIncomingGet=incomingEdgeMap.get.bind(incomingEdgeMap), oldOutgoingGet=outgoingEdgeMap.get.bind(outgoingEdgeMap); incomingEdgeMap.get=id => {incomingReads++; return oldIncomingGet(id)}; outgoingEdgeMap.get=id => {outgoingReads++; return oldOutgoingGet(id)}; applyFilter()'); assert.deepEqual({ incoming: c.run('incomingReads'), outgoing: c.run('outgoingReads') }, { incoming: 1, outgoing: 1 })
})
test('domain deselection removes remounted highlights and restores search intersection', async t => {
  const c = await client(t, structuredClone(row), [{ from: 'a', to: 'd' }]); c.document.getElementById('search-input').value = 'b'; c.run('selectNode(nodeMap.get("d")); transform.x=-600; scheduleTransform()'); c.flush(); c.run('selectNode(null)'); assert.deepEqual({ selected: c.run('activeSelectedId'), highlightCount: c.run('activeHighlighted.length'), display: Array.from(c.run('nodeElements.values()'), element => element.style.display), edges: c.document.getElementById('edge-layer').children.length }, { selected: null, highlightCount: 0, display: ['block', 'none', 'none'], edges: 0 })
})
test('error guessing sidebar navigation pans to an initially unmounted callee', async t => {
  const c = await client(t, structuredClone(row), [{ from: 'a', to: 'd' }]); c.run('selectNode(nodeMap.get("a"))'); c.document.getElementById('selection-details').onclick({ target: { closest: () => ({ dataset: { id: 'd' } }) } }); c.flush(); assert.deepEqual({ selected: c.run('activeSelectedId'), mounted: c.ids(), selectedHighlighted: c.run('nodeElements.get("d").classList.contains("highlighted")') }, { selected: 'd', mounted: ['c', 'd'], selectedHighlighted: true })
})
test('error guessing detached Layered canvas ownership prevents stale remount after tab return', async t => {
  const c = await client(t, structuredClone(row)); c.run('transform.x=-600; scheduleTransform(); currentView="heatmap"; canvas.replaceChildren(); nodeElements.clear(); currentView="layered"'); c.flush(); assert.deepEqual({ mounted: c.ids(), children: c.canvas.children.length }, { mounted: [], children: 0 })
})
test('boundary disjoint frontend and backend rows exclude the padded vertical gap', async t => {
  const c = await client(t, [{ id: 'a', name: 'a', file: 'a.ts', line: 1, inDegree: 0, outDegree: 0, color: '#fff' }, { id: 'b', name: 'b', file: 'b.ts', line: 2, inDegree: 0, outDegree: 0, color: '#fff', region: 'backend' }], [], { x: 0, y: -400, k: 1 }); assert.deepEqual({ mounted: c.ids(), positions: JSON.parse(c.run('JSON.stringify(Array.from(posMap,([id,p])=>[id,p.y]))')) }, { mounted: ['b'], positions: [['a', 79], ['b', 225]] })
})
