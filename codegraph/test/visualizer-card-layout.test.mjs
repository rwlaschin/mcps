import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createVisualizerServer } from '../visualizer.mjs'

// Minimal DOM construction noise; the item and all expected behavior are visible below.
class Element {
  constructor(tag) { this.tagName = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.style = {}; this.parentNode = null; this.textContent = ''; this.classList = { add: (...names) => { this.attributes.class = names.join(' ') } } }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  append(...children) { children.forEach(child => this.appendChild(child)) }
  set innerHTML(value) { this.children = [] }
}
async function servedHtml(t) {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher })
  t.after(() => server.watcher.close())
  return new Promise(resolve => {
    const request = Object.assign(new EventEmitter(), { url: '/', method: 'GET', headers: { host: '127.0.0.1:7331' } })
    const response = Object.assign(new EventEmitter(), { setHeader() {}, end(html) { resolve(html) } })
    server.emit('request', request, response)
  })
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)] }
function worldCoordinate(element, axis) {
  let value = Number(element.getAttribute(axis) ?? 0)
  for (let ancestor = element; ancestor; ancestor = ancestor.parentNode) {
    const translate = ancestor.getAttribute('transform')?.match(/translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)/)
    if (translate) value += Number(translate[axis === 'x' ? 1 : 2])
  }
  return String(value)
}
function clipFor(text, canvas) {
  for (let element = text; element; element = element.parentNode) {
    const reference = element.getAttribute('clip-path') ?? element.style.clipPath
    if (reference) { const id = reference.match(/#([^)]*)/)?.[1]; const clip = descendants(canvas).find(node => node.getAttribute('id') === id); return clip?.children.find(node => node.tagName === 'rect') }
  }
  return null
}

test('boundary layout: both wide Call Tree text rows use a 180-pixel clip while full names and card geometry survive', async (t) => {
  const html = await servedHtml(t)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const renderer = script.slice(script.indexOf('function renderSummaryCards('), script.indexOf('function renderCalltree('))
  const canvas = new Element('g')
  const context = vm.createContext({ layeredNodeGroup: null, layeredRows: [], nodeElements: new Map(), activeHighlighted: [], canvas, document: { createElementNS: (namespace, tag) => new Element(tag) }, complexityData: null, calltreeData: { edges: [] }, summaryItems: [], summaryMode: null, summaryTargetMap: null, centerView() {}, applyFilter() {}, layoutCallTree: () => ({ positions: new Map([['wide', { x: 30, y: 90 }]]), paths: [] }) })
  vm.runInContext(renderer, context)
  context.renderSummaryCards([{ id: 'wide', name: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWW', file: 'src/WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW.ts', cyclomatic: 12, color: '#f00' }], 'calltree')
  const group = descendants(canvas).find(node => node.getAttribute('role') === 'button')
  const texts = descendants(group).filter(node => node.tagName === 'text')
  const rect = group.children.find(node => node.tagName === 'rect')
  const clips = texts.map(text => clipFor(text, canvas))
  const classes = (group.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  const rules = Array.from(html.matchAll(/([^{}]+)\{([^{}]*)\}/g))
  const matchesCard = selector => classes.some(name => selector.includes('.' + name)) || group.getAttribute('role') === 'button' && group.dataset.summaryIndex !== undefined && /g\[data-summary-index\]/.test(selector)
  const scopedOutline = rules.some(([, selector, body]) => matchesCard(selector) && !selector.includes('rect') && /outline:\s*(none|0)\b/.test(body))
  const scopedAccentFocus = rules.some(([, selector, body]) => matchesCard(selector) && /:focus-visible\s*>\s*rect/.test(selector) && /stroke:\s*var\(--accent\)/.test(body))
  assert.deepEqual({ card: { x: worldCoordinate(rect, 'x'), y: worldCoordinate(rect, 'y'), width: rect.getAttribute('width'), height: rect.getAttribute('height') }, clipWidths: clips.map(clip => clip?.getAttribute('width') ?? null), label: texts[0].textContent, title: group.children.find(node => node.tagName === 'title').textContent, aria: group.getAttribute('aria-label'), tabindex: group.getAttribute('tabindex'), scopedOutline, scopedAccentFocus }, {
    card: { x: '30', y: '90', width: '200', height: '48' }, clipWidths: ['180', '180'], label: 'WWWWWWWWWWWWWWWWWWWWWWWWWWW…', title: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWW — Complexity 12 · src/WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW.ts', aria: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWW, complexity 12', tabindex: '0', scopedOutline: true, scopedAccentFocus: true,
  })
})


for (const { name, type, key, prevented } of [
  { name: 'click', type: 'click', key: undefined, prevented: false },
  { name: 'Enter', type: 'keydown', key: 'Enter', prevented: true },
  { name: 'Space', type: 'keydown', key: ' ', prevented: true },
]) test(`equivalence interaction: ${name} still selects the full Call Tree item`, async (t) => {
  const html = await servedHtml(t)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const handlers = script.slice(script.indexOf('canvas.addEventListener("click", event => {'), script.indexOf('// Fast indexed maps for O(1) lookups'))
  const callbacks = new Map()
  let selected; let defaultPrevented = false
  const context = vm.createContext({ canvas: { addEventListener: (event, callback) => callbacks.set(event, callback) }, summaryMode: 'calltree', summaryItems: [{ name: 'fullFunctionName' }], selectionHistory: ['previous'], selectSummaryItem: (item, mode) => { selected = { name: item.name, mode } } })
  vm.runInContext(handlers, context)
  callbacks.get(type)({ key, target: { closest: () => ({ dataset: { summaryIndex: '0' } }) }, preventDefault() { defaultPrevented = true } })
  assert.deepEqual({ selected, defaultPrevented, history: Array.from(context.selectionHistory) }, { selected: { name: 'fullFunctionName', mode: 'calltree' }, defaultPrevented: prevented, history: [] })
})
