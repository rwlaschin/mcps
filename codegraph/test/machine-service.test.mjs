import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import readline from 'node:readline'
import { QueryDaemon, QueryDaemonClient } from '../query-daemon.mjs'

test('domain analysis: separate clients with the same JSON-RPC ID receive their own root and result', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-ids-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'one'))
  fs.mkdirSync(path.join(root, 'two'))
  let started
  let release
  const ready = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'),
    serviceFactory: async () => ({ handle: async (request, { root: requestRoot }) => {
      if (request.method === 'first') { started(); await gate }
      return { jsonrpc: '2.0', id: request.id, result: { method: request.method, root: path.basename(requestRoot) } }
    }, close: async () => {} }),
  })
  t.after(() => daemon.close())
  await daemon.start()
  const first = new QueryDaemonClient(path.join(root, 'one'), { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  const second = new QueryDaemonClient(path.join(root, 'two'), { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => first.close())
  t.after(() => second.close())
  await Promise.all([first.connect(), second.connect()])

  const firstReply = first.mcp({ jsonrpc: '2.0', id: 1, method: 'first' })
  await ready
  const secondReply = await second.mcp({ jsonrpc: '2.0', id: 1, method: 'second' })
  release()
  const result = [await firstReply, secondReply]

  assert.deepEqual(result, [{ jsonrpc: '2.0', id: 1, result: { method: 'first', root: 'one' } }, { jsonrpc: '2.0', id: 1, result: { method: 'second', root: 'two' } }])
})

test('equivalence partition: numeric and string JSON-RPC IDs remain distinct on one client', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-id-types-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'),
    serviceFactory: async () => ({ handle: async (request) => ({ jsonrpc: '2.0', id: request.id, result: request.method }), close: async () => {} }),
  })
  t.after(() => daemon.close())
  await daemon.start()
  const client = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => client.close())
  await client.connect()

  const result = await Promise.all([client.mcp({ jsonrpc: '2.0', id: 1, method: 'numeric' }), client.mcp({ jsonrpc: '2.0', id: '1', method: 'text' })])

  assert.deepEqual(result, [{ jsonrpc: '2.0', id: 1, result: 'numeric' }, { jsonrpc: '2.0', id: '1', result: 'text' }])
})

test('error guessing: disconnect aborts only its own request while another client completes', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-disconnect-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let started
  const ready = new Promise((resolve) => { started = resolve })
  let aborted = false
  let abortObserved
  const stopped = new Promise((resolve) => { abortObserved = resolve })
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'),
    serviceFactory: async () => ({ handle: async (request, { signal }) => {
      if (request.method === 'held') { started(); await once(signal, 'abort'); aborted = true; abortObserved() }
      return { jsonrpc: '2.0', id: request.id, result: request.method }
    }, close: async () => {} }),
  })
  t.after(() => daemon.close())
  await daemon.start()
  const departing = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  const surviving = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => departing.close())
  t.after(() => surviving.close())
  await Promise.all([departing.connect(), surviving.connect()])
  const held = departing.mcp({ jsonrpc: '2.0', id: 1, method: 'held' })
  const rejection = assert.rejects(held, /closed|disconnect|socket/i)
  await ready
  await departing.close()
  await rejection
  await stopped
  const response = await surviving.mcp({ jsonrpc: '2.0', id: 1, method: 'surviving' })

  assert.deepEqual({ aborted, response }, { aborted: true, response: { jsonrpc: '2.0', id: 1, result: 'surviving' } })
})

test('error guessing: a losing starter binds before constructing any heavy service and preserves the winner token', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-election-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tokenPath = path.join(root, 'credentials', 'token')
  let winnerConstructions = 0
  let loserConstructions = 0
  const winner = new QueryDaemon(root, { endpoint: { host: '127.0.0.1', port: 0 }, tokenPath, serviceFactory: async () => { winnerConstructions += 1; return { close: async () => {} } } })
  t.after(() => winner.close())
  await winner.start()
  const token = fs.readFileSync(tokenPath, 'utf8')
  const loser = new QueryDaemon(root, { endpoint: winner.endpoint, tokenPath, serviceFactory: async () => { loserConstructions += 1; return { close: async () => {} } } })
  t.after(() => loser.close())

  await assert.rejects(loser.start(), /active|already|address|EADDRINUSE/i)
  await loser.close()

  assert.deepEqual({ winnerConstructions, loserConstructions, token: fs.readFileSync(tokenPath, 'utf8') }, { winnerConstructions: 1, loserConstructions: 0, token })
})

test('equivalence partition: a wrong authentication token never reaches the service handler', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-auth-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const daemon = new QueryDaemon(root, { endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'), serviceFactory: async () => ({ handle: async () => { calls += 1 }, close: async () => {} }) })
  t.after(() => daemon.close())
  await daemon.start()
  const socket = net.createConnection(daemon.endpoint)
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  socket.setEncoding('utf8')
  const reply = once(socket, 'data')
  socket.write('{"op":"auth","id":7,"token":"wrong","root":"/tmp"}\n')
  const [data] = await reply

  assert.deepEqual({ reply: JSON.parse(data.trim()), calls }, { reply: { id: 7, error: 'authentication failed', done: true }, calls: 0 })
})

test('error guessing: rejecting a duplicate outstanding JSON-RPC ID leaves the original request intact', { timeout: 3000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-duplicate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let started
  let release
  const ready = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'),
    serviceFactory: async () => ({ handle: async (request) => { started(); await gate; return { jsonrpc: '2.0', id: request.id, result: 'original' } }, close: async () => {} }),
  })
  t.after(() => daemon.close())
  await daemon.start()
  const client = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => client.close())
  await client.connect()
  const original = client.mcp({ jsonrpc: '2.0', id: 9, method: 'held' })
  await ready

  const duplicate = await client.mcp({ jsonrpc: '2.0', id: 9, method: 'duplicate' })
  release()

  assert.deepEqual({ duplicate, original: await original }, {
    duplicate: { jsonrpc: '2.0', id: 9, error: { code: -32600, message: 'duplicate outstanding request id' } },
    original: { jsonrpc: '2.0', id: 9, result: 'original' },
  })
})

test('domain analysis: unsubscribing one client preserves another client subscription', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-subscriptions-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const listeners = new Set()
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'),
    serviceFactory: async () => ({ subscribe: (_root, listener) => { listeners.add(listener); return () => listeners.delete(listener) }, close: async () => {} }),
  })
  t.after(() => daemon.close())
  await daemon.start()
  const first = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  const second = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => first.close())
  t.after(() => second.close())
  await Promise.all([first.connect(), second.connect()])
  const firstEvents = []
  let received
  const ready = new Promise((resolve) => { received = resolve })
  const unsubscribe = await first.subscribe((event) => firstEvents.push(event))
  await second.subscribe((event) => received(event))

  await unsubscribe()
  for (const listener of listeners) listener({ status: 'ready' })

  assert.deepEqual({ firstEvents, survivingEvent: await ready, retainedListeners: listeners.size }, { firstEvents: [], survivingEvent: { status: 'ready' }, retainedListeners: 1 })
})

test('domain analysis: root scheduling serves a waiting second root before another job from the active root', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-fairness-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'a'))
  fs.mkdirSync(path.join(root, 'b'))
  const completions = []
  let started
  let release
  const ready = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  let builds = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: (engineRoot) => ({
      build: async () => { builds += 1; if (builds === 1) { started(); await gate } const name = path.basename(engineRoot); completions.push(name); return { root: name } },
      reconcile: async () => {}, incremental: async () => {}, registeredFiles: () => new Set(), dispose: async () => {},
    }),
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())
  const first = service.mutate(path.join(root, 'a'), 'build', { coverage: 'calls' }, { owner: 'fairness-client' })
  await ready
  const anotherA = service.mutate(path.join(root, 'a'), 'build', { coverage: 'complete' }, { owner: 'fairness-client' })
  const firstB = service.mutate(path.join(root, 'b'), 'build', { coverage: 'calls' }, { owner: 'fairness-client' })

  release()
  await Promise.all([first, anotherA, firstB])

  assert.deepEqual(completions, ['a', 'b', 'a'])
})

for (const { name, owner, interimDisposals, retained, expectedUpdates } of [
  { name: 'a connected owner reuses one engine across a build and two updates', owner: 'retention-client', interimDisposals: 0, retained: true, expectedUpdates: [{ updated: true }, { updated: true }] },
  { name: 'an unowned completed operation releases its engine', owner: undefined, interimDisposals: 1, retained: false, expectedUpdates: [] },
]) test(`boundary analysis: RSS above one GiB ${name}`, { timeout: 3000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-pressure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let engines = 0
  let disposals = 0
  let disposalCompleted
  const disposed = new Promise(resolve => { disposalCompleted = resolve })
  const service = createService({ workerCount: 1, rss: () => 1073741825,
    engineFactory: () => { engines += 1; return { build: async () => ({ indexed: 1 }), reconcile: async () => {}, incremental: async () => ({ updated: true }), registeredFiles: () => new Set(), dispose: async () => { disposals += 1; disposalCompleted() } } },
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())

  const result = await service.mutate(root, 'build', { coverage: 'calls' }, { owner })
  const updates = []
  if (owner) {
    updates.push(await service.mutate(root, 'incremental', { events: [{ type: 'change', path: 'one.ts' }] }, { owner }))
    updates.push(await service.mutate(root, 'incremental', { events: [{ type: 'change', path: 'two.ts' }] }, { owner }))
  }
  if (!owner) await disposed
  const afterOperations = { engines, disposals, retained: service.status().heavyRoot === fs.realpathSync(root) }
  await service.release(fs.realpathSync(root), owner)

  assert.deepEqual({ result, updates, afterOperations, finalDisposals: disposals, heavyRoot: service.status().heavyRoot, roots: service.status().roots.length }, {
    result: { indexed: 1 }, updates: expectedUpdates,
    afterOperations: { engines: 1, disposals: interimDisposals, retained }, finalDisposals: 1, heavyRoot: null, roots: 0,
  })
})

for (const { name, rssBytes } of [
  { name: 'one byte below the retention boundary', rssBytes: 1073741823 },
  { name: 'exactly at the retention boundary', rssBytes: 1073741824 },
]) test(`boundary analysis: RSS ${name} retains the idle heavy owner`, { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-retain-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let disposals = 0
  const service = createService({ workerCount: 1, rss: () => rssBytes,
    engineFactory: () => ({ build: async () => ({ indexed: 1 }), reconcile: async () => {}, incremental: async () => {}, registeredFiles: () => new Set(), dispose: async () => { disposals += 1 } }),
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())

  const result = await service.mutate(root, 'build', { coverage: 'calls' }, { owner: 'retention-client' })

  assert.deepEqual({ result, disposals, retained: service.status().heavyRoot === fs.realpathSync(root) }, { result: { indexed: 1 }, disposals: 0, retained: true })
})

test('error guessing: requests accepted during bound service initialization wait for the ready handler', { timeout: 3000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-ready-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let initialized
  let release
  const factoryStarted = new Promise((resolve) => { initialized = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  let calls = 0
  const daemon = new QueryDaemon(root, {
    endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'),
    serviceFactory: async () => { initialized(); await gate; return { handle: async (request) => { calls += 1; return { jsonrpc: '2.0', id: request.id, result: 'ready' } }, close: async () => {} } },
  })
  t.after(() => daemon.close())
  const starting = daemon.start()
  await factoryStarted
  const client = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => client.close())
  const pending = (async () => { await client.connect(); return client.mcp({ jsonrpc: '2.0', id: 4, method: 'ready-check' }) })()
  await new Promise((resolve) => setImmediate(resolve))
  const callsBeforeReady = calls

  release()
  await starting

  assert.deepEqual({ callsBeforeReady, reply: await pending, calls }, { callsBeforeReady: 0, reply: { jsonrpc: '2.0', id: 4, result: 'ready' }, calls: 1 })
})

test('domain analysis: canonical root aliases share one watcher until the final interested client releases it', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-watch-owner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.symlinkSync(root, path.join(root, 'alias'), 'dir')
  let created = 0
  let closed = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: () => ({ build: async () => ({ indexed: 1 }), reconcile: async () => {}, incremental: async () => {}, registeredFiles: () => new Set(), dispose: async () => {} }),
    watchFactory: () => { created += 1; return Object.assign(new EventEmitter(), { close() { closed += 1 } }) },
  })
  t.after(() => service.close())
  await service.mutate(root, 'build', {}, { owner: 'first-client' })
  await service.mutate(path.join(root, 'alias'), 'build', {}, { owner: 'second-client' })

  await service.release(fs.realpathSync(root), 'first-client')
  const afterFirstRelease = closed
  await service.release(fs.realpathSync(root), 'second-client')

  assert.deepEqual({ created, afterFirstRelease, afterFinalRelease: closed }, { created: 1, afterFirstRelease: 0, afterFinalRelease: 1 })
})

test('error guessing: returning to an inactive root queries a fresh engine instead of its disposed predecessor', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'a'))
  fs.mkdirSync(path.join(root, 'b'))
  let creations = 0
  let disposals = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: (engineRoot) => {
      creations += 1
      let disposed = false
      return { reconcile: async () => {}, registeredFiles: () => new Set(),
        pinQuery: async () => { assert.equal(disposed, false, 'query reached a disposed engine'); return { metadata: {}, rows: [{ name: path.basename(engineRoot) }] } },
        dispose: async () => { disposed = true; disposals += 1 },
      }
    },
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())

  const first = await service.queryBatch(path.join(root, 'a'), { type: 'symbols', consistency: 'latest' }, { owner: 'query-client' })
  const second = await service.queryBatch(path.join(root, 'b'), { type: 'symbols', consistency: 'latest' }, { owner: 'query-client' })
  const returning = await service.queryBatch(path.join(root, 'a'), { type: 'symbols', consistency: 'latest' }, { owner: 'query-client' })

  assert.deepEqual({ first, second, returning, creations, disposals }, { first: [{ name: 'a' }], second: [{ name: 'b' }], returning: [{ name: 'a' }], creations: 3, disposals: 2 })
})

for (const { name, budget, expectedWorkers } of [
  { name: 'one checker and no structural worker', budget: 1, expectedWorkers: 1 },
  { name: 'one checker and one structural worker', budget: 2, expectedWorkers: 2 },
  { name: 'one checker and two structural workers', budget: 3, expectedWorkers: 3 },
]) test(`boundary analysis: a real two-file build uses ${name}`, { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-worker-budget-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}')
  fs.writeFileSync(path.join(root, 'one.ts'), 'export function one() { return 1 }')
  fs.writeFileSync(path.join(root, 'two.ts'), "import { one } from './one'; export function two() { return one() }")
  const service = createService({ workerCount: budget, rss: () => 0, watchFactory: () => Object.assign(new EventEmitter(), { close() {} }) })
  t.after(() => service.close())

  await service.mutate(root, 'build', {}, { owner: 'worker-proof-client' })
  const status = service.status()

  assert.deepEqual({ workerBudget: status.workerBudget, observedWorkers: status.observedWorkerCount }, { workerBudget: budget, observedWorkers: expectedWorkers })
})

test('domain analysis: cancelling one identical index waiter leaves the surviving waiter on the same build', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-surviving-waiter-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let started
  let release
  const ready = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  let builds = 0
  let disposals = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: () => ({ build: async () => { builds += 1; started(); await gate; return { indexed: 1 } }, reconcile: async () => {}, incremental: async () => {}, registeredFiles: () => new Set(), dispose: async () => { disposals += 1 } }),
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())
  const controller = new AbortController()
  const cancelled = service.mutate(root, 'build', {}, { owner: 'departing-client', signal: controller.signal })
  const rejected = assert.rejects(cancelled, /cancelled/)
  await ready
  const surviving = service.mutate(root, 'build', {}, { owner: 'surviving-client' })

  controller.abort()
  await rejected
  await new Promise((resolve) => setImmediate(resolve))
  release()

  assert.deepEqual({ result: await surviving, builds, disposals }, { result: { indexed: 1 }, builds: 1, disposals: 0 })
})

test('domain analysis: RSS pressure preserves a streamed query engine until its final connected owner releases it', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-active-reader-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let rssBytes = 0
  let disposals = 0
  let disposalCompleted
  const disposed = new Promise(resolve => { disposalCompleted = resolve })
  const service = createService({ workerCount: 1, rss: () => rssBytes,
    engineFactory: () => ({ reconcile: async () => {}, registeredFiles: () => new Set(), pinQuery: async () => ({ metadata: {}, rows: [{ sequence: 1 }, { sequence: 2 }] }), dispose: async () => { disposals += 1; disposalCompleted() } }),
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())
  const reader = service.query(root, { type: 'symbols', consistency: 'latest' }, { owner: 'reader-client' })
  t.after(() => reader.return())
  const first = await reader.next()

  rssBytes = 1073741825
  await service.release(fs.realpathSync(root), 'unrelated-client')
  const heldDisposals = disposals
  const second = await reader.next()
  await reader.return()

  const afterReaderReturn = disposals
  await service.release(fs.realpathSync(root), 'reader-client')
  await disposed

  assert.deepEqual({ first, second, heldDisposals, afterReaderReturn, releasedDisposals: disposals, heavyRoot: service.status().heavyRoot }, { first: { value: { sequence: 1 }, done: false }, second: { value: { sequence: 2 }, done: false }, heldDisposals: 0, afterReaderReturn: 0, releasedDisposals: 1, heavyRoot: null })
})

test('domain analysis: fallback relationship rows finish materializing before another root disposes their engine', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-lazy-refs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'a'))
  fs.mkdirSync(path.join(root, 'b'))
  let started
  let release
  const ready = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  let secondRootStarted = false
  let firstRootDisposed = false
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: (engineRoot) => {
      if (path.basename(engineRoot) === 'b') secondRootStarted = true
      return { reconcile: async () => {}, registeredFiles: () => new Set(), build: async () => ({ indexed: 1 }),
        pinQuery: async () => ({ metadata: {}, rows: (async function * () { started(); await gate; assert.equal(firstRootDisposed, false, 'lazy rows reached a disposed root'); yield { from: 'a-caller', to: 'a-target', call: true } })() }),
        dispose: async () => { if (path.basename(engineRoot) === 'a') firstRootDisposed = true },
      }
    }, watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())
  const first = service.queryBatch(path.join(root, 'a'), { type: 'refs', consistency: 'latest' }, { owner: 'first-reader' })
  await ready
  const second = service.mutate(path.join(root, 'b'), 'build', {}, { owner: 'second-client' })
  await new Promise((resolve) => setImmediate(resolve))
  const activatedWhileRowsHeld = secondRootStarted

  release()
  const rows = await first
  await second

  assert.deepEqual({ activatedWhileRowsHeld, rows, firstRootDisposed }, { activatedWhileRowsHeld: false, rows: [{ from: 'a-caller', to: 'a-target', call: true }], firstRootDisposed: true })
})

test('domain analysis: a complete mapped graph becomes an independent plain result before switching roots', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-lazy-graph-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'a'))
  fs.mkdirSync(path.join(root, 'b'))
  let started
  let release
  const ready = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  let firstRootDisposed = false
  let graphReads = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: (engineRoot) => ({ reconcile: async () => {}, registeredFiles: () => new Set(), build: async () => ({ indexed: 1 }),
      snapshotComplete: async () => { started(); await gate; return { mapped: true, generation: 'complete-a', edgeCoverage: 'complete', get graph() { assert.equal(firstRootDisposed, false, 'graph decoded after its mapping owner closed'); graphReads += 1; return { generation: 'complete-a', edgeCoverage: 'complete', files: ['one.ts'], symbols: [], edges: [] } } } },
      dispose: async () => { if (path.basename(engineRoot) === 'a') firstRootDisposed = true },
    }), watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())
  const first = service.queryBatch(path.join(root, 'a'), { type: 'graph', edgeCoverage: 'complete', consistency: 'latest' }, { owner: 'graph-reader' })
  await ready
  const second = service.mutate(path.join(root, 'b'), 'build', {}, { owner: 'second-client' })

  release()
  const graphs = await first
  await second

  assert.deepEqual({ graphs, graphReads, firstRootDisposed }, { graphs: [{ generation: 'complete-a', edgeCoverage: 'complete', files: ['one.ts'], symbols: [], edges: [] }], graphReads: 1, firstRootDisposed: true })
})

test('error guessing: deleting an original source after the first cold build removes its published symbol', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-first-unlink-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}')
  fs.writeFileSync(path.join(root, 'one.ts'), 'export function one() { return 1 }')
  fs.writeFileSync(path.join(root, 'two.ts'), "import { one } from './one'; export function two() { return one() }")
  let nativeChange
  const service = createService({ workerCount: 1, rss: () => 0,
    watchFactory: (_root, _options, listener) => { nativeChange = listener; return Object.assign(new EventEmitter(), { close() {} }) },
  })
  t.after(() => service.close())
  await service.mutate(root, 'build', {}, { owner: 'source-owner' })
  let published
  const ready = new Promise((resolve) => { published = resolve })
  const unsubscribe = service.subscribe(root, (event) => { if (event.status === 'ready') published() }, { owner: 'source-owner' })
  t.after(() => unsubscribe())

  fs.unlinkSync(path.join(root, 'one.ts'))
  nativeChange('rename', 'one.ts')
  await ready
  const rows = await service.queryBatch(root, { type: 'symbols', name: 'one' }, { owner: 'source-owner' })

  assert.deepEqual(rows, [])
})

test('domain analysis: an unindexed default root remains unbuilt until its first explicit index performs the only build', async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-default-unindexed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  let builds = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: () => ({ build: async () => { builds += 1; return { generation: 'generation-1', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] } }, reconcile: async () => {}, incremental: async () => {}, registeredFiles: () => new Set(), dispose: async () => {} }),
    watchFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  })
  t.after(() => service.close())
  await service.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { root, owner: 'default-root-client' })
  const buildsBeforeIndex = builds

  const response = await service.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_index', arguments: {} } }, { root, owner: 'default-root-client' })

  assert.deepEqual({ buildsBeforeIndex, builds, receipt: JSON.parse(response.result.content[0].text) }, { buildsBeforeIndex: 0, builds: 1, receipt: { generation: 'generation-1', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] } })
})

for (const { name, invalidRoot } of [
  { name: 'numeric root', invalidRoot: 7 },
  { name: 'boolean root', invalidRoot: true },
  { name: 'array root', invalidRoot: [] },
  { name: 'null root without a configured default', invalidRoot: null },
  { name: 'empty root without a configured default', invalidRoot: '' },
  { name: 'whitespace root without a configured default', invalidRoot: ' ' },
]) test(`equivalence partition: ${name} returns the existing MCP tool error envelope`, { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-invalid-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const daemon = new QueryDaemon(root, { endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'), serviceFactory: async () => createService({ workerCount: 1, rss: () => 0 }) })
  t.after(() => daemon.close())
  await daemon.start()
  const client = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => client.close())
  await client.connect()

  const response = await client.mcp({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'codegraph_index', arguments: { root: invalidRoot } } }, { root: null })

  assert.deepEqual(response, { jsonrpc: '2.0', id: 17, result: { content: [{ type: 'text', text: 'error: missing required argument "root": absolute path of the repository to analyze.' }], isError: true } })
})


test('error guessing: a cancelled stdio request held during reload is never replayed after reconnect', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proxy-held-cancel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const loader = path.join(root, 'transport-loader.mjs')
  fs.writeFileSync(loader, `export async function load(url, context, nextLoad) {
    if (url.endsWith('/query-daemon.mjs')) return { format: 'module', shortCircuit: true, source: \`
      import { EventEmitter } from 'node:events'
      let socket; let control
      process.stdin.on('data', chunk => { if (chunk.toString().includes('surviving-held-probe')) setImmediate(() => process.send({ flushed: true })) })
      process.on('message', message => { if (message === 'reconnect') { socket.destroyed = true; socket.emit('close') } })
      export async function connectQueryDaemon(root, options) {
        socket = new EventEmitter(); socket.destroyed = false; control = options.onControl
        return { socket, close: async () => {}, request: async () => {}, mcp: async request => {
          process.send({ method: request.method })
          if (request.method === 'pause') { control('reload'); process.send({ paused: true }) }
          return { jsonrpc: '2.0', id: request.id, result: request.method }
        } }
      }
    \` }
    return nextLoad(url, context)
  }`)
  const child = fork(path.resolve(import.meta.dirname, '..', 'mcp.mjs'), [], { execArgv: ['--no-warnings', '--experimental-loader', loader], silent: true })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const messages = []
  let flushed
  const flushedReady = new Promise(resolve => { flushed = resolve })
  let paused
  const pauseReady = new Promise(resolve => { paused = resolve })
  child.on('message', message => { if (message.paused) paused(); else if (message.flushed) flushed(); else messages.push(message) })
  const lines = readline.createInterface({ input: child.stdout })
  t.after(() => lines.close())
  const pauseReply = once(lines, 'line')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pause' }) + '\n')
  await pauseReady
  await pauseReply
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'cancelled-while-held' }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'surviving-held-probe' }) + '\n')
  // Flush the real stdio lines before releasing the mocked socket lifecycle gate.
  await flushedReady
  const probeReply = new Promise(resolve => { lines.on('line', line => { const reply = JSON.parse(line); if (reply.id === 3) resolve(reply) }) })
  child.send('reconnect')
  const reply = await probeReply
  const exited = once(child, 'exit')
  child.stdin.end()
  await exited
  assert.deepEqual({ methods: messages, reply, exitCode: child.exitCode }, { methods: [{ method: 'pause' }, { method: 'surviving-held-probe' }], reply: { jsonrpc: '2.0', id: 3, result: 'surviving-held-probe' }, exitCode: 0 })
})

test('domain analysis: a whitespace-padded valid MCP root releases its canonical watcher on disconnect', { timeout: 10000 }, async (t) => {
  const { createService } = await import('../mcp-server.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-trimmed-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let released
  const watcherClosed = new Promise(resolve => { released = resolve })
  let closes = 0
  const service = createService({ workerCount: 1, rss: () => 0,
    engineFactory: () => ({ build: async () => ({ indexed: 1 }), reconcile: async () => {}, incremental: async () => {}, registeredFiles: () => new Set(), dispose: async () => {} }),
    watchFactory: () => Object.assign(new EventEmitter(), { close() { closes += 1 } }),
  })
  const daemon = new QueryDaemon(root, { endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: path.join(root, 'credentials', 'token'), serviceFactory: async () => ({ ...service, release: async (requestRoot, owner) => { await service.release(requestRoot, owner); released() } }) })
  t.after(() => daemon.close())
  await daemon.start()
  const client = new QueryDaemonClient(root, { endpoint: daemon.endpoint, tokenPath: daemon.tokenPath })
  t.after(() => client.close())
  await client.connect()
  const reply = await client.mcp({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'codegraph_index', arguments: { root: '  ' + root + '  ' } } })
  await client.close()
  await watcherClosed
  assert.deepEqual({ receipt: JSON.parse(reply.result.content[0].text), watcherCloses: closes, roots: service.status().roots }, { receipt: { indexed: 1 }, watcherCloses: 1, roots: [] })
})
