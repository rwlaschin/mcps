import { normalizePublicationPatch } from './cached-binding-resolver.mjs'

export class PublicationFacts {
  constructor(seed = {}) {
    const unresolved = seed.unresolvedEdges ?? [], patches = seed.edgePatches ?? []
    const unresolvedSlots = new Map(), patchSlots = new Map(), patchesByFile = new Map()
    for (let i = 0; i < unresolved.length; i += 1) this.addUnresolvedSlot(unresolvedSlots, this.rowKey(unresolved[i]), i)
    for (let i = 0; i < patches.length; i += 1) {
      patchSlots.set(patches[i].key, i)
      let keys = patchesByFile.get(patches[i].file)
      if (!keys) { keys = new Set(); patchesByFile.set(patches[i].file, keys) }
      keys.add(patches[i].key)
    }
    let rawUnresolvedCount = unresolved.length
    for (const patch of patches) if (patch.missing) rawUnresolvedCount -= 1
    this.publication = { unresolved, patches, unresolvedSlots, patchSlots, patchesByFile, rawUnresolvedCount: seed.rawUnresolvedBeforeCount ?? rawUnresolvedCount }
  }
  rowKey(row) { return `${row.from}\0${row.to}\0${row.line}\0${row.reason}` }
  addUnresolvedSlot(slots, key, position) {
    let positions = slots.get(key)
    if (!positions) { positions = new Set(); slots.set(key, positions) }
    positions.add(position)
  }
  removeUnresolved(key) {
    const { unresolved: rows, unresolvedSlots: slots } = this.publication
    const positions = slots.get(key)
    if (!positions) return
    const position = positions.values().next().value
    positions.delete(position)
    if (!positions.size) slots.delete(key)
    const oldLength = rows.length, last = rows.pop()
    if (position < rows.length) {
      const lastKey = this.rowKey(last), lastPositions = slots.get(lastKey)
      lastPositions.delete(oldLength - 1); lastPositions.add(position); rows[position] = last
    }
  }
  removePatch(key) {
    const facts = this.publication
    const position = facts.patchSlots.get(key)
    if (position === undefined) return
    const patch = facts.patches[position]
    const keys = facts.patchesByFile.get(patch.file)
    keys.delete(key)
    if (!keys.size) facts.patchesByFile.delete(patch.file)
    const last = facts.patches.pop()
    facts.patchSlots.delete(key)
    if (position < facts.patches.length) { facts.patches[position] = last; facts.patchSlots.set(last.key, position) }
  }
  apply(result, file) {
    const facts = this.publication
    const changes = result.publicationChanges
    if (!changes) throw new Error('changed-file analyzer omitted publication changes')
    changes.rawUnresolvedBeforeCount = facts.rawUnresolvedCount
    for (const group of changes.groups) {
      for (const kind of ['unresolved', 'missing']) {
        for (const row of group.before[kind]) this.removeUnresolved(this.rowKey(row))
        for (const row of group.after[kind]) { this.addUnresolvedSlot(facts.unresolvedSlots, this.rowKey(row), facts.unresolved.length); facts.unresolved.push(row) }
      }
      facts.rawUnresolvedCount += group.after.unresolved.length - group.before.unresolved.length
    }
    const removed = facts.patchesByFile.get(file)
    if (removed) for (const key of removed) this.removePatch(key)
    for (const repair of result.edgePatches ?? []) {
      const position = facts.patchSlots.get(repair.key)
      const previous = position === undefined ? null : facts.patches[position]
      const patch = normalizePublicationPatch(repair, previous)
      this.removePatch(repair.key)
      if (!patch) continue
      facts.patchSlots.set(patch.key, facts.patches.length); facts.patches.push(patch)
      let keys = facts.patchesByFile.get(patch.file)
      if (!keys) { keys = new Set(); facts.patchesByFile.set(patch.file, keys) }
      keys.add(patch.key)
    }
    result.unresolvedEdges = facts.unresolved
    result.publicationEdgePatches = facts.patches
  }
}
