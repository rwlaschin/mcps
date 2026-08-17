import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { availableParallelism } from 'node:os'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ParserApartmentPool } from '../parser-apartment-pool.mjs'

class FakeWorker extends EventEmitter {
  constructor(workerData) { super(); this.workerData = workerData; this.messages = []; this.terminated = 0 }
  postMessage(message) { this.messages.push(message) }
  terminate() { this.terminated += 1; return Promise.resolve(0) }
}

test('boundary value: omitted worker count reports available parallelism minus one without eagerly constructing workers', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })

  assert.deepEqual({ snapshot: pool.snapshot(), constructed: workers.length }, { snapshot: { workerCount: Math.max(0, availableParallelism() - 1), queued: 0, inFlight: 0, latestRevisionByFile: {} }, constructed: 0 })
  await pool.dispose()
})

test('boundary and domain analysis: configured worker ceiling scales only to concurrent demand and sequential work reuses existing apartments', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 7, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })

  const first = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  assert.deepEqual({ constructed: workers.length, snapshot: pool.snapshot() }, { constructed: 1, snapshot: { workerCount: 7, queued: 0, inFlight: 1, latestRevisionByFile: { 'file-a': 1 } } })
  const second = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })
  assert.deepEqual({ constructed: workers.length, snapshot: pool.snapshot() }, { constructed: 2, snapshot: { workerCount: 7, queued: 0, inFlight: 2, latestRevisionByFile: { 'file-a': 1, 'file-b': 1 } } })
  workers[0].emit('message', { type: 'result', requestId: 1, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts', digest: 'a' } })
  workers[1].emit('message', { type: 'result', requestId: 2, fileId: 'file-b', revision: 1, parsed: { file: 'src/b.ts', digest: 'b' } })
  await Promise.all([first, second])

  const third = pool.parse({ path: 'src/c.ts', fileId: 'file-c', revision: 1 })
  assert.equal(workers.length, 2)
  workers[0].emit('message', { type: 'result', requestId: 3, fileId: 'file-c', revision: 1, parsed: { file: 'src/c.ts', digest: 'c' } })
  await third
  const fourth = pool.parse({ path: 'src/d.ts', fileId: 'file-d', revision: 1 })
  assert.equal(workers.length, 2)
  workers[0].emit('message', { type: 'result', requestId: 4, fileId: 'file-d', revision: 1, parsed: { file: 'src/d.ts', digest: 'd' } })

  assert.deepEqual({ digest: (await fourth).digest, constructed: workers.length, messages: workers.map(({ messages }) => messages.map(({ fileId }) => fileId)) }, { digest: 'd', constructed: 2, messages: [['file-a', 'file-c', 'file-d'], ['file-b']] })
  await pool.dispose()
})

test('boundary value: zero workers parses synchronously from disk without constructing a worker', async () => {
  let workerConstructions = 0
  const pool = new ParserApartmentPool('/repo', { workerCount: 0, workerFactory: () => { workerConstructions += 1 }, readFileSync: (file) => file === '/repo/src/a.ts' ? 'export const a = 1\n' : assert.fail(`unexpected path ${file}`) })

  const parsed = await pool.parse({ path: 'src/../src/a.ts', fileId: 'file-a', revision: 1 })

  assert.deepEqual({ workerConstructions, file: parsed.file, names: parsed.symbols.map(({ name }) => name), snapshot: pool.snapshot() }, { workerConstructions: 0, file: 'src/a.ts', names: ['a'], snapshot: { workerCount: 0, queued: 0, inFlight: 0, latestRevisionByFile: { 'file-a': 1 } } })
  await pool.dispose()
})

test('equivalence partition: worker messages contain only normalized path file identity and revision while root is supplied once in worker data', async () => {
  let worker
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { worker = new FakeWorker(options.workerData); return worker } })

  const pending = pool.parse({ path: 'src/../src/a.ts', fileId: 'file-a', revision: 7 })
  assert.deepEqual({ workerData: worker.workerData, message: worker.messages[0] }, { workerData: { root: '/repo' }, message: { type: 'parse', requestId: 1, path: 'src/a.ts', fileId: 'file-a', revision: 7 } })
  worker.emit('message', { type: 'result', requestId: 1, path: 'src/a.ts', fileId: 'file-a', revision: 7, parsed: { file: 'src/a.ts', digest: 'digest-7', symbols: [], imports: [], namespaces: [], reexports: [], calls: [], stateHash: 7, sourceBytes: 19, nodeCount: 5 } })
  await pending
  await pool.dispose()
})

test('domain analysis: the same file keeps stable worker affinity while another file can use the other worker', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 2, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })

  const a1 = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  const b1 = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })
  workers[0].emit('message', { type: 'result', requestId: 1, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts' } })
  workers[1].emit('message', { type: 'result', requestId: 2, fileId: 'file-b', revision: 1, parsed: { file: 'src/b.ts' } })
  await Promise.all([a1, b1])
  const a2 = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 2 })

  assert.deepEqual(workers.map(({ messages }) => messages.map(({ fileId, revision }) => ({ fileId, revision }))), [[{ fileId: 'file-a', revision: 1 }, { fileId: 'file-a', revision: 2 }], [{ fileId: 'file-b', revision: 1 }]])
  workers[0].emit('message', { type: 'result', requestId: 3, fileId: 'file-a', revision: 2, parsed: { file: 'src/a.ts' } })
  await a2
  await pool.dispose()
})

test('error guessing: a newer revision supersedes an in-flight parse and the stale result resolves null', async () => {
  let worker
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { worker = new FakeWorker(options.workerData); return worker } })
  const stale = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  const latest = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 2 })

  worker.emit('message', { type: 'result', requestId: 1, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts', digest: 'stale' } })
  worker.emit('message', { type: 'result', requestId: 2, fileId: 'file-a', revision: 2, parsed: { file: 'src/a.ts', digest: 'latest' } })

  assert.deepEqual({ stale: await stale, latestDigest: (await latest).digest, snapshot: pool.snapshot() }, { stale: null, latestDigest: 'latest', snapshot: { workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: { 'file-a': 2 } } })
  await pool.dispose()
})

test('error guessing: a worker crash rejects in-flight work and its replacement serves future work', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })
  const current = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  workers[0].emit('error', new Error('parser channel failed'))

  await assert.rejects(current, /parser channel failed|worker.*unavailable|closed/i)
  const future = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })
  workers[1].emit('message', { type: 'result', requestId: 2, fileId: 'file-b', revision: 1, parsed: { file: 'src/b.ts', digest: 'replacement' } })
  assert.equal((await future).digest, 'replacement')
  await pool.dispose()
})

test('error guessing: a timed out parse rejects and clears observable in-flight work', async () => {
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, timeoutMs: 5, workerFactory: (_url, options) => new FakeWorker(options.workerData) })

  await assert.rejects(pool.parse({ path: 'src/slow.ts', fileId: 'file-slow', revision: 1 }), /timed out|timeout/i)

  assert.deepEqual(pool.snapshot(), { workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: { 'file-slow': 1 } })
  await pool.dispose()
})

test('error guessing: disposal rejects queued and in-flight parses and terminates every worker exactly once', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })
  const current = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  const queued = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })

  await pool.dispose()

  await assert.rejects(current, /disposed|closed/i)
  await assert.rejects(queued, /disposed|closed/i)
  assert.deepEqual({ terminated: workers[0].terminated, snapshot: pool.snapshot() }, { terminated: 1, snapshot: { workerCount: 0, queued: 0, inFlight: 0, latestRevisionByFile: { 'file-a': 1, 'file-b': 1 } } })
})

test('observability benchmark: persistent worker startup and reuse report measured duration without a flaky hard-wall gate', async (t) => {
  let worker
  let workerConstructions = 0
  const started = performance.now()
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { workerConstructions += 1; worker = new FakeWorker(options.workerData); return worker } })
  const first = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  worker.emit('message', { type: 'result', requestId: 1, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts' } })
  await first
  const second = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })
  worker.emit('message', { type: 'result', requestId: 2, fileId: 'file-b', revision: 1, parsed: { file: 'src/b.ts' } })
  await second
  const elapsedMs = performance.now() - started

  assert.deepEqual({ workerConstructions, messages: worker.messages.length, snapshot: pool.snapshot() }, { workerConstructions: 1, messages: 2, snapshot: { workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: { 'file-a': 1, 'file-b': 1 } } })
  t.diagnostic(`parser apartment startup plus two dispatches: ${elapsedMs.toFixed(3)}ms`)
  await pool.dispose()
})

test('equivalence partition: non-finite and negative worker counts are rejected instead of silently changing concurrency', () => {
  assert.throws(() => new ParserApartmentPool('/repo', { workerCount: Number.NaN }), /workerCount.*finite|invalid/i)
  assert.throws(() => new ParserApartmentPool('/repo', { workerCount: Number.POSITIVE_INFINITY }), /workerCount.*finite|invalid/i)
  assert.throws(() => new ParserApartmentPool('/repo', { workerCount: -1 }), /workerCount.*non-negative|invalid/i)
})

test('error guessing: a late timed-out response cannot satisfy a retry with the same file and revision', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, timeoutMs: 5, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })
  const timedOut = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  await assert.rejects(timedOut, /timed out|timeout/i)
  const retry = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })

  workers[0].emit('message', { type: 'result', requestId: 1, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts', digest: 'late' } })
  assert.equal(pool.snapshot().inFlight, 1)
  workers[1].emit('message', { type: 'result', requestId: 2, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts', digest: 'retry' } })

  assert.equal((await retry).digest, 'retry')
  await pool.dispose()
})

test('error guessing: one apartment crash is replaced without poisoning a healthy apartment', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 2, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })
  const failed = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  const healthy = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })
  workers[0].emit('error', new Error('apartment zero crashed'))
  workers[1].emit('message', { type: 'result', requestId: 2, fileId: 'file-b', revision: 1, parsed: { file: 'src/b.ts', digest: 'healthy' } })

  await assert.rejects(failed, /apartment zero crashed/)
  assert.equal((await healthy).digest, 'healthy')
  const replacement = pool.parse({ path: 'src/c.ts', fileId: 'file-c', revision: 1 })
  workers[2].emit('message', { type: 'result', requestId: 3, fileId: 'file-c', revision: 1, parsed: { file: 'src/c.ts', digest: 'replacement' } })
  assert.equal((await replacement).digest, 'replacement')
  await pool.dispose()
})

test('error guessing: an unexpected clean worker exit rejects active work and its replacement serves a future request', async () => {
  const workers = []
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { const worker = new FakeWorker(options.workerData); workers.push(worker); return worker } })
  const active = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })

  workers[0].emit('exit', 0)

  await assert.rejects(active, /worker.*exit|exited.*0|unavailable/i)
  const future = pool.parse({ path: 'src/b.ts', fileId: 'file-b', revision: 1 })
  workers[1].emit('message', { type: 'result', requestId: 2, fileId: 'file-b', revision: 1, parsed: { file: 'src/b.ts', digest: 'replacement-after-clean-exit' } })
  assert.equal((await future).digest, 'replacement-after-clean-exit')
  await pool.dispose()
})

test('error guessing: zero-worker fallback rejects a symbolic-link escape before reading bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parser-symlink-root-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parser-symlink-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1\n')
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked.ts'))
  const pool = new ParserApartmentPool(root, { workerCount: 0 })

  await assert.rejects(pool.parse({ path: 'linked.ts', fileId: 'linked', revision: 1 }), /symbolic link|symlink|escapes root/i)
  await pool.dispose()
})

test('domain analysis: unlink release clears retained worker state affinity and latest revision metadata', async () => {
  let worker
  const pool = new ParserApartmentPool('/repo', { workerCount: 1, workerFactory: (_url, options) => { worker = new FakeWorker(options.workerData); return worker } })
  const parsed = pool.parse({ path: 'src/a.ts', fileId: 'file-a', revision: 1 })
  worker.emit('message', { type: 'result', requestId: 1, fileId: 'file-a', revision: 1, parsed: { file: 'src/a.ts', digest: 'one' } })
  await parsed

  await pool.release({ path: 'src/a.ts', fileId: 'file-a' })

  assert.deepEqual({ releaseMessage: worker.messages[1], snapshot: pool.snapshot() }, { releaseMessage: { type: 'release', path: 'src/a.ts', fileId: 'file-a' }, snapshot: { workerCount: 1, queued: 0, inFlight: 0, latestRevisionByFile: {} } })
  await pool.dispose()
})
