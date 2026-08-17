import crypto from 'node:crypto'
import { crc32 } from 'node:zlib'

const FILE_MAGIC = 0x43474d4d
const PAGE_MAGIC = 0x43515047
const VERSION = 2
const HEADER_BYTES = 256
const SCRATCH_BYTES = 4096
const PAGE_HEADER_BYTES = 64
const STRING_PREFIX_BYTES = 64
const SYMBOL_BYTES = 40
const EDGE_BYTES = 16
const INDEX_BYTES = 16
const FOOTER_BYTES = 16
const FOOTER_MAGIC = 0x58444951
const HEADER_CHECKSUM_OFFSET = 252
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const checksum = (bytes) => {
  return crc32(bytes) >>> 0
}
const rootFingerprint = (root) => crypto.createHash('sha256').update(root).digest().readUInt32LE(0)

const encodePage = ({ generation, coverage, view }) => {
  const graph = view.graph
  const strings = []
  const offsets = new Map()
  let stringBytes = STRING_PREFIX_BYTES
  const intern = (value) => {
    const text = String(value)
    if (offsets.has(text)) return offsets.get(text)
    const bytes = encoder.encode(text)
    const offset = stringBytes
    offsets.set(text, offset)
    strings.push({ offset, bytes })
    stringBytes += bytes.byteLength + 1
    return offset
  }
  const generationOffset = intern(generation)
  const coverageOffset = intern(coverage)
  for (const file of graph.files) intern(file)
  for (const symbol of graph.symbols) {
    intern(symbol.id); intern(symbol.file); intern(symbol.name); intern(symbol.kind)
    intern(symbol.qualifiedPath ?? ''); intern(symbol.signature ?? '')
  }
  for (const edge of graph.edges) { intern(edge.from); intern(edge.to) }

  const symbolsOffset = PAGE_HEADER_BYTES + stringBytes
  const edgesOffset = symbolsOffset + graph.symbols.length * SYMBOL_BYTES
  const nameIndexOffset = edgesOffset + graph.edges.length * EDGE_BYTES
  const fileIndexOffset = nameIndexOffset + graph.symbols.length * INDEX_BYTES
  const incomingIndexOffset = fileIndexOffset + graph.symbols.length * INDEX_BYTES
  const outgoingIndexOffset = incomingIndexOffset + graph.edges.length * INDEX_BYTES
  const idIndexOffset = outgoingIndexOffset + graph.edges.length * INDEX_BYTES
  const footerOffset = idIndexOffset + graph.symbols.length * INDEX_BYTES
  const totalBytes = footerOffset + FOOTER_BYTES
  const bytes = new Uint8Array(totalBytes)
  const data = new DataView(bytes.buffer)
  data.setUint32(0, PAGE_MAGIC, true); data.setUint32(4, VERSION, true)
  data.setUint32(8, PAGE_HEADER_BYTES, true); data.setUint32(12, stringBytes, true)
  data.setUint32(16, symbolsOffset, true); data.setUint32(20, graph.symbols.length, true); data.setUint32(24, SYMBOL_BYTES, true)
  data.setUint32(28, edgesOffset, true); data.setUint32(32, graph.edges.length, true); data.setUint32(36, EDGE_BYTES, true)
  data.setUint32(40, nameIndexOffset, true); data.setUint32(44, fileIndexOffset, true)
  data.setUint32(48, incomingIndexOffset, true); data.setUint32(52, outgoingIndexOffset, true)
  data.setUint32(56, generationOffset, true); data.setUint32(60, coverageOffset, true)
  for (const entry of strings) bytes.set(entry.bytes, PAGE_HEADER_BYTES + entry.offset)

  const symbolIndex = new Map()
  graph.symbols.forEach((symbol, index) => {
    symbolIndex.set(symbol.id, index)
    const base = symbolsOffset + index * SYMBOL_BYTES
    data.setUint32(base, intern(symbol.id), true); data.setUint32(base + 4, intern(symbol.file), true)
    data.setUint32(base + 8, intern(symbol.name), true); data.setUint32(base + 12, intern(symbol.kind), true)
    data.setInt32(base + 16, symbol.line, true); data.setUint32(base + 20, intern(symbol.qualifiedPath ?? ''), true)
    data.setUint32(base + 24, intern(symbol.signature ?? ''), true); data.setInt32(base + 28, symbol.ordinal ?? 0, true)
    data.setUint32(base + 32, symbol.exported ? 1 : 0, true)
  })
  graph.edges.forEach((edge, index) => {
    const base = edgesOffset + index * EDGE_BYTES
    data.setUint32(base, symbolIndex.get(edge.from) ?? 0xffffffff, true); data.setUint32(base + 4, symbolIndex.get(edge.to) ?? 0xffffffff, true)
    data.setInt32(base + 8, edge.line, true); data.setUint32(base + 12, edge.call ? 1 : 0, true)
  })
  const sortedSymbols = (key) => graph.symbols.map((symbol, index) => ({ key: key(symbol), index })).sort((left, right) => left.key.localeCompare(right.key) || left.index - right.index)
  sortedSymbols((symbol) => symbol.name).forEach((entry, index) => { data.setUint32(nameIndexOffset + index * INDEX_BYTES, intern(entry.key), true); data.setUint32(nameIndexOffset + index * INDEX_BYTES + 4, entry.index, true) })
  sortedSymbols((symbol) => symbol.file).forEach((entry, index) => { data.setUint32(fileIndexOffset + index * INDEX_BYTES, intern(entry.key), true); data.setUint32(fileIndexOffset + index * INDEX_BYTES + 4, entry.index, true) })
  const sortedEdges = (key) => graph.edges.map((edge, index) => ({ key: symbolIndex.get(key(edge)), index })).sort((left, right) => left.key - right.key || left.index - right.index)
  sortedEdges((edge) => edge.to).forEach((entry, index) => { data.setUint32(incomingIndexOffset + index * INDEX_BYTES, entry.key, true); data.setUint32(incomingIndexOffset + index * INDEX_BYTES + 4, entry.index, true) })
  sortedEdges((edge) => edge.from).forEach((entry, index) => { data.setUint32(outgoingIndexOffset + index * INDEX_BYTES, entry.key, true); data.setUint32(outgoingIndexOffset + index * INDEX_BYTES + 4, entry.index, true) })
  sortedSymbols((symbol) => symbol.id).forEach((entry, index) => { data.setUint32(idIndexOffset + index * INDEX_BYTES, intern(entry.key), true); data.setUint32(idIndexOffset + index * INDEX_BYTES + 4, entry.index, true) })
  data.setUint32(footerOffset, FOOTER_MAGIC, true); data.setUint32(footerOffset + 4, idIndexOffset, true); data.setUint32(footerOffset + 8, graph.symbols.length, true)
  return bytes
}

class MappedQueryView {
  constructor(bytes, pageOffset, pageLength, release, decodeObserver = null) {
    this.bytes = bytes
    this.pageOffset = pageOffset
    this.pageLength = pageLength
    this.data = new DataView(bytes.buffer, bytes.byteOffset + pageOffset, pageLength)
    this.release = release
    this.decodeObserver = decodeObserver
    this.mapped = true
  }
  get generation() { return this.string(this.data.getUint32(56, true)) }
  get edgeCoverage() { return this.string(this.data.getUint32(60, true)) }
  get symbols() { return this.matchingSymbols() }
  get files() { return [...new Set(this.symbols.map((symbol) => symbol.file))].sort() }
  get edges() { return Array.from({ length: this.data.getUint32(32, true) }, (_, index) => this.edge(index)) }
  string(offset) {
    const start = this.pageOffset + this.data.getUint32(8, true) + offset
    let end = start
    const limit = this.pageOffset + this.data.getUint32(8, true) + this.data.getUint32(12, true)
    while (end < limit && this.bytes[end] !== 0) end += 1
    return decoder.decode(this.bytes.subarray(start, end))
  }
  symbol(index) {
    this.decodeObserver?.({ type: 'symbol', index })
    const base = this.data.getUint32(16, true) + index * SYMBOL_BYTES
    return {
      id: this.string(this.data.getUint32(base, true)), file: this.string(this.data.getUint32(base + 4, true)),
      name: this.string(this.data.getUint32(base + 8, true)), kind: this.string(this.data.getUint32(base + 12, true)), line: this.data.getInt32(base + 16, true),
      qualifiedPath: this.string(this.data.getUint32(base + 20, true)), signature: this.string(this.data.getUint32(base + 24, true)),
      ordinal: this.data.getInt32(base + 28, true), exported: Boolean(this.data.getUint32(base + 32, true)),
    }
  }
  edge(index) {
    this.decodeObserver?.({ type: 'edge', index })
    const base = this.data.getUint32(28, true) + index * EDGE_BYTES
    return { from: this.symbol(this.data.getUint32(base, true)).id, to: this.symbol(this.data.getUint32(base + 4, true)).id, line: this.data.getInt32(base + 8, true), call: Boolean(this.data.getUint32(base + 12, true)) }
  }
  matchingSymbols(request = {}) {
    if (request.id) {
      const indexes = this.#stringIndex(this.#idIndexOffset(), this.#footerOffset(), request.id)
      return indexes.map((index) => this.symbol(index)).filter((symbol) => (!request.name || symbol.name === request.name) && (!request.file || symbol.file === request.file || symbol.file.endsWith(request.file)))
    }
    let candidates = null
    if (request.name) candidates = this.#stringIndex(this.data.getUint32(40, true), this.data.getUint32(44, true), request.name)
    if (request.file) {
      const exact = this.#stringIndex(this.data.getUint32(44, true), this.data.getUint32(48, true), request.file)
      if (exact.length) candidates = candidates ? candidates.filter((index) => exact.includes(index)) : exact
    }
    const result = []
    const indexes = candidates ?? Array.from({ length: this.data.getUint32(20, true) }, (_, index) => index)
    for (const index of indexes) {
      const symbol = this.symbol(index)
      if (request.id && symbol.id !== request.id) continue
      if (request.name && symbol.name !== request.name) continue
      if (request.file && symbol.file !== request.file && !symbol.file.endsWith(request.file)) continue
      result.push(symbol)
    }
    return result
  }
  relationships(request, direction) {
    const matched = this.matchingSymbols(request)
    const symbolIndexes = matched.map((symbol) => this.#lookupId(symbol.id)).filter((index) => index !== null)
    const startField = direction === 'incoming' ? 48 : 52
    const end = direction === 'incoming' ? this.data.getUint32(52, true) : this.#idIndexOffset()
    const start = this.data.getUint32(startField, true)
    const result = []
    for (const symbolIndex of symbolIndexes) for (const edgeIndex of this.#numericIndex(start, end, symbolIndex)) result.push(this.edge(edgeIndex))
    return result
  }
  #stringIndex(start, end, key) {
    const result = []
    let low = 0; let high = Math.floor((end - start) / INDEX_BYTES)
    while (low < high) { const middle = (low + high) >>> 1; if (this.string(this.data.getUint32(start + middle * INDEX_BYTES, true)).localeCompare(key) < 0) low = middle + 1; else high = middle }
    for (let index = low; start + index * INDEX_BYTES < end && this.string(this.data.getUint32(start + index * INDEX_BYTES, true)) === key; index += 1) result.push(this.data.getUint32(start + index * INDEX_BYTES + 4, true))
    return result
  }
  #numericIndex(start, end, key) {
    const result = []; let low = 0; let high = Math.floor((end - start) / INDEX_BYTES)
    while (low < high) { const middle = (low + high) >>> 1; if (this.data.getUint32(start + middle * INDEX_BYTES, true) < key) low = middle + 1; else high = middle }
    for (let index = low; start + index * INDEX_BYTES < end && this.data.getUint32(start + index * INDEX_BYTES, true) === key; index += 1) result.push(this.data.getUint32(start + index * INDEX_BYTES + 4, true))
    return result
  }
  #footerOffset() { return this.pageLength - FOOTER_BYTES }
  #idIndexOffset() { const footer = this.#footerOffset(); return this.data.getUint32(footer, true) === FOOTER_MAGIC ? this.data.getUint32(footer + 4, true) : footer }
  #lookupId(id) { return this.#stringIndex(this.#idIndexOffset(), this.#footerOffset(), id)[0] ?? null }
  get graph() {
    this.decodeObserver?.({ type: 'graph' })
    const generation = this.generation
    const edgeCoverage = this.edgeCoverage
    const symbols = this.symbols
    const files = [...new Set(symbols.map((symbol) => symbol.file))].sort()
    const edges = this.edges
    return { generation, edgeCoverage, files, symbols, edges }
  }
}

export class MmapQueryCache {
  constructor({ filePath, root, adapter, capacityBytes = 1024 * 1024 * 1024, decodeObserver = null }) {
    this.rootHash = rootFingerprint(root); this.adapter = adapter; this.capacity = Math.max(1024, Math.floor(capacityBytes))
    this.handle = null; this.mapping = null; this.leases = [0, 0]; this.disposed = false
    this.decodeObserver = decodeObserver
    if (!adapter) return
    try {
      this.handle = adapter.open(filePath, this.capacity); this.mapping = adapter.map(this.handle)
      if (this.mapping instanceof Uint8Array && this.mapping.byteLength < this.capacity) {
        try { adapter.unmap(this.mapping) } catch {}
        this.mapping = null
        adapter.resize(this.handle, this.capacity)
        this.mapping = adapter.map(this.handle)
      }
      if (!(this.mapping instanceof Uint8Array) || this.mapping.byteLength < this.capacity) throw new Error('invalid mmap mapping')
    } catch { this.#releaseNative() }
  }
  publish({ generation, coverage, view }, { signal } = {}) {
    if (!this.mapping || this.disposed || signal?.aborted || this.capacity < HEADER_BYTES + SCRATCH_BYTES + 2) return false
    try {
      let header = this.#readHeader(); if (!header) header = this.#emptyHeader()
      const target = header.serial === 0 ? 0 : 1 - header.active
      if (this.leases[target] > 0) return false
      const payload = encodePage({ generation, coverage, view }); const descriptor = header.pages[target]
      if (payload.byteLength > descriptor.capacity || signal?.aborted) return false
      const priorHeader = this.mapping.slice(0, HEADER_BYTES)
      for (let offset = 0; offset < payload.byteLength; offset += SCRATCH_BYTES) {
        const chunk = payload.subarray(offset, Math.min(payload.byteLength, offset + SCRATCH_BYTES))
        this.mapping.set(chunk, HEADER_BYTES); this.mapping.set(this.mapping.subarray(HEADER_BYTES, HEADER_BYTES + chunk.byteLength), descriptor.offset + offset)
      }
      this.adapter.flush(this.mapping, descriptor.offset, payload.byteLength)
      if (signal?.aborted) return false
      descriptor.length = payload.byteLength; descriptor.checksum = this.#pageChecksum(descriptor); descriptor.serial = ++header.serial; header.active = target
      this.#writeHeader(header)
      try { this.adapter.flush(this.mapping, 0, HEADER_BYTES) } catch { this.mapping.set(priorHeader, 0); try { this.adapter.flush(this.mapping, 0, HEADER_BYTES) } catch {}; return false }
      return true
    } catch { return false }
  }
  acquire({ generation, coverage }) {
    if (!this.mapping || this.disposed) return null
    try {
      const header = this.#readHeader(); if (!header) return null
      for (const index of [header.active, 1 - header.active]) {
        const descriptor = header.pages[index]
        if (!descriptor.length || descriptor.length > descriptor.capacity || this.#pageChecksum(descriptor) !== descriptor.checksum) continue
        const data = new DataView(this.mapping.buffer, this.mapping.byteOffset + descriptor.offset, descriptor.length)
        if (data.getUint32(0, true) !== PAGE_MAGIC || data.getUint32(4, true) !== VERSION) continue
        const temporary = new MappedQueryView(this.mapping, descriptor.offset, descriptor.length, () => {})
        if (temporary.string(data.getUint32(56, true)) !== generation || temporary.string(data.getUint32(60, true)) !== coverage) continue
        this.leases[index] += 1; let released = false
        const release = () => { if (!released) { released = true; this.leases[index] = Math.max(0, this.leases[index] - 1) } }
        const mappedView = new MappedQueryView(this.mapping, descriptor.offset, descriptor.length, release, this.decodeObserver)
        const value = {}
        Object.defineProperty(value, 'graph', { enumerable: true, get: () => mappedView.graph })
        Object.defineProperty(value, 'mappedView', { value: mappedView })
        return { value, release }
      }
    } catch {}
    return null
  }
  dispose() { if (!this.disposed) { this.disposed = true; this.#releaseNative() } }
  #emptyHeader() {
    const scratchEnd = HEADER_BYTES + SCRATCH_BYTES
    const pageAOffset = Math.floor(this.capacity / 2) + 2048
    return { active: 0, serial: 0, pages: [{ offset: pageAOffset, capacity: this.capacity - pageAOffset, length: 0, checksum: 0, serial: 0 }, { offset: scratchEnd, capacity: pageAOffset - scratchEnd, length: 0, checksum: 0, serial: 0 }] }
  }
  #pageChecksum(descriptor) {
    const guardStart = descriptor.offset > this.capacity / 2 ? descriptor.offset - 2048 : descriptor.offset
    return checksum(this.mapping.subarray(guardStart, descriptor.offset + descriptor.length))
  }
  #readHeader() {
    if (this.mapping.byteLength < HEADER_BYTES) return null
    const bytes = this.mapping.subarray(0, HEADER_BYTES); const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (data.getUint32(0, true) !== FILE_MAGIC || data.getUint32(4, true) !== VERSION || data.getUint32(8, true) !== this.capacity || data.getUint32(12, true) !== this.rootHash) return null
    if (checksum(bytes.subarray(0, HEADER_CHECKSUM_OFFSET)) !== data.getUint32(HEADER_CHECKSUM_OFFSET, true)) return null
    if (data.getUint32(24, true) !== HEADER_BYTES || data.getUint32(28, true) !== SCRATCH_BYTES) return null
    const active = data.getUint32(16, true); if (active > 1) return null
    const empty = this.#emptyHeader()
    const pages = [0, 1].map((index) => { const base = 32 + index * 16; const expected = empty.pages[index]; const offset = data.getUint32(base, true); const length = data.getUint32(base + 4, true); if (offset !== expected.offset || length > expected.capacity) throw new Error('invalid page'); return { offset, capacity: expected.capacity, length, checksum: data.getUint32(base + 8, true), serial: data.getUint32(base + 12, true) } })
    return { active, serial: data.getUint32(20, true), pages }
  }
  #writeHeader(header) {
    const bytes = new Uint8Array(HEADER_BYTES); const data = new DataView(bytes.buffer)
    data.setUint32(0, FILE_MAGIC, true); data.setUint32(4, VERSION, true); data.setUint32(8, this.capacity, true); data.setUint32(12, this.rootHash, true)
    data.setUint32(16, header.active, true); data.setUint32(20, header.serial, true); data.setUint32(24, HEADER_BYTES, true); data.setUint32(28, SCRATCH_BYTES, true)
    header.pages.forEach((page, index) => { const base = 32 + index * 16; data.setUint32(base, page.offset, true); data.setUint32(base + 4, page.length, true); data.setUint32(base + 8, page.checksum, true); data.setUint32(base + 12, page.serial, true) })
    data.setUint32(HEADER_CHECKSUM_OFFSET, checksum(bytes.subarray(0, HEADER_CHECKSUM_OFFSET)), true); this.mapping.set(bytes, 0)
  }
  #releaseNative() { if (this.mapping) { try { this.adapter?.unmap(this.mapping) } catch {}; this.mapping = null } if (this.handle) { try { this.adapter?.close(this.handle) } catch {}; this.handle = null } }
}
