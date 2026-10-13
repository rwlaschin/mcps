import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { crc32 } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { DaemonQueryEngine } from '../daemon-query-engine.mjs'
import { CodeGraphEngine } from '../tool-engine.mjs'
import { MmapQueryCache, QUERY_VIEW_CACHE_FILE } from '../mmap-query-cache.mjs'
import * as queryCacheSchema from '../query-cache-schema.mjs'
import { nativeMmapAdapter } from '../native/mmap-adapter.mjs'

class FakeMmapAdapter {
  constructor({ basePadding = 0 } = {}) {
    this.basePadding = basePadding
    this.files = new Map()
    this.maps = []
    this.unmaps = 0
    this.closes = 0
    this.flushes = 0
    this.failFlush = false
  }
  open(filePath, capacity) {
    if (!this.files.has(filePath)) this.files.set(filePath, new Uint8Array(capacity))
    return { filePath, closed: false }
  }
  resize(handle, capacity) {
    const prior = this.files.get(handle.filePath)
    const next = new Uint8Array(capacity)
    next.set(prior.subarray(0, Math.min(prior.byteLength, capacity)))
    this.files.set(handle.filePath, next)
  }
  map(handle) {
    const bytes = this.files.get(handle.filePath)
    const allocation = new Uint8Array(bytes.byteLength + this.basePadding)
    allocation.set(bytes, this.basePadding)
    const mapping = allocation.subarray(this.basePadding)
    mapping.handle = handle
    mapping.allocation = allocation
    this.maps.push(mapping)
    return mapping
  }
  flush(mapping) {
    if (this.failFlush) throw new Error('simulated flush failure')
    this.files.get(mapping.handle.filePath).set(mapping)
    this.flushes += 1
  }
  unmap() { this.unmaps += 1 }
  close(handle) { handle.closed = true; this.closes += 1 }
  truncate(filePath, byteLength) { this.files.set(filePath, this.files.get(filePath).subarray(0, byteLength)) }
  corrupt(filePath, byteOffset) { this.files.get(filePath)[byteOffset] ^= 0xff }
}

class WriteTrackingMmapAdapter extends FakeMmapAdapter {
  constructor() { super(); this.writeRanges = [] }
  map(handle) {
    const adapter = this
    const bytes = this.files.get(handle.filePath)
    class TrackingBytes extends Uint8Array {
      fill(value, start = 0, end = this.byteLength) { adapter.writeRanges.push({ operation: 'fill', start, end }); return super.fill(value, start, end) }
      set(source, offset = 0) { adapter.writeRanges.push({ operation: 'set', start: offset, end: offset + source.byteLength }); return super.set(source, offset) }
    }
    const mapping = new TrackingBytes(bytes.byteLength)
    Uint8Array.prototype.set.call(mapping, bytes)
    mapping.handle = handle
    this.maps.push(mapping)
    return mapping
  }
}

class SparseLifecycleMmapAdapter extends FakeMmapAdapter {
  constructor() { super(); this.opens = []; this.truncates = []; this.resizes = []; this.flushRanges = [] }
  open(filePath, capacity) {
    const absent = !this.files.has(filePath)
    this.opens.push({ filePath, capacity, absent })
    if (absent) { this.files.set(filePath, new Uint8Array(capacity)); this.truncates.push({ filePath, capacity }) }
    return { filePath, closed: false }
  }
  resize(handle, capacity) { this.resizes.push({ filePath: handle.filePath, capacity }); super.resize(handle, capacity) }
  flush(mapping, offset, length) {
    this.flushRanges.push({ offset, length })
    if (this.failFlush) throw new Error('simulated flush failure')
    this.files.get(mapping.handle.filePath).set(mapping.subarray(offset, offset + length), offset)
  }
}

const firstView = {
  graph: {
    generation: 'generation-0001', edgeCoverage: 'calls', files: ['src/a.ts'],
    symbols: [{ id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
    edges: [],
  },
}

const secondView = {
  graph: {
    generation: 'generation-0002', edgeCoverage: 'complete', files: ['src/a.ts', 'src/b.ts'],
    symbols: [
      { id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      { id: 'symbol-b', file: 'src/b.ts', name: 'b', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    ],
    edges: [{ from: 'symbol-b', to: 'symbol-a', line: 1, call: true }],
  },
}

const createCache = (adapter, capacityBytes = 65536) => new MmapQueryCache({
  filePath: path.join('/virtual', 'query-view-cache.bin'),
  root: '/workspace/project',
  adapter,
  capacityBytes,
})

const oldReleaseFixture = path.join(import.meta.dirname, 'fixtures', 'query-view-cache.bin')
const oldReleaseFixtureSha256 = 'd5c575bb20ab5132f17bec86e64aff12a24dd80185db1377e00b6fc3dfdb7b48'
const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

test('boundary value: the default logical mapping requests a fixed one-gibibyte sparse capacity', () => {
  const requestedCapacities = []
  const adapter = { open: (_filePath, capacity) => { requestedCapacities.push(capacity); throw new Error('capacity observed') } }

  const cache = new MmapQueryCache({ filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter })

  assert.deepEqual(requestedCapacities, [1_073_741_824])
  cache.dispose()
})

test('error guessing: reopening an existing sparse mapping never truncates or routinely resizes it', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const first = createCache(adapter)
  first.dispose()
  const reopened = createCache(adapter)

  assert.deepEqual({ opens: adapter.opens.map(({ absent }) => absent), truncates: adapter.truncates, resizes: adapter.resizes, mappedBytes: reopened.mapping.byteLength }, {
    opens: [true, false], truncates: [{ filePath: path.join('/virtual', 'query-view-cache.bin'), capacity: 65536 }], resizes: [], mappedBytes: 65536,
  })
  reopened.dispose()
})

test('domain analysis: publication flushes only appended record bytes and then the fixed header', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter)
  const published = cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const header = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = header.getUint32(32, true)
  const rootLength = header.getUint32(36, true)
  assert.deepEqual({ published, flushCount: adapter.flushRanges.length, appendOffset: adapter.flushRanges[0]?.offset, appendCoversCommittedRoot: adapter.flushRanges[0]?.offset + adapter.flushRanges[0]?.length === rootOffset + rootLength, leavesUnusedCapacity: adapter.flushRanges[0]?.offset + adapter.flushRanges[0]?.length < 65536, finalFlush: adapter.flushRanges[1] }, {
    published: true, flushCount: 2, appendOffset: 4352, appendCoversCommittedRoot: true, leavesUnusedCapacity: true, finalFlush: { offset: 0, length: 256 },
  })
})

test('domain boundary: an oversized inactive page fails without resize remap or whole-mapping flush', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter, 8192)
  const mapsBeforePublish = adapter.maps.length
  const resizesBeforePublish = adapter.resizes.length

  const published = cache.publish({ generation: 'generation-oversized', coverage: 'complete', view: { graph: { ...firstView.graph, generation: 'generation-oversized', symbols: [{ ...firstView.graph.symbols[0], name: 'x'.repeat(8192) }] } } })

  assert.deepEqual({ published, maps: adapter.maps.length, resizes: adapter.resizes.length, flushRanges: adapter.flushRanges }, {
    published: false, maps: mapsBeforePublish, resizes: resizesBeforePublish, flushRanges: [],
  })
})

test('architecture contract: the native flush bridge accepts offset and length and page-aligns the msync range', () => {
  const adapterSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'native', 'mmap-adapter.mjs'), 'utf8')
  const bridgeSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'native', 'mmap_bridge.c'), 'utf8')

  assert.deepEqual({
    adapterForwardsRange: /flush:\s*\(mapping,\s*offset,\s*length\)\s*=>\s*binding\.flush\(mapping,\s*offset,\s*length\)/.test(adapterSource),
    bridgeReadsThreeArguments: /size_t argc = 3/.test(bridgeSource),
    bridgeAlignsOffsetDown: /offset\s*[-=].*offset\s*%\s*page/.test(bridgeSource),
    bridgeAlignsLengthUp: /aligned_length|sync_length/.test(bridgeSource),
  }, {
    adapterForwardsRange: true, bridgeReadsThreeArguments: true, bridgeAlignsOffsetDown: true, bridgeAlignsLengthUp: true,
  })
})

test('equivalence partition: an unavailable native adapter makes every lookup a cache miss', () => {
  const cache = createCache(null)

  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(lease, null)
})

test('domain analysis: publishing page A then page B retains exact current and previous generations', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })

  const previous = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  const current = cache.acquire({ generation: 'generation-0002', coverage: 'complete' })

  assert.deepEqual({ previous: previous.value, current: current.value }, { previous: firstView, current: secondView })
  previous.release()
  current.release()
})

test('boundary value: publishing a third generation evicts the oldest and retains exactly two generations', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  cache.publish({ generation: 'generation-0003', coverage: 'calls', view: { graph: { ...firstView.graph, generation: 'generation-0003' } } })

  const oldest = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(oldest, null)
})

test('domain boundary: a lookup requires the exact generation and exact coverage pair', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })

  const wrongCoverage = cache.acquire({ generation: 'generation-0001', coverage: 'complete' })

  assert.equal(wrongCoverage, null)
})

test('domain boundary: a lookup for a well-formed but different generation is a cache miss', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })

  const wrongGeneration = cache.acquire({ generation: 'generation-0002', coverage: 'calls' })

  assert.equal(wrongGeneration, null)
})

test('equivalence partition: a lookup for a different root is a cache miss', () => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  writer.dispose()
  const reader = new MmapQueryCache({ filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/other', adapter, capacityBytes: 65536 })

  const lease = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(lease, null)
})

test('error guessing: relative offsets survive remapping the same cache at a different base address', () => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  writer.dispose()
  adapter.basePadding = 8192
  const reader = createCache(adapter)

  const lease = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.deepEqual(lease.value, firstView)
  lease.release()
})

test('error guessing: a torn or corrupt header fails closed as a cache miss', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.dispose()
  adapter.corrupt(path.join('/virtual', 'query-view-cache.bin'), 0)
  const reader = createCache(adapter)

  const lease = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(lease, null)
})

test('equivalence partition: an authentic unsupported v2 format is rebuilt instead of migrated', () => {
  const adapter = new FakeMmapAdapter()
  adapter.files.set(path.join('/virtual', 'query-view-cache.bin'), new Uint8Array(fs.readFileSync(oldReleaseFixture)))
  const reader = createCache(adapter)
  const published = reader.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  assert.equal(published, true)
})

test('error guessing: a truncated mapped file fails closed as a cache miss', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.dispose()
  adapter.truncate(path.join('/virtual', 'query-view-cache.bin'), 7)
  const reader = createCache(adapter)

  const lease = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(lease, null)
})

test('error guessing: corrupt committed root bytes fail checksum validation as a cache miss', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.dispose()
  const bytes = adapter.files.get(path.join('/virtual', 'query-view-cache.bin'))
  const header = new DataView(bytes.buffer, bytes.byteOffset)
  adapter.corrupt(path.join('/virtual', 'query-view-cache.bin'), header.getUint32(32 + header.getUint32(16, true) * 16, true))
  const reader = createCache(adapter)

  const lease = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(lease, null)
})

test('domain analysis: immutable publication succeeds without overwriting an active leased root', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })

  const published = cache.publish({ generation: 'generation-0003', coverage: 'calls', view: { graph: { ...firstView.graph, generation: 'generation-0003' } } })

  assert.deepEqual({ published, leasedValue: lease.value }, { published: true, leasedValue: firstView })
  lease.release()
})

test('boundary value: a payload one byte beyond fixed capacity is rejected without replacing the current page', () => {
  const cache = createCache(new FakeMmapAdapter(), 1024)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })

  const published = cache.publish({ generation: 'generation-0002', coverage: 'calls', view: { graph: { ...firstView.graph, generation: 'generation-0002', symbols: [{ ...firstView.graph.symbols[0], name: 'x'.repeat(1025) }] } } })

  assert.equal(published, false)
})

test('domain boundary: reopening with larger capacity replaces an undersized cache and publishes a readable page', () => {
  const adapter = new FakeMmapAdapter()
  const small = createCache(adapter, 1024)
  small.dispose()
  const large = createCache(adapter, 131072)

  const published = large.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })

  assert.equal(published, true)
})

test('error guessing: cancellation before publication leaves no partially readable generation', () => {
  const cache = createCache(new FakeMmapAdapter())
  const controller = new AbortController()
  controller.abort()

  const published = cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView }, { signal: controller.signal })

  assert.deepEqual({ published, lease: cache.acquire({ generation: 'generation-0001', coverage: 'calls' }) }, { published: false, lease: null })
})

test('error guessing: flush failure leaves the previously published page readable and publishes no partial replacement', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  adapter.failFlush = true

  const published = cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  const prior = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.deepEqual({ published, prior: prior.value, replacement: cache.acquire({ generation: 'generation-0002', coverage: 'complete' }) }, { published: false, prior: firstView, replacement: null })
  prior.release()
})

test('equivalence partition: dispose unmaps and closes the optional native resource exactly once', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)

  cache.dispose()
  cache.dispose()

  assert.deepEqual({ unmaps: adapter.unmaps, closes: adapter.closes }, { unmaps: 1, closes: 1 })
})

test('legacy v3 architecture contract: a published page is binary fixed-width data rather than a JSON query-view document', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-first.bin')))
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const activePage = header.getUint32(16, true)
  const descriptorOffset = activePage === 0 ? 32 : 48
  const pageOffset = header.getUint32(descriptorOffset, true)
  const pageLength = header.getUint32(descriptorOffset + 4, true)
  const payload = new TextDecoder().decode(bytes.subarray(pageOffset, pageOffset + pageLength))

  assert.throws(() => JSON.parse(payload), SyntaxError)
})

test('legacy v3 architecture contract: page metadata exposes ordered relative string symbol edge and query-index sections', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-second.bin')))
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const activePage = header.getUint32(16, true)
  const pageOffset = header.getUint32(activePage === 0 ? 32 : 48, true)
  const page = new DataView(bytes.buffer, bytes.byteOffset + pageOffset, bytes.byteLength - pageOffset)

  assert.deepEqual({
    strings: { offset: page.getUint32(8, true), bytes: page.getUint32(12, true) },
    symbols: { offset: page.getUint32(16, true), count: page.getUint32(20, true), recordBytes: page.getUint32(24, true) },
    edges: { offset: page.getUint32(28, true), count: page.getUint32(32, true), recordBytes: page.getUint32(36, true) },
    nameIndexOffset: page.getUint32(40, true), fileIndexOffset: page.getUint32(44, true), incomingIndexOffset: page.getUint32(48, true), outgoingIndexOffset: page.getUint32(52, true),
  }, {
    strings: { offset: 64, bytes: 153 }, symbols: { offset: 217, count: 2, recordBytes: 40 }, edges: { offset: 297, count: 1, recordBytes: 16 },
    nameIndexOffset: 313, fileIndexOffset: 345, incomingIndexOffset: 377, outgoingIndexOffset: 393,
  })
})

test('legacy v3 domain analysis: file header declares non-overlapping fixed scratch and two relative page offsets', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-first.bin')))
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.deepEqual({
    scratchOffset: header.getUint32(24, true), scratchBytes: header.getUint32(28, true),
    pageAOffset: header.getUint32(32, true), pageBOffset: header.getUint32(48, true),
  }, { scratchOffset: 256, scratchBytes: 4096, pageAOffset: 34816, pageBOffset: 4352 })
})

test('hotpath boundary: publishing a small replacement never fills or writes the unused page capacity', () => {
  const adapter = new WriteTrackingMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  adapter.writeRanges.length = 0

  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })

  assert.equal(adapter.writeRanges.some(({ operation, end, start }) => operation === 'fill' && end - start > 7 || end - start > 4096), false)
})

test('schema boundary: the stable cache filename reaches both query engine runtime paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-name-'))
  const opened = []
  const originalOpen = nativeMmapAdapter.open
  nativeMmapAdapter.open = (filePath) => { opened.push(filePath); throw new Error('path observed') }
  const daemon = new DaemonQueryEngine(root)
  const engine = new CodeGraphEngine(root, {
    mmapQueryCache: { adapter: { open: (filePath) => { opened.push(filePath); throw new Error('path observed') } } },
    validationWorkerFactory: () => ({ dispose: async () => {} }),
  })

  try {
    assert.deepEqual({ exportedName: QUERY_VIEW_CACHE_FILE, opened }, {
      exportedName: 'query-view-cache.bin',
      opened: [path.join(root, '.codegraph', 'query-view-cache.bin'), path.join(root, '.codegraph', 'query-view-cache.bin')],
    })
  } finally {
    nativeMmapAdapter.open = originalOpen
    await daemon.dispose()
    await engine.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cache compatibility: an immutable schema-v2 page safely misses and rebuilds as schema v3', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-old-cache-reader-'))
  const cacheFile = path.join(root, 'query-view-cache.bin')
  fs.copyFileSync(oldReleaseFixture, cacheFile)
  const cache = new MmapQueryCache({ filePath: cacheFile, root: '/workspace/project', adapter: nativeMmapAdapter, capacityBytes: 65536 })

  try {
    const callsMiss = cache.acquire({ generation: 'old-release-calls', coverage: 'calls' })
    const completeMiss = cache.acquire({ generation: 'old-release-complete', coverage: 'complete' })
    const rebuilt = cache.publish({
      generation: 'schema-v3-rebuild', coverage: 'complete', view: { graph: {
        generation: 'schema-v3-rebuild', edgeCoverage: 'complete', files: ['src/a.ts'],
        symbols: [
          { id: 'target-id', file: 'src/a.ts', name: 'target', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
          { id: 'caller-id', file: 'src/a.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 1, exported: true },
        ],
        edges: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }],
      } },
    })
    const current = cache.acquire({ generation: 'schema-v3-rebuild', coverage: 'complete' })

    assert.deepEqual({ callsMiss, completeMiss, rebuilt, generation: current.value.mappedView.generation, rows: current.value.mappedView.relationships({ name: 'target' }, 'incoming'), fixtureSha256: sha256File(oldReleaseFixture) }, {
      callsMiss: null,
      completeMiss: null,
      rebuilt: true,
      generation: 'schema-v3-rebuild',
      rows: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }],
      fixtureSha256: oldReleaseFixtureSha256,
    })
    current.release()
  } finally {
    cache.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('schema v3 retains unresolved references in the mapped page', () => {
  const cache = createCache(new FakeMmapAdapter())
  const unresolvedEdges = [{ from: 'caller-id', to: 'missing-id', line: 7, reason: 'unresolved target' }]
  cache.publish({ generation: 'generation-unresolved', coverage: 'complete', view: { graph: {
    generation: 'generation-unresolved', edgeCoverage: 'complete', files: ['src/a.ts'],
    symbols: [{ id: 'caller-id', file: 'src/a.ts', name: 'caller', kind: 'function', line: 7, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }],
    edges: [], unresolvedEdges,
  } } })
  const lease = cache.acquire({ generation: 'generation-unresolved', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.unresolvedEdges, unresolvedEdges)
  lease.release()
  cache.dispose()
})

test('boundary value: an absent mistaken versioned cache returns the stable path without creating either file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-no-legacy-'))

  try {
    const prepared = queryCacheSchema.prepareQueryViewCache(root)

    assert.deepEqual({ prepared, files: fs.readdirSync(root) }, { prepared: path.join(root, 'query-view-cache.bin'), files: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('domain analysis: the mistaken versioned cache is atomically adopted in place without rebuilding or leaving a suffix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-adopt-'))
  const versioned = path.join(root, 'query-view-cache-v2.bin')
  const stable = path.join(root, 'query-view-cache.bin')
  fs.copyFileSync(oldReleaseFixture, versioned)
  const originalInode = fs.statSync(versioned).ino

  try {
    const prepared = queryCacheSchema.prepareQueryViewCache(root)

    assert.deepEqual({
      prepared,
      files: fs.readdirSync(root),
      inodePreserved: fs.statSync(stable).ino === originalInode,
      bytesPreserved: sha256File(stable),
      fixturePreserved: sha256File(oldReleaseFixture),
    }, {
      prepared: stable,
      files: ['query-view-cache.bin'],
      inodePreserved: true,
      bytesPreserved: oldReleaseFixtureSha256,
      fixturePreserved: oldReleaseFixtureSha256,
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('error guessing: rename failure keeps both cache files byte-identical and continues with the warm versioned cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-rename-failure-'))
  const versioned = path.join(root, 'query-view-cache-v2.bin')
  const stable = path.join(root, 'query-view-cache.bin')
  fs.copyFileSync(oldReleaseFixture, versioned)
  fs.writeFileSync(stable, 'stable-cache-must-survive')
  const originalRenameSync = fs.renameSync
  fs.renameSync = () => { throw new Error('simulated rename failure') }

  try {
    const prepared = queryCacheSchema.prepareQueryViewCache(root)

    assert.deepEqual({ prepared, versionedSha256: sha256File(versioned), stableText: fs.readFileSync(stable, 'utf8') }, {
      prepared: versioned,
      versionedSha256: oldReleaseFixtureSha256,
      stableText: 'stable-cache-must-survive',
    })
  } finally {
    fs.renameSync = originalRenameSync
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('error guessing: a stale mmap module namespace cannot break a new importer of the cache schema leaf', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stale-esm-'))
  const staleModule = path.join(root, 'mmap-query-cache.mjs')
  const newImporter = path.join(root, 'new-importer.mjs')
  const runner = path.join(root, 'runner.mjs')
  const schemaUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'query-cache-schema.mjs')).href
  fs.writeFileSync(staleModule, 'export class MmapQueryCache {}\n')
  fs.writeFileSync(newImporter, `import { QUERY_VIEW_CACHE_FILE } from ${JSON.stringify(schemaUrl)}\nexport { QUERY_VIEW_CACHE_FILE }\n`)
  fs.writeFileSync(runner, `
    const stale = await import('./mmap-query-cache.mjs')
    if (Object.hasOwn(stale, 'QUERY_VIEW_CACHE_FILE')) throw new Error('fixture is not stale')
    const current = await import('./new-importer.mjs')
    process.stdout.write(current.QUERY_VIEW_CACHE_FILE)
  `)

  try {
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' })

    assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, {
      status: 0,
      stdout: 'query-view-cache.bin',
      stderr: '',
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('hotpath regression: acquire and indexed symbols deps and resolved refs never materialize graph or decode unrelated records', () => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({
    generation: 'generation-lazy', coverage: 'complete',
    view: { graph: {
      generation: 'generation-lazy', edgeCoverage: 'complete', files: ['src/target.ts', 'src/caller.ts', 'src/unrelated.ts'],
      symbols: [
        { id: 'target-id', file: 'src/target.ts', name: 'target', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'caller-id', file: 'src/caller.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'unrelated-id', file: 'src/unrelated.ts', name: 'unrelated', kind: 'function', line: 3, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      ],
      edges: [
        { from: 'caller-id', to: 'target-id', line: 2, call: true },
        { from: 'unrelated-id', to: 'unrelated-id', line: 3, call: true },
      ],
    } },
  })
  writer.dispose()
  const decoded = { graph: 0, relevantSymbols: 0, relevantEdges: 0 }
  const reader = new MmapQueryCache({
    filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 65536,
    decodeObserver: ({ type, index }) => {
      if (type === 'graph') decoded.graph += 1
      if (type === 'symbol' && index === 2) throw new Error('decoded unrelated symbol')
      if (type === 'edge' && index === 1) throw new Error('decoded unrelated edge')
      if (type === 'symbol' && (index === 0 || index === 1)) decoded.relevantSymbols += 1
      if (type === 'edge' && index === 0) decoded.relevantEdges += 1
    },
  })

  const lease = reader.acquire({ generation: 'generation-lazy', coverage: 'complete' })
  const symbols = lease.value.mappedView.matchingSymbols({ name: 'target' })
  const deps = lease.value.mappedView.relationships({ name: 'caller' }, 'outgoing')
  const refs = lease.value.mappedView.relationships({ name: 'target' }, 'incoming')
  const resolved = refs.map((edge) => ({
    ...edge,
    fromSymbol: lease.value.mappedView.matchingSymbols({ id: edge.from })[0],
    toSymbol: lease.value.mappedView.matchingSymbols({ id: edge.to })[0],
  }))

  assert.deepEqual({
    graphDecodes: decoded.graph, observedRelevantSymbolDecode: decoded.relevantSymbols > 0, observedRelevantEdgeDecode: decoded.relevantEdges > 0,
    symbols: symbols.map(({ name }) => name), deps: deps.length, refs: refs.length, resolved: resolved.map(({ fromSymbol, toSymbol }) => [fromSymbol.name, toSymbol.name]),
  }, {
    graphDecodes: 0, observedRelevantSymbolDecode: true, observedRelevantEdgeDecode: true,
    symbols: ['target'], deps: 1, refs: 1, resolved: [['caller', 'target']],
  })
  lease.release()
})

const assertZeroDecodeLookup = (request, expected) => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({
    generation: 'generation-zero-decode', coverage: 'complete',
    view: { graph: {
      generation: 'generation-zero-decode', edgeCoverage: 'complete', files: ['src/shared.ts', 'src/other.ts'],
      symbols: [
        { id: 'id-a', file: 'src/shared.ts', name: 'same', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'id-b', file: 'src/shared.ts', name: 'same', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'id-c', file: 'src/other.ts', name: 'same-prefix', kind: 'function', line: 3, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      ], edges: [],
    } },
  })
  writer.dispose()
  let resultMaterializationStarted = false
  let traversalStringDecodes = 0
  const reader = new MmapQueryCache({
    filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 65536,
    decodeObserver: ({ type }) => {
      if (type === 'symbol') resultMaterializationStarted = true
      if (type === 'string' && !resultMaterializationStarted) traversalStringDecodes += 1
    },
  })
  const lease = reader.acquire({ generation: 'generation-zero-decode', coverage: 'complete' })

  const actual = lease.value.mappedView.matchingSymbols(request).map(({ id }) => id)

  assert.deepEqual({ traversalStringDecodes, actual }, { traversalStringDecodes: 0, actual: expected })
  lease.release()
}

test('hotpath zero-decode contract: name lookup does not decode strings before result materialization', () => {
  assertZeroDecodeLookup({ name: 'same' }, ['id-a', 'id-b'])
})

test('hotpath zero-decode contract: file lookup does not decode strings before result materialization', () => {
  assertZeroDecodeLookup({ file: 'src/shared.ts' }, ['id-a', 'id-b'])
})

test('hotpath zero-decode contract: id lookup does not decode strings before result materialization', () => {
  assertZeroDecodeLookup({ id: 'id-b' }, ['id-b'])
})

test('hotpath zero-decode contract: combined name and file lookup does not decode strings before result materialization', () => {
  assertZeroDecodeLookup({ name: 'same', file: 'src/shared.ts' }, ['id-a', 'id-b'])
})

test('hotpath zero-decode contract: relationship lookup traversal does not decode strings before result materialization', () => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({
    generation: 'generation-zero-decode-rel', coverage: 'complete',
    view: { graph: {
      generation: 'generation-zero-decode-rel', edgeCoverage: 'complete', files: ['src/a.ts', 'src/b.ts'],
      symbols: [
        { id: 'target-id', file: 'src/a.ts', name: 'target', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'caller-id', file: 'src/b.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      ], edges: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }],
    } },
  })
  writer.dispose()
  let resultMaterializationStarted = false
  let traversalStringDecodes = 0
  const reader = new MmapQueryCache({
    filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 65536,
    decodeObserver: ({ type }) => {
      if (type === 'symbol' || type === 'edge') resultMaterializationStarted = true
      if (type === 'string' && !resultMaterializationStarted) traversalStringDecodes += 1
    },
  })
  const lease = reader.acquire({ generation: 'generation-zero-decode-rel', coverage: 'complete' })

  const actual = lease.value.mappedView.relationships({ name: 'target' }, 'incoming')

  assert.deepEqual({ traversalStringDecodes, actual }, {
    traversalStringDecodes: 0,
    actual: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }],
  })
  lease.release()
})

const assertAbsentNameReturnsNoRows = (name) => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({
    generation: 'generation-absent', coverage: 'complete',
    view: { graph: {
      generation: 'generation-absent', edgeCoverage: 'complete', files: ['src/a.ts'],
      symbols: [
        { id: 'id-a', file: 'src/a.ts', name: 'same', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'id-b', file: 'src/a.ts', name: 'same-prefix', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      ], edges: [],
    } },
  })
  writer.dispose()
  const reader = new MmapQueryCache({ filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 65536 })
  const lease = reader.acquire({ generation: 'generation-absent', coverage: 'complete' })

  const actual = lease.value.mappedView.matchingSymbols({ name }).map(({ id }) => id)

  assert.deepEqual(actual, [])
  lease.release()
}

test('boundary value: absent name before the index range returns no rows', () => {
  assertAbsentNameReturnsNoRows(' ')
})

test('boundary value: absent name within the index range returns no rows', () => {
  assertAbsentNameReturnsNoRows('same-prefig')
})

test('boundary value: absent name after the index range returns no rows', () => {
  assertAbsentNameReturnsNoRows('\uffff')
})

test('hotpath ordering contract: string indexes use UTF-8 page-byte order rather than locale collation', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'mmap-query-cache.mjs'), 'utf8')

  const writerStart = source.indexOf('class RecordWriter')
  const writerEnd = source.indexOf('class ImmutableQueryView', writerStart)
  const readerStart = source.indexOf('class RecordReader')
  const readerEnd = source.indexOf('class RecordWriter', readerStart)
  assert.ok(writerStart >= 0 && writerEnd > writerStart, 'query index writer source span exists')
  assert.ok(readerStart >= 0 && readerEnd > readerStart, 'mapped index reader source span exists')
  const indexes = source.slice(writerStart, writerEnd) + source.slice(readerStart, readerEnd)

  assert.deepEqual({ usesLocaleCollation: indexes.includes('.localeCompare('), usesPageByteComparison: indexes.includes('prefixCompare') && indexes.includes('compareBytes') }, {
    usesLocaleCollation: false,
    usesPageByteComparison: true,
  })
})

test('legacy v3 raw name index is monotonic under the reader UTF-8 byte comparator', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-unicode.bin')))
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pageOffset = file.getUint32(32 + file.getUint32(16, true) * 16, true)
  const page = new DataView(bytes.buffer, bytes.byteOffset + pageOffset)
  const stringsOffset = pageOffset + page.getUint32(8, true)
  const nameIndexOffset = pageOffset + page.getUint32(40, true)
  const firstOffset = file.getUint32(nameIndexOffset, true)
  const secondOffset = file.getUint32(nameIndexOffset + 16, true)
  const firstEnd = bytes.indexOf(0, stringsOffset + firstOffset)
  const secondEnd = bytes.indexOf(0, stringsOffset + secondOffset)
  const first = bytes.subarray(stringsOffset + firstOffset, firstEnd)
  const second = bytes.subarray(stringsOffset + secondOffset, secondEnd)

  assert.deepEqual({
    orderedNames: [new TextDecoder().decode(first), new TextDecoder().decode(second)],
    byteComparator: Buffer.compare(first, second),
  }, { orderedNames: ['z', 'é'], byteComparator: -1 })
})

test('equivalence partition: Unicode name whose byte order differs from locale collation returns its exact row', () => {
  const adapter = new FakeMmapAdapter()
  const writer = createCache(adapter)
  writer.publish({
    generation: 'generation-unicode-query', coverage: 'complete',
    view: { graph: {
      generation: 'generation-unicode-query', edgeCoverage: 'complete', files: ['src/unicode.ts'],
      symbols: [
        { id: 'id-z', file: 'src/unicode.ts', name: 'z', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'id-accent', file: 'src/unicode.ts', name: 'é', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      ], edges: [],
    } },
  })
  writer.dispose()
  const reader = new MmapQueryCache({ filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 65536 })
  const lease = reader.acquire({ generation: 'generation-unicode-query', coverage: 'complete' })

  const actual = lease.value.mappedView.matchingSymbols({ name: 'é' })

  assert.deepEqual(actual, [{ id: 'id-accent', file: 'src/unicode.ts', name: 'é', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }])
  lease.release()
})

test('hotpath diagnostic: mapped indexes query one of 22000 symbols and 29 of 55000 incoming refs without full graph decode', (t) => {
  const symbols = Array.from({ length: 22000 }, (_, index) => ({
    id: `symbol-${index}`, file: `src/file-${index}.ts`, name: index === 0 ? 'needle' : `symbol${index}`, kind: 'function', line: 1,
    qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true,
  }))
  const edges = Array.from({ length: 55000 }, (_, index) => index < 29
    ? { from: `symbol-${index + 1}`, to: 'symbol-0', line: index + 1, call: true }
    : { from: `symbol-${30 + (index % 21970)}`, to: `symbol-${30 + ((index + 1) % 21970)}`, line: index + 1, call: true })
  const adapter = new FakeMmapAdapter()
  const writer = new MmapQueryCache({ filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 64 * 1024 * 1024 })
  writer.publish({ generation: 'generation-large', coverage: 'complete', view: { graph: { generation: 'generation-large', edgeCoverage: 'complete', files: symbols.map(({ file }) => file), symbols, edges } } })
  writer.dispose()
  let graphDecodes = 0
  let symbolDecodes = 0
  let edgeDecodes = 0
  const reader = new MmapQueryCache({
    filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 64 * 1024 * 1024,
    decodeObserver: ({ type }) => {
      if (type === 'graph') graphDecodes += 1
      if (type === 'symbol') symbolDecodes += 1
      if (type === 'edge') edgeDecodes += 1
    },
  })
  const acquireStarted = performance.now()
  const lease = reader.acquire({ generation: 'generation-large', coverage: 'complete' })
  const acquireMs = performance.now() - acquireStarted
  const firstSymbol = lease.value.mappedView.matchingSymbols({ name: 'needle' })[0]
  const firstRefs = lease.value.mappedView.relationships({ name: 'needle' }, 'incoming')
  const firstQueryDecodes = { symbolDecodes, edgeDecodes }
  const durations = []
  let symbolCount = 0
  let refCount = 0
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const started = performance.now()
    symbolCount = lease.value.mappedView.matchingSymbols({ name: 'needle' }).length
    refCount = lease.value.mappedView.relationships({ name: 'needle' }, 'incoming').length
    durations.push(performance.now() - started)
  }
  const ordered = durations.toSorted((left, right) => left - right)
  const metrics = { acquireMs, p50: ordered[9], p95: ordered[18], max: ordered[19] }
  t.diagnostic(`mapped 22k-symbol/55k-edge needle+29-refs latency ${JSON.stringify(metrics)}`)

  assert.deepEqual({
    graphDecodes, firstSymbol, firstRef: firstRefs[0], firstRefCount: firstRefs.length, firstQueryDecodes,
    symbolCount, refCount,
  }, {
    graphDecodes: 0,
    firstSymbol: { id: 'symbol-0', file: 'src/file-0.ts', name: 'needle', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    firstRef: { from: 'symbol-1', to: 'symbol-0', line: 1, call: true }, firstRefCount: 29,
    firstQueryDecodes: { symbolDecodes: 2, edgeDecodes: 29 },
    symbolCount: 1, refCount: 29,
  })
  lease.release()
})

// Equivalence partitioning/domain analysis: literal v3 rows must survive migration.
const migrationCalls = {
  generation: 'fixture-v3-calls', edgeCoverage: 'calls', files: ['src/a.ts', 'src/é.ts'],
  symbols: [
    { id: 'caller-id', file: 'src/a.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    { id: 'target-id', file: 'src/é.ts', name: 'é😀', kind: 'function', line: 7, qualifiedPath: '<module>', signature: '<>():number', ordinal: 0, exported: true },
  ],
  edges: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 2, call: true }],
  unresolvedEdges: [{ from: 'caller-id', to: 'missing-id', line: 3, reason: 'unresolved target' }],
}
const migrationComplete = {
  generation: 'fixture-v3-complete', edgeCoverage: 'complete', files: ['src/a.ts', 'src/é.ts'],
  symbols: [
    { id: 'caller-id', file: 'src/a.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    { id: 'target-id', file: 'src/é.ts', name: 'é😀', kind: 'function', line: 7, qualifiedPath: '<module>', signature: '<>():number', ordinal: 0, exported: true },
  ],
  edges: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 4, call: false }],
  unresolvedEdges: [{ from: 'caller-id', to: 'missing-id', line: 3, reason: 'unresolved target' }],
}

test('migration preserves both authentic v3 generations and exact duplicate Unicode unresolved rows', () => {
  const adapter = new FakeMmapAdapter()
  adapter.files.set(path.join('/virtual', 'query-view-cache.bin'), new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3.bin'))))
  const cache = createCache(adapter)
  const calls = cache.acquire({ generation: 'fixture-v3-calls', coverage: 'calls' })
  const complete = cache.acquire({ generation: 'fixture-v3-complete', coverage: 'complete' })
  assert.deepEqual({ version: new DataView(cache.mapping.buffer, cache.mapping.byteOffset).getUint32(4, true), calls: calls?.value.mappedView.graph, complete: complete?.value.mappedView.graph }, {
    version: 4, calls: migrationCalls, complete: migrationComplete,
  })
  calls?.release()
  complete?.release()
  cache.dispose()
})

// Error guessing: a different reader owns a pin beyond the two-root retention limit.
test('a separately acquired pinned root stays exact after repeated publications', () => {
  const adapter = new FakeMmapAdapter()
  adapter.map = function (handle) { const bytes = this.files.get(handle.filePath); bytes.handle = handle; this.maps.push(bytes); return bytes }
  const writer = createCache(adapter)
  writer.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const reader = createCache(adapter)
  const pinned = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })
  writer.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  writer.publish({ generation: 'generation-0003', coverage: 'calls', view: { graph: { ...secondView.graph, generation: 'generation-0003', edgeCoverage: 'calls' } } })
  assert.deepEqual(pinned.value.mappedView.graph, firstView.graph)
  pinned.release()
  reader.dispose()
  writer.dispose()
})

// Boundary analysis: lease release must not turn a still-reachable view into dangling bytes.
test('a released retained mapped view remains readable after cache disposal', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  const view = lease.value.mappedView
  lease.release()
  cache.dispose()
  assert.deepEqual(view.graph, firstView.graph)
})

// Combinatorial/domain boundary: unchanged partition and groups must retain index work.
test('a body-only delta writes generation metadata without decoding the parent graph', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  lease.value.mappedView.decodeObserver = ({ type }) => { if (type === 'graph') throw new Error('delta decoded the parent graph') }
  adapter.flushRanges.length = 0
  const published = cache.publish({ generation: 'generation-0002', coverage: 'calls', view: {
    parent: lease.value.mappedView, file: 'src/a.ts',
    oldPartition: { symbols: [{ id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }], edges: [], unresolvedEdges: [] },
    newPartition: { symbols: [{ id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }], edges: [], unresolvedEdges: [] },
    publicationChanges: { groups: [] },
  } })
  const current = cache.acquire({ generation: 'generation-0002', coverage: 'calls' })
  assert.deepEqual({ published, graph: current?.value.mappedView.graph, wideFlushes: adapter.flushRanges.some(({ length }) => length > 512) }, {
    published: true, graph: { ...firstView.graph, generation: 'generation-0002' }, wideFlushes: false,
  })
  current?.release()
  lease.release()
  cache.dispose()
})

// Error guessing/domain analysis: migration may append, but cannot destroy its inputs.
test('a failed migration header flush keeps the authentic v3 header and both protected pages queryable', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const original = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3.bin')))
  adapter.files.set(path.join('/virtual', 'query-view-cache.bin'), original.slice())
  let failedHeaderFlushes = 0
  adapter.flush = function (mapping, offset, length) {
    if (offset === 0) { failedHeaderFlushes += 1; throw new Error('migration header flush failed') }
    this.files.get(mapping.handle.filePath).set(mapping.subarray(offset, offset + length), offset)
  }
  const cache = createCache(adapter)
  const calls = cache.acquire({ generation: 'fixture-v3-calls', coverage: 'calls' })
  const complete = cache.acquire({ generation: 'fixture-v3-complete', coverage: 'complete' })
  assert.deepEqual({ attemptedCommit: failedHeaderFlushes > 0, header: cache.mapping.subarray(0, 256), lowerPage: cache.mapping.subarray(4352, 4987), upperGuardAndPage: cache.mapping.subarray(32768, 35397), calls: calls?.value.mappedView.graph, complete: complete?.value.mappedView.graph }, {
    attemptedCommit: true, header: original.subarray(0, 256), lowerPage: original.subarray(4352, 4987), upperGuardAndPage: original.subarray(32768, 35397), calls: migrationCalls, complete: migrationComplete,
  })
  calls?.release()
  complete?.release()
  cache.dispose()
})

// Error guessing: appended records are not a committed generation until its header flush succeeds.
test('a failed publication header flush leaves the prior root exact after reopen', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const flush = adapter.flush.bind(adapter)
  adapter.flush = (mapping, offset, length) => { if (offset === 0) throw new Error('header-only failure'); flush(mapping, offset, length) }
  const published = cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  cache.dispose()
  adapter.flush = flush
  const reopened = createCache(adapter)
  const prior = reopened.acquire({ generation: 'generation-0001', coverage: 'calls' })
  assert.deepEqual({ published, prior: prior?.value.mappedView.graph, failedGeneration: reopened.acquire({ generation: 'generation-0002', coverage: 'complete' }) }, {
    published: false, prior: firstView.graph, failedGeneration: null,
  })
  prior?.release()
  reopened.dispose()
})

// Error guessing: validating an immutable offset once is not a license to trust later bytes.
test('a previously read record fails closed when its mapped bytes are later corrupted', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'symbol-a' }), [{ id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }])
  const location = Buffer.from(cache.mapping.buffer, cache.mapping.byteOffset, cache.mapping.byteLength).indexOf('symbol-a')
  assert.notEqual(location, -1)
  cache.mapping[location] ^= 1
  assert.throws(() => lease.value.mappedView.matchingSymbols({ id: 'symbol-a' }))
  lease.release()
  cache.dispose()
})

// Equivalence/domain analysis: accepted duplicate IDs have distinct physical endpoint identity.
test('duplicate symbol IDs retain cold edge rows while relationship lookup keeps the first occurrence rule', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'duplicate-id-cold', coverage: 'complete', view: { graph: {
    generation: 'duplicate-id-cold', edgeCoverage: 'complete', files: ['src/a.ts'],
    symbols: [
      { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      { id: 'same-id', file: 'src/a.ts', name: 'last', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 1, exported: true },
    ],
    edges: [{ from: 'same-id', to: 'same-id', line: 3, call: true }, { from: 'same-id', to: 'same-id', line: 3, call: true }],
  } } })
  const lease = cache.acquire({ generation: 'duplicate-id-cold', coverage: 'complete' })
  assert.deepEqual({ symbols: lease.value.mappedView.symbols, edges: lease.value.mappedView.edges, incoming: lease.value.mappedView.relationships({ id: 'same-id' }, 'incoming'), outgoing: lease.value.mappedView.relationships({ id: 'same-id' }, 'outgoing') }, {
    symbols: [
      { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
      { id: 'same-id', file: 'src/a.ts', name: 'last', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 1, exported: true },
    ],
    edges: [{ from: 'same-id', to: 'same-id', line: 3, call: true }, { from: 'same-id', to: 'same-id', line: 3, call: true }], incoming: [], outgoing: [],
  })
  lease.release()
  cache.dispose()
})

// Domain/state boundary: retained readable roots cannot authorize an out-of-order commit.
test('a delta based on a stale retained parent leaves the newer generation unchanged', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const old = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  const published = cache.publish({ generation: 'generation-0003', coverage: 'calls', view: {
    parent: old.value.mappedView, file: 'src/a.ts',
    oldPartition: { symbols: [{ id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }], edges: [], unresolvedEdges: [] },
    newPartition: { symbols: [{ id: 'symbol-a', file: 'src/a.ts', name: 'a', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true }], edges: [], unresolvedEdges: [] },
    publicationChanges: { groups: [] },
  } })
  const current = cache.acquire({ generation: 'generation-0002', coverage: 'complete' })
  assert.deepEqual({ published, current: current?.value.mappedView.graph, rejectedGeneration: cache.acquire({ generation: 'generation-0003', coverage: 'calls' }) }, {
    published: false, current: secondView.graph, rejectedGeneration: null,
  })
  current?.release()
  old.release()
  cache.dispose()
})

// Error guessing/lifecycle partition: migration must survive a real unmap and reopen.
test('native v3 migration persists both exact generation roots across reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v3-migration-'))
  const filePath = path.join(root, 'query-view-cache.bin')
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3.bin'), filePath)
  const migrated = new MmapQueryCache({ filePath, root: '/workspace/project', adapter: nativeMmapAdapter, capacityBytes: 65536 })
  migrated.dispose()
  const reopened = new MmapQueryCache({ filePath, root: '/workspace/project', adapter: nativeMmapAdapter, capacityBytes: 65536 })
  const calls = reopened.acquire({ generation: 'fixture-v3-calls', coverage: 'calls' })
  const complete = reopened.acquire({ generation: 'fixture-v3-complete', coverage: 'complete' })
  try {
    assert.deepEqual({ version: new DataView(reopened.mapping.buffer, reopened.mapping.byteOffset).getUint32(4, true), calls: calls?.value.mappedView.graph, complete: complete?.value.mappedView.graph }, {
      version: 4, calls: migrationCalls, complete: migrationComplete,
    })
  } finally {
    calls?.release()
    complete?.release()
    reopened.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Domain/boundary analysis: total raw count growth cannot reclassify retained cold missing rows.
test('growing raw unresolved rows preserves an identical-field missing occurrence and an untouched missing group', () => {

  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'unresolved-cold', coverage: 'complete', view: { graph: {
    generation: 'unresolved-cold', edgeCoverage: 'complete', files: [], symbols: [], edges: [],
    unresolvedEdges: [
      { from: 'owner', to: 'absent', line: 1, reason: 'same fields' },
      { from: 'owner', to: 'absent', line: 1, reason: 'same fields' },
      { from: 'a-untouched', to: 'absent', line: 7, reason: 'untouched missing' },
    ],
  } } })
  const pinned = cache.acquire({ generation: 'unresolved-cold', coverage: 'complete' })
  const grew = cache.publish({ generation: 'unresolved-grow', coverage: 'complete', view: {
    parent: pinned.value.mappedView, file: 'src/a.ts', oldPartition: { symbols: [], edges: [] }, newPartition: { symbols: [], edges: [] },
    publicationChanges: { rawUnresolvedBeforeCount: 1, groups: [{ from: 'z-new', to: 'absent', line: 2,
      before: { edges: [], unresolved: [], missing: [] },
      after: { edges: [], unresolved: [{ from: 'z-new', to: 'absent', line: 2, reason: 'new raw' }], missing: [] },
    }] },
  } })
  const grown = cache.acquire({ generation: 'unresolved-grow', coverage: 'complete' })

  assert.deepEqual({ published: grew, rows: grown?.value.mappedView.unresolvedEdges }, {
    published: true, rows: [
      { from: 'owner', to: 'absent', line: 1, reason: 'same fields' },
      { from: 'z-new', to: 'absent', line: 2, reason: 'new raw' },
      { from: 'a-untouched', to: 'absent', line: 7, reason: 'untouched missing' },
      { from: 'owner', to: 'absent', line: 1, reason: 'same fields' },
    ],
  })
  grown?.release()
  pinned.release()
  cache.dispose()
})

// Error guessing/state boundary: reopen must retain the original cold section boundary after growth and shrink.
test('shrinking raw unresolved rows after growth keeps identical missing rows exact through reopen and a retained pin', () => {

  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'unresolved-cold', coverage: 'complete', view: { graph: {
    generation: 'unresolved-cold', edgeCoverage: 'complete', files: [], symbols: [], edges: [],
    unresolvedEdges: [
      { from: 'owner', to: 'absent', line: 1, reason: 'same fields' },
      { from: 'owner', to: 'absent', line: 1, reason: 'same fields' },
      { from: 'a-untouched', to: 'absent', line: 7, reason: 'untouched missing' },
    ],
  } } })
  const pinned = cache.acquire({ generation: 'unresolved-cold', coverage: 'complete' })
  const grew = cache.publish({ generation: 'unresolved-grow', coverage: 'complete', view: {
    parent: pinned.value.mappedView, file: 'src/a.ts', oldPartition: { symbols: [], edges: [] }, newPartition: { symbols: [], edges: [] },
    publicationChanges: { rawUnresolvedBeforeCount: 1, groups: [{ from: 'z-new', to: 'absent', line: 2,
      before: { edges: [], unresolved: [], missing: [] },
      after: { edges: [], unresolved: [{ from: 'z-new', to: 'absent', line: 2, reason: 'new raw' }], missing: [] },
    }] },
  } })
  const grown = cache.acquire({ generation: 'unresolved-grow', coverage: 'complete' })

  const shrank = cache.publish({ generation: 'unresolved-shrink', coverage: 'complete', view: {
    parent: grown.value.mappedView, file: 'src/a.ts', oldPartition: { symbols: [], edges: [] }, newPartition: { symbols: [], edges: [] },
    publicationChanges: { rawUnresolvedBeforeCount: 2, groups: [
      { from: 'owner', to: 'absent', line: 1,
        before: { edges: [], unresolved: [{ from: 'owner', to: 'absent', line: 1, reason: 'same fields' }], missing: [{ from: 'owner', to: 'absent', line: 1, reason: 'same fields' }] },
        after: { edges: [], unresolved: [], missing: [{ from: 'owner', to: 'absent', line: 1, reason: 'same fields' }] },
      },
      { from: 'z-new', to: 'absent', line: 2,
        before: { edges: [], unresolved: [{ from: 'z-new', to: 'absent', line: 2, reason: 'new raw' }], missing: [] },
        after: { edges: [], unresolved: [], missing: [] },
      },
    ] },
  } })
  grown.release()
  pinned.release()
  cache.dispose()
  const reopened = createCache(adapter)
  const current = reopened.acquire({ generation: 'unresolved-shrink', coverage: 'complete' })
  assert.deepEqual({ grew, shrank, current: current?.value.mappedView.unresolvedEdges, pinned: pinned.value.mappedView.unresolvedEdges }, {
    grew: true, shrank: true,
    current: [{ from: 'a-untouched', to: 'absent', line: 7, reason: 'untouched missing' }, { from: 'owner', to: 'absent', line: 1, reason: 'same fields' }],
    pinned: [{ from: 'owner', to: 'absent', line: 1, reason: 'same fields' }, { from: 'owner', to: 'absent', line: 1, reason: 'same fields' }, { from: 'a-untouched', to: 'absent', line: 7, reason: 'untouched missing' }],
  })
  current?.release()
  reopened.dispose()
})

// Error guessing/all-pairs boundary: migrated active root may have an older allocation cursor than its sibling.
test('cloning a migrated active-A generation never overwrites the other pinned root record', () => {
  const adapter = new FakeMmapAdapter()
  adapter.files.set(path.join('/virtual', 'query-view-cache.bin'), new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-active-a.bin'))))
  const cache = createCache(adapter)
  const calls = cache.acquire({ generation: 'fixture-v3-calls', coverage: 'calls' })
  const complete = cache.acquire({ generation: 'fixture-v3-complete', coverage: 'complete' })
  const header = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const otherOffset = header.getUint32(48, true)
  const otherLength = header.getUint32(52, true)
  const protectedOtherRoot = cache.mapping.slice(otherOffset, otherOffset + otherLength)
  const cloned = cache.cloneGeneration({ fromGeneration: 'fixture-v3-calls', generation: 'fixture-v3-cloned', coverage: 'calls' })
  const clone = cache.acquire({ generation: 'fixture-v3-cloned', coverage: 'calls' })
  assert.deepEqual({ cloned, otherRootBytes: cache.mapping.subarray(otherOffset, otherOffset + otherLength), calls: calls?.value.mappedView.graph, complete: complete?.value.mappedView.graph, clone: clone?.value.mappedView.graph }, {
    cloned: true, otherRootBytes: protectedOtherRoot, calls: migrationCalls, complete: migrationComplete, clone: { ...migrationCalls, generation: 'fixture-v3-cloned' },
  })
  calls?.release()
  complete?.release()
  clone?.release()
  cache.dispose()
})

// Boundary/domain analysis: a valid lower legacy page can consume the entire first free interval.
test('migration skips a consumed lower interval and keeps both authentic overlapping-guard generations readable after reopen', () => {
  const adapter = new FakeMmapAdapter()
  adapter.files.set(path.join('/virtual', 'query-view-cache.bin'), new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-overlap.bin'))))
  const migrated = createCache(adapter)
  migrated.dispose()
  const reopened = createCache(adapter)
  const calls = reopened.acquire({ generation: 'overlap-calls', coverage: 'calls' })
  const complete = reopened.acquire({ generation: 'overlap-complete', coverage: 'complete' })
  assert.deepEqual({ version: new DataView(reopened.mapping.buffer, reopened.mapping.byteOffset).getUint32(4, true), calls: calls?.value.mappedView.graph, complete: complete?.value.mappedView.graph }, {
    version: 4,
    calls: { generation: 'overlap-calls', edgeCoverage: 'calls', files: [], symbols: [], edges: [] },
    complete: { generation: 'overlap-complete', edgeCoverage: 'complete', files: [], symbols: [], edges: [] },
  })
  calls?.release()
  complete?.release()
  reopened.dispose()
})

// Error guessing/domain boundary: invalid publication metadata must not make committed storage virgin again.
for (const { name, byteOffset } of [
  { name: 'a corrupted header CRC cannot authorize publication over a live pinned generation', byteOffset: 252 },
  { name: 'a corrupted header magic cannot authorize publication over a live pinned generation', byteOffset: 0 },
  { name: 'a corrupted header version cannot authorize publication over a live pinned generation', byteOffset: 4 },
]) {
  test(name, () => {
    const cache = createCache(new FakeMmapAdapter())
    cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
    const pinned = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
    cache.mapping[byteOffset] ^= 1
    const published = cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
    assert.deepEqual({ published, pinned: pinned.value.mappedView.graph }, { published: false, pinned: firstView.graph })
    pinned.release()
    cache.dispose()
  })
}

// Boundary/error guessing: insufficient migration space must preserve readable legacy data, not rebuild it.
test('insufficient migration capacity preserves both authentic v3 pages and refuses replacement', () => {
  const adapter = new FakeMmapAdapter()
  const original = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v3-capacity.bin')))
  adapter.files.set(path.join('/virtual', 'query-view-cache.bin'), original.slice())
  const cache = createCache(adapter)
  const calls = cache.acquire({ generation: 'capacity-calls', coverage: 'calls' })
  const complete = cache.acquire({ generation: 'capacity-complete', coverage: 'complete' })
  const published = cache.publish({ generation: 'replacement', coverage: 'calls', view: firstView })
  assert.deepEqual({ published, version: new DataView(cache.mapping.buffer, cache.mapping.byteOffset).getUint32(4, true), header: cache.mapping.subarray(0, 256), lowerPage: cache.mapping.subarray(4352, 24662), upperGuardAndPage: cache.mapping.subarray(32768, 55120), callsGeneration: calls?.value.mappedView.generation, completeGeneration: complete?.value.mappedView.generation, callsRows: calls?.value.mappedView.matchingSymbols({ name: 'x'.repeat(20000) }).map(({ id, name }) => ({ id, nameLength: name.length })), completeRows: complete?.value.mappedView.matchingSymbols({ name: 'x'.repeat(20000) }).map(({ id, name }) => ({ id, nameLength: name.length })) }, {
    published: false, version: 3, header: original.subarray(0, 256), lowerPage: original.subarray(4352, 24662), upperGuardAndPage: original.subarray(32768, 55120), callsGeneration: 'capacity-calls', completeGeneration: 'capacity-complete', callsRows: [{ id: 'large-id', nameLength: 20000 }], completeRows: [{ id: 'large-id', nameLength: 20000 }],
  })
  calls?.release()
  complete?.release()
  cache.dispose()
})

// Error guessing/re-entry: a publication input may be reused by a different cache instance.
test('reusing one cold publication view across caches cannot adopt another cache owner roots', () => {
  const first = createCache(new FakeMmapAdapter())
  const second = createCache(new FakeMmapAdapter())
  const view = { graph: firstView.graph }
  first.publish({ generation: 'generation-0001', coverage: 'calls', view })
  second.publish({ generation: 'generation-0001', coverage: 'calls', view: { graph: { ...secondView.graph, generation: 'generation-0001', edgeCoverage: 'calls' } } })
  const published = second.publish({ generation: 'generation-0001', coverage: 'calls', view })
  const actual = second.acquire({ generation: 'generation-0001', coverage: 'calls' })
  assert.deepEqual({ published, graph: actual?.value.mappedView.graph }, { published: true, graph: firstView.graph })
  actual?.release()
  first.dispose()
  second.dispose()
})

// Domain/input identity: equal generation strings do not make changed graph inputs interchangeable.
test('replacing a reused cold view graph under the same generation publishes the replacement rows', () => {
  const cache = createCache(new FakeMmapAdapter())
  const view = { graph: firstView.graph }
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view })
  view.graph = { ...secondView.graph, generation: 'generation-0001', edgeCoverage: 'calls' }
  const published = cache.publish({ generation: 'generation-0001', coverage: 'calls', view })
  const actual = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  assert.deepEqual({ published, graph: actual?.value.mappedView.graph }, { published: true, graph: { ...secondView.graph, generation: 'generation-0001', edgeCoverage: 'calls' } })
  actual?.release()
  cache.dispose()
})

// Boundary value analysis: literal 0/1/63/64/65/66 entries exercise the fixed chunk boundary.
test('sparse chunk boundary: 0 literal entries publish empty indexes', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const published = cache.publish({ generation: 'chunk-0', coverage: 'complete', view: { graph: {
    generation: 'chunk-0', edgeCoverage: 'complete', files: ['src/chunk.ts'],
    symbols: [

    ], edges: [],
  } } })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = data.getUint32(32, true)
  const idIndex = data.getUint32(rootOffset + 16, true)
  assert.deepEqual({ published, rootTag: data.getUint32(rootOffset, true), idIndex }, { published: true, rootTag: 7, idIndex: 0 })
  const lease = cache.acquire({ generation: 'chunk-0', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({}).map(({ id }) => id), [])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-00' }).map(({ id }) => id), [])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-99' }), [])
  lease.release()
  cache.dispose()
})

test('sparse chunk boundary: 1 literal entries publish one unsorted chunk', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const published = cache.publish({ generation: 'chunk-1', coverage: 'complete', view: { graph: {
    generation: 'chunk-1', edgeCoverage: 'complete', files: ['src/chunk.ts'],
    symbols: [
      { id: 'id-00', file: 'src/chunk.ts', name: 'name-00', kind: 'function', line: 1 },
    ], edges: [],
  } } })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = data.getUint32(32, true)
  const idIndex = data.getUint32(rootOffset + 16, true)
  assert.deepEqual({ published, rootTag: data.getUint32(rootOffset, true), indexTag: data.getUint32(idIndex, true), payloadBytes: data.getUint32(idIndex + 4, true), entries: data.getUint32(idIndex + 16, true) }, { published: true, rootTag: 7, indexTag: 9, payloadBytes: 520, entries: 1 })
  const lease = cache.acquire({ generation: 'chunk-1', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({}).map(({ id }) => id), ['id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-00' }).map(({ id }) => id), ['id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-99' }), [])
  lease.release()
  cache.dispose()
})

test('sparse chunk boundary: 63 literal entries publish one unsorted chunk', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const published = cache.publish({ generation: 'chunk-63', coverage: 'complete', view: { graph: {
    generation: 'chunk-63', edgeCoverage: 'complete', files: ['src/chunk.ts'],
    symbols: [
      { id: 'id-62', file: 'src/chunk.ts', name: 'name-62', kind: 'function', line: 1 },
      { id: 'id-61', file: 'src/chunk.ts', name: 'name-61', kind: 'function', line: 1 },
      { id: 'id-60', file: 'src/chunk.ts', name: 'name-60', kind: 'function', line: 1 },
      { id: 'id-59', file: 'src/chunk.ts', name: 'name-59', kind: 'function', line: 1 },
      { id: 'id-58', file: 'src/chunk.ts', name: 'name-58', kind: 'function', line: 1 },
      { id: 'id-57', file: 'src/chunk.ts', name: 'name-57', kind: 'function', line: 1 },
      { id: 'id-56', file: 'src/chunk.ts', name: 'name-56', kind: 'function', line: 1 },
      { id: 'id-55', file: 'src/chunk.ts', name: 'name-55', kind: 'function', line: 1 },
      { id: 'id-54', file: 'src/chunk.ts', name: 'name-54', kind: 'function', line: 1 },
      { id: 'id-53', file: 'src/chunk.ts', name: 'name-53', kind: 'function', line: 1 },
      { id: 'id-52', file: 'src/chunk.ts', name: 'name-52', kind: 'function', line: 1 },
      { id: 'id-51', file: 'src/chunk.ts', name: 'name-51', kind: 'function', line: 1 },
      { id: 'id-50', file: 'src/chunk.ts', name: 'name-50', kind: 'function', line: 1 },
      { id: 'id-49', file: 'src/chunk.ts', name: 'name-49', kind: 'function', line: 1 },
      { id: 'id-48', file: 'src/chunk.ts', name: 'name-48', kind: 'function', line: 1 },
      { id: 'id-47', file: 'src/chunk.ts', name: 'name-47', kind: 'function', line: 1 },
      { id: 'id-46', file: 'src/chunk.ts', name: 'name-46', kind: 'function', line: 1 },
      { id: 'id-45', file: 'src/chunk.ts', name: 'name-45', kind: 'function', line: 1 },
      { id: 'id-44', file: 'src/chunk.ts', name: 'name-44', kind: 'function', line: 1 },
      { id: 'id-43', file: 'src/chunk.ts', name: 'name-43', kind: 'function', line: 1 },
      { id: 'id-42', file: 'src/chunk.ts', name: 'name-42', kind: 'function', line: 1 },
      { id: 'id-41', file: 'src/chunk.ts', name: 'name-41', kind: 'function', line: 1 },
      { id: 'id-40', file: 'src/chunk.ts', name: 'name-40', kind: 'function', line: 1 },
      { id: 'id-39', file: 'src/chunk.ts', name: 'name-39', kind: 'function', line: 1 },
      { id: 'id-38', file: 'src/chunk.ts', name: 'name-38', kind: 'function', line: 1 },
      { id: 'id-37', file: 'src/chunk.ts', name: 'name-37', kind: 'function', line: 1 },
      { id: 'id-36', file: 'src/chunk.ts', name: 'name-36', kind: 'function', line: 1 },
      { id: 'id-35', file: 'src/chunk.ts', name: 'name-35', kind: 'function', line: 1 },
      { id: 'id-34', file: 'src/chunk.ts', name: 'name-34', kind: 'function', line: 1 },
      { id: 'id-33', file: 'src/chunk.ts', name: 'name-33', kind: 'function', line: 1 },
      { id: 'id-32', file: 'src/chunk.ts', name: 'name-32', kind: 'function', line: 1 },
      { id: 'id-31', file: 'src/chunk.ts', name: 'name-31', kind: 'function', line: 1 },
      { id: 'id-30', file: 'src/chunk.ts', name: 'name-30', kind: 'function', line: 1 },
      { id: 'id-29', file: 'src/chunk.ts', name: 'name-29', kind: 'function', line: 1 },
      { id: 'id-28', file: 'src/chunk.ts', name: 'name-28', kind: 'function', line: 1 },
      { id: 'id-27', file: 'src/chunk.ts', name: 'name-27', kind: 'function', line: 1 },
      { id: 'id-26', file: 'src/chunk.ts', name: 'name-26', kind: 'function', line: 1 },
      { id: 'id-25', file: 'src/chunk.ts', name: 'name-25', kind: 'function', line: 1 },
      { id: 'id-24', file: 'src/chunk.ts', name: 'name-24', kind: 'function', line: 1 },
      { id: 'id-23', file: 'src/chunk.ts', name: 'name-23', kind: 'function', line: 1 },
      { id: 'id-22', file: 'src/chunk.ts', name: 'name-22', kind: 'function', line: 1 },
      { id: 'id-21', file: 'src/chunk.ts', name: 'name-21', kind: 'function', line: 1 },
      { id: 'id-20', file: 'src/chunk.ts', name: 'name-20', kind: 'function', line: 1 },
      { id: 'id-19', file: 'src/chunk.ts', name: 'name-19', kind: 'function', line: 1 },
      { id: 'id-18', file: 'src/chunk.ts', name: 'name-18', kind: 'function', line: 1 },
      { id: 'id-17', file: 'src/chunk.ts', name: 'name-17', kind: 'function', line: 1 },
      { id: 'id-16', file: 'src/chunk.ts', name: 'name-16', kind: 'function', line: 1 },
      { id: 'id-15', file: 'src/chunk.ts', name: 'name-15', kind: 'function', line: 1 },
      { id: 'id-14', file: 'src/chunk.ts', name: 'name-14', kind: 'function', line: 1 },
      { id: 'id-13', file: 'src/chunk.ts', name: 'name-13', kind: 'function', line: 1 },
      { id: 'id-12', file: 'src/chunk.ts', name: 'name-12', kind: 'function', line: 1 },
      { id: 'id-11', file: 'src/chunk.ts', name: 'name-11', kind: 'function', line: 1 },
      { id: 'id-10', file: 'src/chunk.ts', name: 'name-10', kind: 'function', line: 1 },
      { id: 'id-09', file: 'src/chunk.ts', name: 'name-09', kind: 'function', line: 1 },
      { id: 'id-08', file: 'src/chunk.ts', name: 'name-08', kind: 'function', line: 1 },
      { id: 'id-07', file: 'src/chunk.ts', name: 'name-07', kind: 'function', line: 1 },
      { id: 'id-06', file: 'src/chunk.ts', name: 'name-06', kind: 'function', line: 1 },
      { id: 'id-05', file: 'src/chunk.ts', name: 'name-05', kind: 'function', line: 1 },
      { id: 'id-04', file: 'src/chunk.ts', name: 'name-04', kind: 'function', line: 1 },
      { id: 'id-03', file: 'src/chunk.ts', name: 'name-03', kind: 'function', line: 1 },
      { id: 'id-02', file: 'src/chunk.ts', name: 'name-02', kind: 'function', line: 1 },
      { id: 'id-01', file: 'src/chunk.ts', name: 'name-01', kind: 'function', line: 1 },
      { id: 'id-00', file: 'src/chunk.ts', name: 'name-00', kind: 'function', line: 1 },
    ], edges: [],
  } } })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = data.getUint32(32, true)
  const idIndex = data.getUint32(rootOffset + 16, true)
  assert.deepEqual({ published, rootTag: data.getUint32(rootOffset, true), indexTag: data.getUint32(idIndex, true), payloadBytes: data.getUint32(idIndex + 4, true), entries: data.getUint32(idIndex + 16, true) }, { published: true, rootTag: 7, indexTag: 9, payloadBytes: 520, entries: 63 })
  const lease = cache.acquire({ generation: 'chunk-63', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({}).map(({ id }) => id), ['id-62', 'id-61', 'id-60', 'id-59', 'id-58', 'id-57', 'id-56', 'id-55', 'id-54', 'id-53', 'id-52', 'id-51', 'id-50', 'id-49', 'id-48', 'id-47', 'id-46', 'id-45', 'id-44', 'id-43', 'id-42', 'id-41', 'id-40', 'id-39', 'id-38', 'id-37', 'id-36', 'id-35', 'id-34', 'id-33', 'id-32', 'id-31', 'id-30', 'id-29', 'id-28', 'id-27', 'id-26', 'id-25', 'id-24', 'id-23', 'id-22', 'id-21', 'id-20', 'id-19', 'id-18', 'id-17', 'id-16', 'id-15', 'id-14', 'id-13', 'id-12', 'id-11', 'id-10', 'id-09', 'id-08', 'id-07', 'id-06', 'id-05', 'id-04', 'id-03', 'id-02', 'id-01', 'id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-00' }).map(({ id }) => id), ['id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-99' }), [])
  lease.release()
  cache.dispose()
})

test('sparse chunk boundary: 64 literal entries publish one unsorted chunk', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const published = cache.publish({ generation: 'chunk-64', coverage: 'complete', view: { graph: {
    generation: 'chunk-64', edgeCoverage: 'complete', files: ['src/chunk.ts'],
    symbols: [
      { id: 'id-63', file: 'src/chunk.ts', name: 'name-63', kind: 'function', line: 1 },
      { id: 'id-62', file: 'src/chunk.ts', name: 'name-62', kind: 'function', line: 1 },
      { id: 'id-61', file: 'src/chunk.ts', name: 'name-61', kind: 'function', line: 1 },
      { id: 'id-60', file: 'src/chunk.ts', name: 'name-60', kind: 'function', line: 1 },
      { id: 'id-59', file: 'src/chunk.ts', name: 'name-59', kind: 'function', line: 1 },
      { id: 'id-58', file: 'src/chunk.ts', name: 'name-58', kind: 'function', line: 1 },
      { id: 'id-57', file: 'src/chunk.ts', name: 'name-57', kind: 'function', line: 1 },
      { id: 'id-56', file: 'src/chunk.ts', name: 'name-56', kind: 'function', line: 1 },
      { id: 'id-55', file: 'src/chunk.ts', name: 'name-55', kind: 'function', line: 1 },
      { id: 'id-54', file: 'src/chunk.ts', name: 'name-54', kind: 'function', line: 1 },
      { id: 'id-53', file: 'src/chunk.ts', name: 'name-53', kind: 'function', line: 1 },
      { id: 'id-52', file: 'src/chunk.ts', name: 'name-52', kind: 'function', line: 1 },
      { id: 'id-51', file: 'src/chunk.ts', name: 'name-51', kind: 'function', line: 1 },
      { id: 'id-50', file: 'src/chunk.ts', name: 'name-50', kind: 'function', line: 1 },
      { id: 'id-49', file: 'src/chunk.ts', name: 'name-49', kind: 'function', line: 1 },
      { id: 'id-48', file: 'src/chunk.ts', name: 'name-48', kind: 'function', line: 1 },
      { id: 'id-47', file: 'src/chunk.ts', name: 'name-47', kind: 'function', line: 1 },
      { id: 'id-46', file: 'src/chunk.ts', name: 'name-46', kind: 'function', line: 1 },
      { id: 'id-45', file: 'src/chunk.ts', name: 'name-45', kind: 'function', line: 1 },
      { id: 'id-44', file: 'src/chunk.ts', name: 'name-44', kind: 'function', line: 1 },
      { id: 'id-43', file: 'src/chunk.ts', name: 'name-43', kind: 'function', line: 1 },
      { id: 'id-42', file: 'src/chunk.ts', name: 'name-42', kind: 'function', line: 1 },
      { id: 'id-41', file: 'src/chunk.ts', name: 'name-41', kind: 'function', line: 1 },
      { id: 'id-40', file: 'src/chunk.ts', name: 'name-40', kind: 'function', line: 1 },
      { id: 'id-39', file: 'src/chunk.ts', name: 'name-39', kind: 'function', line: 1 },
      { id: 'id-38', file: 'src/chunk.ts', name: 'name-38', kind: 'function', line: 1 },
      { id: 'id-37', file: 'src/chunk.ts', name: 'name-37', kind: 'function', line: 1 },
      { id: 'id-36', file: 'src/chunk.ts', name: 'name-36', kind: 'function', line: 1 },
      { id: 'id-35', file: 'src/chunk.ts', name: 'name-35', kind: 'function', line: 1 },
      { id: 'id-34', file: 'src/chunk.ts', name: 'name-34', kind: 'function', line: 1 },
      { id: 'id-33', file: 'src/chunk.ts', name: 'name-33', kind: 'function', line: 1 },
      { id: 'id-32', file: 'src/chunk.ts', name: 'name-32', kind: 'function', line: 1 },
      { id: 'id-31', file: 'src/chunk.ts', name: 'name-31', kind: 'function', line: 1 },
      { id: 'id-30', file: 'src/chunk.ts', name: 'name-30', kind: 'function', line: 1 },
      { id: 'id-29', file: 'src/chunk.ts', name: 'name-29', kind: 'function', line: 1 },
      { id: 'id-28', file: 'src/chunk.ts', name: 'name-28', kind: 'function', line: 1 },
      { id: 'id-27', file: 'src/chunk.ts', name: 'name-27', kind: 'function', line: 1 },
      { id: 'id-26', file: 'src/chunk.ts', name: 'name-26', kind: 'function', line: 1 },
      { id: 'id-25', file: 'src/chunk.ts', name: 'name-25', kind: 'function', line: 1 },
      { id: 'id-24', file: 'src/chunk.ts', name: 'name-24', kind: 'function', line: 1 },
      { id: 'id-23', file: 'src/chunk.ts', name: 'name-23', kind: 'function', line: 1 },
      { id: 'id-22', file: 'src/chunk.ts', name: 'name-22', kind: 'function', line: 1 },
      { id: 'id-21', file: 'src/chunk.ts', name: 'name-21', kind: 'function', line: 1 },
      { id: 'id-20', file: 'src/chunk.ts', name: 'name-20', kind: 'function', line: 1 },
      { id: 'id-19', file: 'src/chunk.ts', name: 'name-19', kind: 'function', line: 1 },
      { id: 'id-18', file: 'src/chunk.ts', name: 'name-18', kind: 'function', line: 1 },
      { id: 'id-17', file: 'src/chunk.ts', name: 'name-17', kind: 'function', line: 1 },
      { id: 'id-16', file: 'src/chunk.ts', name: 'name-16', kind: 'function', line: 1 },
      { id: 'id-15', file: 'src/chunk.ts', name: 'name-15', kind: 'function', line: 1 },
      { id: 'id-14', file: 'src/chunk.ts', name: 'name-14', kind: 'function', line: 1 },
      { id: 'id-13', file: 'src/chunk.ts', name: 'name-13', kind: 'function', line: 1 },
      { id: 'id-12', file: 'src/chunk.ts', name: 'name-12', kind: 'function', line: 1 },
      { id: 'id-11', file: 'src/chunk.ts', name: 'name-11', kind: 'function', line: 1 },
      { id: 'id-10', file: 'src/chunk.ts', name: 'name-10', kind: 'function', line: 1 },
      { id: 'id-09', file: 'src/chunk.ts', name: 'name-09', kind: 'function', line: 1 },
      { id: 'id-08', file: 'src/chunk.ts', name: 'name-08', kind: 'function', line: 1 },
      { id: 'id-07', file: 'src/chunk.ts', name: 'name-07', kind: 'function', line: 1 },
      { id: 'id-06', file: 'src/chunk.ts', name: 'name-06', kind: 'function', line: 1 },
      { id: 'id-05', file: 'src/chunk.ts', name: 'name-05', kind: 'function', line: 1 },
      { id: 'id-04', file: 'src/chunk.ts', name: 'name-04', kind: 'function', line: 1 },
      { id: 'id-03', file: 'src/chunk.ts', name: 'name-03', kind: 'function', line: 1 },
      { id: 'id-02', file: 'src/chunk.ts', name: 'name-02', kind: 'function', line: 1 },
      { id: 'id-01', file: 'src/chunk.ts', name: 'name-01', kind: 'function', line: 1 },
      { id: 'id-00', file: 'src/chunk.ts', name: 'name-00', kind: 'function', line: 1 },
    ], edges: [],
  } } })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = data.getUint32(32, true)
  const idIndex = data.getUint32(rootOffset + 16, true)
  assert.deepEqual({ published, rootTag: data.getUint32(rootOffset, true), indexTag: data.getUint32(idIndex, true), payloadBytes: data.getUint32(idIndex + 4, true), entries: data.getUint32(idIndex + 16, true) }, { published: true, rootTag: 7, indexTag: 9, payloadBytes: 520, entries: 64 })
  const lease = cache.acquire({ generation: 'chunk-64', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({}).map(({ id }) => id), ['id-63', 'id-62', 'id-61', 'id-60', 'id-59', 'id-58', 'id-57', 'id-56', 'id-55', 'id-54', 'id-53', 'id-52', 'id-51', 'id-50', 'id-49', 'id-48', 'id-47', 'id-46', 'id-45', 'id-44', 'id-43', 'id-42', 'id-41', 'id-40', 'id-39', 'id-38', 'id-37', 'id-36', 'id-35', 'id-34', 'id-33', 'id-32', 'id-31', 'id-30', 'id-29', 'id-28', 'id-27', 'id-26', 'id-25', 'id-24', 'id-23', 'id-22', 'id-21', 'id-20', 'id-19', 'id-18', 'id-17', 'id-16', 'id-15', 'id-14', 'id-13', 'id-12', 'id-11', 'id-10', 'id-09', 'id-08', 'id-07', 'id-06', 'id-05', 'id-04', 'id-03', 'id-02', 'id-01', 'id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-00' }).map(({ id }) => id), ['id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-99' }), [])
  lease.release()
  cache.dispose()
})

test('sparse chunk boundary: 65 literal entries publish a local directory', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const published = cache.publish({ generation: 'chunk-65', coverage: 'complete', view: { graph: {
    generation: 'chunk-65', edgeCoverage: 'complete', files: ['src/chunk.ts'],
    symbols: [
      { id: 'id-64', file: 'src/chunk.ts', name: 'name-64', kind: 'function', line: 1 },
      { id: 'id-63', file: 'src/chunk.ts', name: 'name-63', kind: 'function', line: 1 },
      { id: 'id-62', file: 'src/chunk.ts', name: 'name-62', kind: 'function', line: 1 },
      { id: 'id-61', file: 'src/chunk.ts', name: 'name-61', kind: 'function', line: 1 },
      { id: 'id-60', file: 'src/chunk.ts', name: 'name-60', kind: 'function', line: 1 },
      { id: 'id-59', file: 'src/chunk.ts', name: 'name-59', kind: 'function', line: 1 },
      { id: 'id-58', file: 'src/chunk.ts', name: 'name-58', kind: 'function', line: 1 },
      { id: 'id-57', file: 'src/chunk.ts', name: 'name-57', kind: 'function', line: 1 },
      { id: 'id-56', file: 'src/chunk.ts', name: 'name-56', kind: 'function', line: 1 },
      { id: 'id-55', file: 'src/chunk.ts', name: 'name-55', kind: 'function', line: 1 },
      { id: 'id-54', file: 'src/chunk.ts', name: 'name-54', kind: 'function', line: 1 },
      { id: 'id-53', file: 'src/chunk.ts', name: 'name-53', kind: 'function', line: 1 },
      { id: 'id-52', file: 'src/chunk.ts', name: 'name-52', kind: 'function', line: 1 },
      { id: 'id-51', file: 'src/chunk.ts', name: 'name-51', kind: 'function', line: 1 },
      { id: 'id-50', file: 'src/chunk.ts', name: 'name-50', kind: 'function', line: 1 },
      { id: 'id-49', file: 'src/chunk.ts', name: 'name-49', kind: 'function', line: 1 },
      { id: 'id-48', file: 'src/chunk.ts', name: 'name-48', kind: 'function', line: 1 },
      { id: 'id-47', file: 'src/chunk.ts', name: 'name-47', kind: 'function', line: 1 },
      { id: 'id-46', file: 'src/chunk.ts', name: 'name-46', kind: 'function', line: 1 },
      { id: 'id-45', file: 'src/chunk.ts', name: 'name-45', kind: 'function', line: 1 },
      { id: 'id-44', file: 'src/chunk.ts', name: 'name-44', kind: 'function', line: 1 },
      { id: 'id-43', file: 'src/chunk.ts', name: 'name-43', kind: 'function', line: 1 },
      { id: 'id-42', file: 'src/chunk.ts', name: 'name-42', kind: 'function', line: 1 },
      { id: 'id-41', file: 'src/chunk.ts', name: 'name-41', kind: 'function', line: 1 },
      { id: 'id-40', file: 'src/chunk.ts', name: 'name-40', kind: 'function', line: 1 },
      { id: 'id-39', file: 'src/chunk.ts', name: 'name-39', kind: 'function', line: 1 },
      { id: 'id-38', file: 'src/chunk.ts', name: 'name-38', kind: 'function', line: 1 },
      { id: 'id-37', file: 'src/chunk.ts', name: 'name-37', kind: 'function', line: 1 },
      { id: 'id-36', file: 'src/chunk.ts', name: 'name-36', kind: 'function', line: 1 },
      { id: 'id-35', file: 'src/chunk.ts', name: 'name-35', kind: 'function', line: 1 },
      { id: 'id-34', file: 'src/chunk.ts', name: 'name-34', kind: 'function', line: 1 },
      { id: 'id-33', file: 'src/chunk.ts', name: 'name-33', kind: 'function', line: 1 },
      { id: 'id-32', file: 'src/chunk.ts', name: 'name-32', kind: 'function', line: 1 },
      { id: 'id-31', file: 'src/chunk.ts', name: 'name-31', kind: 'function', line: 1 },
      { id: 'id-30', file: 'src/chunk.ts', name: 'name-30', kind: 'function', line: 1 },
      { id: 'id-29', file: 'src/chunk.ts', name: 'name-29', kind: 'function', line: 1 },
      { id: 'id-28', file: 'src/chunk.ts', name: 'name-28', kind: 'function', line: 1 },
      { id: 'id-27', file: 'src/chunk.ts', name: 'name-27', kind: 'function', line: 1 },
      { id: 'id-26', file: 'src/chunk.ts', name: 'name-26', kind: 'function', line: 1 },
      { id: 'id-25', file: 'src/chunk.ts', name: 'name-25', kind: 'function', line: 1 },
      { id: 'id-24', file: 'src/chunk.ts', name: 'name-24', kind: 'function', line: 1 },
      { id: 'id-23', file: 'src/chunk.ts', name: 'name-23', kind: 'function', line: 1 },
      { id: 'id-22', file: 'src/chunk.ts', name: 'name-22', kind: 'function', line: 1 },
      { id: 'id-21', file: 'src/chunk.ts', name: 'name-21', kind: 'function', line: 1 },
      { id: 'id-20', file: 'src/chunk.ts', name: 'name-20', kind: 'function', line: 1 },
      { id: 'id-19', file: 'src/chunk.ts', name: 'name-19', kind: 'function', line: 1 },
      { id: 'id-18', file: 'src/chunk.ts', name: 'name-18', kind: 'function', line: 1 },
      { id: 'id-17', file: 'src/chunk.ts', name: 'name-17', kind: 'function', line: 1 },
      { id: 'id-16', file: 'src/chunk.ts', name: 'name-16', kind: 'function', line: 1 },
      { id: 'id-15', file: 'src/chunk.ts', name: 'name-15', kind: 'function', line: 1 },
      { id: 'id-14', file: 'src/chunk.ts', name: 'name-14', kind: 'function', line: 1 },
      { id: 'id-13', file: 'src/chunk.ts', name: 'name-13', kind: 'function', line: 1 },
      { id: 'id-12', file: 'src/chunk.ts', name: 'name-12', kind: 'function', line: 1 },
      { id: 'id-11', file: 'src/chunk.ts', name: 'name-11', kind: 'function', line: 1 },
      { id: 'id-10', file: 'src/chunk.ts', name: 'name-10', kind: 'function', line: 1 },
      { id: 'id-09', file: 'src/chunk.ts', name: 'name-09', kind: 'function', line: 1 },
      { id: 'id-08', file: 'src/chunk.ts', name: 'name-08', kind: 'function', line: 1 },
      { id: 'id-07', file: 'src/chunk.ts', name: 'name-07', kind: 'function', line: 1 },
      { id: 'id-06', file: 'src/chunk.ts', name: 'name-06', kind: 'function', line: 1 },
      { id: 'id-05', file: 'src/chunk.ts', name: 'name-05', kind: 'function', line: 1 },
      { id: 'id-04', file: 'src/chunk.ts', name: 'name-04', kind: 'function', line: 1 },
      { id: 'id-03', file: 'src/chunk.ts', name: 'name-03', kind: 'function', line: 1 },
      { id: 'id-02', file: 'src/chunk.ts', name: 'name-02', kind: 'function', line: 1 },
      { id: 'id-01', file: 'src/chunk.ts', name: 'name-01', kind: 'function', line: 1 },
      { id: 'id-00', file: 'src/chunk.ts', name: 'name-00', kind: 'function', line: 1 },
    ], edges: [],
  } } })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = data.getUint32(32, true)
  const idIndex = data.getUint32(rootOffset + 16, true)
  assert.deepEqual({ published, rootTag: data.getUint32(rootOffset, true), indexTag: data.getUint32(idIndex, true), payloadBytes: data.getUint32(idIndex + 4, true), entries: data.getUint32(idIndex + 24, true) }, { published: true, rootTag: 7, indexTag: 8, payloadBytes: 1040, entries: 65 })
  const lease = cache.acquire({ generation: 'chunk-65', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({}).map(({ id }) => id), ['id-64', 'id-63', 'id-62', 'id-61', 'id-60', 'id-59', 'id-58', 'id-57', 'id-56', 'id-55', 'id-54', 'id-53', 'id-52', 'id-51', 'id-50', 'id-49', 'id-48', 'id-47', 'id-46', 'id-45', 'id-44', 'id-43', 'id-42', 'id-41', 'id-40', 'id-39', 'id-38', 'id-37', 'id-36', 'id-35', 'id-34', 'id-33', 'id-32', 'id-31', 'id-30', 'id-29', 'id-28', 'id-27', 'id-26', 'id-25', 'id-24', 'id-23', 'id-22', 'id-21', 'id-20', 'id-19', 'id-18', 'id-17', 'id-16', 'id-15', 'id-14', 'id-13', 'id-12', 'id-11', 'id-10', 'id-09', 'id-08', 'id-07', 'id-06', 'id-05', 'id-04', 'id-03', 'id-02', 'id-01', 'id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-00' }).map(({ id }) => id), ['id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-99' }), [])
  lease.release()
  cache.dispose()
})

test('sparse chunk boundary: 66 literal entries publish a local directory', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const published = cache.publish({ generation: 'chunk-66', coverage: 'complete', view: { graph: {
    generation: 'chunk-66', edgeCoverage: 'complete', files: ['src/chunk.ts'],
    symbols: [
      { id: 'id-65', file: 'src/chunk.ts', name: 'name-65', kind: 'function', line: 1 },
      { id: 'id-64', file: 'src/chunk.ts', name: 'name-64', kind: 'function', line: 1 },
      { id: 'id-63', file: 'src/chunk.ts', name: 'name-63', kind: 'function', line: 1 },
      { id: 'id-62', file: 'src/chunk.ts', name: 'name-62', kind: 'function', line: 1 },
      { id: 'id-61', file: 'src/chunk.ts', name: 'name-61', kind: 'function', line: 1 },
      { id: 'id-60', file: 'src/chunk.ts', name: 'name-60', kind: 'function', line: 1 },
      { id: 'id-59', file: 'src/chunk.ts', name: 'name-59', kind: 'function', line: 1 },
      { id: 'id-58', file: 'src/chunk.ts', name: 'name-58', kind: 'function', line: 1 },
      { id: 'id-57', file: 'src/chunk.ts', name: 'name-57', kind: 'function', line: 1 },
      { id: 'id-56', file: 'src/chunk.ts', name: 'name-56', kind: 'function', line: 1 },
      { id: 'id-55', file: 'src/chunk.ts', name: 'name-55', kind: 'function', line: 1 },
      { id: 'id-54', file: 'src/chunk.ts', name: 'name-54', kind: 'function', line: 1 },
      { id: 'id-53', file: 'src/chunk.ts', name: 'name-53', kind: 'function', line: 1 },
      { id: 'id-52', file: 'src/chunk.ts', name: 'name-52', kind: 'function', line: 1 },
      { id: 'id-51', file: 'src/chunk.ts', name: 'name-51', kind: 'function', line: 1 },
      { id: 'id-50', file: 'src/chunk.ts', name: 'name-50', kind: 'function', line: 1 },
      { id: 'id-49', file: 'src/chunk.ts', name: 'name-49', kind: 'function', line: 1 },
      { id: 'id-48', file: 'src/chunk.ts', name: 'name-48', kind: 'function', line: 1 },
      { id: 'id-47', file: 'src/chunk.ts', name: 'name-47', kind: 'function', line: 1 },
      { id: 'id-46', file: 'src/chunk.ts', name: 'name-46', kind: 'function', line: 1 },
      { id: 'id-45', file: 'src/chunk.ts', name: 'name-45', kind: 'function', line: 1 },
      { id: 'id-44', file: 'src/chunk.ts', name: 'name-44', kind: 'function', line: 1 },
      { id: 'id-43', file: 'src/chunk.ts', name: 'name-43', kind: 'function', line: 1 },
      { id: 'id-42', file: 'src/chunk.ts', name: 'name-42', kind: 'function', line: 1 },
      { id: 'id-41', file: 'src/chunk.ts', name: 'name-41', kind: 'function', line: 1 },
      { id: 'id-40', file: 'src/chunk.ts', name: 'name-40', kind: 'function', line: 1 },
      { id: 'id-39', file: 'src/chunk.ts', name: 'name-39', kind: 'function', line: 1 },
      { id: 'id-38', file: 'src/chunk.ts', name: 'name-38', kind: 'function', line: 1 },
      { id: 'id-37', file: 'src/chunk.ts', name: 'name-37', kind: 'function', line: 1 },
      { id: 'id-36', file: 'src/chunk.ts', name: 'name-36', kind: 'function', line: 1 },
      { id: 'id-35', file: 'src/chunk.ts', name: 'name-35', kind: 'function', line: 1 },
      { id: 'id-34', file: 'src/chunk.ts', name: 'name-34', kind: 'function', line: 1 },
      { id: 'id-33', file: 'src/chunk.ts', name: 'name-33', kind: 'function', line: 1 },
      { id: 'id-32', file: 'src/chunk.ts', name: 'name-32', kind: 'function', line: 1 },
      { id: 'id-31', file: 'src/chunk.ts', name: 'name-31', kind: 'function', line: 1 },
      { id: 'id-30', file: 'src/chunk.ts', name: 'name-30', kind: 'function', line: 1 },
      { id: 'id-29', file: 'src/chunk.ts', name: 'name-29', kind: 'function', line: 1 },
      { id: 'id-28', file: 'src/chunk.ts', name: 'name-28', kind: 'function', line: 1 },
      { id: 'id-27', file: 'src/chunk.ts', name: 'name-27', kind: 'function', line: 1 },
      { id: 'id-26', file: 'src/chunk.ts', name: 'name-26', kind: 'function', line: 1 },
      { id: 'id-25', file: 'src/chunk.ts', name: 'name-25', kind: 'function', line: 1 },
      { id: 'id-24', file: 'src/chunk.ts', name: 'name-24', kind: 'function', line: 1 },
      { id: 'id-23', file: 'src/chunk.ts', name: 'name-23', kind: 'function', line: 1 },
      { id: 'id-22', file: 'src/chunk.ts', name: 'name-22', kind: 'function', line: 1 },
      { id: 'id-21', file: 'src/chunk.ts', name: 'name-21', kind: 'function', line: 1 },
      { id: 'id-20', file: 'src/chunk.ts', name: 'name-20', kind: 'function', line: 1 },
      { id: 'id-19', file: 'src/chunk.ts', name: 'name-19', kind: 'function', line: 1 },
      { id: 'id-18', file: 'src/chunk.ts', name: 'name-18', kind: 'function', line: 1 },
      { id: 'id-17', file: 'src/chunk.ts', name: 'name-17', kind: 'function', line: 1 },
      { id: 'id-16', file: 'src/chunk.ts', name: 'name-16', kind: 'function', line: 1 },
      { id: 'id-15', file: 'src/chunk.ts', name: 'name-15', kind: 'function', line: 1 },
      { id: 'id-14', file: 'src/chunk.ts', name: 'name-14', kind: 'function', line: 1 },
      { id: 'id-13', file: 'src/chunk.ts', name: 'name-13', kind: 'function', line: 1 },
      { id: 'id-12', file: 'src/chunk.ts', name: 'name-12', kind: 'function', line: 1 },
      { id: 'id-11', file: 'src/chunk.ts', name: 'name-11', kind: 'function', line: 1 },
      { id: 'id-10', file: 'src/chunk.ts', name: 'name-10', kind: 'function', line: 1 },
      { id: 'id-09', file: 'src/chunk.ts', name: 'name-09', kind: 'function', line: 1 },
      { id: 'id-08', file: 'src/chunk.ts', name: 'name-08', kind: 'function', line: 1 },
      { id: 'id-07', file: 'src/chunk.ts', name: 'name-07', kind: 'function', line: 1 },
      { id: 'id-06', file: 'src/chunk.ts', name: 'name-06', kind: 'function', line: 1 },
      { id: 'id-05', file: 'src/chunk.ts', name: 'name-05', kind: 'function', line: 1 },
      { id: 'id-04', file: 'src/chunk.ts', name: 'name-04', kind: 'function', line: 1 },
      { id: 'id-03', file: 'src/chunk.ts', name: 'name-03', kind: 'function', line: 1 },
      { id: 'id-02', file: 'src/chunk.ts', name: 'name-02', kind: 'function', line: 1 },
      { id: 'id-01', file: 'src/chunk.ts', name: 'name-01', kind: 'function', line: 1 },
      { id: 'id-00', file: 'src/chunk.ts', name: 'name-00', kind: 'function', line: 1 },
    ], edges: [],
  } } })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const rootOffset = data.getUint32(32, true)
  const idIndex = data.getUint32(rootOffset + 16, true)
  assert.deepEqual({ published, rootTag: data.getUint32(rootOffset, true), indexTag: data.getUint32(idIndex, true), payloadBytes: data.getUint32(idIndex + 4, true), entries: data.getUint32(idIndex + 24, true) }, { published: true, rootTag: 7, indexTag: 8, payloadBytes: 1040, entries: 66 })
  const lease = cache.acquire({ generation: 'chunk-66', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({}).map(({ id }) => id), ['id-65', 'id-64', 'id-63', 'id-62', 'id-61', 'id-60', 'id-59', 'id-58', 'id-57', 'id-56', 'id-55', 'id-54', 'id-53', 'id-52', 'id-51', 'id-50', 'id-49', 'id-48', 'id-47', 'id-46', 'id-45', 'id-44', 'id-43', 'id-42', 'id-41', 'id-40', 'id-39', 'id-38', 'id-37', 'id-36', 'id-35', 'id-34', 'id-33', 'id-32', 'id-31', 'id-30', 'id-29', 'id-28', 'id-27', 'id-26', 'id-25', 'id-24', 'id-23', 'id-22', 'id-21', 'id-20', 'id-19', 'id-18', 'id-17', 'id-16', 'id-15', 'id-14', 'id-13', 'id-12', 'id-11', 'id-10', 'id-09', 'id-08', 'id-07', 'id-06', 'id-05', 'id-04', 'id-03', 'id-02', 'id-01', 'id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-00' }).map(({ id }) => id), ['id-00'])
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ id: 'id-99' }), [])
  lease.release()
  cache.dispose()
})

// Error guessing: cold construction must not quietly retain the old whole-index sort.
test('sparse publication never sorts cold lookup entries', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const originalSort = Array.prototype.sort
  let published
  try {
    Array.prototype.sort = () => { throw new Error('cold publication sorted lookup entries') }
    published = cache.publish({ generation: 'unsorted-cold', coverage: 'complete', view: { graph: {
      generation: 'unsorted-cold', edgeCoverage: 'complete', files: ['src/a.ts'],
      symbols: [
        { id: 'z-id', file: 'src/a.ts', name: 'z', kind: 'function', line: 1 },
        { id: 'a-id', file: 'src/a.ts', name: 'a', kind: 'function', line: 2 },
      ], edges: [],
    } } })
  } finally { Array.prototype.sort = originalSort }
  assert.equal(published, true)
  cache.dispose()
})

// Equivalence partition/domain analysis: migrate real cached bytes, not a fixture from the new writer.
test('sparse migration preserves both genuine AVL v4 roots and duplicate endpoint identity', () => {
  const adapter = new FakeMmapAdapter()
  adapter.files.set('/virtual/query-view-cache.bin', new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v4.bin'))))
  const cache = createCache(adapter)
  const calls = cache.acquire({ generation: 'fixture-v4-calls', coverage: 'calls' })
  const complete = cache.acquire({ generation: 'fixture-v4-complete', coverage: 'complete' })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  assert.deepEqual({ version: data.getUint32(4, true), currentTag: data.getUint32(data.getUint32(32, true), true), previousTag: data.getUint32(data.getUint32(48, true), true), calls: calls?.value.mappedView.graph, complete: complete?.value.mappedView.graph, duplicateIncoming: calls?.value.mappedView.relationships({ id: 'same-id' }, 'incoming'), unicodeIncoming: complete?.value.mappedView.relationships({ name: 'é😀' }, 'incoming') }, {
    version: 4, currentTag: 7, previousTag: 7,
    calls: {
      generation: 'fixture-v4-calls', edgeCoverage: 'calls', files: ['src/a.ts', 'src/é.ts'],
      symbols: [
        { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'same-id', file: 'src/é.ts', name: 'é😀', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 1, exported: true },
      ],
      edges: [{ from: 'same-id', to: 'same-id', line: 3, call: true }, { from: 'same-id', to: 'same-id', line: 3, call: true }],
      unresolvedEdges: [{ from: 'same-id', to: 'missing-id', line: 4, reason: 'unresolved target' }],
    },
    complete: {
      generation: 'fixture-v4-complete', edgeCoverage: 'complete', files: ['src/a.ts', 'src/é.ts'],
      symbols: [
        { id: 'caller-id', file: 'src/a.ts', name: 'caller', kind: 'function', line: 2, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
        { id: 'target-id', file: 'src/é.ts', name: 'é😀', kind: 'function', line: 7, qualifiedPath: '<module>', signature: '<>():number', ordinal: 0, exported: true },
      ],
      edges: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 4, call: false }],
      unresolvedEdges: [{ from: 'caller-id', to: 'missing-id', line: 3, reason: 'unresolved target' }],
    },
    duplicateIncoming: [],
    unicodeIncoming: [{ from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 2, call: true }, { from: 'caller-id', to: 'target-id', line: 4, call: false }],
  })
  calls?.release()
  complete?.release()
  cache.dispose()
})

// Combinatorial/error guessing: failed migration must retain both old authenticated descriptors.
test('sparse AVL v4 migration header failure keeps the old roots readable across retry and reopen', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const original = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'query-view-cache-v4.bin')))
  adapter.files.set('/virtual/query-view-cache.bin', original.slice())
  adapter.flush = (mapping, offset, length) => {
    if (offset === 0) throw new Error('migration header flush fails')
    adapter.files.get(mapping.handle.filePath).set(mapping.subarray(offset, offset + length), offset)
  }
  const failed = createCache(adapter)
  const old = failed.acquire({ generation: 'fixture-v4-calls', coverage: 'calls' })
  adapter.flush = SparseLifecycleMmapAdapter.prototype.flush
  const clonedOldLayout = failed.cloneGeneration({ fromGeneration: 'fixture-v4-calls', generation: 'invalid-layout-clone', coverage: 'calls' })
  assert.deepEqual({ clonedOldLayout, header: failed.mapping.subarray(0, 256), pinnedRows: old?.value.mappedView.matchingSymbols({ id: 'same-id' }).map(({ name }) => name) }, { clonedOldLayout: false, header: original.subarray(0, 256), pinnedRows: ['first', 'é😀'] })
  failed.dispose()
  adapter.flush = SparseLifecycleMmapAdapter.prototype.flush
  const retried = createCache(adapter)
  const current = retried.acquire({ generation: 'fixture-v4-complete', coverage: 'complete' })
  assert.deepEqual({ pinnedRows: old?.value.mappedView.matchingSymbols({ id: 'same-id' }).map(({ name }) => name), currentRows: current?.value.mappedView.matchingSymbols({ name: 'é😀' }).map(({ id }) => id) }, { pinnedRows: ['first', 'é😀'], currentRows: ['target-id'] })
  current?.release()
  old?.release()
  retried.dispose()
})

// Equivalence partition/error guessing: escaped NUL and multibyte keys must never alias prefixes.
test('sparse exact names distinguish empty names NUL prefixes Unicode and longer names', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  cache.publish({ generation: 'escaped-keys', coverage: 'complete', view: { graph: {
    generation: 'escaped-keys', edgeCoverage: 'complete', files: ['src/keys.ts'],
    symbols: [
      { id: 'empty', file: 'src/keys.ts', name: '', kind: 'function', line: 1 },
      { id: 'a', file: 'src/keys.ts', name: 'a', kind: 'function', line: 2 },
      { id: 'nul', file: 'src/keys.ts', name: 'a\u0000', kind: 'function', line: 3 },
      { id: 'long', file: 'src/keys.ts', name: 'ab', kind: 'function', line: 4 },
      { id: 'unicode', file: 'src/keys.ts', name: 'é😀', kind: 'function', line: 5 },
    ], edges: [],
  } } })
  const lease = cache.acquire({ generation: 'escaped-keys', coverage: 'complete' })
  assert.deepEqual(lease.value.mappedView.matchingSymbols({ name: 'a\u0000' }).map(({ id }) => id), ['nul'])
  lease.release()
  cache.dispose()
})

// Equivalence partition/error guessing: valid CRC is not proof of a valid lookup structure.

// Combinatorial/error guessing: a failed split must not consume or overwrite committed pages.
test('sparse failed split header publication retries from the old cursor and preserves its pinned chunk', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter)
  const oldPartition = { symbols: [
      { id: 'id-00', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-01', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-02', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-03', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-04', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-05', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-06', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-07', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-08', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-09', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-10', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-11', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-12', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-13', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-14', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-15', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-16', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-17', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-18', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-19', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-20', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-21', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-22', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-23', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-24', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-25', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-26', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-27', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-28', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-29', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-30', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-31', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-32', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-33', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-34', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-35', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-36', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-37', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-38', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-39', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-40', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-41', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-42', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-43', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-44', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-45', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-46', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-47', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-48', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-49', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-50', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-51', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-52', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-53', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-54', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-55', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-56', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-57', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-58', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-59', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-60', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-61', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-62', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'id-63', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 },
  ], edges: [] }
  cache.publish({ generation: 'split-before', coverage: 'complete', view: { graph: { generation: 'split-before', edgeCoverage: 'complete', files: ['src/split.ts'], symbols: oldPartition.symbols, edges: [] } } })
  const pinned = cache.acquire({ generation: 'split-before', coverage: 'complete' })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const oldRoot = data.getUint32(32, true), oldCursor = data.getUint32(oldRoot + 72, true)
  const oldBytes = cache.mapping.slice(4352, oldCursor)
  const view = { parent: pinned.value.mappedView, file: 'src/split.ts', oldPartition,
    newPartition: { symbols: [...oldPartition.symbols, { id: 'id-64', file: 'src/split.ts', name: 'sharedName', kind: 'function', line: 1 }], edges: [] },
    publicationChanges: { groups: [] },
  }
  adapter.flush = (mapping, offset, length) => {
    if (offset === 0) throw new Error('split header flush failed')
    adapter.files.get(mapping.handle.filePath).set(mapping.subarray(offset, offset + length), offset)
  }
  const failed = cache.publish({ generation: 'split-after', coverage: 'complete', view })
  adapter.flush = SparseLifecycleMmapAdapter.prototype.flush
  adapter.flushRanges.length = 0
  const retried = cache.publish({ generation: 'split-after', coverage: 'complete', view })
  const current = cache.acquire({ generation: 'split-after', coverage: 'complete' })
  const newRoot = data.getUint32(32 + data.getUint32(16, true) * 16, true)
  assert.deepEqual({ failed, retried, oldBytes: cache.mapping.subarray(4352, oldCursor), retryStartsAtOldCursor: adapter.flushRanges[0]?.offset === oldCursor, oldRows: pinned.value.mappedView.matchingSymbols({ id: 'id-64' }).map(({ id }) => id), newRows: current?.value.mappedView.matchingSymbols({ id: 'id-64' }).map(({ id }) => id), newIdIndexTag: data.getUint32(data.getUint32(newRoot + 16, true), true) }, { failed: false, retried: true, oldBytes, retryStartsAtOldCursor: true, oldRows: [], newRows: ['id-64'], newIdIndexTag: 8 })
  current?.release()
  pinned.release()
  cache.dispose()
})


// Domain analysis: divergence before an existing compressed hint creates a parent without replacing its subtree.
test('sparse insertion before a compressed hint retains the old directory and its complete name group', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  const oldPartition = { symbols: [
      { id: 'prefix-long-00', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-01', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-02', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-03', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-04', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-05', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-06', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-07', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-08', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-09', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-10', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-11', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-12', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-13', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-14', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-15', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-16', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-17', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-18', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-19', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-20', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-21', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-22', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-23', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-24', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-25', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-26', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-27', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-28', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-29', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-30', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-31', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-32', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-33', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-34', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-35', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-36', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-37', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-38', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-39', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-40', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-41', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-42', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-43', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-44', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-45', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-46', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-47', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-48', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-49', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-50', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-51', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-52', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-53', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-54', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-55', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-56', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-57', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-58', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-59', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-60', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-61', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-62', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-63', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
      { id: 'prefix-long-64', file: 'src/hint.ts', name: 'sharedName', kind: 'function', line: 1 },
  ], edges: [] }
  cache.publish({ generation: 'hint-before', coverage: 'complete', view: { graph: { generation: 'hint-before', edgeCoverage: 'complete', files: ['src/hint.ts'], symbols: oldPartition.symbols, edges: [] } } })
  const pinned = cache.acquire({ generation: 'hint-before', coverage: 'complete' })
  const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
  const oldRoot = data.getUint32(32, true), oldIdIndex = data.getUint32(oldRoot + 16, true)
  const published = cache.publish({ generation: 'hint-after', coverage: 'complete', view: {
    parent: pinned.value.mappedView, file: 'src/hint.ts', oldPartition,
    newPartition: { symbols: [...oldPartition.symbols, { id: 'a', file: 'src/hint.ts', name: 'short', kind: 'function', line: 1 }], edges: [] },
    publicationChanges: { groups: [] },
  } })
  const lease = cache.acquire({ generation: 'hint-after', coverage: 'complete' })
  const root = data.getUint32(32 + data.getUint32(16, true) * 16, true), newIdIndex = data.getUint32(root + 16, true)
  assert.deepEqual({ published, branchDepth: data.getUint32(newIdIndex + 16, true), retainedOldDirectory: data.getUint32(newIdIndex + 480, true) === oldIdIndex, newRows: lease?.value.mappedView.matchingSymbols({ id: 'a' }).map(({ id }) => id), sharedNameRows: lease?.value.mappedView.matchingSymbols({ name: 'sharedName' }).length, oldRows: pinned.value.mappedView.matchingSymbols({ id: 'a' }) }, { published: true, branchDepth: 0, retainedOldDirectory: true, newRows: ['a'], sharedNameRows: 65, oldRows: [] })
  lease?.release()
  pinned.release()
  cache.dispose()
})

// Boundary value analysis: fixed-capacity acceptance is exact, not a rounded estimate.
// Combinatorial/error guessing: clone has no payload changes but must obey the same commit rules.
test('sparse clone without a pin retains calls rows and publishes only a new generation root', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const cloned = cache.cloneGeneration({ fromGeneration: 'generation-0001', generation: 'clone-calls', coverage: 'calls' })
  const lease = cache.acquire({ generation: 'clone-calls', coverage: 'calls' })
  assert.deepEqual({ cloned, graph: lease?.value.mappedView.graph }, { cloned: true, graph: { ...firstView.graph, generation: 'clone-calls' } })
  lease?.release()
  cache.dispose()
})

test('sparse failed clone flush retains the old pinned generation and never publishes the clone', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const pinned = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  adapter.failFlush = true
  const cloned = cache.cloneGeneration({ fromGeneration: 'generation-0001', generation: 'clone-failed', coverage: 'calls' })
  assert.deepEqual({ cloned, old: pinned.value.mappedView.graph, replacement: cache.acquire({ generation: 'clone-failed', coverage: 'calls' }) }, { cloned: false, old: firstView.graph, replacement: null })
  pinned.release()
  cache.dispose()
})

test('sparse cold publication fits exactly at the final aligned root byte', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter, 6288)
  const published = cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
  assert.deepEqual({ published, graph: lease?.value.mappedView.graph, finalDataFlush: adapter.flushRanges[0] }, { published: true, graph: firstView.graph, finalDataFlush: { offset: 4352, length: 1936 } })
  lease?.release()
  cache.dispose()
})

test('sparse cold publication one byte short leaves no committed generation', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter, 6287)
  const published = cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  assert.deepEqual({ published, lease: cache.acquire({ generation: 'generation-0001', coverage: 'calls' }), flushes: adapter.flushRanges }, { published: false, lease: null, flushes: [] })
  cache.dispose()
})

// Domain analysis: a local deletion can swap the last pair ahead of earlier duplicate occurrences.
// Domain analysis/combinatorial: change one duplicate edge group while another group stays pinned.
test('sparse delta replaces one duplicate relationship group and preserves the untouched group and old pin', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  cache.publish({ generation: 'edges-before', coverage: 'complete', view: { graph: {
    generation: 'edges-before', edgeCoverage: 'complete', files: ['src/a.ts'],
    symbols: [
      { id: 'caller', file: 'src/a.ts', name: 'caller', kind: 'function', line: 1 },
      { id: 'target', file: 'src/a.ts', name: 'target', kind: 'function', line: 2 },
    ], edges: [
      { from: 'caller', to: 'target', line: 2, call: true },
      { from: 'caller', to: 'target', line: 2, call: false },
      { from: 'caller', to: 'target', line: 3, call: true },
    ],
  } } })
  const pinned = cache.acquire({ generation: 'edges-before', coverage: 'complete' })
  const published = cache.publish({ generation: 'edges-after', coverage: 'complete', view: {
    parent: pinned.value.mappedView, file: 'src/a.ts',
    oldPartition: { symbols: [
      { id: 'caller', file: 'src/a.ts', name: 'caller', kind: 'function', line: 1 },
      { id: 'target', file: 'src/a.ts', name: 'target', kind: 'function', line: 2 },
    ], edges: [
      { from: 'caller', to: 'target', line: 2, call: true },
      { from: 'caller', to: 'target', line: 2, call: false },
      { from: 'caller', to: 'target', line: 3, call: true },
    ] },
    newPartition: { symbols: [
      { id: 'caller', file: 'src/a.ts', name: 'caller', kind: 'function', line: 1 },
      { id: 'target', file: 'src/a.ts', name: 'target', kind: 'function', line: 2 },
    ], edges: [
      { from: 'caller', to: 'target', line: 2, call: false },
      { from: 'caller', to: 'target', line: 3, call: true },
    ] }, publicationChanges: { groups: [{ from: 'caller', to: 'target', line: 2, before: { edges: [{ from: 'caller', to: 'target', line: 2, call: true }, { from: 'caller', to: 'target', line: 2, call: false }] }, after: { edges: [{ from: 'caller', to: 'target', line: 2, call: false }] } }] },
  } })
  const current = cache.acquire({ generation: 'edges-after', coverage: 'complete' })
  assert.deepEqual({ published, incoming: current?.value.mappedView.relationships({ id: 'target' }, 'incoming'), oldIncoming: pinned.value.mappedView.relationships({ id: 'target' }, 'incoming') }, {
    published: true,
    incoming: [{ from: 'caller', to: 'target', line: 2, call: false }, { from: 'caller', to: 'target', line: 3, call: true }],
    oldIncoming: [{ from: 'caller', to: 'target', line: 2, call: true }, { from: 'caller', to: 'target', line: 2, call: false }, { from: 'caller', to: 'target', line: 3, call: true }],
  })
  current?.release()
  pinned.release()
  cache.dispose()
})

test('sparse duplicate ID updates retain first occurrence ordering after a preceding pair is deleted', () => {
  const cache = createCache(new SparseLifecycleMmapAdapter())
  cache.publish({ generation: 'duplicate-before-delete', coverage: 'complete', view: { graph: {
    generation: 'duplicate-before-delete', edgeCoverage: 'complete', files: ['src/a.ts'],
    symbols: [
      { id: 'removed-id', file: 'src/a.ts', name: 'removed', kind: 'function', line: 0 },
      { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1 },
      { id: 'same-id', file: 'src/a.ts', name: 'last', kind: 'function', line: 2 },
    ], edges: [],
  } } })
  const before = cache.acquire({ generation: 'duplicate-before-delete', coverage: 'complete' })
  const deleted = cache.publish({ generation: 'duplicate-after-delete', coverage: 'complete', view: {
    parent: before.value.mappedView, file: 'src/a.ts',
    oldPartition: { symbols: [
      { id: 'removed-id', file: 'src/a.ts', name: 'removed', kind: 'function', line: 0 },
      { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1 },
      { id: 'same-id', file: 'src/a.ts', name: 'last', kind: 'function', line: 2 },
    ], edges: [] },
    newPartition: { symbols: [
      { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1 },
      { id: 'same-id', file: 'src/a.ts', name: 'last', kind: 'function', line: 2 },
    ], edges: [] }, publicationChanges: { groups: [] },
  } })
  const parent = cache.acquire({ generation: 'duplicate-after-delete', coverage: 'complete' })
  const updated = cache.publish({ generation: 'duplicate-after-update', coverage: 'complete', view: {
    parent: parent.value.mappedView, file: 'src/a.ts',
    oldPartition: { symbols: [
      { id: 'same-id', file: 'src/a.ts', name: 'first', kind: 'function', line: 1 },
      { id: 'same-id', file: 'src/a.ts', name: 'last', kind: 'function', line: 2 },
    ], edges: [] },
    newPartition: { symbols: [
      { id: 'same-id', file: 'src/a.ts', name: 'first-changed', kind: 'function', line: 10 },
      { id: 'same-id', file: 'src/a.ts', name: 'last-changed', kind: 'function', line: 20 },
    ], edges: [] }, publicationChanges: { groups: [] },
  } })
  const current = cache.acquire({ generation: 'duplicate-after-update', coverage: 'complete' })
  assert.deepEqual({ deleted, updated, names: current?.value.mappedView.matchingSymbols({ id: 'same-id' }).map(({ name }) => name), originalNames: before.value.mappedView.matchingSymbols({ id: 'same-id' }).map(({ name }) => name) }, { deleted: true, updated: true, names: ['first-changed', 'last-changed'], originalNames: ['first', 'last'] })
  current?.release()
  parent?.release()
  before.release()
  cache.dispose()
})

for (const { name, field, value } of [
  { name: 'an authenticated chunk count of 65', field: 16, value: 65 },
  { name: 'an authenticated nonzero chunk reserved field', field: 20, value: 1 },
  { name: 'an unsupported authenticated lookup record tag', field: 0, value: 10 },
]) {
  test(`sparse structural corruption rejects ${name}`, () => {
    const cache = createCache(new SparseLifecycleMmapAdapter())
    cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
    const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })
    const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
    const root = data.getUint32(32, true), chunk = data.getUint32(root + 16, true)
    data.setUint32(chunk + field, value, true)
    data.setUint32(chunk + 8, crc32(cache.mapping.subarray(chunk + 16, chunk + 536)), true)
    assert.throws(() => lease.value.mappedView.matchingSymbols({ id: 'symbol-a' }), /invalid mapped lookup/)
    lease.release()
    cache.dispose()
  })
}

// Equivalence partition/error guessing: authenticate malformed directory fields before lookup.
for (const { name, damage } of [
  { name: 'a directory branch beyond its hint key', damage: (data, offset) => data.setUint32(offset + 16, 1000000, true) },
  { name: 'a directory hint pointing outside record storage', damage: (data, offset) => data.setUint32(offset + 20, 0, true) },
  { name: 'a nonzero directory reserved field', damage: (data, offset) => data.setUint32(offset + 28, 1, true) },
  { name: 'a selected child beyond the mapping capacity', damage: (data, offset) => data.setUint32(offset + 224, 65536, true) },
  { name: 'a self child whose traversal depth cannot increase', damage: (data, offset) => data.setUint32(offset + 224, offset, true) },
]) {
  test(`sparse structural corruption rejects ${name}`, () => {
    const cache = createCache(new SparseLifecycleMmapAdapter())
    cache.publish({ generation: 'malformed-directory', coverage: 'complete', view: { graph: {
      generation: 'malformed-directory', edgeCoverage: 'complete', files: ['src/chunk.ts'],
      symbols: [
        { id: 'id-64', file: 'src/chunk.ts', name: 'name-64', kind: 'function', line: 1 },
        { id: 'id-63', file: 'src/chunk.ts', name: 'name-63', kind: 'function', line: 1 },
        { id: 'id-62', file: 'src/chunk.ts', name: 'name-62', kind: 'function', line: 1 },
        { id: 'id-61', file: 'src/chunk.ts', name: 'name-61', kind: 'function', line: 1 },
        { id: 'id-60', file: 'src/chunk.ts', name: 'name-60', kind: 'function', line: 1 },
        { id: 'id-59', file: 'src/chunk.ts', name: 'name-59', kind: 'function', line: 1 },
        { id: 'id-58', file: 'src/chunk.ts', name: 'name-58', kind: 'function', line: 1 },
        { id: 'id-57', file: 'src/chunk.ts', name: 'name-57', kind: 'function', line: 1 },
        { id: 'id-56', file: 'src/chunk.ts', name: 'name-56', kind: 'function', line: 1 },
        { id: 'id-55', file: 'src/chunk.ts', name: 'name-55', kind: 'function', line: 1 },
        { id: 'id-54', file: 'src/chunk.ts', name: 'name-54', kind: 'function', line: 1 },
        { id: 'id-53', file: 'src/chunk.ts', name: 'name-53', kind: 'function', line: 1 },
        { id: 'id-52', file: 'src/chunk.ts', name: 'name-52', kind: 'function', line: 1 },
        { id: 'id-51', file: 'src/chunk.ts', name: 'name-51', kind: 'function', line: 1 },
        { id: 'id-50', file: 'src/chunk.ts', name: 'name-50', kind: 'function', line: 1 },
        { id: 'id-49', file: 'src/chunk.ts', name: 'name-49', kind: 'function', line: 1 },
        { id: 'id-48', file: 'src/chunk.ts', name: 'name-48', kind: 'function', line: 1 },
        { id: 'id-47', file: 'src/chunk.ts', name: 'name-47', kind: 'function', line: 1 },
        { id: 'id-46', file: 'src/chunk.ts', name: 'name-46', kind: 'function', line: 1 },
        { id: 'id-45', file: 'src/chunk.ts', name: 'name-45', kind: 'function', line: 1 },
        { id: 'id-44', file: 'src/chunk.ts', name: 'name-44', kind: 'function', line: 1 },
        { id: 'id-43', file: 'src/chunk.ts', name: 'name-43', kind: 'function', line: 1 },
        { id: 'id-42', file: 'src/chunk.ts', name: 'name-42', kind: 'function', line: 1 },
        { id: 'id-41', file: 'src/chunk.ts', name: 'name-41', kind: 'function', line: 1 },
        { id: 'id-40', file: 'src/chunk.ts', name: 'name-40', kind: 'function', line: 1 },
        { id: 'id-39', file: 'src/chunk.ts', name: 'name-39', kind: 'function', line: 1 },
        { id: 'id-38', file: 'src/chunk.ts', name: 'name-38', kind: 'function', line: 1 },
        { id: 'id-37', file: 'src/chunk.ts', name: 'name-37', kind: 'function', line: 1 },
        { id: 'id-36', file: 'src/chunk.ts', name: 'name-36', kind: 'function', line: 1 },
        { id: 'id-35', file: 'src/chunk.ts', name: 'name-35', kind: 'function', line: 1 },
        { id: 'id-34', file: 'src/chunk.ts', name: 'name-34', kind: 'function', line: 1 },
        { id: 'id-33', file: 'src/chunk.ts', name: 'name-33', kind: 'function', line: 1 },
        { id: 'id-32', file: 'src/chunk.ts', name: 'name-32', kind: 'function', line: 1 },
        { id: 'id-31', file: 'src/chunk.ts', name: 'name-31', kind: 'function', line: 1 },
        { id: 'id-30', file: 'src/chunk.ts', name: 'name-30', kind: 'function', line: 1 },
        { id: 'id-29', file: 'src/chunk.ts', name: 'name-29', kind: 'function', line: 1 },
        { id: 'id-28', file: 'src/chunk.ts', name: 'name-28', kind: 'function', line: 1 },
        { id: 'id-27', file: 'src/chunk.ts', name: 'name-27', kind: 'function', line: 1 },
        { id: 'id-26', file: 'src/chunk.ts', name: 'name-26', kind: 'function', line: 1 },
        { id: 'id-25', file: 'src/chunk.ts', name: 'name-25', kind: 'function', line: 1 },
        { id: 'id-24', file: 'src/chunk.ts', name: 'name-24', kind: 'function', line: 1 },
        { id: 'id-23', file: 'src/chunk.ts', name: 'name-23', kind: 'function', line: 1 },
        { id: 'id-22', file: 'src/chunk.ts', name: 'name-22', kind: 'function', line: 1 },
        { id: 'id-21', file: 'src/chunk.ts', name: 'name-21', kind: 'function', line: 1 },
        { id: 'id-20', file: 'src/chunk.ts', name: 'name-20', kind: 'function', line: 1 },
        { id: 'id-19', file: 'src/chunk.ts', name: 'name-19', kind: 'function', line: 1 },
        { id: 'id-18', file: 'src/chunk.ts', name: 'name-18', kind: 'function', line: 1 },
        { id: 'id-17', file: 'src/chunk.ts', name: 'name-17', kind: 'function', line: 1 },
        { id: 'id-16', file: 'src/chunk.ts', name: 'name-16', kind: 'function', line: 1 },
        { id: 'id-15', file: 'src/chunk.ts', name: 'name-15', kind: 'function', line: 1 },
        { id: 'id-14', file: 'src/chunk.ts', name: 'name-14', kind: 'function', line: 1 },
        { id: 'id-13', file: 'src/chunk.ts', name: 'name-13', kind: 'function', line: 1 },
        { id: 'id-12', file: 'src/chunk.ts', name: 'name-12', kind: 'function', line: 1 },
        { id: 'id-11', file: 'src/chunk.ts', name: 'name-11', kind: 'function', line: 1 },
        { id: 'id-10', file: 'src/chunk.ts', name: 'name-10', kind: 'function', line: 1 },
        { id: 'id-09', file: 'src/chunk.ts', name: 'name-09', kind: 'function', line: 1 },
        { id: 'id-08', file: 'src/chunk.ts', name: 'name-08', kind: 'function', line: 1 },
        { id: 'id-07', file: 'src/chunk.ts', name: 'name-07', kind: 'function', line: 1 },
        { id: 'id-06', file: 'src/chunk.ts', name: 'name-06', kind: 'function', line: 1 },
        { id: 'id-05', file: 'src/chunk.ts', name: 'name-05', kind: 'function', line: 1 },
        { id: 'id-04', file: 'src/chunk.ts', name: 'name-04', kind: 'function', line: 1 },
        { id: 'id-03', file: 'src/chunk.ts', name: 'name-03', kind: 'function', line: 1 },
        { id: 'id-02', file: 'src/chunk.ts', name: 'name-02', kind: 'function', line: 1 },
        { id: 'id-01', file: 'src/chunk.ts', name: 'name-01', kind: 'function', line: 1 },
        { id: 'id-00', file: 'src/chunk.ts', name: 'name-00', kind: 'function', line: 1 },
      ], edges: [],
    } } })
    const lease = cache.acquire({ generation: 'malformed-directory', coverage: 'complete' })
    const data = new DataView(cache.mapping.buffer, cache.mapping.byteOffset)
    const root = data.getUint32(32, true), directory = data.getUint32(root + 16, true)
    damage(data, directory)
    data.setUint32(directory + 8, crc32(cache.mapping.subarray(directory + 16, directory + 1056)), true)
    assert.throws(() => lease.value.mappedView.matchingSymbols({ id: 'id-00' }), /invalid mapped|offset out of bounds/)
    lease.release()
    cache.dispose()
  })
}
