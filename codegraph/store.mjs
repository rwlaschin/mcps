import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const stable = (value) => JSON.stringify(value)
const digest = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex')
const digestSerialized = (value) => crypto.createHash('sha256').update(value).digest('hex')

export const OVERLAY_VERSION = 2
const INTERNAL_MAGIC = Buffer.from('CGIN')
export const INTERNAL_SCHEMA_VERSION = 1
const NONE = 0xffffffff
const OWNER_KINDS = ['module', 'function', 'arrow', 'method', 'constructor', 'getter', 'setter', 'static-block', 'field-initializer']
const NODE_KINDS = ['entry', 'exit', 'statement', 'condition', 'loop', 'case', 'call', 'return', 'throw', 'break', 'continue', 'assignment', 'await', 'yield']
const ROLES = ['body', 'condition', 'consequent', 'alternate', 'initializer', 'update', 'operand', 'callee', 'argument', 'handler', 'finalizer']
const EDGE_KINDS = ['next', 'true', 'false', 'case', 'default', 'back', 'break', 'continue', 'return', 'throw', 'exception', 'finally']
const RELATION_KINDS = ['call', 'read', 'write']
const MAX_INTERNAL_RECORDS = 10_000_000
const SYMBOL_MAGIC = 0x50534743
const SYMBOL_SCHEMA_VERSION = 1
const SYMBOL_HEADER_BYTES = 48
const SYMBOL_RECORD_BYTES = 36
const SYMBOL_EDGE_BYTES = 16
const SYMBOL_UNRESOLVED_BYTES = 12
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()
const code = (list, value, label) => { const result = list.indexOf(value); if (result < 0) throw new Error(`unknown internal ${label}: ${value}`); return result }
const decodeCode = (list, value, label) => { if (!list[value]) throw new Error(`invalid internal ${label} code: ${value}`); return list[value] }
const uint32 = (value, label, nullable = false) => {
  if (nullable && (value === null || value === undefined)) return NONE
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${label} must be a uint32`)
  return value
}

const symbolStrings = (partition) => {
  const symbols = partition.symbols ?? []; const edges = partition.edges ?? []; const dependencies = partition.dependencies ?? []; const unresolved = partition.unresolved ?? []
  const indexes = new Map(); const values = []
  const intern = (value) => { value = String(value ?? ''); if (indexes.has(value)) return indexes.get(value); const index = values.length; indexes.set(value, index); values.push(value); return index }
  const file = intern(partition.file); const sourceHash = intern(partition.sourceHash)
  for (const row of symbols) for (const value of [row.id, row.file, row.name, row.kind, row.qualifiedPath, row.signature]) intern(value)
  for (const row of edges) { intern(row.from); intern(row.to) }
  for (const value of dependencies) intern(value)
  let candidateCount = 0
  for (const row of unresolved) { intern(row.specifier); for (const value of row.candidates) intern(value); candidateCount += row.candidates.length }
  return { symbols, edges, dependencies, unresolved, values, indexes, file, sourceHash, candidateCount }
}

export function symbolPartitionLayout(partition) {
  const strings = symbolStrings(partition)
  const recordsEnd = SYMBOL_HEADER_BYTES + strings.symbols.length * SYMBOL_RECORD_BYTES + strings.edges.length * SYMBOL_EDGE_BYTES + strings.dependencies.length * 4 + strings.unresolved.length * SYMBOL_UNRESOLVED_BYTES + strings.candidateCount * 4
  let stringBytes = 0
  for (const value of strings.values) stringBytes += 4 + UTF8_ENCODER.encode(value).byteLength
  return { ...strings, recordsEnd, byteLength: recordsEnd + stringBytes }
}

export function writeSymbolPartition(partition, layout, target) {
  const bytes = target instanceof Uint8Array ? target : new Uint8Array(target)
  if (bytes.byteLength !== layout.byteLength) throw new Error('packed symbol target length mismatch')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const u = (offset, value) => view.setUint32(offset, value >>> 0, true)
  const stringOffsets = new Uint32Array(layout.values.length); let cursor = layout.recordsEnd
  layout.values.forEach((value, index) => { const encoded = UTF8_ENCODER.encode(value); stringOffsets[index] = cursor; u(cursor, encoded.byteLength); bytes.set(encoded, cursor + 4); cursor += 4 + encoded.byteLength })
  ;[SYMBOL_MAGIC, SYMBOL_SCHEMA_VERSION, layout.byteLength, layout.symbols.length, layout.edges.length, layout.dependencies.length, layout.unresolved.length, layout.candidateCount, layout.recordsEnd, stringOffsets[layout.file], stringOffsets[layout.sourceHash], 0].forEach((value, index) => u(index * 4, value))
  let offset = SYMBOL_HEADER_BYTES
  for (const row of layout.symbols) { [layout.indexes.get(row.id), layout.indexes.get(row.file), layout.indexes.get(row.name), layout.indexes.get(row.kind), row.line, layout.indexes.get(row.qualifiedPath), layout.indexes.get(row.signature), row.ordinal, row.exported ? 1 : 0].forEach((value, index) => u(offset + index * 4, value)); offset += SYMBOL_RECORD_BYTES }
  for (const row of layout.edges) { [layout.indexes.get(row.from), layout.indexes.get(row.to), row.line, row.call ? 1 : 0].forEach((value, index) => u(offset + index * 4, value)); offset += SYMBOL_EDGE_BYTES }
  for (const value of layout.dependencies) { u(offset, layout.indexes.get(value)); offset += 4 }
  let candidate = 0
  for (const row of layout.unresolved) { u(offset, layout.indexes.get(row.specifier)); u(offset + 4, candidate); u(offset + 8, row.candidates.length); offset += SYMBOL_UNRESOLVED_BYTES; candidate += row.candidates.length }
  for (const row of layout.unresolved) for (const value of row.candidates) { u(offset, layout.indexes.get(value)); offset += 4 }
  for (let index = 0; index < stringOffsets.length; index += 1) stringOffsets[index] = stringOffsets[index]
  // Records store string-table indexes; rewrite them to byte offsets once, in place.
  const convert = (at) => u(at, stringOffsets[view.getUint32(at, true)])
  offset = SYMBOL_HEADER_BYTES
  for (let index = 0; index < layout.symbols.length; index += 1, offset += SYMBOL_RECORD_BYTES) for (const field of [0, 1, 2, 3, 5, 6]) convert(offset + field * 4)
  for (let index = 0; index < layout.edges.length; index += 1, offset += SYMBOL_EDGE_BYTES) { convert(offset); convert(offset + 4) }
  for (let index = 0; index < layout.dependencies.length; index += 1, offset += 4) convert(offset)
  for (let index = 0; index < layout.unresolved.length; index += 1, offset += SYMBOL_UNRESOLVED_BYTES) convert(offset)
  for (let index = 0; index < layout.candidateCount; index += 1, offset += 4) convert(offset)
  return bytes
}

const openSymbolPartition = (input, offset = 0, length = input.byteLength - offset) => {
  const bytes = input instanceof Uint8Array ? input.subarray(offset, offset + length) : new Uint8Array(input, offset, length)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const u = (at) => view.getUint32(at, true)
  if (length < SYMBOL_HEADER_BYTES || u(0) !== SYMBOL_MAGIC || u(4) !== SYMBOL_SCHEMA_VERSION || u(8) !== length) throw new Error('invalid packed symbol partition')
  const stringAt = (at) => { const size = u(at); if (at < u(32) || at + 4 + size > length) throw new Error('invalid packed symbol string'); return UTF8_DECODER.decode(bytes.subarray(at + 4, at + 4 + size)) }
  return { bytes, view, u, stringAt, counts: { symbols: u(12), edges: u(16), dependencies: u(20), unresolved: u(24), candidates: u(28) }, file: stringAt(u(36)), sourceHash: stringAt(u(40)) }
}

export const readSymbolPartitionIdentity = (bytes, offset, length) => { const packed = openSymbolPartition(bytes, offset, length); return { file: packed.file, sourceHash: packed.sourceHash } }

export function decodeSymbolPartition(input, offset = 0, length = input.byteLength - offset) {
  const packed = openSymbolPartition(input, offset, length); const { u, stringAt, counts } = packed; let cursor = SYMBOL_HEADER_BYTES
  const symbols = Array.from({ length: counts.symbols }, () => { const row = { id: stringAt(u(cursor)), file: stringAt(u(cursor + 4)), name: stringAt(u(cursor + 8)), kind: stringAt(u(cursor + 12)), line: u(cursor + 16), qualifiedPath: stringAt(u(cursor + 20)), signature: stringAt(u(cursor + 24)), ordinal: u(cursor + 28), exported: Boolean(u(cursor + 32)) }; cursor += SYMBOL_RECORD_BYTES; return row })
  const edges = Array.from({ length: counts.edges }, () => { const row = { from: stringAt(u(cursor)), to: stringAt(u(cursor + 4)), line: u(cursor + 8), call: Boolean(u(cursor + 12)) }; cursor += SYMBOL_EDGE_BYTES; return row })
  const dependencies = Array.from({ length: counts.dependencies }, () => { const value = stringAt(u(cursor)); cursor += 4; return value })
  const unresolvedRows = Array.from({ length: counts.unresolved }, () => { const row = { specifier: stringAt(u(cursor)), start: u(cursor + 4), count: u(cursor + 8) }; cursor += SYMBOL_UNRESOLVED_BYTES; return row })
  const candidates = Array.from({ length: counts.candidates }, () => { const value = stringAt(u(cursor)); cursor += 4; return value })
  return { file: packed.file, sourceHash: packed.sourceHash, symbols, edges, dependencies, unresolved: unresolvedRows.map(({ specifier, start, count }) => ({ specifier, candidates: candidates.slice(start, start + count) })) }
}

export function encodeInternalPartition(input) {
  const strings = []; const stringOffsets = new Map(); let stringBytes = 0
  const intern = (value) => {
    if (value === null || value === undefined) return NONE
    value = String(value)
    if (stringOffsets.has(value)) return stringOffsets.get(value)
    const offset = stringBytes; const bytes = Buffer.byteLength(value); stringOffsets.set(value, offset); strings.push(Buffer.from(`${value}\0`)); stringBytes += bytes + 1; return offset
  }
  const owners = input.owners ?? []; const nodes = input.nodes ?? []; const edges = input.edges ?? []; const relations = input.relations ?? []
  for (const [label, rows] of [['owners', owners], ['nodes', nodes], ['edges', edges], ['relations', relations]]) if (!Number.isInteger(rows.length) || rows.length > MAX_INTERNAL_RECORDS) throw new Error(`internal ${label} count exceeds allocation limit`)
  const fingerprintOffset = intern(input.compilerFingerprint ?? '')
  const ownerBuffer = Buffer.alloc(owners.length * 80)
  owners.forEach((owner, index) => {
    const o = index * 80; const values = [uint32(owner.id, 'owner id'), intern(owner.symbolId), uint32(owner.parentOwnerId, 'parent owner id', true), code(OWNER_KINDS, owner.kind, 'owner kind'), intern(owner.name), intern(owner.file), uint32(owner.start, 'owner start'), uint32(owner.end, 'owner end'), uint32(owner.line, 'owner line', true), uint32(owner.column, 'owner column', true), uint32(owner.endLine, 'owner end line', true), uint32(owner.endColumn, 'owner end column', true), uint32(owner.entryNodeId, 'entry node id'), uint32(owner.exitNodeId, 'exit node id'), uint32(owner.cyclomatic, 'cyclomatic'), uint32(owner.branchCount, 'branch count'), uint32(owner.nestingDepth, 'nesting depth'), uint32(owner.firstNode, 'first node', true), uint32(owner.nodeCount, 'node count', true), uint32(owner.flags ?? 0, 'owner flags')]
    values.forEach((value, field) => ownerBuffer.writeUInt32LE(value >>> 0, o + field * 4))
  })
  const nodeBuffer = Buffer.alloc(nodes.length * 64)
  nodes.forEach((node, index) => {
    const o = index * 64; const values = [uint32(node.id, 'node id'), uint32(node.ownerId, 'node owner id'), uint32(node.parentId, 'node parent id', true), code(NODE_KINDS, node.kind, 'node kind'), code(ROLES, node.role ?? 'body', 'role'), uint32(node.start, 'node start'), uint32(node.end, 'node end'), uint32(node.line, 'node line', true), uint32(node.column, 'node column', true), uint32(node.endLine, 'node end line', true), uint32(node.endColumn, 'node end column', true), intern(node.symbolId), node.unreachable ? 1 : 0, uint32(node.flags ?? 0, 'node flags'), 0, 0]
    values.forEach((value, field) => nodeBuffer.writeUInt32LE(value >>> 0, o + field * 4))
  })
  const edgeBuffer = Buffer.alloc(edges.length * 16)
  edges.forEach((edge, index) => { const o = index * 16; [uint32(edge.ownerId, 'edge owner id'), uint32(edge.from, 'edge source'), uint32(edge.to, 'edge target'), code(EDGE_KINDS, edge.kind, 'edge kind')].forEach((value, field) => edgeBuffer.writeUInt32LE(value, o + field * 4)) })
  const relationBuffer = Buffer.alloc(relations.length * 16)
  relations.forEach((relation, index) => { if (!relation.targetSymbolId) throw new Error('internal relation target symbol id is required'); const o = index * 16; [uint32(relation.ownerId, 'relation owner id'), uint32(relation.fromNode, 'relation source'), intern(relation.targetSymbolId), code(RELATION_KINDS, relation.kind, 'relation kind')].forEach((value, field) => relationBuffer.writeUInt32LE(value, o + field * 4)) })
  const stringBuffer = Buffer.concat(strings)
  const header = Buffer.alloc(36); INTERNAL_MAGIC.copy(header); [INTERNAL_SCHEMA_VERSION, owners.length, nodes.length, edges.length, relations.length, stringBuffer.length, fingerprintOffset, 0].forEach((value, index) => header.writeUInt32LE(value >>> 0, 4 + index * 4))
  const body = Buffer.concat([header, ownerBuffer, nodeBuffer, edgeBuffer, relationBuffer, stringBuffer])
  return Buffer.concat([body, crypto.createHash('sha256').update(body).digest()])
}

export function decodeInternalPartition(bytes, { compilerFingerprint } = {}) {
  const buffer = Buffer.from(bytes)
  if (buffer.length < 68 || !buffer.subarray(0, 4).equals(INTERNAL_MAGIC)) throw new Error('invalid or truncated internal partition magic/header')
  if (buffer.readUInt32LE(4) !== INTERNAL_SCHEMA_VERSION) throw new Error('unsupported internal partition schema')
  const ownerCount = buffer.readUInt32LE(8); const nodeCount = buffer.readUInt32LE(12); const edgeCount = buffer.readUInt32LE(16); const relationCount = buffer.readUInt32LE(20); const stringBytes = buffer.readUInt32LE(24); const fingerprintOffset = buffer.readUInt32LE(28)
  if ([ownerCount, nodeCount, edgeCount, relationCount].some((count) => count > MAX_INTERNAL_RECORDS)) throw new Error('internal record count exceeds allocation limit')
  const expected = 36 + ownerCount * 80 + nodeCount * 64 + edgeCount * 16 + relationCount * 16 + stringBytes + 32
  if (!Number.isSafeInteger(expected) || buffer.length !== expected) throw new Error('internal partition length is truncated')
  const body = buffer.subarray(0, -32)
  if (!crypto.createHash('sha256').update(body).digest().equals(buffer.subarray(-32))) throw new Error('internal partition checksum mismatch')
  const stringsStart = 36 + ownerCount * 80 + nodeCount * 64 + edgeCount * 16 + relationCount * 16
  const stringAt = (offset) => { if (offset === NONE) return null; if (offset >= stringBytes) throw new Error('internal string offset outside table'); const end = buffer.indexOf(0, stringsStart + offset); if (end < 0 || end >= stringsStart + stringBytes) throw new Error('unterminated internal string'); return buffer.toString('utf8', stringsStart + offset, end) }
  const actualFingerprint = stringAt(fingerprintOffset)
  if (compilerFingerprint !== undefined && actualFingerprint !== compilerFingerprint) throw new Error('internal partition compiler fingerprint mismatch')
  const owners = Array.from({ length: ownerCount }, (_, index) => {
    const o = 36 + index * 80; const u = (field) => buffer.readUInt32LE(o + field * 4); const nullable = (field) => u(field) === NONE ? null : u(field)
    const owner = { id: u(0), kind: decodeCode(OWNER_KINDS, u(3), 'owner kind'), name: stringAt(u(4)), start: u(6), end: u(7), entryNodeId: u(12), exitNodeId: u(13), cyclomatic: u(14), branchCount: u(15), nestingDepth: u(16) }
    if (u(1) !== NONE) owner.symbolId = stringAt(u(1)); if (u(2) !== NONE) owner.parentOwnerId = u(2)
    if (u(5) !== NONE) owner.file = stringAt(u(5)); for (const [field, name] of [[8, 'line'], [9, 'column'], [10, 'endLine'], [11, 'endColumn'], [17, 'firstNode'], [18, 'nodeCount']]) if (u(field) !== NONE) owner[name] = u(field)
    if (u(19)) owner.flags = u(19); return owner
  })
  const nodeBase = 36 + ownerCount * 80
  const nodes = Array.from({ length: nodeCount }, (_, index) => { const o = nodeBase + index * 64; const u = (field) => buffer.readUInt32LE(o + field * 4); const node = { id: u(0), ownerId: u(1), parentId: u(2) === NONE ? null : u(2), kind: decodeCode(NODE_KINDS, u(3), 'node kind'), role: decodeCode(ROLES, u(4), 'role'), start: u(5), end: u(6) }; for (const [field, name] of [[7, 'line'], [8, 'column'], [9, 'endLine'], [10, 'endColumn']]) if (u(field) !== NONE) node[name] = u(field); if (u(11) !== NONE) node.symbolId = stringAt(u(11)); node.unreachable = Boolean(u(12)); if (u(13)) node.flags = u(13); return node })
  const edgeBase = nodeBase + nodeCount * 64
  const edges = Array.from({ length: edgeCount }, (_, index) => { const o = edgeBase + index * 16; return { ownerId: buffer.readUInt32LE(o), from: buffer.readUInt32LE(o + 4), to: buffer.readUInt32LE(o + 8), kind: decodeCode(EDGE_KINDS, buffer.readUInt32LE(o + 12), 'edge kind') } })
  const relationBase = edgeBase + edgeCount * 16
  const relations = Array.from({ length: relationCount }, (_, index) => { const o = relationBase + index * 16; return { ownerId: buffer.readUInt32LE(o), fromNode: buffer.readUInt32LE(o + 4), targetSymbolId: stringAt(buffer.readUInt32LE(o + 8)), kind: decodeCode(RELATION_KINDS, buffer.readUInt32LE(o + 12), 'relation kind') } })
  const ownerIds = new Set(owners.map(({ id }) => id)); const nodeOwner = new Map(nodes.map((node) => [node.id, node.ownerId]))
  if (ownerIds.size !== owners.length || nodeOwner.size !== nodes.length) throw new Error('duplicate internal record id')
  for (let index = 0; index < owners.length; index += 1) { const owner = owners[index]; if (owner.id !== index || owner.start > owner.end || nodeOwner.get(owner.entryNodeId) !== owner.id || nodeOwner.get(owner.exitNodeId) !== owner.id || owner.parentOwnerId !== undefined && !ownerIds.has(owner.parentOwnerId)) throw new Error('invalid internal owner structure') }
  for (let index = 0; index < nodes.length; index += 1) { const node = nodes[index]; const owner = owners[node.ownerId]; if (node.id !== index || !owner || node.start > node.end || node.start < owner.start || node.end > owner.end || node.parentId !== null && nodeOwner.get(node.parentId) !== node.ownerId) throw new Error('invalid internal node owner/parent endpoint') }
  for (const edge of edges) if (!ownerIds.has(edge.ownerId) || nodeOwner.get(edge.from) !== edge.ownerId || nodeOwner.get(edge.to) !== edge.ownerId) throw new Error('invalid internal control-flow endpoint ownership')
  for (const relation of relations) if (!ownerIds.has(relation.ownerId) || nodeOwner.get(relation.fromNode) !== relation.ownerId) throw new Error('invalid internal semantic relation endpoint ownership')
  return { compilerFingerprint: actualFingerprint, owners, nodes, edges, relations }
}

// Query-time view: validates the immutable payload once, then decodes only records requested by
// the caller. The materializing decoder above remains the test/debug convenience API.
export function openInternalPartition(bytes, { compilerFingerprint } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length < 68 || !buffer.subarray(0, 4).equals(INTERNAL_MAGIC)) throw new Error('invalid or truncated internal partition magic/header')
  if (buffer.readUInt32LE(4) !== INTERNAL_SCHEMA_VERSION) throw new Error('unsupported internal partition schema')
  const counts = { owners: buffer.readUInt32LE(8), nodes: buffer.readUInt32LE(12), edges: buffer.readUInt32LE(16), relations: buffer.readUInt32LE(20) }
  if (Object.values(counts).some((count) => count > MAX_INTERNAL_RECORDS)) throw new Error('internal record count exceeds allocation limit')
  const stringBytes = buffer.readUInt32LE(24); const fingerprintOffset = buffer.readUInt32LE(28)
  const nodeBase = 36 + counts.owners * 80; const edgeBase = nodeBase + counts.nodes * 64; const relationBase = edgeBase + counts.edges * 16; const stringsStart = relationBase + counts.relations * 16
  if (buffer.length !== stringsStart + stringBytes + 32) throw new Error('internal partition length is truncated')
  const body = buffer.subarray(0, -32)
  if (!crypto.createHash('sha256').update(body).digest().equals(buffer.subarray(-32))) throw new Error('internal partition checksum mismatch')
  const stringAt = (offset) => { if (offset === NONE) return null; if (offset >= stringBytes) throw new Error('internal string offset outside table'); const end = buffer.indexOf(0, stringsStart + offset); if (end < 0 || end >= stringsStart + stringBytes) throw new Error('unterminated internal string'); return buffer.toString('utf8', stringsStart + offset, end) }
  const actualFingerprint = stringAt(fingerprintOffset)
  if (compilerFingerprint !== undefined && compilerFingerprint !== actualFingerprint) throw new Error('internal partition compiler fingerprint mismatch')
  const ownerAt = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= counts.owners) return null
    const o = 36 + index * 80; const u = (field) => buffer.readUInt32LE(o + field * 4)
    const owner = { id: u(0), kind: decodeCode(OWNER_KINDS, u(3), 'owner kind'), name: stringAt(u(4)), start: u(6), end: u(7), entryNodeId: u(12), exitNodeId: u(13), cyclomatic: u(14), branchCount: u(15), nestingDepth: u(16) }
    if (u(1) !== NONE) owner.symbolId = stringAt(u(1)); if (u(2) !== NONE) owner.parentOwnerId = u(2); else owner.parentOwnerId = null
    if (u(5) !== NONE) owner.file = stringAt(u(5)); for (const [field, name] of [[8, 'line'], [9, 'column'], [10, 'endLine'], [11, 'endColumn']]) if (u(field) !== NONE) owner[name] = u(field)
    return owner
  }
  const nodeAt = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= counts.nodes) return null
    const o = nodeBase + index * 64; const u = (field) => buffer.readUInt32LE(o + field * 4)
    const node = { id: u(0), ownerId: u(1), parentId: u(2) === NONE ? null : u(2), kind: decodeCode(NODE_KINDS, u(3), 'node kind'), role: decodeCode(ROLES, u(4), 'role'), start: u(5), end: u(6), unreachable: Boolean(u(12)) }
    for (const [field, name] of [[7, 'line'], [8, 'column'], [9, 'endLine'], [10, 'endColumn']]) if (u(field) !== NONE) node[name] = u(field); if (u(11) !== NONE) node.symbolId = stringAt(u(11)); if (u(13)) node.flags = u(13); return node
  }
  const edgeAt = (index) => { if (!Number.isInteger(index) || index < 0 || index >= counts.edges) return null; const o = edgeBase + index * 16; return { ownerId: buffer.readUInt32LE(o), from: buffer.readUInt32LE(o + 4), to: buffer.readUInt32LE(o + 8), kind: decodeCode(EDGE_KINDS, buffer.readUInt32LE(o + 12), 'edge kind') } }
  const relationAt = (index) => { if (!Number.isInteger(index) || index < 0 || index >= counts.relations) return null; const o = relationBase + index * 16; return { ownerId: buffer.readUInt32LE(o), fromNode: buffer.readUInt32LE(o + 4), targetSymbolId: stringAt(buffer.readUInt32LE(o + 8)), kind: decodeCode(RELATION_KINDS, buffer.readUInt32LE(o + 12), 'relation kind') } }
  for (let index = 0; index < counts.owners; index += 1) {
    const owner = ownerAt(index)
    if (owner.id !== index || owner.start > owner.end || owner.parentOwnerId !== null && owner.parentOwnerId >= counts.owners) throw new Error('invalid internal owner structure')
    if (nodeAt(owner.entryNodeId)?.ownerId !== owner.id || nodeAt(owner.exitNodeId)?.ownerId !== owner.id) throw new Error('invalid internal owner entry/exit endpoint')
  }
  for (let index = 0; index < counts.nodes; index += 1) {
    const node = nodeAt(index); const owner = ownerAt(node.ownerId)
    if (node.id !== index || !owner || node.start > node.end || node.start < owner.start || node.end > owner.end || node.parentId !== null && nodeAt(node.parentId)?.ownerId !== node.ownerId) throw new Error('invalid internal node owner/parent endpoint')
  }
  for (let index = 0; index < counts.edges; index += 1) { const edge = edgeAt(index); if (!ownerAt(edge.ownerId) || nodeAt(edge.from)?.ownerId !== edge.ownerId || nodeAt(edge.to)?.ownerId !== edge.ownerId) throw new Error('invalid internal control-flow endpoint ownership') }
  for (let index = 0; index < counts.relations; index += 1) { const relation = relationAt(index); if (!ownerAt(relation.ownerId) || nodeAt(relation.fromNode)?.ownerId !== relation.ownerId || !relation.targetSymbolId) throw new Error('invalid internal semantic relation endpoint ownership') }
  const selected = function * (count, read, ownerId) { for (let index = 0; index < count; index += 1) { const row = read(index); if (ownerId === undefined || row.ownerId === ownerId) yield row } }
  return {
    compilerFingerprint: actualFingerprint, counts, ownerAt, nodeAt, edgeAt, relationAt,
    owners: () => selected(counts.owners, ownerAt), nodes: (ownerId) => selected(counts.nodes, nodeAt, ownerId),
    edges: (ownerId) => selected(counts.edges, edgeAt, ownerId), relations: (ownerId) => selected(counts.relations, relationAt, ownerId),
  }
}

// v2 stores edges per file so a rebuild can reuse unchanged files; consumers still want one flat
// list, so it is synthesized on read rather than persisted twice. v1 overlays already are flat.
const hydrateOverlay = (overlay) =>
  overlay?.version === OVERLAY_VERSION ? { ...overlay, edges: Object.values(overlay.files).flatMap((entry) => entry.edges) } : overlay

export class GraphStore {
  constructor(root, cacheDir = '.codegraph') {
    this.root = root; this.dir = path.join(root, cacheDir)
    this.partitions = path.join(this.dir, 'partitions'); this.generations = path.join(this.dir, 'generations')
    this.internalPartitions = path.join(this.dir, 'internal-partitions')
    this.sources = path.join(this.dir, 'sources'); this.overlays = path.join(this.dir, 'overlays')
  }
  initialize() {
    fs.mkdirSync(this.partitions, { recursive: true }); fs.mkdirSync(this.generations, { recursive: true })
    fs.mkdirSync(this.internalPartitions, { recursive: true })
    fs.mkdirSync(this.sources, { recursive: true }); fs.mkdirSync(this.overlays, { recursive: true })
  }
  writePartition(partition, profiler = null) {
    const layout = symbolPartitionLayout(partition)
    const contents = writeSymbolPartition(partition, layout, new Uint8Array(layout.byteLength))
    return this.#writePartitionContents(contents, partition, profiler)
  }
  writePartitionBytes(bytes, profiler = null, decoded = null) {
    const contents = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const partition = decoded ?? decodeSymbolPartition(contents)
    if (this.writePartition !== GraphStore.prototype.writePartition) return this.writePartition(partition, profiler)
    return this.#writePartitionContents(contents, partition, profiler)
  }
  #writePartitionContents(contents, partition, profiler) {
    const partitionBytes = Buffer.byteLength(contents)
    const hashArgs = { file: partition.file, partitionBytes }
    const hashProfile = profiler?.begin('partition-hash', hashArgs)
    const id = digestSerialized(contents)
    if (hashProfile) profiler.end(hashProfile)
    const writeArgs = { file: partition.file, partitionBytes, cacheWrite: 0 }
    const writeProfile = profiler?.begin('partition-write', writeArgs)
    this.initialize(); const target = path.join(this.partitions, `${id}.bin`)
    if (!fs.existsSync(target)) { this.#atomicWrite(target, contents); writeArgs.cacheWrite = 1 }
    if (writeProfile) profiler.end(writeProfile)
    return id
  }
  writePackedPartitionRange(bytes, offset, length, file, profiler = null) {
    const contents = bytes.subarray(offset, offset + length)
    return this.#writePartitionContents(contents, { file }, profiler)
  }
  readPartition(id) {
    const packed = path.join(this.partitions, `${id}.bin`)
    return fs.existsSync(packed) ? decodeSymbolPartition(fs.readFileSync(packed)) : JSON.parse(fs.readFileSync(path.join(this.partitions, `${id}.json`), 'utf8'))
  }
  writeInternalPartition(bytes) {
    this.initialize()
    const id = crypto.createHash('sha256').update(bytes).digest('hex')
    const target = path.join(this.internalPartitions, `${id}.bin`)
    if (!fs.existsSync(target)) this.#atomicWrite(target, bytes)
    return id
  }
  writeInternalPartitionRange(bytes, offset, length) { return this.writeInternalPartition(bytes.subarray(offset, offset + length)) }
  readInternalPartition(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`invalid internal partition id: ${id}`)
    return fs.readFileSync(path.join(this.internalPartitions, `${id}.bin`))
  }
  writeSource(source) {
    this.initialize()
    const id = crypto.createHash('sha256').update(source).digest('hex')
    const target = path.join(this.sources, id)
    if (!fs.existsSync(target)) this.#atomicWrite(target, source)
    return id
  }
  readSource(id) { return fs.readFileSync(path.join(this.sources, id), 'utf8') }
  readOverlay(generation) {
    try { return hydrateOverlay(JSON.parse(fs.readFileSync(path.join(this.overlays, `${generation}.json`), 'utf8'))) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  // Per-file entries from the newest overlay of any generation, as reuse donors. Overlays are
  // rewritten whole on every generation, so without a donor every rebuild reparses the repo.
  donorOverlayFiles(exclude) {
    try {
      const names = fs.readdirSync(this.overlays).filter((name) => name.endsWith('.json') && name.slice(0, -5) !== exclude)
        .sort((a, b) => fs.statSync(path.join(this.overlays, b)).mtimeMs - fs.statSync(path.join(this.overlays, a)).mtimeMs)
      for (const name of names) {
        const overlay = JSON.parse(fs.readFileSync(path.join(this.overlays, name), 'utf8'))
        if (overlay.version === OVERLAY_VERSION && overlay.files) return overlay.files
      }
    } catch {}
    return {}
  }
  writeOverlay(generation, overlay) {
    this.initialize()
    if (overlay.generation !== generation) throw new Error('overlay generation mismatch')
    // `edges` is derived from `files` on read, and `ordered` describes only the in-memory copy
    // just built — a hydrated overlay flattens in file order, not edge order.
    const { edges, ordered, ...persisted } = overlay
    this.#atomicWrite(path.join(this.overlays, `${generation}.json`), stable(persisted.files ? persisted : overlay))
    return overlay
  }
  publish(manifest) {
    this.initialize(); const generation = `${Date.now().toString(36)}-${digest(manifest).slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}`
    const complete = { ...manifest, generation, createdAt: new Date().toISOString() }
    this.#atomicWrite(path.join(this.generations, `${generation}.json`), stable(complete))
    this.#atomicWrite(path.join(this.dir, 'CURRENT'), generation)
    return complete
  }
  readGeneration(generation) {
    this.initialize()
    if (!generation) {
      try { generation = fs.readFileSync(path.join(this.dir, 'CURRENT'), 'utf8').trim() } catch {}
      if (!generation || !fs.existsSync(path.join(this.generations, `${generation}.json`))) {
        const available = fs.readdirSync(this.generations).filter((f) => f.endsWith('.json'))
          .sort((a, b) => fs.statSync(path.join(this.generations, a)).mtimeMs - fs.statSync(path.join(this.generations, b)).mtimeMs || a.localeCompare(b))
        if (!available.length) throw new Error('no codegraph generation; run build')
        generation = available.at(-1).slice(0, -5)
        this.#atomicWrite(path.join(this.dir, 'CURRENT'), generation)
      }
    }
    return JSON.parse(fs.readFileSync(path.join(this.generations, `${generation}.json`), 'utf8'))
  }
  #atomicWrite(target, contents) {
    const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temp, contents); fs.renameSync(temp, target)
  }
}
