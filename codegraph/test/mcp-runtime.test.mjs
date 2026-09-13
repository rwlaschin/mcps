import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { DebouncedBuildQueue, McpProjectRuntime } from '../mcp-runtime.mjs'
import { DaemonQueryEngine } from '../daemon-query-engine.mjs'

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

test('polling fallback reconciles a mutation absorbed before ready and reports reconciliation failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-fallback-reconcile-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  const nativeWatcher = new EventEmitter()
  nativeWatcher.close = () => {}
  const fallbackWatcher = new EventEmitter()
  fallbackWatcher.close = () => {}
  const errors = []
  const reconciledStates = []
  let mutated = false
  const runtime = new McpProjectRuntime(root, {
    engine: {
      policy: (await import('../source-policy.mjs')).createSourcePolicy(root),
      reconcile: async () => { reconciledStates.push(mutated); if (reconciledStates.length === 2) throw new Error('fallback reconcile failed') },
      incremental: async () => {},
      registeredFiles: () => new Set(),
      dispose: async () => {},
    },
    nativeWatch: () => nativeWatcher,
    fallbackWatch: () => fallbackWatcher,
    onError: (error) => errors.push(error.message),
  })

  await runtime.start()
  mutated = true
  nativeWatcher.emit('error', new Error('EMFILE: too many open files, watch'))
  fallbackWatcher.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual({ reconciledStates, errors }, { reconciledStates: [false, true], errors: ['EMFILE: too many open files, watch', 'fallback reconcile failed'] })
  await runtime.close()
})

test('domain analysis: first and later explicit indexes each perform one semantic build and return that build receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-explicit-index-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  let builds = 0
  let reconciles = 0
  const runtime = new McpProjectRuntime(root, {
    engine: {
      policy: (await import('../source-policy.mjs')).createSourcePolicy(root),
      reconcile: async () => { reconciles += 1; return { generation: 'unexpected-reconcile' } },
      build: async () => { builds += 1; return builds === 1 ? { generation: 'generation-1', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] } : { generation: 'generation-2', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] } },
      incremental: async () => {},
      dispose: async () => {},
    },
  })

  const first = await runtime.index()
  const second = await runtime.index()
  await runtime.close()

  assert.deepEqual(
    { builds, reconciles, first, second, queueClosed: runtime.queue.closed },
    {
      builds: 2,
      reconciles: 0,
      first: { generation: 'generation-1', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] },
      second: { generation: 'generation-2', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] },
      queueClosed: true,
    },
  )
})

test('domain analysis: an unindexed default root remains unbuilt until its first explicit index performs the only build', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-default-unindexed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  const loader = path.join(root, 'runtime-loader.mjs')
  const driver = path.join(root, 'driver.mjs')
  fs.writeFileSync(loader, `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/mcp-runtime.mjs')) return { format: 'module', shortCircuit: true, source: \`
    let builds = 0
    export class McpProjectRuntime {
      async start() { builds += 1; process.stderr.write('semantic-build:' + builds + '\\\\n'); return this }
      async index() { builds += 1; process.stderr.write('semantic-build:' + builds + '\\\\n'); return { generation: 'generation-' + builds, parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] } }
      async close() {}
    }
  \` }
  return nextLoad(url, context)
}
`)
  fs.writeFileSync(driver, `
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', ${JSON.stringify(loader)}, ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'mcp-server.mjs'))}], { env: { ...process.env, CODEGRAPH_ROOT: ${JSON.stringify(root)} }, stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = ''; let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })
await new Promise((resolve) => setTimeout(resolve, 100))
child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_index', arguments: { root: ${JSON.stringify(root)} } } }) + '\\n')
await once(child, 'exit')
process.stdout.write(JSON.stringify({ stdout, stderr }))
`)

  const execution = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 5_000 })
  const observed = JSON.parse(execution.stdout)
  const response = JSON.parse(observed.stdout.trim())

  assert.deepEqual(
    { status: execution.status, builds: observed.stderr, receipt: JSON.parse(response.result.content[0].text) },
    { status: 0, builds: 'semantic-build:1\n', receipt: { generation: 'generation-1', parsedFiles: ['one.ts'], validatedFiles: ['one.ts'] } },
  )
})

test('ownership boundary: the MCP runtime creates the worker-owned engine path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-worker-owner-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')

  const runtime = new McpProjectRuntime(root)

  assert.ok(runtime.engine.validationWorker)
  return runtime.engine.dispose()
})

test('ownership boundary: the MCP runtime preserves an injected engine without replacing its policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-injected-owner-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  const injected = { policy: (await import('../source-policy.mjs')).createSourcePolicy(root), reconcile: async () => {}, incremental: async () => {}, dispose: async () => {} }

  const runtime = new McpProjectRuntime(root, { engine: injected })

  assert.equal(runtime.engine, injected)
})

test('ownership boundary: mmap-only daemon queries create the engine without mode options', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mmap-owner-'))
  fs.mkdirSync(path.join(root, '.codegraph'))
  let requestedOptions
  const query = new DaemonQueryEngine(root, {
    cacheFactory: () => ({ acquire: () => null, dispose: () => {} }),
    engineFactory: async (options) => { requestedOptions = options; return { queryBatch: async () => [], dispose: async () => {} } },
  })

  await query.queryBatch({ type: 'symbols', name: 'missing' })
  await query.dispose()

  assert.equal(requestedOptions, undefined)
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

test('error guessing: runtime close disposes the warm engine as well as watcher and queue', async () => {
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
