import test from 'node:test'
import assert from 'node:assert/strict'
import { FileIdRegistry, PagedBitSet } from '../file-index.mjs'

test('equivalence partition: an empty registry reserves ID zero and assigns ID one', () => {
  const registry = new FileIdRegistry()

  assert.deepEqual({ id: registry.intern('src/a.ts'), nextFileId: registry.nextFileId }, { id: 1, nextFileId: 2 })
})

test('equivalence partition: repeated interning of the exact same full path returns its existing ID', () => {
  const registry = new FileIdRegistry()

  assert.deepEqual([registry.intern('src/a.ts'), registry.intern('src/a.ts')], [1, 1])
})

test('error guessing: distinct full paths that could share a hash remain distinct identities', () => {
  const registry = new FileIdRegistry()

  assert.deepEqual([registry.intern('src/Foo.ts'), registry.intern('src/foo.ts')], [1, 2])
})

test('domain analysis: lookup is bidirectional without assigning a missing path', () => {
  const registry = new FileIdRegistry()
  registry.intern('src/a.ts')

  assert.deepEqual({ knownId: registry.idOf('src/a.ts'), missingId: registry.idOf('src/missing.ts'), knownPath: registry.pathOf(1), missingPath: registry.pathOf(2) }, { knownId: 1, missingId: undefined, knownPath: 'src/a.ts', missingPath: undefined })
})

test('domain analysis: releasing by path removes both directions of the active mapping', () => {
  const registry = new FileIdRegistry()
  registry.intern('src/deleted.ts')

  assert.deepEqual({ released: registry.release('src/deleted.ts'), id: registry.idOf('src/deleted.ts'), path: registry.pathOf(1), entries: [...registry.entries()] }, { released: true, id: undefined, path: undefined, entries: [] })
})

test('domain analysis: releasing by ID removes both directions of the active mapping', () => {
  const registry = new FileIdRegistry()
  registry.intern('src/deleted.ts')

  assert.deepEqual({ released: registry.release(1), id: registry.idOf('src/deleted.ts'), path: registry.pathOf(1) }, { released: true, id: undefined, path: undefined })
})

test('boundary value analysis: a released slot is reused before the registry grows', () => {
  const registry = new FileIdRegistry()
  registry.intern('src/first.ts')
  registry.intern('src/kept.ts')
  registry.release('src/first.ts')

  assert.deepEqual({ reusedId: registry.intern('src/replacement.ts'), nextFileId: registry.nextFileId }, { reusedId: 1, nextFileId: 3 })
})

test('error guessing: double release is safe and cannot duplicate a free slot', () => {
  const registry = new FileIdRegistry()
  registry.intern('src/deleted.ts')
  registry.release('src/deleted.ts')
  const secondRelease = registry.release('src/deleted.ts')
  const firstReplacement = registry.intern('src/one.ts')
  const secondReplacement = registry.intern('src/two.ts')

  assert.deepEqual({ secondRelease, firstReplacement, secondReplacement }, { secondRelease: false, firstReplacement: 1, secondReplacement: 2 })
})

test('equivalence partition: releasing an unknown ID is safe and does not create a free slot', () => {
  const registry = new FileIdRegistry()

  assert.deepEqual({ released: registry.release(99), assigned: registry.intern('src/a.ts') }, { released: false, assigned: 1 })
})

test('equivalence partition: a new paged bitset has no allocated pages and absent membership', () => {
  const bits = new PagedBitSet()

  assert.deepEqual({ allocatedPageCount: bits.allocatedPageCount, present: bits.has(1) }, { allocatedPageCount: 0, present: false })
})

test('error guessing: has on a far sparse ID does not allocate a page', () => {
  const bits = new PagedBitSet()

  assert.deepEqual({ present: bits.has(4294967295), allocatedPageCount: bits.allocatedPageCount }, { present: false, allocatedPageCount: 0 })
})

test('boundary value analysis: adding bit zero allocates one typed page and reports a transition', () => {
  let allocatedPage
  const bits = new PagedBitSet({ pageFactory: () => (allocatedPage = new Uint32Array(128)) })

  assert.deepEqual({ transitioned: bits.add(0), allocatedPageCount: bits.allocatedPageCount, typedPage: allocatedPage instanceof Uint32Array, words: allocatedPage.length }, { transitioned: true, allocatedPageCount: 1, typedPage: true, words: 128 })
})

test('equivalence partition: adding an existing bit reports no transition', () => {
  const bits = new PagedBitSet()
  bits.add(17)

  assert.equal(bits.add(17), false)
})

test('boundary value analysis: IDs 4095 and 4096 occupy distinct pages', () => {
  const bits = new PagedBitSet()
  bits.add(4095)
  bits.add(4096)

  assert.deepEqual({ lastFirstPage: bits.has(4095), firstSecondPage: bits.has(4096), allocatedPageCount: bits.allocatedPageCount }, { lastFirstPage: true, firstSecondPage: true, allocatedPageCount: 2 })
})

test('error guessing: a far sparse add allocates only its addressed page', () => {
  const bits = new PagedBitSet()

  assert.deepEqual({ transitioned: bits.add(4294967295), present: bits.has(4294967295), allocatedPageCount: bits.allocatedPageCount }, { transitioned: true, present: true, allocatedPageCount: 1 })
})

test('domain analysis: deleting a present bit removes only that membership', () => {
  const bits = new PagedBitSet()
  bits.add(31)
  bits.add(32)

  assert.deepEqual({ deleted: bits.delete(31), deletedPresent: bits.has(31), neighborPresent: bits.has(32) }, { deleted: true, deletedPresent: false, neighborPresent: true })
})

test('equivalence partition: deleting an absent bit reports no transition and does not allocate', () => {
  const bits = new PagedBitSet()

  assert.deepEqual({ deleted: bits.delete(99), allocatedPageCount: bits.allocatedPageCount }, { deleted: false, allocatedPageCount: 0 })
})

test('domain analysis: clear removes all memberships and releases every allocated page', () => {
  const bits = new PagedBitSet()
  bits.add(1)
  bits.add(4096)
  bits.clear()

  assert.deepEqual({ first: bits.has(1), second: bits.has(4096), allocatedPageCount: bits.allocatedPageCount }, { first: false, second: false, allocatedPageCount: 0 })
})

test('boundary value analysis: rejects bit ID negative one', () => { assert.throws(() => new PagedBitSet().add(-1), /id|integer|uint32|range/i) })
test('equivalence partition: rejects a fractional bit ID', () => { assert.throws(() => new PagedBitSet().add(1.5), /id|integer|uint32|range/i) })
test('boundary value analysis: rejects bit ID above uint32', () => { assert.throws(() => new PagedBitSet().add(4294967296), /id|integer|uint32|range/i) })
test('equivalence partition: rejects NaN as a bit ID', () => { assert.throws(() => new PagedBitSet().add(NaN), /id|integer|uint32|range/i) })
test('equivalence partition: rejects a numeric string as a bit ID', () => { assert.throws(() => new PagedBitSet().add('1'), /id|integer|uint32|range/i) })
test('equivalence partition: rejects null as a bit ID', () => { assert.throws(() => new PagedBitSet().add(null), /id|integer|uint32|range/i) })
test('equivalence partition: rejects undefined as a bit ID', () => { assert.throws(() => new PagedBitSet().add(undefined), /id|integer|uint32|range/i) })
