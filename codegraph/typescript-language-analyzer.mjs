import { createSourcePolicy, controlFileHashes } from './source-policy.mjs'
import { SemanticCheckerWorker } from './semantic-checker-worker.mjs'
import { typescriptSourceExtensions } from './module-candidates.mjs'

export function createTypeScriptLanguageAnalyzer(root) {
  return {
    id: 'typescript', extensions: typescriptSourceExtensions, controlFiles: ['tsconfig.json', 'jsconfig.json'], cacheKey: 'typescript-2',
    createSourceMatcher: (analyzerRoot = root) => createSourcePolicy(analyzerRoot),
    createSemanticWorker: () => new SemanticCheckerWorker(),
    createProvisionalResolver(analyzerRoot = root, options = {}) {
      let current = null
      const load = async () => {
        if (!current) { const { FileLocalResolver } = await import('./incremental-resolver.mjs'); current = new FileLocalResolver(analyzerRoot, options.sources, options) }
        return current
      }
      return {
        snapshot: () => current.snapshot(),
        async stageChanges(changes, revision) {
          await load()
          const next = current.fork()
          const work = next.applyChanges(changes, { baseRevision: current.revision, materialize: false })
          return { revision, baseRevision: current.revision, next, work, consumed: false }
        },
        async stageFileChanges(changes, revision) {
          await load()
          const next = current.fork()
          const work = await next.applyFileChanges(changes, { baseRevision: current.revision, materialize: false })
          return { revision, baseRevision: current.revision, next, work, consumed: false }
        },
        commit(staged) { if (staged.consumed) throw new Error('staged resolver is consumed'); if (current.revision !== staged.baseRevision) throw new Error(`stale base revision ${staged.baseRevision}; latest is ${current.revision}`); staged.consumed = true; current.adopt(staged.next, staged.revision); return staged.work },
        discard(staged) { if (staged.consumed) throw new Error('staged resolver is consumed'); staged.consumed = true; staged.next.dispose() },
        dispose: () => current?.dispose(),
      }
    },
    createPartition: async (...args) => (await import('./parser.mjs')).parsePartition(...args),
    createInternalPartition: async (...args) => (await import('./internal-graph.mjs')).buildInternalGraph(...args),
    cacheInputs: (analyzerRoot = root) => controlFileHashes(analyzerRoot),
    invalidate: (file) => typescriptSourceExtensions.includes(file.slice(file.lastIndexOf('.')).toLowerCase()) || file === 'tsconfig.json' || file === 'jsconfig.json',
  }
}
