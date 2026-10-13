import crypto from 'node:crypto'
import { crc32 } from 'node:zlib'
import { coverageName, requireCoverage } from './edge-coverage.mjs'
import { CACHE_SCHEMA_VERSION } from './query-cache-schema.mjs'
export { CACHE_SCHEMA_VERSION, QUERY_VIEW_CACHE_FILE } from './query-cache-schema.mjs'

const FILE_MAGIC = 0x43474d4d
const PAGE_MAGIC = 0x43515047
const VERSION = CACHE_SCHEMA_VERSION
const HEADER_BYTES = 256
const SCRATCH_BYTES = 4096
const SYMBOL_BYTES = 40
const EDGE_BYTES = 16
const UNRESOLVED_EDGE_BYTES = 16
const INDEX_BYTES = 16
const FOOTER_BYTES = 24
const FOOTER_MAGIC = 0x58444951
const HEADER_CHECKSUM_OFFSET = 252
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const compareBytes = (left, right) => {
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  return left.byteLength - right.byteLength
}

const checksum = (bytes) => {
  return crc32(bytes) >>> 0
}
const rootFingerprint = (root) => crypto.createHash('sha256').update(root).digest().readUInt32LE(0)

class LegacyQueryView {
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
  detach() {
    if (this.pageOffset === 0) return 0
    const bytes = new Uint8Array(this.pageLength)
    bytes.set(this.bytes.subarray(this.pageOffset, this.pageOffset + this.pageLength))
    const data = new DataView(bytes.buffer, bytes.byteOffset, this.pageLength)
    this.bytes = bytes; this.pageOffset = 0; this.data = data
    this.release()
    return this.pageLength
  }
  get edgeCoverage() { return this.string(this.data.getUint32(60, true)) }
  get symbols() { return this.matchingSymbols() }
  get files() { return [...new Set(this.symbols.map((symbol) => symbol.file))].sort() }
  get edges() { return Array.from({ length: this.data.getUint32(32, true) }, (_, index) => this.edge(index)) }
  get unresolvedEdges() {
    const footer = this.#footerOffset()
    const offset = this.data.getUint32(footer + 12, true)
    return Array.from({ length: this.data.getUint32(footer + 16, true) }, (_, index) => {
      const base = offset + index * UNRESOLVED_EDGE_BYTES
      return { from: this.string(this.data.getUint32(base, true)), to: this.string(this.data.getUint32(base + 4, true)), line: this.data.getInt32(base + 8, true), reason: this.string(this.data.getUint32(base + 12, true)) }
    })
  }
  string(offset) {
    this.decodeObserver?.({ type: 'string' })
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
    const from = this.data.getUint32(base, true), to = this.data.getUint32(base + 4, true)
    const count = this.data.getUint32(20, true), symbols = this.data.getUint32(16, true)
    if (from >= count || to >= count) throw new RangeError('edge symbol index out of bounds')
    return { from: this.string(this.data.getUint32(symbols + from * SYMBOL_BYTES, true)), to: this.string(this.data.getUint32(symbols + to * SYMBOL_BYTES, true)), line: this.data.getInt32(base + 8, true), call: Boolean(this.data.getUint32(base + 12, true)) }
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
    const result = []; const needle = encoder.encode(key)
    const count = Math.floor((end - start) / INDEX_BYTES)
    const compare = (row) => this.#comparePageString(this.data.getUint32(start + row * INDEX_BYTES, true), needle)
    let low = 0; let high = count
    while (low < high) { const middle = (low + high) >>> 1; if (compare(middle) < 0) low = middle + 1; else high = middle }
    for (let row = low; row < count && compare(row) === 0; row += 1) result.push(this.data.getUint32(start + row * INDEX_BYTES + 4, true))
    return result
  }
  #comparePageString(offset, needle) {
    const start = this.pageOffset + this.data.getUint32(8, true) + offset
    const limit = this.pageOffset + this.data.getUint32(8, true) + this.data.getUint32(12, true)
    let index = 0
    while (index < needle.byteLength && start + index < limit && this.bytes[start + index] !== 0) {
      const difference = this.bytes[start + index] - needle[index]
      if (difference) return difference
      index += 1
    }
    return start + index >= limit || this.bytes[start + index] === 0 ? (index === needle.byteLength ? 0 : -1) : 1
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
    return { generation, edgeCoverage, files, symbols, edges, ...(this.data.getUint32(this.#footerOffset() + 20, true) ? { unresolvedEdges: this.unresolvedEdges } : {}) }
  }
}


const RECORD_HEADER = 16
const RECORD = { KEY: 1, SYMBOL: 2, EDGE: 3, UNRESOLVED: 4, NODE: 5, ROOT: 6, PARTITION_ROOT: 7, DIRECTORY: 8, LOOKUP_CHUNK: 9 }
const ID = 0, NAME = 1, FILE = 2, INCOMING = 3, OUTGOING = 4, UNRESOLVED = 5
const align = (value) => Math.ceil(value / 8) * 8
const orderSequence = (left, right) => left.sequence - right.sequence
const orderSymbol = (left, right) => left.row.id.localeCompare(right.row.id) || left.occurrence - right.occurrence
const orderEdge = (left, right) => (left.row.from < right.row.from ? -1 : left.row.from > right.row.from ? 1 : 0) || (left.row.to < right.row.to ? -1 : left.row.to > right.row.to ? 1 : 0) || left.row.line - right.row.line || left.occurrence - right.occurrence
const orderUnresolved = (left, right) => left.effectiveKind - right.effectiveKind || orderEdge(left, right)
const sameSymbol = (left, right) => left.id === right.id && left.file === right.file && left.name === right.name && left.kind === right.kind && left.line === right.line && (left.qualifiedPath ?? '') === (right.qualifiedPath ?? '') && (left.signature ?? '') === (right.signature ?? '') && (left.ordinal ?? 0) === (right.ordinal ?? 0) && Boolean(left.exported) === Boolean(right.exported)
const sameRows = (left, right) => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index]
    if (a.from !== b.from || a.to !== b.to || a.line !== b.line || a.call !== b.call || a.reason !== b.reason) return false
  }
  return true
}

// Zero-terminated UTF-8 components keep prefix search and lookup comparisons symmetric.
function compositeKey(parts) {
  const chunks = []; let length = 0
  for (const part of parts) {
    if (typeof part === 'number') {
      const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, part >>> 0)
      chunks.push(bytes); length += 4
    } else {
      const bytes = encoder.encode(String(part)); let zeros = 0
      for (const byte of bytes) if (byte === 0) zeros++
      const escaped = new Uint8Array(bytes.length + zeros + 2); let cursor = 0
      for (const byte of bytes) { escaped[cursor++] = byte; if (byte === 0) escaped[cursor++] = 255 }
      chunks.push(escaped); length += escaped.length
    }
  }
  const result = new Uint8Array(length); let cursor = 0
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length }
  return result
}
function prefixCompare(key, prefix) {
  for (let index = 0; index < prefix.length; index++) {
    if (index >= key.length) return -1
    if (key[index] !== prefix[index]) return key[index] - prefix[index]
  }
  return 0
}
function encodePayload(numbers, strings) {
  const chunks = []; let length = numbers.length * 4
  for (const value of strings) { const bytes = encoder.encode(String(value)); chunks.push(bytes); length += 4 + bytes.length }
  const bytes = new Uint8Array(length), data = new DataView(bytes.buffer); let cursor = 0
  for (const number of numbers) { data.setUint32(cursor, number >>> 0, true); cursor += 4 }
  for (const chunk of chunks) { data.setUint32(cursor, chunk.length, true); cursor += 4; bytes.set(chunk, cursor); cursor += chunk.length }
  return bytes
}
function payloadStrings(payload, start, count) {
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), strings = []
  for (let index = 0; index < count; index++) {
    if (start + 4 > payload.length) throw new Error('truncated mapped string')
    const length = data.getUint32(start, true); start += 4
    if (start + length > payload.length) throw new Error('invalid mapped string length')
    strings.push(decoder.decode(payload.subarray(start, start + length))); start += length
  }
  if (start !== payload.length) throw new Error('invalid mapped payload length')
  return strings
}
function symbolKeys(row, occurrence) {
  return [compositeKey([row.id, occurrence]), compositeKey([row.name, row.id, occurrence]), compositeKey([row.file, row.id, occurrence])]
}
function edgeKeys(row, fromOccurrence, toOccurrence, occurrence) {
  const line = (row.line ^ 0x80000000) >>> 0
  return [compositeKey([row.to, toOccurrence, row.from, line, occurrence]), compositeKey([row.from, fromOccurrence, row.to, line, occurrence])]
}
function unresolvedKey(row, kind, occurrence) { return compositeKey([kind, row.from, row.to, (row.line ^ 0x80000000) >>> 0, occurrence]) }

class RecordReader {
  constructor(bytes, limit, observer = null) { this.bytes = bytes; this.limit = limit; this.observer = observer; this.partitioned = null }
  recordType(offset) {
    if (!Number.isInteger(offset) || offset < HEADER_BYTES + SCRATCH_BYTES || offset % 8 || offset + RECORD_HEADER > this.limit) throw new RangeError('mapped record offset out of bounds')
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, RECORD_HEADER).getUint32(0, true)
  }
  record(offset, type) {
    if (!Number.isInteger(offset) || offset < HEADER_BYTES + SCRATCH_BYTES || offset % 8 || offset + RECORD_HEADER > this.limit) throw new RangeError('mapped record offset out of bounds')
    const data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, RECORD_HEADER)
    const length = data.getUint32(4, true)
    if (data.getUint32(0, true) !== type || length > this.limit - offset - RECORD_HEADER) throw new Error('invalid mapped record')
    const payload = this.bytes.subarray(offset + RECORD_HEADER, offset + RECORD_HEADER + length)
    if (checksum(payload) !== data.getUint32(8, true)) throw new Error('mapped record checksum mismatch')
    this.observer?.({ type: 'record', offset, recordType: type })
    return payload
  }
  node(offset) {
    if (!offset) return null
    const payload = this.record(offset, RECORD.NODE)
    if (payload.length !== 24) throw new Error('invalid mapped node length')
    const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const node = { key: data.getUint32(0, true), value: data.getUint32(4, true), left: data.getUint32(8, true), right: data.getUint32(12, true), height: data.getUint32(16, true), count: data.getUint32(20, true) }
    if (node.height < 1 || node.height > 64 || node.count < 1) throw new Error('invalid mapped node bounds')
    return node
  }
  key(offset) { return this.record(offset, RECORD.KEY) }
  lookup(offset, depth) {
    const type = this.recordType(offset)
    if (type !== RECORD.DIRECTORY && type !== RECORD.LOOKUP_CHUNK) throw new Error('invalid mapped lookup type')
    const payload = this.record(offset, type), data = new DataView(payload.buffer, payload.byteOffset, payload.length)
    if (type === RECORD.LOOKUP_CHUNK) {
      if (payload.length !== 520 || data.getUint32(0, true) > 64 || data.getUint32(4, true)) throw new Error('invalid mapped lookup chunk')
      return { type, data, count: data.getUint32(0, true) }
    }
    if (payload.length !== 1040 || data.getUint32(12, true)) throw new Error('invalid mapped directory')
    const branchDepth = data.getUint32(0, true), hint = this.key(data.getUint32(4, true)), count = data.getUint32(8, true)
    if (branchDepth < depth || branchDepth >= hint.length || count < 1) throw new Error('invalid mapped directory hint')
    return { type, data, branchDepth, hint, count }
  }
  count(root) {
    if (!root) return 0
    return this.lookup(root, 0).count
  }
  range(root, prefix = null, result = [], depth = 0) {
    if (!root) return result
    if (this.recordType(root) === RECORD.NODE) {
      if (this.partitioned === true) throw new Error('legacy node in partitioned lookup')
      if (depth > 64) throw new Error('mapped tree traversal limit')
      const node = this.node(root), key = this.key(node.key), comparison = prefix ? prefixCompare(key, prefix) : 0
      if (comparison >= 0) this.range(node.left, prefix, result, depth + 1)
      if (comparison === 0) result.push(node.value)
      if (comparison <= 0) this.range(node.right, prefix, result, depth + 1)
      return result
    }
    if (this.partitioned === false) throw new Error('partitioned page in legacy lookup')
    const page = this.lookup(root, depth)
    if (page.type === RECORD.LOOKUP_CHUNK) {
      for (let index = 0; index < page.count; index++) {
        const key = this.key(page.data.getUint32(8 + index * 8, true)), value = page.data.getUint32(12 + index * 8, true)
        if (!value) throw new Error('invalid mapped lookup value')
        if (!prefix || prefixCompare(key, prefix) === 0) result.push(value)
      }
    } else {
      if (prefix) for (let index = depth; index < page.branchDepth && index < prefix.length; index++) if (prefix[index] !== page.hint[index]) return result
      if (prefix && prefix.length > page.branchDepth) this.range(page.data.getUint32(16 + prefix[page.branchDepth] * 4, true), prefix, result, page.branchDepth + 1)
      else for (let index = 0; index < 256; index++) this.range(page.data.getUint32(16 + index * 4, true), prefix, result, page.branchDepth + 1)
    }
    return result
  }
  migrateIndex(root, writer, result = 0, depth = 0) {
    if (!root) return result
    if (depth > 64) throw new Error('mapped tree traversal limit')
    const node = this.node(root)
    result = this.migrateIndex(node.left, writer, result, depth + 1)
    result = writer.update(result, this.key(node.key), node.value, node.key)
    return this.migrateIndex(node.right, writer, result, depth + 1)
  }
  symbol(offset, observer = this.observer) {
    const payload = this.record(offset, RECORD.SYMBOL), data = new DataView(payload.buffer, payload.byteOffset, payload.length)
    if (payload.length < 44) throw new Error('invalid mapped symbol length')
    observer?.({ type: 'symbol', index: data.getUint32(0, true) })
    const strings = payloadStrings(payload, 20, 6)
    return { row: { id: strings[0], file: strings[1], name: strings[2], kind: strings[3], line: data.getInt32(8, true), qualifiedPath: strings[4], signature: strings[5], ordinal: data.getInt32(12, true), exported: Boolean(data.getUint32(16, true)) }, sequence: data.getUint32(0, true), occurrence: data.getUint32(4, true), offset }
  }
  edge(offset, observer = this.observer) {
    const payload = this.record(offset, RECORD.EDGE), data = new DataView(payload.buffer, payload.byteOffset, payload.length)
    if (payload.length < 32) throw new Error('invalid mapped edge length')
    observer?.({ type: 'edge', index: data.getUint32(0, true) })
    const strings = payloadStrings(payload, 24, 2)
    return { row: { from: strings[0], to: strings[1], line: data.getInt32(16, true), call: Boolean(data.getUint32(20, true)) }, sequence: data.getUint32(0, true), fromOccurrence: data.getUint32(4, true), toOccurrence: data.getUint32(8, true), occurrence: data.getUint32(12, true), offset }
  }
  unresolved(offset) {
    this.observer?.({ type: 'unresolved', index: offset })
    const payload = this.record(offset, RECORD.UNRESOLVED), data = new DataView(payload.buffer, payload.byteOffset, payload.length)
    if (payload.length < 28) throw new Error('invalid mapped unresolved length')
    const strings = payloadStrings(payload, 16, 3)
    return { row: { from: strings[0], to: strings[1], line: data.getInt32(12, true), reason: strings[2] }, sequence: data.getUint32(0, true), kind: data.getUint32(4, true), occurrence: data.getUint32(8, true), offset }
  }
  root(offset) {
    const type = this.recordType(offset)
    if (type !== RECORD.ROOT && type !== RECORD.PARTITION_ROOT || this.partitioned !== null && this.partitioned !== (type === RECORD.PARTITION_ROOT)) throw new Error('invalid mapped root type')
    const payload = this.record(offset, type), data = new DataView(payload.buffer, payload.byteOffset, payload.length)
    if (payload.length < 76) throw new Error('invalid mapped root length')
    const trees = []; for (let index = 0; index < 6; index++) trees.push(data.getUint32(index * 4, true))
    const strings = payloadStrings(payload, 68, 2)
    return { trees, partitioned: type === RECORD.PARTITION_ROOT, nextOccurrence: data.getUint32(24, true), hasUnresolved: Boolean(data.getUint32(28, true)), ordered: Boolean(data.getUint32(32, true)), intervals: [[data.getUint32(36, true), data.getUint32(40, true)], [data.getUint32(44, true), data.getUint32(48, true)]], activeInterval: data.getUint32(52, true), cursor: data.getUint32(56, true), rawUnresolvedCount: data.getUint32(60, true), originalRawBoundary: data.getUint32(64, true), generation: strings[0], coverage: strings[1], offset }
  }
}

class RecordWriter extends RecordReader {
  constructor(bytes, allocation) {
    super(bytes, bytes.length)
    this.partitioned = true
    this.intervals = allocation.intervals; this.activeInterval = allocation.activeInterval; this.cursor = allocation.cursor; this.ranges = []; this.startInterval = allocation.activeInterval; this.startCursor = allocation.cursor
    this.building = false; this.copies = new Map(); this.pairs = new Uint32Array(130); this.counts = new Uint32Array(256); this.positions = new Uint32Array(256)
  }
  append(type, payload) {
    const length = align(RECORD_HEADER + payload.length)
    while (this.activeInterval < this.intervals.length && this.cursor + length > this.intervals[this.activeInterval][1]) {
      this.activeInterval++; this.cursor = this.intervals[this.activeInterval]?.[0] ?? this.bytes.length
    }
    if (this.activeInterval >= this.intervals.length) throw new Error('mapped cache capacity exhausted')
    const offset = this.cursor, data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, RECORD_HEADER)
    data.setUint32(0, type, true); data.setUint32(4, payload.length, true); data.setUint32(8, type === RECORD.DIRECTORY || type === RECORD.LOOKUP_CHUNK ? 0 : checksum(payload), true); data.setUint32(12, 0, true)
    this.bytes.set(payload, offset + RECORD_HEADER)
    if (length > RECORD_HEADER + payload.length) this.bytes.fill(0, offset + RECORD_HEADER + payload.length, offset + length)
    this.cursor += length
    const prior = this.ranges[this.ranges.length - 1]
    if (prior && prior.offset + prior.length === offset) prior.length += length
    else this.ranges.push({ offset, length })
    return offset
  }
  writeSymbol(row, sequence, occurrence) {
    return this.append(RECORD.SYMBOL, encodePayload([sequence, occurrence, row.line, row.ordinal ?? 0, row.exported ? 1 : 0], [row.id, row.file, row.name, row.kind, row.qualifiedPath ?? '', row.signature ?? '']))
  }
  writeEdge(row, sequence, fromOccurrence, toOccurrence, occurrence) { return this.append(RECORD.EDGE, encodePayload([sequence, fromOccurrence, toOccurrence, occurrence, row.line, row.call ? 1 : 0], [row.from, row.to])) }
  writeUnresolved(row, sequence, kind, occurrence) { return this.append(RECORD.UNRESOLVED, encodePayload([sequence, kind, occurrence, row.line], [row.from, row.to, row.reason])) }
  owned(offset) {
    for (let index = this.startInterval; index <= this.activeInterval; index++) {
      const start = index === this.startInterval ? this.startCursor : this.intervals[index][0]
      const end = index === this.activeInterval ? this.cursor : this.intervals[index][1]
      if (offset >= start && offset < end) return true
    }
    return false
  }
  record(offset, type) {
    if ((type !== RECORD.DIRECTORY && type !== RECORD.LOOKUP_CHUNK) || !this.owned(offset)) return super.record(offset, type)
    if (this.recordType(offset) !== type) throw new Error('invalid unpublished lookup type')
    const data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, RECORD_HEADER)
    return this.bytes.subarray(offset + RECORD_HEADER, offset + RECORD_HEADER + data.getUint32(4, true))
  }
  writable(offset, page) {
    if (this.owned(offset)) return offset
    const existing = this.copies.get(offset)
    if (existing) return existing
    const copy = this.append(page.type, new Uint8Array(page.data.buffer, page.data.byteOffset, page.data.byteLength))
    this.copies.set(offset, copy)
    return copy
  }
  finalize() {
    for (const range of this.ranges) for (let offset = range.offset; offset < range.offset + range.length;) {
      const data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, RECORD_HEADER), type = data.getUint32(0, true), length = data.getUint32(4, true)
      if (type === RECORD.LOOKUP_CHUNK) new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + RECORD_HEADER, length).setUint32(4, 0, true)
      if (type === RECORD.DIRECTORY || type === RECORD.LOOKUP_CHUNK) data.setUint32(8, checksum(this.bytes.subarray(offset + RECORD_HEADER, offset + RECORD_HEADER + length)), true)
      offset += align(RECORD_HEADER + length)
    }
  }
  chunk(key, value) {
    const payload = new Uint8Array(520), data = new DataView(payload.buffer)
    data.setUint32(0, 1, true); data.setUint32(8, key, true); data.setUint32(12, value, true)
    return this.append(RECORD.LOOKUP_CHUNK, payload)
  }
  #ownedKey(offset) {
    if (!this.owned(offset) || this.recordType(offset) !== RECORD.KEY) throw new Error('invalid unpublished key')
    const data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, RECORD_HEADER), length = data.getUint32(4, true)
    const end = Math.min(this.cursor, this.intervals[this.startInterval][1])
    if (length > (offset < this.intervals[this.startInterval][1] ? end : this.cursor) - offset - RECORD_HEADER) throw new Error('invalid unpublished key length')
    return this.bytes.subarray(offset + RECORD_HEADER, offset + RECORD_HEADER + length)
  }
  stageCold(heads, tails, counts, views, index, needle, value) {
    const key = this.append(RECORD.KEY, needle)
    if (!tails[index] || counts[index] === 64) {
      const offset = this.append(RECORD.LOOKUP_CHUNK, new Uint8Array(520))
      if (tails[index]) views[index].setUint32(4, offset, true)
      else heads[index] = offset
      tails[index] = offset; counts[index] = 0
      views[index] = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + RECORD_HEADER, 520)
    }
    const data = views[index], count = counts[index]++
    data.setUint32(8 + count * 8, key, true); data.setUint32(12 + count * 8, value, true); data.setUint32(0, count + 1, true)
  }
  finishCold(head, depth = 0) {
    if (!head) return 0
    const firstChunk = new DataView(this.bytes.buffer, this.bytes.byteOffset + head + RECORD_HEADER, 520)
    if (!firstChunk.getUint32(4, true)) return head
    const firstOffset = firstChunk.getUint32(8, true), first = this.#ownedKey(firstOffset)
    let branchDepth = first.length, count = 0
    for (let offset = head; offset;) {
      const data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + RECORD_HEADER, 520), size = data.getUint32(0, true)
      count += size
      for (let index = 0; index < size; index++) {
        const keyOffset = data.getUint32(8 + index * 8, true)
        if (keyOffset === firstOffset) continue
        const key = this.#ownedKey(keyOffset); let common = depth
        if (depth >= key.length) throw new Error('truncated mapped split key')
        const limit = Math.min(branchDepth, key.length)
        while (common < limit && key[common] === first[common]) common++
        branchDepth = common
        if (branchDepth >= key.length) throw new Error('truncated mapped split key')
      }
      offset = data.getUint32(4, true)
    }
    if (branchDepth < depth || branchDepth >= first.length) throw new Error('indistinguishable mapped keys')
    const root = this.append(RECORD.DIRECTORY, new Uint8Array(1040)), directory = new DataView(this.bytes.buffer, this.bytes.byteOffset + root + RECORD_HEADER, 1040)
    directory.setUint32(0, branchDepth, true); directory.setUint32(4, firstOffset, true); directory.setUint32(8, count, true)
    this.counts.fill(0); this.positions.fill(0)
    for (let offset = head; offset;) {
      const data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + RECORD_HEADER, 520), size = data.getUint32(0, true)
      for (let index = 0; index < size; index++) {
        const keyOffset = data.getUint32(8 + index * 8, true), key = this.#ownedKey(keyOffset)
        if (branchDepth >= key.length) throw new Error('truncated mapped split key')
        const byte = key[branchDepth]
        if (!this.positions[byte] || this.counts[byte] === 64) {
          const child = this.append(RECORD.LOOKUP_CHUNK, new Uint8Array(520))
          if (this.positions[byte]) new DataView(this.bytes.buffer, this.bytes.byteOffset + this.positions[byte] + RECORD_HEADER, 520).setUint32(4, child, true)
          else directory.setUint32(16 + byte * 4, child, true)
          this.positions[byte] = child; this.counts[byte] = 0
        }
        const childData = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.positions[byte] + RECORD_HEADER, 520), cursor = this.counts[byte]++
        childData.setUint32(8 + cursor * 8, keyOffset, true); childData.setUint32(12 + cursor * 8, data.getUint32(12 + index * 8, true), true); childData.setUint32(0, cursor + 1, true)
      }
      offset = data.getUint32(4, true)
    }
    for (let byte = 0; byte < 256; byte++) {
      const child = directory.getUint32(16 + byte * 4, true)
      if (child) directory.setUint32(16 + byte * 4, this.finishCold(child, branchDepth + 1), true)
    }
    return root
  }
  split(count, depth) {
    const first = this.key(this.pairs[0]); let branchDepth = first.length
    for (let index = 1; index < count; index++) {
      const key = this.key(this.pairs[index * 2]); let common = depth
      const limit = Math.min(branchDepth, key.length)
      while (common < limit && key[common] === first[common]) common++
      branchDepth = common
      if (branchDepth >= key.length) throw new Error('truncated mapped split key')
    }
    if (branchDepth >= first.length) throw new Error('indistinguishable mapped keys')
    this.counts.fill(0); this.positions.fill(0)
    for (let index = 0; index < count; index++) this.counts[this.key(this.pairs[index * 2])[branchDepth]]++
    const payload = new Uint8Array(1040), data = new DataView(payload.buffer)
    data.setUint32(0, branchDepth, true); data.setUint32(4, this.pairs[0], true); data.setUint32(8, count, true)
    for (let byte = 0; byte < 256; byte++) if (this.counts[byte]) {
      const chunk = new Uint8Array(520), chunkData = new DataView(chunk.buffer)
      chunkData.setUint32(0, this.counts[byte], true)
      const offset = this.append(RECORD.LOOKUP_CHUNK, chunk)
      data.setUint32(16 + byte * 4, offset, true); this.positions[byte] = offset
    }
    this.counts.fill(0)
    for (let index = 0; index < count; index++) {
      const byte = this.key(this.pairs[index * 2])[branchDepth], cursor = this.counts[byte]++
      const chunkData = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.positions[byte] + RECORD_HEADER, 520)
      chunkData.setUint32(8 + cursor * 8, this.pairs[index * 2], true); chunkData.setUint32(12 + cursor * 8, this.pairs[index * 2 + 1], true)
    }
    return this.append(RECORD.DIRECTORY, payload)
  }
  update(root, needle, value, keyOffset = 0, depth = 0) {
    if (!root) return value ? this.chunk(keyOffset || this.append(RECORD.KEY, needle), value) : 0
    const page = this.lookup(root, depth)
    if (page.type === RECORD.DIRECTORY) {
      let difference = depth
      while (difference < page.branchDepth && difference < needle.length && needle[difference] === page.hint[difference]) difference++
      if (difference < page.branchDepth) {
        if (!value) return root
        if (difference >= needle.length) throw new Error('truncated mapped insertion key')
        const key = keyOffset || this.append(RECORD.KEY, needle), payload = new Uint8Array(1040), data = new DataView(payload.buffer)
        data.setUint32(0, difference, true); data.setUint32(4, key, true); data.setUint32(8, page.count + 1, true)
        data.setUint32(16 + page.hint[difference] * 4, root, true); data.setUint32(16 + needle[difference] * 4, this.chunk(key, value), true)
        return this.append(RECORD.DIRECTORY, payload)
      }
      if (page.branchDepth >= needle.length) throw new Error('truncated mapped insertion key')
      const field = 16 + needle[page.branchDepth] * 4, child = page.data.getUint32(field, true), before = child ? this.lookup(child, page.branchDepth + 1).count : 0
      const replacement = this.update(child, needle, value, keyOffset, page.branchDepth + 1)
      const after = replacement ? this.lookup(replacement, page.branchDepth + 1).count : 0, count = page.count + after - before
      if (replacement === child && before === after) return root
      if (!count) return 0
      const offset = this.writable(root, page), data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + RECORD_HEADER, 1040)
      data.setUint32(field, replacement, true); data.setUint32(8, count, true)
      return offset
    }
    let found = -1
    for (let index = 0; !this.building && index < page.count; index++) if (compareBytes(needle, this.key(page.data.getUint32(8 + index * 8, true))) === 0) { found = index; break }
    if (found < 0 && !value || found >= 0 && value === page.data.getUint32(12 + found * 8, true)) return root
    if (found < 0 && page.count === 64) {
      for (let index = 0; index < 64; index++) { this.pairs[index * 2] = page.data.getUint32(8 + index * 8, true); this.pairs[index * 2 + 1] = page.data.getUint32(12 + index * 8, true) }
      this.pairs[128] = keyOffset || this.append(RECORD.KEY, needle); this.pairs[129] = value
      return this.split(65, depth)
    }
    const offset = this.writable(root, page), data = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + RECORD_HEADER, 520)
    if (found >= 0) {
      if (value) data.setUint32(12 + found * 8, value, true)
      else {
        const last = page.count - 1
        if (found !== last) { data.setUint32(8 + found * 8, data.getUint32(8 + last * 8, true), true); data.setUint32(12 + found * 8, data.getUint32(12 + last * 8, true), true) }
        data.setUint32(8 + last * 8, 0, true); data.setUint32(12 + last * 8, 0, true); data.setUint32(0, last, true)
        if (!last) return 0
      }
    } else {
      data.setUint32(8 + page.count * 8, keyOffset || this.append(RECORD.KEY, needle), true); data.setUint32(12 + page.count * 8, value, true); data.setUint32(0, page.count + 1, true)
    }
    return offset
  }
  writeRoot(state, generation, coverage) {
    const numbers = []
    for (const tree of state.trees) numbers.push(tree)
    numbers.push(state.nextOccurrence, state.hasUnresolved ? 1 : 0, state.ordered ? 1 : 0, this.intervals[0][0], this.intervals[0][1], this.intervals[1]?.[0] ?? 0, this.intervals[1]?.[1] ?? 0, this.activeInterval, 0, state.rawUnresolvedCount ?? 0, state.originalRawBoundary ?? 0xffffffff)
    const payload = encodePayload(numbers, [generation, coverage]), length = align(RECORD_HEADER + payload.length)
    while (this.activeInterval < this.intervals.length && this.cursor + length > this.intervals[this.activeInterval][1]) { this.activeInterval++; this.cursor = this.intervals[this.activeInterval]?.[0] ?? this.bytes.length }
    if (this.activeInterval >= this.intervals.length) throw new Error('mapped root capacity exhausted')
    const data = new DataView(payload.buffer); data.setUint32(52, this.activeInterval, true); data.setUint32(56, this.cursor + length, true)
    const offset = this.append(RECORD.PARTITION_ROOT, payload)
    return { offset, length: RECORD_HEADER + payload.length, checksum: checksum(payload) }
  }
}

class ImmutableQueryView {
  constructor(bytes, root, release, observer = null) {
    this.reader = new RecordReader(bytes, root.cursor, observer); this.reader.partitioned = root.partitioned; this.state = root; this.release = release; this.decodeObserver = observer; this.mapped = true; this.immutable = true
  }
  get generation() { return this.state.generation }
  get edgeCoverage() { return this.state.coverage }
  get bytes() { return this.reader.bytes }
  detach() {
    if (this.detached) return 0
    const bytes = new Uint8Array(this.reader.limit); bytes.set(this.reader.bytes.subarray(0, this.reader.limit)); this.reader.bytes = bytes; this.detached = true; this.release(); return bytes.length
  }
  symbolRows(request = {}) {
    this.reader.root(this.state.offset)
    let offsets
    if (request.id) offsets = this.reader.range(this.state.trees[ID], compositeKey([request.id]))
    else if (request.name) offsets = this.reader.range(this.state.trees[NAME], compositeKey([request.name]))
    else if (request.file) { offsets = this.reader.range(this.state.trees[FILE], compositeKey([request.file])); if (!offsets.length) offsets = this.reader.range(this.state.trees[ID]) }
    else offsets = this.reader.range(this.state.trees[ID])
    const rows = []
    for (const offset of offsets) {
      const symbol = this.reader.symbol(offset, this.decodeObserver)
      if (request.name && symbol.row.name !== request.name) continue
      if (request.file && symbol.row.file !== request.file && !symbol.row.file.endsWith(request.file)) continue
      rows.push(symbol)
    }
    rows.sort(this.state.ordered ? orderSymbol : orderSequence)
    return rows
  }
  matchingSymbols(request = {}) { const result = []; for (const symbol of this.symbolRows(request)) result.push(symbol.row); return result }
  get symbols() { return this.matchingSymbols() }
  get files() { const files = new Set(); for (const row of this.symbols) files.add(row.file); return [...files].sort() }
  edgeRows() { this.reader.root(this.state.offset); const result = []; for (const offset of this.reader.range(this.state.trees[OUTGOING])) result.push(this.reader.edge(offset, this.decodeObserver)); result.sort(this.state.ordered ? orderEdge : orderSequence); return result }
  get edges() { const rows = []; for (const edge of this.edgeRows()) rows.push(edge.row); return rows }
  get unresolvedEdges() {
    this.reader.root(this.state.offset)
    const records = []; for (const offset of this.reader.range(this.state.trees[UNRESOLVED])) { const row = this.reader.unresolved(offset); row.effectiveKind = row.kind === 2 ? (row.sequence < this.state.originalRawBoundary ? 0 : 1) : row.kind; records.push(row) }
    records.sort(this.state.ordered ? orderUnresolved : orderSequence)
    const result = []; for (const record of records) result.push(record.row); return result
  }
  relationships(request, direction) {
    const matched = this.symbolRows(request), result = [], tree = this.state.trees[direction === 'incoming' ? INCOMING : OUTGOING]
    for (const match of matched) {
      const firstOffsets = this.reader.range(this.state.trees[ID], compositeKey([match.row.id]))
      if (!firstOffsets.length) continue
      let first = null
      for (const offset of firstOffsets) { const symbol = this.reader.symbol(offset, null); if (!first || symbol.occurrence < first.occurrence) first = symbol }
      const rows = []
      for (const offset of this.reader.range(tree, compositeKey([match.row.id, first.occurrence]))) rows.push(this.reader.edge(offset, this.decodeObserver))
      rows.sort(this.state.ordered ? orderEdge : orderSequence)
      for (const edge of rows) result.push(edge.row)
    }
    return result
  }
  get graph() {
    this.decodeObserver?.({ type: 'graph' })
    return { generation: this.generation, edgeCoverage: this.edgeCoverage, files: this.files, symbols: this.symbols, edges: this.edges, ...(this.state.hasUnresolved ? { unresolvedEdges: this.unresolvedEdges } : {}) }
  }
}

function coldState(writer, graph, legacy = null) {
  const trees = [0, 0, 0, 0, 0, 0], lastSymbols = new Map(), edgeOccurrences = new Map(), unresolvedOccurrences = new Map()
  const tails = new Uint32Array(6), counts = new Uint32Array(6), views = [null, null, null, null, null, null]
  let nextOccurrence = 0
  for (const row of graph.symbols) {
    const occurrence = nextOccurrence++, value = writer.writeSymbol(row, occurrence, occurrence), keys = symbolKeys(row, occurrence)
    lastSymbols.set(row.id, occurrence)
    for (let index = 0; index < 3; index++) writer.stageCold(trees, tails, counts, views, index, keys[index], value)
  }
  let sequence = 0
  for (const row of graph.edges) {
    const group = compositeKey([row.from, row.to, (row.line ^ 0x80000000) >>> 0]).toString(), occurrence = edgeOccurrences.get(group) ?? 0
    edgeOccurrences.set(group, occurrence + 1)
    let fromOccurrence = lastSymbols.get(row.from), toOccurrence = lastSymbols.get(row.to)
    if (legacy) {
      const base = legacy.data.getUint32(28, true) + sequence * EDGE_BYTES
      fromOccurrence = legacy.data.getUint32(base, true); toOccurrence = legacy.data.getUint32(base + 4, true)
    }
    if (fromOccurrence === undefined || toOccurrence === undefined || fromOccurrence >= graph.symbols.length || toOccurrence >= graph.symbols.length) throw new Error('mapped edge endpoint missing')
    const value = writer.writeEdge(row, sequence++, fromOccurrence, toOccurrence, occurrence), keys = edgeKeys(row, fromOccurrence, toOccurrence, occurrence)
    writer.stageCold(trees, tails, counts, views, INCOMING, keys[0], value); writer.stageCold(trees, tails, counts, views, OUTGOING, keys[1], value)
  }
  sequence = 0
  for (const row of graph.unresolvedEdges ?? []) {
    const group = compositeKey([row.from, row.to, (row.line ^ 0x80000000) >>> 0]).toString(), occurrence = unresolvedOccurrences.get(group) ?? 0
    unresolvedOccurrences.set(group, occurrence + 1)
    const value = writer.writeUnresolved(row, sequence++, 2, occurrence)
    writer.stageCold(trees, tails, counts, views, UNRESOLVED, unresolvedKey(row, 2, occurrence), value)
  }
  for (let index = 0; index < 6; index++) trees[index] = writer.finishCold(trees[index])
  return { trees, partitioned: true, nextOccurrence, hasUnresolved: Array.isArray(graph.unresolvedEdges), ordered: false, originalRawBoundary: 0xffffffff, rawUnresolvedCount: graph.unresolvedEdges?.length ?? 0 }
}
function symbolOccurrence(writer, state, id, last = true) {
  const offsets = writer.range(state.trees[ID], compositeKey([id]))
  if (!offsets.length) throw new Error('mapped edge endpoint missing')
  let occurrence = last ? -1 : Infinity
  for (const offset of offsets) { const current = writer.symbol(offset, null).occurrence; if (last ? current > occurrence : current < occurrence) occurrence = current }
  return occurrence
}
function patchSymbols(writer, state, view) {
  const oldRows = writer.range(state.trees[FILE], compositeKey([view.file])), available = new Map(), retained = new Set()
  for (const offset of oldRows) { const record = writer.symbol(offset, null), bucket = available.get(record.row.id); if (bucket) bucket.push(record); else available.set(record.row.id, [record]) }
  for (const row of view.newPartition?.symbols ?? []) {
    const bucket = available.get(row.id); let previous = null
    for (const candidate of bucket ?? []) if (!retained.has(candidate.offset) && sameSymbol(candidate.row, row) && (!previous || candidate.occurrence < previous.occurrence)) previous = candidate
    if (previous) { retained.add(previous.offset); continue }
    for (const candidate of bucket ?? []) if (!retained.has(candidate.offset) && (!previous || candidate.occurrence < previous.occurrence)) previous = candidate
    const occurrence = previous ? previous.occurrence : state.nextOccurrence++, value = writer.writeSymbol(row, previous?.sequence ?? occurrence, occurrence), keys = symbolKeys(row, occurrence)
    if (previous) {
      retained.add(previous.offset)
      const oldKeys = symbolKeys(previous.row, previous.occurrence)
      for (let index = 0; index < 3; index++) if (compareBytes(oldKeys[index], keys[index])) state.trees[index] = writer.update(state.trees[index], oldKeys[index], 0)
    }
    for (let index = 0; index < 3; index++) state.trees[index] = writer.update(state.trees[index], keys[index], value)
  }
  for (const offset of oldRows) {
    if (retained.has(offset)) continue
    const record = writer.symbol(offset, null), keys = symbolKeys(record.row, record.occurrence)
    for (let index = 0; index < 3; index++) state.trees[index] = writer.update(state.trees[index], keys[index], 0)
  }
}
function groupEdgeRecords(writer, state, group) {
  const result = [], offsets = writer.range(state.trees[ID], compositeKey([group.from]))
  for (const offset of offsets) {
    const occurrence = writer.symbol(offset, null).occurrence
    const prefix = compositeKey([group.from, occurrence, group.to, (group.line ^ 0x80000000) >>> 0])
    for (const value of writer.range(state.trees[OUTGOING], prefix)) { const record = writer.edge(value, null); result[record.occurrence] = record }
  }
  return result
}
function patchEdges(writer, state, view, parentState) {
  for (const group of view.publicationChanges.groups) {
    const before = group.before.edges ?? [], after = group.after.edges ?? []
    if (sameRows(before, after)) continue
    const records = groupEdgeRecords(writer, parentState, group)
    if (records.length !== before.length) throw new Error('mapped publication parent occurrence count mismatch')
    for (let index = 0; index < records.length; index++) {
      const record = records[index]
      if (!sameRows([record.row], [before[index]])) throw new Error('mapped publication parent occurrence mismatch')
      const keys = edgeKeys(record.row, record.fromOccurrence, record.toOccurrence, record.occurrence)
      state.trees[INCOMING] = writer.update(state.trees[INCOMING], keys[0], 0); state.trees[OUTGOING] = writer.update(state.trees[OUTGOING], keys[1], 0)
    }
    let occurrence = 0
    for (const row of after) {
      const fromOccurrence = symbolOccurrence(writer, state, row.from), toOccurrence = symbolOccurrence(writer, state, row.to)
      const value = writer.writeEdge(row, occurrence, fromOccurrence, toOccurrence, occurrence), keys = edgeKeys(row, fromOccurrence, toOccurrence, occurrence)
      state.trees[INCOMING] = writer.update(state.trees[INCOMING], keys[0], value); state.trees[OUTGOING] = writer.update(state.trees[OUTGOING], keys[1], value); occurrence++
    }
  }
}

function patchUnresolved(writer, state, view, parentState) {
  for (const group of view.publicationChanges.groups) {
    if (sameRows(group.before.unresolved ?? [], group.after.unresolved ?? []) && sameRows(group.before.missing ?? [], group.after.missing ?? [])) continue
    const records = [[], []]
    for (let kind = 0; kind < 3; kind++) {
      const prefix = compositeKey([kind, group.from, group.to, (group.line ^ 0x80000000) >>> 0])
      for (const offset of writer.range(parentState.trees[UNRESOLVED], prefix)) {
        const record = writer.unresolved(offset), section = kind === 2 ? (record.sequence < state.originalRawBoundary ? 0 : 1) : kind
        records[section].push(record)
      }
    }
    for (let kind = 0; kind < 2; kind++) {
      const section = kind ? 'missing' : 'unresolved', before = group.before[section] ?? [], after = group.after[section] ?? [], previous = []
      let firstOccurrence = Infinity
      for (const record of records[kind]) if (record.occurrence < firstOccurrence) firstOccurrence = record.occurrence
      for (const record of records[kind]) previous[record.occurrence - firstOccurrence] = record
      if (previous.length !== before.length) throw new Error('mapped unresolved parent occurrence count mismatch')
      for (let index = 0; index < previous.length; index++) {
        const record = previous[index]
        if (!sameRows([record.row], [before[index]])) throw new Error('mapped unresolved parent occurrence mismatch')
        state.trees[UNRESOLVED] = writer.update(state.trees[UNRESOLVED], unresolvedKey(record.row, record.kind, record.occurrence), 0)
      }
      let occurrence = 0
      for (const row of after) {
        const value = writer.writeUnresolved(row, occurrence, kind, occurrence)
        state.trees[UNRESOLVED] = writer.update(state.trees[UNRESOLVED], unresolvedKey(row, kind, occurrence), value); occurrence++
      }
      if (!kind) state.rawUnresolvedCount += after.length - before.length
    }
  }
}

export class MmapQueryCache {
  constructor({ filePath, root, adapter, capacityBytes = 1024 * 1024 * 1024, decodeObserver = null }) {
    this.rootHash = rootFingerprint(root); this.adapter = adapter; this.capacity = Math.max(1024, Math.floor(capacityBytes))
    this.handle = null; this.mapping = null; this.leases = [0, 0]; this.disposed = false; this.decodeObserver = decodeObserver; this.views = new Set(); this.viewFinalizer = new FinalizationRegistry(retireView); this.rollbackHeader = new Uint8Array(HEADER_BYTES)
    if (!adapter) return
    try {
      this.handle = adapter.open(filePath, this.capacity); this.mapping = adapter.map(this.handle)
      if (this.mapping instanceof Uint8Array && this.mapping.byteLength < this.capacity) {
        try { adapter.unmap(this.mapping) } catch {}; this.mapping = null
        adapter.resize(this.handle, this.capacity); this.mapping = adapter.map(this.handle)
      }
      if (!(this.mapping instanceof Uint8Array) || this.mapping.byteLength < this.capacity) throw new Error('invalid mmap mapping')
      this.#migrate()
    } catch { this.#releaseNative() }
  }
  #legacyPages() {
    const scratchEnd = HEADER_BYTES + SCRATCH_BYTES, upper = Math.floor(this.capacity / 2) + 2048
    return [{ offset: upper, capacity: this.capacity - upper }, { offset: scratchEnd, capacity: upper - scratchEnd }]
  }
  #readHeader() {
    if (!this.mapping || this.mapping.byteLength < HEADER_BYTES) return null
    const bytes = this.mapping.subarray(0, HEADER_BYTES), data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), version = data.getUint32(4, true)
    if (data.getUint32(0, true) !== FILE_MAGIC || (version !== 3 && version !== VERSION) || data.getUint32(8, true) !== this.capacity || data.getUint32(12, true) !== this.rootHash || checksum(bytes.subarray(0, HEADER_CHECKSUM_OFFSET)) !== data.getUint32(HEADER_CHECKSUM_OFFSET, true) || data.getUint32(24, true) !== HEADER_BYTES || data.getUint32(28, true) !== SCRATCH_BYTES) return null
    const active = data.getUint32(16, true); if (active > 1) return null
    const expected = this.#legacyPages(), pages = []
    for (let index = 0; index < 2; index++) {
      const base = 32 + index * 16, offset = data.getUint32(base, true), length = data.getUint32(base + 4, true)
      if (version === 3 && (offset !== expected[index].offset || length > expected[index].capacity)) return null
      if (version === VERSION && length && (offset < HEADER_BYTES + SCRATCH_BYTES || length > this.capacity - offset)) return null
      pages.push({ offset, length, checksum: data.getUint32(base + 8, true), serial: data.getUint32(base + 12, true), capacity: expected[index].capacity })
    }
    return { version, active, serial: data.getUint32(20, true), pages }
  }
  #writeHeader(header) {
    const bytes = new Uint8Array(HEADER_BYTES), data = new DataView(bytes.buffer)
    data.setUint32(0, FILE_MAGIC, true); data.setUint32(4, VERSION, true); data.setUint32(8, this.capacity, true); data.setUint32(12, this.rootHash, true)
    data.setUint32(16, header.active, true); data.setUint32(20, header.serial, true); data.setUint32(24, HEADER_BYTES, true); data.setUint32(28, SCRATCH_BYTES, true)
    for (let index = 0; index < 2; index++) { const page = header.pages[index], base = 32 + index * 16; data.setUint32(base, page.offset, true); data.setUint32(base + 4, page.length, true); data.setUint32(base + 8, page.checksum, true); data.setUint32(base + 12, page.serial, true) }
    data.setUint32(HEADER_CHECKSUM_OFFSET, checksum(bytes.subarray(0, HEADER_CHECKSUM_OFFSET)), true); this.mapping.set(bytes, 0)
  }
  #root(descriptor) {
    if (!descriptor.length) return null
    const reader = new RecordReader(this.mapping, this.capacity), payload = reader.record(descriptor.offset, reader.recordType(descriptor.offset))
    if (descriptor.length !== RECORD_HEADER + payload.length || descriptor.checksum !== checksum(payload)) throw new Error('invalid mapped root descriptor')
    const root = reader.root(descriptor.offset)
    if (descriptor.offset + descriptor.length > root.cursor || root.activeInterval > 1 || root.cursor < root.intervals[root.activeInterval][0] || root.cursor > root.intervals[root.activeInterval][1]) throw new Error('invalid committed allocation cursor')
    for (let index = 0; index < root.intervals.length; index++) { const [start, end] = root.intervals[index]; if (start === 0 && end === 0 && index === 1) continue; if (start < HEADER_BYTES + SCRATCH_BYTES || start > end || end > this.capacity || start % 8 || index && start < root.intervals[index - 1][1]) throw new Error('invalid committed allocation interval') }
    return root
  }
  #allocation(header) {
    let allocation = { intervals: [[HEADER_BYTES + SCRATCH_BYTES, this.capacity], [0, 0]], activeInterval: 0, cursor: HEADER_BYTES + SCRATCH_BYTES }
    for (const descriptor of header.pages) { const root = this.#root(descriptor); if (root && root.cursor > allocation.cursor) allocation = root }
    return allocation
  }
  #legacy(descriptor) {
    if (!descriptor.length) return null
    const guard = descriptor.offset > this.capacity / 2 ? descriptor.offset - 2048 : descriptor.offset
    if (checksum(this.mapping.subarray(guard, descriptor.offset + descriptor.length)) !== descriptor.checksum) return null
    const data = new DataView(this.mapping.buffer, this.mapping.byteOffset + descriptor.offset, descriptor.length)
    if (data.getUint32(0, true) !== PAGE_MAGIC || data.getUint32(4, true) !== 3) return null
    return new LegacyQueryView(this.mapping, descriptor.offset, descriptor.length, noop, this.decodeObserver)
  }
  #commit(header, writer, signal) {
    writer.finalize()
    for (const range of writer.ranges) this.adapter.flush(this.mapping, range.offset, range.length)
    if (signal?.aborted) return false
    this.rollbackHeader.set(this.mapping.subarray(0, HEADER_BYTES)); this.#writeHeader(header)
    try { this.adapter.flush(this.mapping, 0, HEADER_BYTES) } catch { this.mapping.set(this.rollbackHeader, 0); try { this.adapter.flush(this.mapping, 0, HEADER_BYTES) } catch {}; return false }
    return true
  }
  #migrate() {
    const header = this.#readHeader(); if (header?.version === VERSION) return this.#migrateAvl(header)
    if (header?.version !== 3) return false
    try {
      const legacy = [], protectedPages = this.#legacyPages(), lower = header.pages[1], upper = header.pages[0]
      for (let index = 0; index < 2; index++) legacy.push(this.#legacy(header.pages[index]))
      if (!legacy[0] && !legacy[1]) return false
      const lowerStart = align(protectedPages[1].offset + lower.length)
      const intervals = [[lowerStart, Math.max(lowerStart, protectedPages[0].offset - 2048)], [align(protectedPages[0].offset + upper.length), this.capacity]]
      const writer = new RecordWriter(this.mapping, { intervals, activeInterval: 0, cursor: intervals[0][0] }), pages = []
      for (let index = 0; index < 2; index++) {
        const view = legacy[index]
        if (!view) { pages.push({ offset: 0, length: 0, checksum: 0, serial: header.pages[index].serial }); continue }
        const graph = { symbols: view.symbols, edges: view.edges, ...(view.data.getUint32(view.pageLength - 4, true) ? { unresolvedEdges: view.unresolvedEdges } : {}) }
        const state = coldState(writer, graph, view), descriptor = writer.writeRoot(state, view.generation, view.edgeCoverage)
        pages.push({ ...descriptor, serial: header.pages[index].serial })
      }
      // Each root carries the final allocator cursor so either retained descriptor can reopen safely.
      for (let index = 0; index < 2; index++) if (legacy[index]) {
        const state = writer.root(pages[index].offset), descriptor = writer.writeRoot(state, state.generation, state.coverage)
        pages[index] = { ...descriptor, serial: pages[index].serial }
      }
      return this.#commit({ ...header, version: VERSION, pages }, writer)
    } catch { return false }
  }
  #migrateAvl(header) {
    try {
      const roots = []
      let old = false
      for (const descriptor of header.pages) { const root = this.#root(descriptor); roots.push(root); if (root && !root.partitioned) old = true }
      if (!old) return true
      const writer = new RecordWriter(this.mapping, this.#allocation(header)), reader = new RecordReader(this.mapping, this.capacity), pages = []
      writer.building = true
      for (let index = 0; index < 2; index++) {
        const root = roots[index]
        if (!root || root.partitioned) { pages.push(header.pages[index]); continue }
        const trees = []
        for (const tree of root.trees) trees.push(reader.migrateIndex(tree, writer))
        pages.push({ ...writer.writeRoot({ ...root, trees, partitioned: true }, root.generation, root.coverage), serial: header.pages[index].serial })
      }
      return this.#commit({ ...header, pages }, writer)
    } catch { return false }
  }
  publish({ generation, coverage, view }, { signal } = {}) {
    if (!this.mapping || this.disposed || signal?.aborted || this.capacity < HEADER_BYTES + SCRATCH_BYTES + RECORD_HEADER) return false
    try {
      let header = this.#readHeader()
      if (header?.version === 3) return false
      if (header) for (const descriptor of header.pages) { const root = this.#root(descriptor); if (root && !root.partitioned) return false }
      if (!header) {
        const data = new DataView(this.mapping.buffer, this.mapping.byteOffset, HEADER_BYTES)
        let empty = true
        for (let index = 0; index < HEADER_BYTES; index++) if (this.mapping[index] !== 0) { empty = false; break }
        const legacyV2 = data.getUint32(0, true) === FILE_MAGIC && data.getUint32(4, true) === 2 && checksum(this.mapping.subarray(0, HEADER_CHECKSUM_OFFSET)) === data.getUint32(HEADER_CHECKSUM_OFFSET, true)
        if (!empty && !legacyV2) return false
        header = { version: VERSION, active: 0, serial: 0, pages: [{ offset: 0, length: 0, checksum: 0, serial: 0 }, { offset: 0, length: 0, checksum: 0, serial: 0 }] }
      }
      const writer = new RecordWriter(this.mapping, this.#allocation(header)), expectedCoverage = coverageName(requireCoverage(coverage))
      const reusable = view.publicationState?.owner === this && view.publicationState.generation === generation ? view.publicationState : null
      let state
      if (view.parent) {
        if (!view.parent.immutable || view.parent.generation !== view.parent.state.generation) return false
        const parentState = writer.root(view.parent.state.offset)
        if (parentState.generation !== view.parent.generation) return false
        const activeRoot = this.#root(header.pages[header.active])
        if (!activeRoot || activeRoot.generation !== parentState.generation && !(activeRoot.generation === generation && reusable)) return false
        if (reusable) state = reusable
        else {
          const trees = []; for (const tree of parentState.trees) trees.push(tree)
          state = { ...parentState, trees }
          if (state.originalRawBoundary === 0xffffffff) {
            const rawBefore = view.publicationChanges.rawUnresolvedBeforeCount ?? (state.trees[UNRESOLVED] ? NaN : 0)
            const total = writer.count(state.trees[UNRESOLVED])
            if (!Number.isInteger(rawBefore) || rawBefore < 0 || rawBefore > total) return false
            state.originalRawBoundary = rawBefore; state.rawUnresolvedCount = rawBefore
          } else if (view.publicationChanges.rawUnresolvedBeforeCount !== undefined && view.publicationChanges.rawUnresolvedBeforeCount !== state.rawUnresolvedCount) return false
          patchSymbols(writer, state, view); patchEdges(writer, state, view, parentState)
          patchUnresolved(writer, state, view, parentState)
          for (let index = 0; index < trees.length; index++) if (trees[index] !== parentState.trees[index]) { state.ordered = true; break }
          state.hasUnresolved = view.manifest ? Array.isArray(view.manifest.unresolvedEdges) : parentState.hasUnresolved || Boolean(state.trees[UNRESOLVED])
        }
      } else if (reusable && reusable.graph === view.graph && this.#root(header.pages[header.active])?.generation === generation) state = reusable
      else state = coldState(writer, view.graph)
      const target = header.serial === 0 ? 0 : 1 - header.active, descriptor = writer.writeRoot(state, generation, expectedCoverage)
      header.pages[target] = { ...descriptor, serial: ++header.serial }; header.active = target
      if (!this.#commit(header, writer, signal)) return false
      if (Object.isExtensible(view)) Object.defineProperty(view, 'publicationState', { value: { ...state, generation, owner: this, graph: view.parent ? undefined : view.graph }, writable: true, configurable: true })
      return true
    } catch { return false }
  }
  cloneGeneration({ fromGeneration, generation, coverage }) {
    if (!this.mapping || this.disposed) return false
    try {
      const header = this.#readHeader(); if (!header || header.version !== VERSION) return false
      const expectedCoverage = coverageName(requireCoverage(coverage))
      for (const index of [header.active, 1 - header.active]) {
        const source = this.#root(header.pages[index]); if (!source || source.generation !== fromGeneration || source.coverage !== expectedCoverage) continue
        if (!source.partitioned) return false
        const writer = new RecordWriter(this.mapping, this.#allocation(header))
        const target = 1 - index, descriptor = writer.writeRoot(source, generation, expectedCoverage)
        header.pages[target] = { ...descriptor, serial: ++header.serial }; header.active = target
        return this.#commit(header, writer)
      }
    } catch {}
    return false
  }
  acquire({ generation, coverage }) {
    if (!this.mapping || this.disposed) return null
    try {
      const header = this.#readHeader(); if (!header) return null
      const expectedCoverage = coverageName(requireCoverage(coverage))
      for (const index of [header.active, 1 - header.active]) {
        let mappedView
        try {
          if (header.version === 3) mappedView = this.#legacy(header.pages[index])
          else { const root = this.#root(header.pages[index]); if (root) mappedView = new ImmutableQueryView(this.mapping, root, noop, this.decodeObserver) }
        } catch { continue }
        if (!mappedView || mappedView.generation !== generation || mappedView.edgeCoverage !== expectedCoverage) continue
        const weak = new WeakRef(mappedView); this.views.add(weak); this.viewFinalizer.register(mappedView, { references: this.views, weak }, weak); this.leases[index]++
        const leaseState = { cache: this, index, released: false }
        const release = releaseMappedLease.bind(leaseState)
        mappedView.release = release
        const value = {}
        Object.defineProperty(value, 'graph', { enumerable: true, get: mappedGraph.bind(mappedView) }); Object.defineProperty(value, 'mappedView', { value: mappedView })
        return { value, release }
      }
    } catch {}
    return null
  }
  dispose() {
    if (this.disposed) return
    for (const reference of this.views) { const view = reference.deref(); if (view) view.detach(); this.viewFinalizer.unregister(reference) }
    this.views.clear(); this.disposed = true; this.#releaseNative()
  }
  #releaseNative() { if (this.mapping) { try { this.adapter?.unmap(this.mapping) } catch {}; this.mapping = null } if (this.handle) { try { this.adapter?.close(this.handle) } catch {}; this.handle = null } }
}
function mappedGraph() { return this.graph }

function retireView({ references, weak }) { references.delete(weak) }
function releaseMappedLease() { if (!this.released) { this.released = true; this.cache.leases[this.index] = Math.max(0, this.cache.leases[this.index] - 1) } }

function noop() {}
