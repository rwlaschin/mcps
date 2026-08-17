import test from 'node:test'
import assert from 'node:assert/strict'
import * as incrementalResolver from '../incremental-resolver.mjs'

const createParseDiagnosticsCollector = (...args) => incrementalResolver.createParseDiagnosticsCollector(...args)

test('boundary value: a fresh parse taking exactly the default 8 milliseconds contributes to aggregate totals without retaining a detailed event', () => {
  const readings = [100, 108]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 1000, rss: 4000 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const token = collector.begin({ file: '/repo/src/fast.ts', root: '/repo', sourceHash: 'fast-hash', sourceBytes: 20, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 7 })
  collector.end(token, { parseCount: 1, extractCount: 2, nodeCount: 3 })

  assert.deepEqual(collector.snapshot(), {
    aggregate: { parses: 1, wallMs: 8, parseCount: 1, extractCount: 2, nodeCount: 3 },
    events: [],
  })
})

test('boundary value: a fresh parse just over the default 8 milliseconds is retained without severe classification', () => {
  const readings = [0, 8.001]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const token = collector.begin({ file: '/repo/src/just-slow.ts', root: '/repo', sourceHash: 'just-slow', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 1 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })

  assert.deepEqual(collector.snapshot().events.map(({ file, wallMs, severe }) => ({ file, wallMs, severe })), [
    { file: 'src/just-slow.ts', wallMs: 8.001, severe: false },
  ])
})

test('boundary value: a fresh parse taking exactly 50 milliseconds is retained without severe classification', () => {
  const readings = [100, 150]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const token = collector.begin({ file: '/repo/src/not-severe.ts', root: '/repo', sourceHash: 'not-severe', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 2 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })

  assert.deepEqual(collector.snapshot().events.map(({ file, wallMs, severe }) => ({ file, wallMs, severe })), [
    { file: 'src/not-severe.ts', wallMs: 50, severe: false },
  ])
})

test('boundary value: a fresh parse just over 50 milliseconds is retained with severe classification', () => {
  const readings = [0, 50.001]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const token = collector.begin({ file: '/repo/src/severe.ts', root: '/repo', sourceHash: 'severe', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 3 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })

  assert.deepEqual(collector.snapshot().events.map(({ file, wallMs, severe }) => ({ file, wallMs, severe })), [
    { file: 'src/severe.ts', wallMs: 50.001, severe: true },
  ])
})

test('boundary value: a parse taking exactly 50 milliseconds is aggregate-only because the slow threshold is strict', () => {
  const readings = [10, 60]
  const collector = createParseDiagnosticsCollector({ enabled: true, thresholdMs: 50, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 10, rss: 20 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const token = collector.begin({ file: '/repo/src/boundary.ts', root: '/repo', sourceHash: 'boundary-hash', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: true, iteration: 0 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })

  assert.deepEqual(collector.snapshot().events, [])
})

test('boundary value: a parse just over 50 milliseconds retains complete repository-relative diagnostics', () => {
  const readings = [10, 60.001]
  const cpuReadings = [{ user: 1000, system: 2000 }, { user: 21000, system: 7000 }]
  const memoryReadings = [{ heapUsed: 1000, rss: 5000 }, { heapUsed: 1600, rss: 6200 }]
  const resourceReadings = [
    { voluntaryContextSwitches: 2, involuntaryContextSwitches: 3, minorPageFault: 5, majorPageFault: 7 },
    { voluntaryContextSwitches: 13, involuntaryContextSwitches: 20, minorPageFault: 28, majorPageFault: 38 },
  ]
  const collector = createParseDiagnosticsCollector({ enabled: true, thresholdMs: 50, now: () => readings.shift(), cpuUsage: () => cpuReadings.shift(), memoryUsage: () => memoryReadings.shift(), resourceUsage: () => resourceReadings.shift() })

  const token = collector.begin({ file: '/repo/src/привет🐉.tsx', root: '/repo', sourceHash: 'abc123', sourceBytes: 81, sourceLines: 4, scriptKind: 'TSX', cache: 'miss', warmup: false, iteration: 9 })
  collector.end(token, { parseCount: 2, extractCount: 5, nodeCount: 13 })

  assert.deepEqual(collector.snapshot().events, [{
    file: 'src/привет🐉.tsx', sourceHash: 'abc123', sourceBytes: 81, sourceLines: 4, scriptKind: 'TSX',
    wallMs: 50.001, cpuUserMs: 20, cpuSystemMs: 5, unaccountedMs: 25.001,
    heapDeltaBytes: 600, rssDeltaBytes: 1200,
    voluntaryContextSwitches: 11, involuntaryContextSwitches: 17, minorPageFaults: 23, majorPageFaults: 31,
    parseCount: 2, extractCount: 5, nodeCount: 13, gc: [], cache: 'miss', warmup: false, iteration: 9, severe: true,
  }])
})

test('domain analysis: unaccounted time is clamped to zero when measured CPU exceeds wall time', () => {
  const readings = [0, 60]
  const cpuReadings = [{ user: 0, system: 0 }, { user: 50000, system: 30000 }]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => cpuReadings.shift(), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const token = collector.begin({ file: '/repo/src/cpu.ts', root: '/repo', sourceHash: 'cpu', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 1 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })

  assert.equal(collector.snapshot().events[0].unaccountedMs, 0)
})

test('error guessing: only GC entries overlapping the parse interval are attached and overlap duration is clipped to the interval', () => {
  const readings = [100, 160]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })
  collector.recordGc({ startTime: 90, duration: 5, kind: 1 })
  collector.recordGc({ startTime: 95, duration: 10, kind: 2 })
  collector.recordGc({ startTime: 120, duration: 10, kind: 4 })
  collector.recordGc({ startTime: 155, duration: 10, kind: 8 })
  collector.recordGc({ startTime: 160, duration: 5, kind: 16 })

  const token = collector.begin({ file: '/repo/src/gc.ts', root: '/repo', sourceHash: 'gc', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 2 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })

  assert.deepEqual(collector.snapshot().events[0].gc, [
    { startTime: 95, duration: 10, overlapMs: 5, kind: 2 },
    { startTime: 120, duration: 10, overlapMs: 10, kind: 4 },
    { startTime: 155, duration: 10, overlapMs: 5, kind: 8 },
  ])
})

test('error guessing: a late GC entry attaches to the retained overlapping slow event while an evicted event retains no obsolete GC bookkeeping', () => {
  const readings = [0, 60, 100, 160]
  const collector = createParseDiagnosticsCollector({ enabled: true, capacity: 1, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const evicted = collector.begin({ file: '/repo/src/evicted.ts', root: '/repo', sourceHash: 'evicted', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: true, iteration: 0 })
  collector.end(evicted, { parseCount: 1, extractCount: 1, nodeCount: 1 })
  const retained = collector.begin({ file: '/repo/src/retained.ts', root: '/repo', sourceHash: 'retained', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 1 })
  collector.end(retained, { parseCount: 1, extractCount: 1, nodeCount: 1 })
  collector.recordGc({ startTime: 55, duration: 10, kind: 2 })
  collector.recordGc({ startTime: 155, duration: 10, kind: 4 })

  assert.deepEqual(collector.snapshot().events.map(({ file, gc }) => ({ file, gc })), [{
    file: 'src/retained.ts',
    gc: [{ startTime: 155, duration: 10, overlapMs: 5, kind: 4 }],
  }])
})

test('boundary values: a capacity-two ring evicts only the oldest slow event while aggregate totals retain all three parses', () => {
  const readings = [0, 51, 100, 152, 200, 253]
  const collector = createParseDiagnosticsCollector({ enabled: true, capacity: 2, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })

  const first = collector.begin({ file: '/repo/first.ts', root: '/repo', sourceHash: 'first', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: true, iteration: 0 })
  collector.end(first, { parseCount: 1, extractCount: 2, nodeCount: 3 })
  const second = collector.begin({ file: '/repo/second.ts', root: '/repo', sourceHash: 'second', sourceBytes: 1, sourceLines: 1, scriptKind: 'JS', cache: 'miss', warmup: false, iteration: 1 })
  collector.end(second, { parseCount: 4, extractCount: 5, nodeCount: 6 })
  const third = collector.begin({ file: '/repo/third.ts', root: '/repo', sourceHash: 'third', sourceBytes: 1, sourceLines: 1, scriptKind: 'TSX', cache: 'hit', warmup: false, iteration: 2 })
  collector.end(third, { parseCount: 7, extractCount: 8, nodeCount: 9 })

  assert.deepEqual(
    { aggregate: collector.snapshot().aggregate, files: collector.snapshot().events.map((event) => event.file) },
    { aggregate: { parses: 3, wallMs: 156, parseCount: 12, extractCount: 15, nodeCount: 18 }, files: ['second.ts', 'third.ts'] },
  )
})

test('equivalence partition: a disabled collector is null and invokes no optional clock memory resource CPU or GC hooks', () => {
  let calls = 0

  const collector = createParseDiagnosticsCollector({ enabled: false, now: () => { calls += 1 }, cpuUsage: () => { calls += 1 }, memoryUsage: () => { calls += 1 }, resourceUsage: () => { calls += 1 }, observeGc: () => { calls += 1 } })

  assert.deepEqual({ collector, calls }, { collector: null, calls: 0 })
})

test('error guessing: begin and end perform no console logging inside the measured parse interval', () => {
  const readings = [0, 60]
  let logCalls = 0
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = () => { logCalls += 1 }
  console.warn = () => { logCalls += 1 }
  console.error = () => { logCalls += 1 }
  try {
    const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })
    const token = collector.begin({ file: '/repo/src/silent.ts', root: '/repo', sourceHash: 'silent', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 1 })
    collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  }

  assert.equal(logCalls, 0)
})

test('error guessing: snapshots and nested slow events are copy-safe against caller mutation', () => {
  const readings = [0, 60]
  const collector = createParseDiagnosticsCollector({ enabled: true, now: () => readings.shift(), cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ heapUsed: 0, rss: 0 }), resourceUsage: () => ({ voluntaryContextSwitches: 0, involuntaryContextSwitches: 0, minorPageFault: 0, majorPageFault: 0 }) })
  const token = collector.begin({ file: '/repo/src/immutable.ts', root: '/repo', sourceHash: 'immutable', sourceBytes: 1, sourceLines: 1, scriptKind: 'TS', cache: 'miss', warmup: false, iteration: 1 })
  collector.end(token, { parseCount: 1, extractCount: 1, nodeCount: 1 })
  const exposed = collector.snapshot()
  exposed.aggregate.parses = 99
  exposed.events[0].file = 'corrupted.ts'
  exposed.events[0].gc.push({ startTime: 0, duration: 1, overlapMs: 1, kind: 1 })

  assert.deepEqual(
    { parses: collector.snapshot().aggregate.parses, file: collector.snapshot().events[0].file, gc: collector.snapshot().events[0].gc },
    { parses: 1, file: 'src/immutable.ts', gc: [] },
  )
})
