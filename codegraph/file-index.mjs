const PAGE_BITS = 4096
const WORD_BITS = 32
const WORDS_PER_PAGE = PAGE_BITS / WORD_BITS
const MAX_UINT32 = 0xffffffff

const assertUint32 = (id) => {
  if (!Number.isInteger(id) || id < 0 || id > MAX_UINT32) throw new RangeError('bit id must be a uint32 integer')
}

export class FileIdRegistry {
  constructor() {
    this.pathToId = new Map()
    this.idToPath = []
    this.freeIds = []
    this.nextFileId = 1
  }

  intern(filePath) {
    const existing = this.pathToId.get(filePath)
    if (existing !== undefined) return existing
    const id = this.freeIds.length ? this.freeIds.pop() : this.nextFileId++
    this.pathToId.set(filePath, id)
    this.idToPath[id] = filePath
    return id
  }

  idOf(filePath) { return this.pathToId.get(filePath) }

  pathOf(id) { return this.idToPath[id] }

  entries() { return this.pathToId.entries() }

  release(pathOrId) {
    const id = typeof pathOrId === 'number' ? pathOrId : this.pathToId.get(pathOrId)
    const filePath = id === undefined ? undefined : this.idToPath[id]
    if (filePath === undefined) return false
    this.pathToId.delete(filePath)
    this.idToPath[id] = undefined
    this.freeIds.push(id)
    return true
  }
}

export class PagedBitSet {
  constructor({ pageFactory = () => new Uint32Array(WORDS_PER_PAGE) } = {}) {
    this.pages = []
    this.pageFactory = pageFactory
    this.allocatedPageCount = 0
  }

  has(id) {
    assertUint32(id)
    const page = this.pages[Math.floor(id / PAGE_BITS)]
    if (page === undefined) return false
    const withinPage = id % PAGE_BITS
    return (page[Math.floor(withinPage / WORD_BITS)] & (1 << (withinPage % WORD_BITS))) !== 0
  }

  add(id) {
    assertUint32(id)
    const pageIndex = Math.floor(id / PAGE_BITS)
    let page = this.pages[pageIndex]
    if (page === undefined) {
      page = this.pageFactory()
      this.pages[pageIndex] = page
      this.allocatedPageCount += 1
    }
    const withinPage = id % PAGE_BITS
    const wordIndex = Math.floor(withinPage / WORD_BITS)
    const mask = 1 << (withinPage % WORD_BITS)
    if ((page[wordIndex] & mask) !== 0) return false
    page[wordIndex] |= mask
    return true
  }

  delete(id) {
    assertUint32(id)
    const page = this.pages[Math.floor(id / PAGE_BITS)]
    if (page === undefined) return false
    const withinPage = id % PAGE_BITS
    const wordIndex = Math.floor(withinPage / WORD_BITS)
    const mask = 1 << (withinPage % WORD_BITS)
    if ((page[wordIndex] & mask) === 0) return false
    page[wordIndex] &= ~mask
    return true
  }

  clear() {
    this.pages = []
    this.allocatedPageCount = 0
  }
}
