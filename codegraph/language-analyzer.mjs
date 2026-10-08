import path from 'node:path'

const requiredFactory = (descriptor, name) => {
  if (typeof descriptor[name] !== 'function') throw new TypeError(`analyzer descriptor requires ${name}`)
}

export function createLanguageAnalyzers(root, factories) {
  if (!Array.isArray(factories)) throw new TypeError('analyzer factories must be an array')
  const analyzers = [...factories].map((factory) => {
    if (typeof factory !== 'function') throw new TypeError('analyzer factory must be a function')
    const descriptor = factory(root)
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id) throw new TypeError('analyzer descriptor requires a nonempty id')
    if (!Array.isArray(descriptor.extensions)) throw new TypeError('analyzer descriptor extensions must be an array')
    if (!Array.isArray(descriptor.controlFiles)) throw new TypeError('analyzer descriptor controlFiles must be an array')
    if (typeof descriptor.cacheKey !== 'string' || !descriptor.cacheKey) throw new TypeError('analyzer descriptor requires a nonempty cacheKey')
    requiredFactory(descriptor, 'createSourceMatcher')
    requiredFactory(descriptor, 'createSemanticWorker')
    requiredFactory(descriptor, 'createProvisionalResolver')
    return descriptor
  })
  const ids = new Set(); const extensionOwners = new Map(); const controlOwners = new Map()
  for (const analyzer of analyzers) {
    if (ids.has(analyzer.id)) throw new Error(`duplicate analyzer id: ${analyzer.id}`)
    ids.add(analyzer.id)
    for (const extension of analyzer.extensions) {
      if (typeof extension !== 'string' || !/^\.[^.]+$/.test(extension)) throw new TypeError(`invalid analyzer extension: ${extension}`)
      const normalized = extension.toLowerCase()
      if (extensionOwners.has(normalized)) throw new Error(`duplicate analyzer extension ownership: ${extension}`)
      extensionOwners.set(normalized, analyzer)
    }
    for (const control of analyzer.controlFiles) {
      if (typeof control !== 'string' || !control) throw new TypeError(`invalid analyzer control file: ${control}`)
      if (controlOwners.has(control)) throw new Error(`duplicate analyzer control ownership: ${control}`)
      controlOwners.set(control, analyzer)
    }
  }
  const resolvers = new Map()
  const transaction = (staged, action) => {
    if (!staged || staged.registry !== registry || staged.consumed) throw new Error('analyzer transaction is stale or consumed')
    staged.consumed = true
    for (const entry of staged.entries) entry.resolver[action](entry.value)
  }
  const registry = {
    analyzers,
    extensions: extensionOwners.keys(),
    controlFiles: controlOwners.keys(),
    analyzerFor(file) { return controlOwners.get(file) ?? extensionOwners.get(path.extname(file).toLowerCase()) },
    active(files) { return [...new Set(files.map((file) => registry.analyzerFor(file)).filter(Boolean))] },
    metadata(files) { return Object.fromEntries(registry.active(files).map(({ id, cacheKey }) => [id, cacheKey])) },
    isManifestCompatible(manifest, files) {
      const active = registry.metadata(files)
      return manifest.analyzers ? Object.entries(active).every(([id, key]) => manifest.analyzers[id] === key) : Object.keys(active).every((id) => id === 'typescript')
    },
    async stageAll(inputs) {
      const entries = []
      try {
        for (const analyzer of analyzers) if (Object.hasOwn(inputs, analyzer.id)) {
          let resolver = resolvers.get(analyzer.id)
          if (!resolver) { resolver = analyzer.createProvisionalResolver(root); resolvers.set(analyzer.id, resolver) }
          entries.push({ resolver, value: await resolver.stageChanges(inputs[analyzer.id]) })
        }
        return { registry, entries, consumed: false }
      } catch (error) {
        for (const entry of entries) entry.resolver.discard(entry.value)
        throw error
      }
    },
    commitAll(staged) { transaction(staged, 'commit') },
    discardAll(staged) { transaction(staged, 'discard') },
  }
  return registry
}
