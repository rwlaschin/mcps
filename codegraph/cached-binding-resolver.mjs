import { moduleCandidates } from './module-candidates.mjs'

const fileAt = (files, file) => typeof files?.get === 'function' ? files.get(file) : files[file]
const partitionIndexes = new WeakMap()

export function visitImportBindings(sourceFile, ts, visit) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause?.name) visit(clause.name.text, specifier, 'default', false, statement.pos, statement.end)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) visit(element.name.text, specifier, element.propertyName?.text ?? element.name.text, false, statement.pos, statement.end)
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) visit(clause.namedBindings.name.text, specifier, undefined, true, statement.pos, statement.end)
  }
}

const indexesFor = (partition) => {
  let indexes = partitionIndexes.get(partition)
  if (indexes) return indexes
  const bindings = new Map()
  const stars = []
  for (const binding of partition.bindings ?? []) {
    if (binding.kind === 'star') stars.push(binding)
    else if (!bindings.has(binding.name)) bindings.set(binding.name, binding)
  }
  const symbolsById = new Map()
  const membersByOwner = new Map()
  for (const symbol of partition.symbols ?? []) {
    if (!symbolsById.has(symbol.id)) symbolsById.set(symbol.id, symbol)
    if (typeof symbol.qualifiedPath === 'string' && symbol.qualifiedPath !== '<module>') {
      const ownerStart = symbol.qualifiedPath.lastIndexOf('/') + 1
      const memberStart = symbol.name.lastIndexOf('.') + 1
      membersByOwner.set(`${symbol.qualifiedPath.slice(ownerStart)}\0${symbol.name.slice(memberStart)}`, symbol)
    } else if (symbol.kind === 'method') {
      const memberStart = symbol.name.lastIndexOf('.') + 1
      if (memberStart > 1) membersByOwner.set(`class:${symbol.name.slice(0, memberStart - 1)}\0${symbol.name.slice(memberStart)}`, symbol)
    }
  }
  indexes = { bindings, stars, symbolsById, membersByOwner }
  partitionIndexes.set(partition, indexes)
  return indexes
}

export function extractCachedBindings(sourceFile, symbols, ts, exportedIds = null, structuralCache = null) {
  const symbolByName = new Map()
  for (const symbol of symbols) if (symbol.qualifiedPath === '<module>') {
    const rows = symbolByName.get(symbol.name)
    if (rows) rows.push(symbol)
    else symbolByName.set(symbol.name, [symbol])
  }
  const direct = new Map()
  const bind = (local, name = local) => {
    const symbols = symbolByName.get(local)
    if (!symbols) return
    for (const symbol of symbols) exportedIds?.add(symbol.id)
    direct.set(name, { kind: 'symbol', name, target: symbols[0].id })
  }
  const bindings = []
  const exportFacts = structuralCache ? structuralCache.exports ??= new WeakMap() : null
  for (const statement of sourceFile.statements) {
    let facts = exportFacts?.get(statement)
    if (!facts) {
      facts = []
      if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) facts.push({ kind: 'symbol', local: statement.expression.text, name: 'default' })
      const modifiers = statement.modifiers ?? []
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const name = statement.name?.text ?? (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null)
        if (name) facts.push({ kind: 'symbol', local: name, name: modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : name })
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) facts.push({ kind: 'symbol', local: declaration.name.text, name: declaration.name.text })
      }
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null
        if (!specifier) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) facts.push({ kind: 'symbol', local: element.propertyName?.text ?? element.name.text, name: element.name.text })
        } else if (!statement.exportClause) facts.push({ kind: 'star', specifier })
        else if (ts.isNamespaceExport(statement.exportClause)) facts.push({ kind: 'namespace', name: statement.exportClause.name.text, specifier })
        else if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) facts.push({ kind: 'reexport', name: element.name.text, specifier, remote: element.propertyName?.text ?? element.name.text })
      }
      exportFacts?.set(statement, facts)
    }
    for (const fact of facts) {
      if (fact.kind === 'symbol') bind(fact.local, fact.name)
      else bindings.push({ ...fact })
    }
  }
  return [...direct.values(), ...bindings]
}

const moduleAt = (files, fromFile, specifier, dependencies) => {
  for (const candidate of moduleCandidates(fromFile, specifier)) {
    dependencies?.add(candidate)
    if (fileAt(files, candidate)) return candidate
  }
  return null
}

const exportedSymbol = (partition, target) => partition ? indexesFor(partition).symbolsById.get(target) ?? null : null

const resolveExport = (files, file, name, dependencies, seen) => {
  dependencies?.add(file)
  const key = `${file}\0${name}`
  if (seen.has(key)) return null
  seen.add(key)
  const partition = fileAt(files, file)
  if (!partition) return null
  const indexes = indexesFor(partition)
  const binding = indexes.bindings.get(name)
  if (binding?.kind === 'symbol') return exportedSymbol(partition, binding.target)
  if (binding?.kind === 'namespace') {
    const targetFile = moduleAt(files, file, binding.specifier, dependencies)
    return targetFile ? { kind: 'namespace', file: targetFile } : null
  }
  if (binding?.kind === 'reexport') {
    const targetFile = moduleAt(files, file, binding.specifier, dependencies)
    return targetFile ? resolveExport(files, targetFile, binding.remote, dependencies, seen) : null
  }
  if (name === 'default') return null
  let resolved = null
  for (const star of indexes.stars) {
    const targetFile = moduleAt(files, file, star.specifier, dependencies)
    if (!targetFile) continue
    const target = resolveExport(files, targetFile, name, dependencies, new Set(seen))
    if (!target) continue
    if (resolved && (resolved.id !== target.id || resolved.file !== target.file || resolved.kind !== target.kind)) return null
    resolved = target
  }
  return resolved
}

export function resolveCachedImport(files, fromFile, imported, property = null, dependencies = null) {
  const module = moduleAt(files, fromFile, imported.specifier, dependencies)
  if (!module) return null
  const seen = new Set()
  const target = imported.namespace ? { kind: 'namespace', file: module } : resolveExport(files, module, imported.remote, dependencies, seen)
  if (!property) return target?.kind === 'namespace' ? null : target
  if (target?.kind === 'namespace') return resolveExport(files, target.file, property, dependencies, seen)
  if (target?.kind === 'class') {
    const partition = fileAt(files, target.file)
    return partition ? indexesFor(partition).membersByOwner.get(`class:${target.name}\0${property}`) ?? null : null
  }
  return null
}

const resolveReference = (files, file, reference, dependencies = null) => {
  const target = resolveCachedImport(files, file, reference, reference.property ?? null, dependencies)
  return target ? { from: reference.from, to: target.id, line: reference.line, call: reference.call } : null
}

const unindex = (index, entry) => {
  for (const dependency of entry.dependencies) {
    const bucket = index.byDependency.get(dependency)
    bucket?.delete(entry)
    if (!bucket?.size) index.byDependency.delete(dependency)
  }
}

const indexReference = (index, files, file, reference, ordinal) => {
  const dependencies = new Set()
  const edge = resolveReference(files, file, reference, dependencies)
  const entry = { key: `${file}\0${ordinal}`, file, ordinal, reference, dependencies, edge }
  for (const dependency of dependencies) {
    let bucket = index.byDependency.get(dependency)
    if (!bucket) index.byDependency.set(dependency, bucket = new Set())
    bucket.add(entry)
  }
  return entry
}

const graphEdgeKey = (edge) => `${edge.from}\0${edge.to}\0${edge.line}\0${edge.call ? 1 : 0}`
const graphEdgeOrder = (left, right) => (left.edge.from < right.edge.from ? -1 : left.edge.from > right.edge.from ? 1 : 0) || (left.edge.to < right.edge.to ? -1 : left.edge.to > right.edge.to ? 1 : 0) || left.edge.line - right.edge.line || left.ordinal - right.ordinal
const moveUnresolvedRecord = (index, record, add) => {
  const rows = record.missing ? index.missingUnresolved : index.unresolved
  let low = 0; let high = rows.length
  while (low < high) { const middle = (low + high) >>> 1; if (graphEdgeOrder(rows[middle], record) < 0) low = middle + 1; else high = middle }
  if (add) {
    for (let cursor = rows.length; cursor > low; cursor--) { rows[cursor] = rows[cursor - 1]; index.outputSlotMoves++ }
    rows[low] = record
  } else if (rows[low] === record) {
    for (let cursor = low; cursor + 1 < rows.length; cursor++) { rows[cursor] = rows[cursor + 1]; index.outputSlotMoves++ }
    rows.length--
  }
}
const classifyGraphRecord = (index, record) => {
  index.graphRecordsVisited++
  const reason = !index.symbols.has(record.edge.from) ? 'dangling-symbol-source' : !index.symbols.has(record.edge.to) ? 'dangling-symbol-target' : null
  const unresolved = record.active && reason ? { from: record.edge.from, to: record.edge.to, line: record.edge.line, reason } : null
  if (record.unresolved && !unresolved) moveUnresolvedRecord(index, record, false)
  else if (!record.unresolved && unresolved) moveUnresolvedRecord(index, record, true)
  record.unresolved = unresolved
}
const addGraphRecord = (index, edge, missing = false, ownerFile = null, edgeOrdinal = null, patchKey = null) => {
  const record = { edge, missing, ownerFile, edgeOrdinal, patchKey, ordinal: index.nextOrdinal++, active: true, unresolved: null }
  for (const id of edge.from === edge.to ? [edge.from] : [edge.from, edge.to]) {
    let bucket = index.byEndpoint.get(id)
    if (!bucket) index.byEndpoint.set(id, bucket = new Set())
    bucket.add(record)
  }
  if (!index.initializing) classifyGraphRecord(index, record)
  return record
}
const removeGraphRecord = (index, record) => {
  record.active = false
  classifyGraphRecord(index, record)
  for (const id of record.edge.from === record.edge.to ? [record.edge.from] : [record.edge.from, record.edge.to]) {
    const bucket = index.byEndpoint.get(id)
    bucket.delete(record)
    if (!bucket.size) index.byEndpoint.delete(id)
  }
}
const refreshRawKey = (index, key) => {
  let removed = index.removals.get(key) ?? 0
  for (const record of index.rawByKey.get(key) ?? []) {
    const active = !removed
    if (removed) removed--
    if (record.active !== active) { record.active = active; classifyGraphRecord(index, record) }
  }
}
const changeRemoval = (index, edge, amount) => {
  const key = graphEdgeKey(edge)
  const count = (index.removals.get(key) ?? 0) + amount
  if (count) index.removals.set(key, count)
  else index.removals.delete(key)
  refreshRawKey(index, key)
}
const removePublicationPatch = (index, patch) => {
  if (patch.base) changeRemoval(index, patch.base, -1)
  if (patch.edgeRecord) removeGraphRecord(index, patch.edgeRecord)
  if (patch.missingRecord) removeGraphRecord(index, patch.missingRecord)
  index.patches.delete(patch.key)
  const bucket = index.patchesByFile.get(patch.file)
  bucket.delete(patch)
  if (!bucket.size) index.patchesByFile.delete(patch.file)
  const rows = index.orderedPatches
  let low = 0; let high = rows.length
  while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].key < patch.key) low = middle + 1; else high = middle }
  for (let cursor = low; cursor + 1 < rows.length; cursor++) { rows[cursor] = rows[cursor + 1]; index.outputSlotMoves++ }
  rows.length--
}
const addPublicationPatch = (index, patch) => {
  const stored = { ...patch }
  if (stored.base) changeRemoval(index, stored.base, 1)
  if (stored.edge) stored.edgeRecord = addGraphRecord(index, stored.edge, false, null, null, stored.key)
  if (stored.missing) stored.missingRecord = addGraphRecord(index, stored.missing, true, null, null, stored.key)
  index.patches.set(stored.key, stored)
  let bucket = index.patchesByFile.get(stored.file)
  if (!bucket) index.patchesByFile.set(stored.file, bucket = new Set())
  bucket.add(stored)
  const rows = index.orderedPatches
  let low = 0; let high = rows.length
  while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].key < stored.key) low = middle + 1; else high = middle }
  for (let cursor = rows.length; cursor > low; cursor--) { rows[cursor] = rows[cursor - 1]; index.outputSlotMoves++ }
  rows[low] = stored
}
const addGraphFile = (index, file, partition, affected = null) => {
  const records = []; const ids = []
  for (const symbol of partition.symbols ?? []) {
    ids.push(symbol.id)
    index.symbols.set(symbol.id, (index.symbols.get(symbol.id) ?? 0) + 1)
    affected?.add(symbol.id)
  }
  let edgeOrdinal = 0
  for (const edge of partition.edges ?? []) {
    const record = addGraphRecord(index, edge, false, file, edgeOrdinal++)
    records.push(record)
    const key = graphEdgeKey(edge)
    let bucket = index.rawByKey.get(key)
    if (!bucket) index.rawByKey.set(key, bucket = new Set())
    bucket.add(record)
    if (index.removals.has(key)) refreshRawKey(index, key)
  }
  index.graphByFile.set(file, { ids, records })
}

export function createCachedReferenceIndex(files, inheritedPatches = []) {
  const index = { byDependency: new Map(), byFile: new Map(), graphByFile: new Map(), byEndpoint: new Map(), symbols: new Map(), rawByKey: new Map(), removals: new Map(), patches: new Map(), patchesByFile: new Map(), orderedPatches: [], unresolved: [], missingUnresolved: [], nextOrdinal: 0, graphRecordsVisited: 0, outputSlotMoves: 0, initializing: true }
  for (const [file, partition] of typeof files?.entries === 'function' ? files.entries() : Object.entries(files ?? {})) addGraphFile(index, file, partition)
  index.initializing = false
  for (const file of index.graphByFile.values()) for (const record of file.records) classifyGraphRecord(index, record)
  for (const patch of inheritedPatches) addPublicationPatch(index, patch)
  for (const [file, partition] of typeof files?.entries === 'function' ? files.entries() : Object.entries(files ?? {})) {
    const entries = (partition.references ?? []).map((reference, ordinal) => indexReference(index, files, file, reference, ordinal))
    if (entries.length) index.byFile.set(file, entries)
  }
  return index
}

export function updateCachedGraphFacts(index, files, changedFile, repairs) {
  index.graphRecordsVisited = 0; index.outputSlotMoves = 0
  const affected = new Set()
  const old = index.graphByFile.get(changedFile)
  const changed = fileAt(files, changedFile)
  const groups = new Map()
  const addGroup = (edge) => {
    if (!edge) return
    const key = `${edge.from}\0${edge.to}\0${edge.line}`
    if (!groups.has(key)) groups.set(key, { from: edge.from, to: edge.to, line: edge.line })
  }
  for (const record of old?.records ?? []) addGroup(record.edge)
  for (const edge of changed?.edges ?? []) addGroup(edge)
  for (const patch of index.patchesByFile.get(changedFile) ?? []) {
    addGroup(patch.base); addGroup(patch.edge); addGroup(patch.missing)
  }
  for (const repair of repairs) {
    addGroup(repair.base); addGroup(repair.edge)
    const previous = index.patches.get(repair.key)
    addGroup(previous?.base); addGroup(previous?.edge); addGroup(previous?.missing)
  }
  for (const id of old?.ids ?? []) affected.add(id)
  for (const symbol of changed?.symbols ?? []) affected.add(symbol.id)
  for (const id of affected) for (const record of index.byEndpoint.get(id) ?? []) addGroup(record.edge)
  const patchGroups = () => {
    const rows = new Map(); const visited = new Set()
    for (const group of groups.values()) {
      if (visited.has(group.from)) continue
      visited.add(group.from)
      for (const record of index.byEndpoint.get(group.from) ?? []) if (record.patchKey !== null && record.active && record.edge.from === group.from) {
        const key = `${record.edge.from}\0${record.edge.to}\0${record.edge.line}`
        if (!groups.has(key)) continue
        let bucket = rows.get(key)
        if (!bucket) rows.set(key, bucket = [])
        bucket.push(record)
      }
    }
    return rows
  }
  const groupRows = (group, patches) => {
    const records = []
    for (const call of [false, true]) for (const record of index.rawByKey.get(graphEdgeKey({ ...group, call })) ?? []) records.push(record)
    for (const record of patches.get(`${group.from}\0${group.to}\0${group.line}`) ?? []) records.push(record)
    records.sort((left, right) => left.patchKey === null && right.patchKey === null ? left.ownerFile.localeCompare(right.ownerFile) || left.edgeOrdinal - right.edgeOrdinal : left.patchKey === null ? -1 : right.patchKey === null ? 1 : left.patchKey < right.patchKey ? -1 : left.patchKey > right.patchKey ? 1 : 0)
    const edges = []; const unresolved = []; const missing = []
    let removedCalls = index.removals.get(graphEdgeKey({ ...group, call: true })) ?? 0
    let removedReferences = index.removals.get(graphEdgeKey({ ...group, call: false })) ?? 0
    for (const record of records) {
      if (record.active && record.unresolved) (record.missing ? missing : unresolved).push(record)
      if (record.patchKey === null) {
        if (record.edge.call && removedCalls) { removedCalls--; continue }
        if (!record.edge.call && removedReferences) { removedReferences--; continue }
        if (index.symbols.has(record.edge.from) && index.symbols.has(record.edge.to)) edges.push(record.edge)
      } else if (record.active && !record.missing && !record.unresolved) edges.push(record.edge)
    }
    unresolved.sort((left, right) => left.ordinal - right.ordinal)
    missing.sort((left, right) => left.ordinal - right.ordinal)
    for (let ordinal = 0; ordinal < unresolved.length; ordinal++) unresolved[ordinal] = unresolved[ordinal].unresolved
    for (let ordinal = 0; ordinal < missing.length; ordinal++) missing[ordinal] = missing[ordinal].unresolved
    return { edges, unresolved, missing }
  }
  const rawUnresolvedBeforeCount = index.unresolved.length
  const beforePatches = patchGroups()
  for (const group of groups.values()) group.before = groupRows(group, beforePatches)
  if (old) {
    for (const id of old.ids) {
      const count = index.symbols.get(id) - 1
      if (count) index.symbols.set(id, count)
      else index.symbols.delete(id)
      affected.add(id)
    }
    for (const record of old.records) {
      removeGraphRecord(index, record)
      const key = graphEdgeKey(record.edge); const bucket = index.rawByKey.get(key)
      bucket.delete(record)
      if (!bucket.size) index.rawByKey.delete(key)
      refreshRawKey(index, key)
    }
    index.graphByFile.delete(changedFile)
  }
  for (const patch of index.patchesByFile.get(changedFile) ?? []) removePublicationPatch(index, patch)
  if (changed) addGraphFile(index, changedFile, changed, affected)
  for (const repair of repairs) {
    const previous = index.patches.get(repair.key)
    const missing = repair.edge ? null : repair.base ?? previous?.missing
    const patch = { ...repair, base: previous ? previous.base : repair.base, ...(missing ? { missing } : {}) }
    if (previous) removePublicationPatch(index, previous)
    if (!patch.base && !patch.edge && !patch.missing || patch.base && patch.edge && !patch.missing && graphEdgeKey(patch.base) === graphEdgeKey(patch.edge)) continue
    addPublicationPatch(index, patch)
  }
  const visited = new Set()
  for (const id of affected) for (const record of index.byEndpoint.get(id) ?? []) if (!visited.has(record)) { visited.add(record); classifyGraphRecord(index, record) }
  const changedGroups = []; const afterPatches = patchGroups()
  for (const group of groups.values()) {
    group.after = groupRows(group, afterPatches)
    let different = false
    for (const kind of ['edges', 'unresolved', 'missing']) {
      const before = group.before[kind], after = group.after[kind]
      if (before.length !== after.length) { different = true; break }
      for (let ordinal = 0; ordinal < before.length; ordinal++) {
        const left = before[ordinal], right = after[ordinal]
        if (left.from !== right.from || left.to !== right.to || left.line !== right.line || left.call !== right.call || left.reason !== right.reason) { different = true; break }
      }
      if (different) break
    }
    if (different) changedGroups.push(group)
  }
  return { groups: changedGroups, rawUnresolvedBeforeCount }
}

export function cachedUnresolvedEdges(index) {
  const edges = new Array(index.unresolved.length + index.missingUnresolved.length)
  let ordinal = 0
  for (const record of index.unresolved) edges[ordinal++] = record.unresolved
  for (const record of index.missingUnresolved) edges[ordinal++] = record.unresolved
  return edges
}

export function cachedPublicationEdgePatches(index) {
  const patches = new Array(index.orderedPatches.length)
  let ordinal = 0
  for (const { edgeRecord, missingRecord, ...patch } of index.orderedPatches) patches[ordinal++] = patch
  return patches
}

export function repairCachedReferences(index, files, changedFile) {
  const impacted = [...(index.byDependency.get(changedFile) ?? [])]
  const repaired = []
  for (const entry of impacted) {
    unindex(index, entry)
    if (entry.file === changedFile) continue
    const next = indexReference(index, files, entry.file, entry.reference, entry.ordinal)
    const fileEntries = index.byFile.get(entry.file)
    if (fileEntries) fileEntries[entry.ordinal] = next
    repaired.push({ key: entry.key, file: entry.file, base: entry.edge, edge: next.edge })
  }
  for (const entry of index.byFile.get(changedFile) ?? []) unindex(index, entry)
  const changed = fileAt(files, changedFile)
  const entries = (changed?.references ?? []).map((reference, ordinal) => indexReference(index, files, changedFile, reference, ordinal))
  if (entries.length) index.byFile.set(changedFile, entries)
  else index.byFile.delete(changedFile)
  return repaired
}
