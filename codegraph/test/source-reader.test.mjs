import test from 'node:test'
import assert from 'node:assert/strict'
import { readSources } from '../source-reader.mjs'

test('equivalence partition: reads exactly the relative files returned by the source policy scan', async () => {
  const calls = []
  const policy = { scan: () => ['src/a.ts', 'src/b.ts'] }

  const result = await readSources('/repo', policy, {
    readFile: async (file, encoding) => { calls.push([file, encoding]); return file.endsWith('a.ts') ? 'alpha' : 'beta' },
    now: () => 10n,
  })

  assert.deepEqual(
    { calls, entries: [...result.sources], stats: result.stats },
    { calls: [['/repo/src/a.ts', 'utf8'], ['/repo/src/b.ts', 'utf8']], entries: [['src/a.ts', 'alpha'], ['src/b.ts', 'beta']], stats: { filesRead: 2, bytesRead: 9, readMs: 0, readConcurrency: 16, peakReads: 2 } },
  )
})

test('boundary value: an empty policy scan performs no reads and reports zero activity', async () => {
  let readCalls = 0

  const result = await readSources('/repo', { scan: () => [] }, {
    readFile: async () => { readCalls += 1; return 'unexpected' },
    now: () => 10n,
  })

  assert.deepEqual({ entries: [...result.sources], stats: result.stats, readCalls }, { entries: [], stats: { filesRead: 0, bytesRead: 0, readMs: 0, readConcurrency: 16, peakReads: 0 }, readCalls: 0 })
})

test('boundary value: concurrency one schedules only one read until that read settles', async () => {
  const started = []
  let releaseFirst
  const first = new Promise((resolve) => { releaseFirst = resolve })
  const reading = readSources('/repo', { scan: () => ['a.ts', 'b.ts'] }, {
    concurrency: 1,
    readFile: async (file) => { started.push(file); if (file === '/repo/a.ts') await first; return file },
    now: () => 10n,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['/repo/a.ts'])
  releaseFirst()
  await reading
})

test('boundary value: concurrency 128 permits all 128 reads to be in flight', async () => {
  let active = 0
  let peak = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const files = Array.from({ length: 128 }, (_, index) => `src/${index}.ts`)
  const reading = readSources('/repo', { scan: () => files }, {
    concurrency: 128,
    readFile: async () => { active += 1; peak = Math.max(peak, active); await gate; active -= 1; return 'x' },
    now: () => 10n,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peak, 128)
  release()
  await reading
})

test('boundary value: concurrency two is accepted one above the minimum', async () => {
  const result = await readSources('/repo', { scan: () => [] }, { concurrency: 2 })

  assert.equal(result.stats.readConcurrency, 2)
})

test('boundary value: concurrency 127 is accepted one below the maximum', async () => {
  const result = await readSources('/repo', { scan: () => [] }, { concurrency: 127 })

  assert.equal(result.stats.readConcurrency, 127)
})

test('equivalence partition: concurrency zero is rejected before scanning or reading', async () => {
  let scanCalls = 0

  await assert.rejects(readSources('/repo', { scan: () => { scanCalls += 1; return [] } }, { concurrency: 0 }), { message: 'read concurrency must be an integer from 1 to 128' })

  assert.equal(scanCalls, 0)
})

test('equivalence partition: concurrency 129 is rejected', async () => {
  await assert.rejects(readSources('/repo', { scan: () => [] }, { concurrency: 129 }), { message: 'read concurrency must be an integer from 1 to 128' })
})

test('equivalence partition: a noninteger concurrency is rejected', async () => {
  await assert.rejects(readSources('/repo', { scan: () => [] }, { concurrency: 1.5 }), { message: 'read concurrency must be an integer from 1 to 128' })
})

test('equivalence partition: null concurrency is rejected instead of being coerced to zero or a default', async () => {
  await assert.rejects(readSources('/repo', { scan: () => [] }, { concurrency: null }), { message: 'read concurrency must be an integer from 1 to 128' })
})

test('equivalence partition: numeric-string concurrency is rejected instead of being coerced', async () => {
  await assert.rejects(readSources('/repo', { scan: () => [] }, { concurrency: '16' }), { message: 'read concurrency must be an integer from 1 to 128' })
})

test('error guessing: completion order cannot change source Map order', async () => {
  const releases = new Map()
  const reading = readSources('/repo', { scan: () => ['a.ts', 'b.ts', 'c.ts'] }, {
    concurrency: 3,
    readFile: (file) => new Promise((resolve) => releases.set(file, resolve)),
    now: () => 10n,
  })

  await new Promise((resolve) => setImmediate(resolve))
  releases.get('/repo/c.ts')('charlie')
  releases.get('/repo/b.ts')('bravo')
  releases.get('/repo/a.ts')('alpha')

  assert.deepEqual([...((await reading).sources)], [['a.ts', 'alpha'], ['b.ts', 'bravo'], ['c.ts', 'charlie']])
})

test('domain analysis: a failed read stops new scheduling, waits for in-flight reads, and rethrows the original error object', async () => {
  const firstFailure = new Error('first indexed file failed')
  const started = []
  let releaseSecond
  let secondSettled = false
  const second = new Promise((resolve) => { releaseSecond = () => { secondSettled = true; resolve('bravo') } })
  const reading = readSources('/repo', { scan: () => ['a.ts', 'b.ts', 'c.ts'] }, {
    concurrency: 2,
    readFile: async (file) => { started.push(file); if (file === '/repo/a.ts') throw firstFailure; return second },
    now: () => 10n,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual({ started, secondSettled }, { started: ['/repo/a.ts', '/repo/b.ts'], secondSettled: false })
  releaseSecond()
  await assert.rejects(reading, (error) => error === firstFailure)
})

test('domain analysis: concurrent failures rethrow the lowest scan-index error regardless of rejection order', async () => {
  const lowestIndexFailure = new Error('a failed later')
  const higherIndexFailure = new Error('b failed first')
  let rejectA
  let rejectB
  const reading = readSources('/repo', { scan: () => ['a.ts', 'b.ts'] }, {
    concurrency: 2,
    readFile: (file) => new Promise((resolve, reject) => { if (file === '/repo/a.ts') rejectA = reject; else rejectB = reject }),
    now: () => 10n,
  })

  await new Promise((resolve) => setImmediate(resolve))
  rejectB(higherIndexFailure)
  rejectA(lowestIndexFailure)

  await assert.rejects(reading, (error) => error === lowestIndexFailure)
})

test('error guessing: UTF-8 byte accounting counts multibyte source bytes rather than JavaScript characters', async () => {
  const readings = [1000000n, 4000000n]

  const result = await readSources('/repo', { scan: () => ['emoji.ts'] }, {
    concurrency: 1,
    readFile: async () => '😀',
    now: () => readings.shift(),
  })

  assert.deepEqual(result.stats, { filesRead: 1, bytesRead: 4, readMs: 3, readConcurrency: 1, peakReads: 1 })
})

test('regression: disabled measurement reads sources without touching the clock or accumulating observer counters', async () => {
  let clockCalls = 0

  const result = await readSources('/repo', { scan: () => ['a.ts'] }, {
    measure: false,
    readFile: async () => 'export const a = "😀"\n',
    now: () => { clockCalls += 1; throw new Error('disabled measurement touched the clock') },
  })

  assert.deepEqual(
    { entries: [...result.sources], stats: result.stats, clockCalls },
    { entries: [['a.ts', 'export const a = "😀"\n']], stats: { filesRead: 0, bytesRead: 0, readMs: 0, readConcurrency: 16, peakReads: 0 }, clockCalls: 0 },
  )
})
