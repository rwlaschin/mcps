import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DebouncedBuildQueue, McpProjectRuntime } from '../mcp-runtime.mjs'

test('debounce coalesces and preserves events arriving during a build', async () => {
  const batches = []; let release
  const queue = new DebouncedBuildQueue(async (events) => { batches.push(events); if (batches.length === 1) await new Promise((r) => { release = r }) }, { debounceMs: 5 })
  queue.push({ type: 'change', path: 'a.ts' }); queue.push({ type: 'change', path: 'a.ts' })
  await new Promise((r) => setTimeout(r, 15))
  queue.push({ type: 'change', path: 'b.ts' }); release()
  await queue.idle()
  assert.deepEqual(batches.map((b) => b.map((e) => e.path)), [['a.ts'], ['b.ts']])
  await queue.close(); assert.equal(queue.closed, true)
})

test('MCP runtime reconciles on startup and shuts watcher down', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  fs.writeFileSync(path.join(root, 'one.ts'), 'export const one = 1')
  let reconciled = 0
  const runtime = new McpProjectRuntime(root, {
    engine: {
      policy: (await import('../source-policy.mjs')).createSourcePolicy(root),
      reconcile: async () => { reconciled++ },
      incremental: async () => {},
    },
  })
  await runtime.start()
  assert.equal(reconciled, 1)
  await runtime.close()
  assert.equal(runtime.queue.closed, true)
})

test('domain analysis: a watcher build advancing CURRENT cannot change an already pinned reference request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-pinned-overlay-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 41\n')
  fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), "import { value } from './value'\nexport function read(){ return value }\n")
  const runtime = new McpProjectRuntime(root, { debounceMs: 1 })
  await runtime.start()
  try {
    const pinned = runtime.engine.readGeneration().generation
    fs.writeFileSync(path.join(root, 'src', 'consumer.ts'), 'export function read(){ return 0 }\n')
    runtime.queue.push({ type: 'change', path: 'src/consumer.ts' })

    const rows = []
    for await (const row of runtime.engine.query({ type: 'refs', name: 'value', generation: pinned })) rows.push(row)
    const overlay = runtime.engine.store.readOverlay(pinned)

    assert.deepEqual({ rows: rows.map(({ call, line }) => ({ call, line })), overlayGeneration: overlay.generation }, { rows: [{ call: false, line: 2 }], overlayGeneration: pinned })
  } finally {
    await runtime.close()
  }
})

test('error guessing: runtime close disposes the warm engine workspace as well as watcher and queue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-dispose-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  let disposed = 0
  const runtime = new McpProjectRuntime(root, { engine: { policy: (await import('../source-policy.mjs')).createSourcePolicy(root), reconcile: async () => {}, incremental: async () => {}, dispose: async () => { disposed += 1 } } })
  await runtime.start()

  await runtime.close()

  assert.deepEqual({ disposed, queueClosed: runtime.queue.closed }, { disposed: 1, queueClosed: true })
})

test('combinatorial watcher policy: unlink accepts only a previously registered source while ignored and non-source paths stay excluded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-unlink-policy-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'src', 'known.ts'), 'export const known = 1\n')
  const batches = []
  const runtime = new McpProjectRuntime(root, { debounceMs: 1, engine: { policy: (await import('../source-policy.mjs')).createSourcePolicy(root), reconcile: async () => {}, incremental: async (events) => { batches.push(events) }, registeredFiles: () => new Set(['src/known.ts']) } })
  await runtime.start()
  runtime.enqueue('unlink', path.join(root, 'src', 'known.ts'))
  runtime.enqueue('unlink', path.join(root, 'src', 'notes.txt'))
  runtime.enqueue('unlink', path.join(root, 'node_modules', 'ignored.ts'))
  await runtime.queue.idle()

  await runtime.close()

  assert.deepEqual(batches, [[{ type: 'unlink', path: 'src/known.ts' }]])
})

test('domain analysis: watcher add then unlink for a previously unregistered source coalesces to an absent final state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-add-unlink-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  const batches = []
  const runtime = new McpProjectRuntime(root, { debounceMs: 5, engine: { policy: (await import('../source-policy.mjs')).createSourcePolicy(root), reconcile: async () => {}, incremental: async (events) => { batches.push(events) }, registeredFiles: () => new Set() } })
  await runtime.start()

  runtime.enqueue('add', path.join(root, 'src', 'new.ts'))
  runtime.enqueue('unlink', path.join(root, 'src', 'new.ts'))
  await runtime.queue.idle()
  await runtime.close()

  assert.deepEqual(batches, [])
})

test('domain analysis: watcher unlink then add for a previously unregistered source coalesces to an added final state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-unlink-add-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  const batches = []
  const runtime = new McpProjectRuntime(root, { debounceMs: 5, engine: { policy: (await import('../source-policy.mjs')).createSourcePolicy(root), reconcile: async () => {}, incremental: async (events) => { batches.push(events) }, registeredFiles: () => new Set() } })
  await runtime.start()

  runtime.enqueue('unlink', path.join(root, 'src', 'new.ts'))
  runtime.enqueue('add', path.join(root, 'src', 'new.ts'))
  await runtime.queue.idle()
  await runtime.close()

  assert.deepEqual(batches, [[{ type: 'add', path: 'src/new.ts' }]])
})

test('error guessing: a timer-triggered build rejection is reported once without an unhandled rejection and idle remains settleable', async () => {
  const failure = new Error('incremental build rejected')
  const reported = []
  const unhandled = []
  const onUnhandled = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  const queue = new DebouncedBuildQueue(async () => { throw failure }, { debounceMs: 1, onError: (error) => { reported.push(error) } })
  try {
    queue.push({ type: 'change', path: 'src/a.ts' })

    await Promise.race([queue.idle(), new Promise((_, reject) => setTimeout(() => reject(new Error('idle did not settle after rejected build')), 100))])
    await queue.close()

    assert.deepEqual({ reported, unhandled, closed: queue.closed }, { reported: [failure], unhandled: [], closed: true })
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('error guessing: runtime close waits for asynchronous engine disposal before it settles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-await-dispose-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  let releaseDispose = () => {}
  let closeSettled = false
  const runtime = new McpProjectRuntime(root, { engine: { policy: (await import('../source-policy.mjs')).createSourcePolicy(root), reconcile: async () => {}, incremental: async () => {}, dispose: async () => { await new Promise((resolve) => { releaseDispose = resolve }) } } })
  await runtime.start()

  const closing = runtime.close().then(() => { closeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeDispose = closeSettled
  releaseDispose()
  await closing

  assert.deepEqual({ settledBeforeDispose, settledAfterDispose: closeSettled }, { settledBeforeDispose: false, settledAfterDispose: true })
})

test('error guessing: native watcher EMFILE falls back to polling, forwards changes, and closes both watchers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-watch-fallback-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1\n')
  const nativeWatcher = new EventEmitter()
  const fallbackWatcher = new EventEmitter()
  let nativeClosed = 0
  let fallbackClosed = 0
  let fallbackOptions
  const batches = []
  nativeWatcher.close = () => { nativeClosed += 1 }
  fallbackWatcher.close = async () => { fallbackClosed += 1 }
  const runtime = new McpProjectRuntime(root, {
    debounceMs: 1,
    engine: {
      policy: (await import('../source-policy.mjs')).createSourcePolicy(root),
      reconcile: async () => {},
      incremental: async (events) => { batches.push(events) },
      registeredFiles: () => new Set(['src/value.ts']),
    },
    nativeWatch: () => nativeWatcher,
    fallbackWatch: (_root, options) => { fallbackOptions = options; return fallbackWatcher },
  })
  await runtime.start()

  nativeWatcher.emit('error', Object.assign(new Error('watch resource exhausted'), { code: 'EMFILE' }))
  await new Promise((resolve) => setImmediate(resolve))
  fallbackWatcher.emit('change', path.join(root, 'src', 'value.ts'))
  await runtime.queue.idle()
  await runtime.close()

  assert.deepEqual(
    {
      fallbackOptions: { persistent: fallbackOptions.persistent, ignoreInitial: fallbackOptions.ignoreInitial, followSymlinks: fallbackOptions.followSymlinks, usePolling: fallbackOptions.usePolling, ignored: typeof fallbackOptions.ignored },
      batches,
      nativeClosed,
      fallbackClosed,
      queueClosed: runtime.queue.closed,
    },
    { fallbackOptions: { persistent: true, ignoreInitial: true, followSymlinks: false, usePolling: true, ignored: 'function' }, batches: [[{ type: 'change', path: 'src/value.ts' }]], nativeClosed: 1, fallbackClosed: 1, queueClosed: true },
  )
})
