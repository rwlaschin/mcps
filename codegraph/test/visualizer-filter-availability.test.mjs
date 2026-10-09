import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createVisualizerServer } from '../visualizer.mjs'

// Plumbing only: the actual served switchView executes against ordinary button state.
async function switchClient(t, view, filter = 'all') {
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const server = createVisualizerServer('/test/root', { watch: () => watcher })
  t.after(() => server.watcher.close())
  const html = await new Promise(resolve => server.emit('request', Object.assign(new EventEmitter(), { url: '/', method: 'GET', headers: {} }), { setHeader() {}, end: resolve }))
  const buttons = ['all', 'most-called', 'orphans', 'violations'].map(value => {
    const active = new Set(value === filter ? ['active'] : [])
    return { dataset: { filter: value }, hidden: false, style: {}, classList: { add: value => active.add(value), remove: value => active.delete(value), contains: value => active.has(value), toggle(value, force) { if (force) active.add(value); else active.delete(value) } } }
  })
  const elements = new Map(); const renders = []
  const context = vm.createContext({ currentView: view, currentFilter: filter, hasPendingUpdate: false, graphData: {}, heatmapData: {}, sunburstData: {}, chordData: {}, calltreeData: {}, complexityData: {}, document: { querySelectorAll: () => buttons, getElementById: id => { if (!elements.has(id)) elements.set(id, { style: {}, checked: false }); return elements.get(id) } }, renderGraph: () => renders.push('layered'), renderHeatmap: () => renders.push('heatmap'), renderSunburst: () => renders.push('sunburst'), renderChord: () => renders.push('chord'), renderCalltree: () => renders.push('calltree'), renderComplexity: () => renders.push('complexity') })
  vm.runInContext(html.slice(html.indexOf('function switchView('), html.indexOf('const inFlightFetches = new Map()')), context)
  context.switchView()
  return { context, buttons, renders, visible: () => buttons.filter(button => !button.hidden && button.style.display !== 'none').map(button => button.dataset.filter), active: () => buttons.filter(button => button.classList.contains('active')).map(button => button.dataset.filter) }
}

for (const { view, visible } of [
  { view: 'layered', visible: ['all', 'most-called', 'orphans', 'violations'] },
  { view: 'heatmap', visible: ['all', 'most-called', 'orphans', 'violations'] },
  { view: 'sunburst', visible: ['all', 'most-called', 'orphans'] },
  { view: 'chord', visible: ['all', 'most-called', 'orphans', 'violations'] },
  { view: 'calltree', visible: ['all', 'most-called'] },
  { view: 'complexity', visible: ['all', 'most-called'] },
]) test(`equivalence availability: ${view} exposes exactly its supported filter buttons on initial switch`, async t => {
  const client = await switchClient(t, view)
  assert.deepEqual({ visible: client.visible(), rendered: client.renders }, { visible, rendered: [view] })
})

for (const { view, filter } of [
  { view: 'sunburst', filter: 'violations' },
  { view: 'calltree', filter: 'orphans' },
  { view: 'calltree', filter: 'violations' },
  { view: 'complexity', filter: 'orphans' },
  { view: 'complexity', filter: 'violations' },
]) test(`domain unsupported selection: switching to ${view} with ${filter} resets model and active button to All`, async t => {
  const client = await switchClient(t, view, filter)
  assert.deepEqual({ filter: client.context.currentFilter, active: client.active() }, { filter: 'all', active: ['all'] })
})

for (const { view, filter } of [
  { view: 'layered', filter: 'violations' },
  { view: 'heatmap', filter: 'orphans' },
  { view: 'sunburst', filter: 'orphans' },
  { view: 'chord', filter: 'violations' },
  { view: 'calltree', filter: 'most-called' },
  { view: 'complexity', filter: 'most-called' },
]) test(`all-pairs supported selection: ${view} retains ${filter} and its active button`, async t => {
  const client = await switchClient(t, view, filter)
  assert.deepEqual({ filter: client.context.currentFilter, active: client.active() }, { filter, active: [filter] })
})

test('error guessing availability restores hidden controls when returning from Complexity to Layered', async t => {
  const client = await switchClient(t, 'complexity', 'violations'); client.context.currentView = 'layered'; client.context.switchView()
  assert.deepEqual({ visible: client.visible(), filter: client.context.currentFilter, active: client.active() }, { visible: ['all', 'most-called', 'orphans', 'violations'], filter: 'all', active: ['all'] })
})
