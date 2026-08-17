import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MmapQueryCache } from '../mmap-query-cache.mjs'

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

test('domain analysis: publication flushes only used inactive-page bytes and then the fixed header', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter)

  const published = cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const bytes = cache.mapping
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pageOffset = header.getUint32(32, true)
  const pageLength = header.getUint32(36, true)

  assert.deepEqual({ published, flushRanges: adapter.flushRanges }, {
    published: true,
    flushRanges: [{ offset: pageOffset, length: pageLength }, { offset: 0, length: 256 }],
  })
})

test('domain boundary: an oversized inactive page fails without resize remap or whole-mapping flush', () => {
  const adapter = new SparseLifecycleMmapAdapter()
  const cache = createCache(adapter, 8192)
  const mapsBeforePublish = adapter.maps.length
  const resizesBeforePublish = adapter.resizes.length

  const published = cache.publish({ generation: 'generation-oversized', coverage: 'complete', view: { graph: { ...firstView.graph, generation: 'generation-oversized', files: ['x'.repeat(8192)] } } })

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

test('equivalence partition: a mismatched format version is rebuilt instead of migrated', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.dispose()
  adapter.corrupt(path.join('/virtual', 'query-view-cache.bin'), 4)
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

test('error guessing: corrupt page bytes fail checksum validation as a cache miss', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.dispose()
  adapter.corrupt(path.join('/virtual', 'query-view-cache.bin'), 32768)
  const reader = createCache(adapter)

  const lease = reader.acquire({ generation: 'generation-0001', coverage: 'calls' })

  assert.equal(lease, null)
})

test('domain analysis: an active lease prevents its page from being overwritten', () => {
  const cache = createCache(new FakeMmapAdapter())
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  const lease = cache.acquire({ generation: 'generation-0001', coverage: 'calls' })

  const published = cache.publish({ generation: 'generation-0003', coverage: 'calls', view: { graph: { ...firstView.graph, generation: 'generation-0003' } } })

  assert.deepEqual({ published, leasedValue: lease.value }, { published: false, leasedValue: firstView })
  lease.release()
})

test('boundary value: a payload one byte beyond fixed capacity is rejected without replacing the current page', () => {
  const cache = createCache(new FakeMmapAdapter(), 1024)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })

  const published = cache.publish({ generation: 'generation-0002', coverage: 'calls', view: { graph: { ...firstView.graph, generation: 'generation-0002', files: ['x'.repeat(1025)] } } })

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

test('architecture contract: a published page is binary fixed-width data rather than a JSON query-view document', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const bytes = adapter.files.get(path.join('/virtual', 'query-view-cache.bin'))
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const activePage = header.getUint32(16, true)
  const descriptorOffset = activePage === 0 ? 32 : 48
  const pageOffset = header.getUint32(descriptorOffset, true)
  const pageLength = header.getUint32(descriptorOffset + 4, true)
  const payload = new TextDecoder().decode(bytes.subarray(pageOffset, pageOffset + pageLength))

  assert.throws(() => JSON.parse(payload), SyntaxError)
})

test('architecture contract: page metadata exposes ordered relative string symbol edge and query-index sections', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0002', coverage: 'complete', view: secondView })
  const bytes = adapter.files.get(path.join('/virtual', 'query-view-cache.bin'))
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

test('domain analysis: file header declares non-overlapping fixed scratch and two relative page offsets', () => {
  const adapter = new FakeMmapAdapter()
  const cache = createCache(adapter)
  cache.publish({ generation: 'generation-0001', coverage: 'calls', view: firstView })
  const bytes = adapter.files.get(path.join('/virtual', 'query-view-cache.bin'))
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

  assert.equal(adapter.writeRanges.some(({ operation, end, start }) => operation === 'fill' || end - start > 4096), false)
})

test('build contract: optional native build declares node-gyp or resolves npm bundled node-gyp explicitly', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const buildScript = fs.readFileSync(path.join(import.meta.dirname, '..', 'native', 'build-optional.mjs'), 'utf8')

  assert.equal(Boolean(packageJson.devDependencies?.['node-gyp']) || buildScript.includes('npm/node_modules/node-gyp/bin/node-gyp.js'), true)
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

test('hotpath diagnostic: mapped indexes query one of 22000 symbols and 29 of 55000 incoming refs without full graph decode', (t) => {
  const symbols = Array.from({ length: 22000 }, (_, index) => ({
    id: `symbol-${index}`, file: `src/file-${index}.ts`, name: index === 0 ? 'needle' : `symbol${index}`, kind: 'function', line: 1,
    qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true,
  }))
  const edges = Array.from({ length: 55000 }, (_, index) => index < 29
    ? { from: `symbol-${index + 1}`, to: 'symbol-0', line: index + 1, call: true }
    : { from: `symbol-${30 + (index % 21970)}`, to: `symbol-${30 + ((index + 1) % 21970)}`, line: index + 1, call: true })
  const adapter = new FakeMmapAdapter()
  const writer = new MmapQueryCache({ filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 16 * 1024 * 1024 })
  writer.publish({ generation: 'generation-large', coverage: 'complete', view: { graph: { generation: 'generation-large', edgeCoverage: 'complete', files: symbols.map(({ file }) => file), symbols, edges } } })
  writer.dispose()
  let graphDecodes = 0
  let symbolDecodes = 0
  let edgeDecodes = 0
  const reader = new MmapQueryCache({
    filePath: path.join('/virtual', 'query-view-cache.bin'), root: '/workspace/project', adapter, capacityBytes: 16 * 1024 * 1024,
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
    symbolCount, refCount, acquireUnder25ms: acquireMs < 25, p95Under10ms: metrics.p95 < 10,
  }, {
    graphDecodes: 0,
    firstSymbol: { id: 'symbol-0', file: 'src/file-0.ts', name: 'needle', kind: 'function', line: 1, qualifiedPath: '<module>', signature: '<>():', ordinal: 0, exported: true },
    firstRef: { from: 'symbol-1', to: 'symbol-0', line: 1, call: true }, firstRefCount: 29,
    firstQueryDecodes: { symbolDecodes: 60, edgeDecodes: 29 },
    symbolCount: 1, refCount: 29, acquireUnder25ms: true, p95Under10ms: true,
  })
  lease.release()
})
