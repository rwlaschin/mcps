---
modified: 2026-09-12
dependencies: [storage-and-query.md, mcp-and-cli.md]
---

# Parsing and Resolution

This subsystem turns files on disk into the graph's raw material: it decides which files count as source, reads them, and sends semantic parsing and identifier resolution to `semantic-checker-worker.mjs`.

Read this if you are changing what gets indexed, what kinds of symbols exist, or why an expected edge is missing from the graph. Consult it before adding a language, a symbol kind, or an edge attribute — the constraints below are the ones people trip over. Storage and query of the resulting rows are [storage-and-query.md](storage-and-query.md); the tools that invoke indexing are [mcp-and-cli.md](mcp-and-cli.md).

## Sensitive Areas

- **There are no property/field symbols, so property access produces no edge.** `declarationKinds` (`parser.mjs:10-15`) is exactly seven `SyntaxKind`s: `FunctionDeclaration`→`function`, `MethodDeclaration`→`method`, `ClassDeclaration`→`class`, `InterfaceDeclaration`→`interface`, `TypeAliasDeclaration`→`type`, `EnumDeclaration`→`enum`, `VariableDeclaration`→`variable`. No `PropertyDeclaration`, `PropertySignature`, or `PropertyAssignment` kind exists anywhere in the map, so `user.email` has nothing to point at and yields no edge.
- **Unresolvable references are dropped silently into a counter.** `identityForSymbol` (`parser.mjs:143-150`) looks a symbol's declarations up in `context.byDeclaration`, which only ever contains nodes of those seven kinds (`parser.mjs:134`). Anything else resolves to `null` and is discarded at `parser.mjs:183` (`if (!target) { identifierArgs.targetMissing += 1; continue }`). There is no warning, no unresolved row, no log — the only trace is the `targetMissing` field of the profiler args. A large `targetMissing` count is the expected symptom of the property gap above, not a bug in resolution.
- **`SOURCE_EXTENSIONS` is not extensible.** `source-policy.mjs:8` is a module-level `const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])`, and `createSourcePolicy(root)` (`source-policy.mjs:19`) takes only `root` — no options object, no injection point. Ignore files and `tsconfig`/`jsconfig` `include`/`exclude` can only SUBTRACT from that set (`sourceCandidateRelative` at `source-policy.mjs:74` ANDs `configured(rel)` with the extension test); nothing at runtime can add an extension. Adding a language means editing that line.
- **Only one edge attribute exists: `call: boolean`.** `parser.mjs` pushes `{ from, to, line, call }`. There is no read/write distinction, no import-vs-invoke distinction, and no way to ask "who assigns to this".
- **Prefetched sources shadow disk and refuse mutation.** `PrefetchedFileSystemHost` answers reads from its in-memory map and throws on any write/delete/move/copy touching a mapped path (`prefetched-file-system.mjs:66-70`). Every mapped path is checked for root escape at construction (`prefetched-file-system.mjs:21-23`), and case-insensitive hosts collapse keys via `toLocaleLowerCase` (`prefetched-file-system.mjs:36`), so two sources differing only in case collide and throw.
- **Worker paths are re-validated after `realpath`.** `semantic-checker-worker.mjs` rejects a path that escapes the root through a symlink, and `source-policy.mjs` refuses to watch anything under a symlinked directory. Weakening either check reintroduces a read-outside-root path.

## Design Constraints

- **Semantic parsing is worker-owned.** Every `CodeGraphEngine` sends initial `index`, persisted `hydrate`, delta `validate`, and warm `reference-overlay` work through one `SemanticCheckerWorker`.
- **Sparse semantic validation is deliberately narrow.** A delta is allowed only for one edit to an existing module-scoped file when both the old and new source remain module-scoped and contain no global/ambient or triple-slash constructs. Adds, deletes, multi-file changes, scripts, unresolved dependencies, and cache/base mismatches use full validation.
- **Read concurrency is validated, not clamped.** `readSources` throws unless concurrency is an integer in 1..128 (`source-reader.mjs:8`), default 16.
- **Worker requests time out at 30 s** and the worker is replaced (`parser-apartment-pool.mjs:7, 90`).
- **`allowJs` is always on and `jsconfig.json` is accepted.** `parser.mjs:64-66` finds `tsconfig.json` or `jsconfig.json` and creates the `Project` with `compilerOptions: { allowJs: true }` and `skipAddingFilesFromTsConfig: true`.
- **`.gitignore`/`.codegraphignore` are honored; `node_modules`, `vendor`, `third_party`, `.git`, `.codegraph`, `.codegraph-v2` and the build directories in `BUILD_IGNORES` are unconditionally excluded** (`source-policy.mjs:6-7, 64`).
- **File ids are uint32.** `PagedBitSet` asserts the range and pages at 4096 bits (`file-index.mjs:1-8`).

## Feature Overview

Everything downstream — queries, dead-code detection, the visualizer — consumes symbol rows and edge rows. This subsystem is where those rows come from.

The **semantic path** wants correctness: it needs the TypeScript checker to know that `helper` in this file is the `helper` exported from three modules over. That requires a real `Project` with a type checker over the whole workspace, which is expensive to build. `createSemanticProject` pays that cost against an in-memory source map, `prepareSemanticProject` does a single descendant walk per prepared file, and `parsePartition` resolves per-file without re-walking. In a persistent MCP runtime, the worker creates and retains that project during initial `index` or reconstructs it once during `hydrate`; the coordinator validates exact source and partition membership before adopting the result and retains no second semantic workspace. A safe one-file edit then refreshes only that file and its reverse transitive dependent closure. Unsafe edits rebuild the worker's full validated state.

Complete-reference overlays use the semantic worker for only the stale files, hydrating the requested persisted generation when needed. The coordinator validates returned fragment membership, edge shape, endpoints, and owning file before atomically writing the overlay.

That semantic walk also produces a compact internal partition for each source file. It records executable owners, normalized syntax nodes, control-flow edges, semantic relations, and summary metrics without retaining a second repository-sized object graph. Cold builds move bounded partition payloads through one reusable shared-memory pool; oversized payloads are persisted by the worker directly.

Reading and file selection are separated from semantic analysis so the policy is decided once. `createSourcePolicy` (`source-policy.mjs:19`) is the single answer to "is this a source file", used both for the initial `scan()` and for watch-event filtering (`acceptWatchPath`); `readSources` (`source-reader.mjs:6`) turns that list into the `Map<relPath, text>` the worker takes as input, while measuring bytes, wall time and peak concurrency. `PrefetchedFileSystemHost` then hands that same map to `ts-morph` so the checker never re-reads a file the indexer already read.

`FileIdRegistry` and `PagedBitSet` (`file-index.mjs`) exist so the rest of the system can talk about files as small integers and hold dense sets of them cheaply; `FileIdRegistry.release` recycles ids through a free list (`file-index.mjs:33-41`).

## Architecture

```
source-policy.mjs      decides what is source (scan + watch filter)
        |
source-reader.mjs      bounded-concurrency read -> Map<rel, text> + stats
        |
        +--> semantic worker (accurate, batch)
        |      prefetched-file-system.mjs   PrefetchedFileSystemHost (ts-morph host)
        |      parser.mjs                   createSemanticProject
        |                                   prepareSemanticProject  (one walk/file)
        |                                   parsePartition          (per-file rows/edges)
        |      semantic-checker-worker.mjs  index / hydrate / validate / reference-overlay
        |                                   one retained Project per engine
        |      internal-graph.mjs            owners / CFG / relations / metrics


file-index.mjs         FileIdRegistry (path <-> uint32) + PagedBitSet (dense id sets)
```

Component relationships:

- Worker `index` and `hydrate` requests require exact, duplicate-free source membership and matching SHA-256 source hashes. Hydration additionally requires one partition per source whose `file` and `sourceHash` match. The cache is replaced only after validation succeeds.
- `validateSnapshot` can take sources inline or hydrate a pinned generation from content-addressed blobs and partitions. Safe edits return `{ mode: 'delta' }` with exactly the changed file plus its reverse dependency closure; every unsafe or mismatched case returns `{ mode: 'full' }`.
- `referenceOverlay` accepts only the current cached generation membership and an exact stale-file set, then returns non-call edges partitioned by owning file.

## Functions

**`source-policy.mjs`**
- `createSourcePolicy(root)` — returns `{ root, scan, acceptWatchPath, isSourceRelative, isControlRelative, isIgnoredRelative, normalize }`. Compiles gitignore/codegraphignore patterns (with `!` negation, `source-policy.mjs:42-44, 70`) and `tsconfig`/`jsconfig` `include`/`exclude` into `minimatch` matchers; strips comments and trailing commas before `JSON.parse` and falls back to `{}` on failure (`:28-32`).
- `scan()` — recursive `readdirSync` walk; prunes ignored directories, records symlinked directories in `symlinkDirs` without descending them, returns sorted relative paths.
- `acceptWatchPath(file)` — true for control files; otherwise requires `isSourceRelative` and rejects anything inside a known symlinked directory or under any symlinked ancestor.
- `fileContentHash(file)`, `controlFileHashes(root)` — SHA-256 of a file, and a `{name: hash|null}` map over `.codegraphignore`, `.gitignore`, `jsconfig.json`, `tsconfig.json`.

**`source-reader.mjs`**
- `readSources(root, policy, options)` — runs `min(concurrency, fileCount)` workers over `policy.scan()`; first read error sets `stopped` and is rethrown after the pool drains. Returns `{ sources, stats }`. `readFile`, `now`, `measure` are injectable.

**`prefetched-file-system.mjs`**
- `PrefetchedFileSystemHost(root, sources, delegate)` — `readFileSync`/`readFile`/`fileExistsSync`/`fileExists` answer from the map then fall through to the delegate; `writeFileSync`/`writeFile`/`delete*`/`move*`/`copy*` throw if they would touch a mapped path; `upsert(relative, source)` and `remove(relative)` mutate the map; the methods in `delegateMethods` (`:3-6`) are forwarded verbatim.

**`parser.mjs`**
- `contentHash(text)` — SHA-256 hex.
- `LineCursor` — forward-only offset→line scanner with a backward-seek slow path (`:31-41`); `reset`/`lineAt`/`clear`.
- `createSemanticProject(root, sources)` — builds the `Project` over a `PrefetchedFileSystemHost`, creates every source file with `overwrite: true`, stashes the host on `project.__codegraphHost`.
- `prepareSemanticProject(project, root, profiler)` — one `forEachDescendant` per file collecting declaration nodes and identifiers; returns the resolution context `{ project, root, byDeclaration, perFile, lineCursor }`. Emits a `collect-file-syntax` profiler span per file.
- `parsePartition(rel, source, knownFiles, context, profiler, edgeCoverage = 'complete')` — computes exported ids from `getExportedDeclarations()`, resolves identifier edges, collects import/export module dependencies, hashes the source, and returns the partition. Throws if the file was not prefetched or not prepared (`:196, 198`). Profiler spans: `exports`, `identifiers-symbol-resolution`, `dependencies`, `source-hash`.
- `resolveIdentifierEdges(...)` (module-private) — the identifier loop at `parser.mjs:169-189`. With `edgeCoverage === 'complete'` it walks every collected identifier; with `'calls'` it skips non-callee identifiers (`:173`). Per identifier: find the enclosing declaration owner, get the symbol, follow one alias hop inside `try/catch`, map to a declaration identity, drop self-edges, emit `{ from, to, line, call }`.
- `callExpressionForIdentifier(ident)` — true when the identifier is a call's callee directly, or is the name of a property access that is itself a callee (`:152-157`).
- `semanticPath(node)`, `semanticSignature(node)`, `nodeName(node)` — the qualified-path, signature, and name components of symbol identity; `nodeName` falls back to `'constructor'` and `'default'`.

**`semantic-checker-worker.mjs`**
- `ownedSnapshot(request, hydrate)` — validates exact source/hash membership, then either parses all partitions for `index` or adopts matching stored partitions for `hydrate`.
- `validateSnapshot(snapshot)` — hydrates or reuses the pinned validated state, verifies changes, and returns `{ revision, mode, baseGeneration, sourceBlobs, partitions }`. Delta partitions are sparse; full partitions contain every source.
- `referenceOverlay(request)` — reparses only requested stale files at complete coverage and returns their non-call edge fragments.
- `SemanticCheckerWorker` — `index`, `hydrate`, `validate`, `referenceOverlay`, and `dispose`; unknown operations reject explicitly, while worker error or unexpected exit fails every pending request through `#fail`.

**`internal-graph.mjs`**
- Encodes and validates file-scoped executable owners, syntax nodes, control-flow edges, semantic relations, cyclomatic complexity, branch count, and nesting depth.

**`file-index.mjs`**
- `FileIdRegistry` — `intern`, `idOf`, `pathOf`, `entries`, `release`. Ids start at 1 and are recycled from `freeIds`.
- `PagedBitSet` — `has`, `add`, `delete`, `clear`; `add`/`delete` return whether the bit actually changed; `pageFactory` is injectable and `allocatedPageCount` is exposed.

## Models

**Semantic symbol row** (`parser.mjs:116, 210`) — the identity fields plus `exported`:

| field | type | notes |
|---|---|---|
| `id` | string | first 24 hex chars of SHA-256 over `rel\0qualifiedPath\0kind\0name\0signature\0ordinal` |
| `file` | string | root-relative, forward slashes |
| `name` | string | `nodeName`; `'constructor'` / `'default'` fallbacks |
| `kind` | string | one of `function`, `method`, `class`, `interface`, `type`, `enum`, `variable` |
| `line` | number | 1-based, from `LineCursor` |
| `qualifiedPath` | string | `kind:name` segments joined by `/`, or `<module>` |
| `signature` | string | `<typeParams>(params):returnOrDeclaredType`, unknown param types as `?` |
| `ordinal` | number | disambiguates identical `qualifiedPath:kind:name:signature` within a file |
| `exported` | boolean | id present in `file.getExportedDeclarations()` |

**Semantic edge row** (`parser.mjs:185`) — `{ from: string, to: string, line: number, call: boolean }`. `call` is the only attribute.

**Semantic partition** (`parser.mjs:236`) — `{ file, sourceHash, symbols[], edges[], dependencies: string[] (deduped, sorted), unresolved: [{ specifier, candidates: string[] }] }`.

**Identifier resolution counters** (`parser.mjs:212`) — the profiler args object, and the only place dropped references are recorded: `{ file, total, noOwner, symbolMissing, aliases, targetMissing, selfTarget, edges, calls, nonCalls, declarationProbes }`.

**Other diagnostics counter objects**
- `collect-file-syntax` (`parser.mjs:127`): `{ file, descendantTraversals, declarationCount, identifierCount }`.
- `exports` (`parser.mjs:201`): `{ file, exportsVisited }`.
- `dependencies` (`parser.mjs:217`): `{ file, dependencyDecls, resolved, unresolved, candidates }`.
- `source-hash` (`parser.mjs:232`): `{ file, sourceBytes }`.
- Read stats (`source-reader.mjs:57`): `{ filesRead, bytesRead, readMs, readConcurrency, peakReads }`.

**Source policy shape** (`source-policy.mjs:110`) — `{ root, scan, acceptWatchPath, isSourceRelative, isControlRelative, isIgnoredRelative, normalize }`. Module constants: `MANDATORY_IGNORES`, `BUILD_IGNORES` (both exported), `SOURCE_EXTENSIONS`, `CONTROL_FILES` (both module-private).

**Semantic ownership requests** — `index` receives `{ root, sources: [[file, text]], sourceBlobs: {file: sha256}, edgeCoverage }`; `hydrate` adds `{ generation, partitions: {file: partition} }`. Both return `{ mode: 'full', sourceBlobs, partitions }` only after exact membership and hash validation.

**Semantic checker snapshot input** — `{ root, revision, sourceDir?, partitionDir?, baseGeneration?, baseSourceBlobs?: {file: sha256}, basePartitionIds?: {file: sha256}, sources?: [[file, text]], changes?: [{ type, path, source?, expectedDigest? }] }`; output `{ revision, mode: 'full'|'delta', baseGeneration, sourceBlobs, partitions: {file: partition} }`. A persistent runtime omits `basePartitionIds` after successful ownership transfer.

**Reference-overlay request** — `{ generation, sourceBlobs, staleFiles }`; output `{ generation, files: { [file]: { edges } } }`, containing only `call: false` edges for the requested stale files.

**Internal partition** — a versioned binary file containing executable-owner, node, control-flow, semantic-relation, and metric records. Node and owner identifiers are local to one file and generation; source text stays in the existing source blob.

**File index** (`file-index.mjs`) — `FileIdRegistry` holds `pathToId: Map<string, uint32>`, `idToPath: string[]`, `freeIds: number[]`, `nextFileId` (starts at 1). `PagedBitSet` holds `pages: Uint32Array[]` of 128 words (4096 bits) each, plus `allocatedPageCount`.

## Use Cases

### 1. Index a workspace from scratch (semantic path)

- **Goal** — produce accurate symbol and edge rows for every source file in a repository.
- **Stakeholders** — anyone querying the graph for callers/references/dead code; the daemon that serves those queries.
- **Actors** — the indexing caller (CLI or MCP server, see [mcp-and-cli.md](mcp-and-cli.md)); `SemanticCheckerWorker`'s worker thread.
- **Preconditions** — `root` exists and is absolute; a `tsconfig.json` or `jsconfig.json` may or may not be present; `ts-morph` is installed.
- **Basic Course of Events**
  1. Caller builds a policy with `createSourcePolicy(root)`, which reads `.gitignore`, `.codegraphignore`, and the first of `tsconfig.json`/`jsconfig.json` found.
  2. Caller calls `readSources(root, policy)`; `policy.scan()` returns the sorted candidate list and up to 16 concurrent reads fill a `Map<rel, text>` alongside read stats.
  3. Caller passes root and sources into `SemanticCheckerWorker.validate(snapshot)`, which posts them to the worker thread.
  4. `validateSnapshot` materializes the source map and applies `snapshot.changes`, verifying each change's `expectedDigest` when present.
  5. `createSemanticProject` wraps the map in a `PrefetchedFileSystemHost`, creates the `Project` with `{ allowJs: true }`, and creates every source file in it.
  6. `prepareSemanticProject` walks each file once, recording declaration nodes of the seven `declarationKinds` into `byDeclaration` and every identifier into `perFile`.
  7. For each file, `parsePartition` marks exported ids, resolves identifiers to edges, collects module dependencies, hashes the source, and deletes that file's cached analysis.
  8. The worker replies `{ revision, sourceBlobs, partitions }`; the caller hands the partitions to storage.
- **Alternate Flows**
  - No `tsconfig.json`/`jsconfig.json`: the `Project` is created without `tsConfigFilePath` and `configured()` accepts every non-ignored path with a source extension.
  - `snapshot.sources` omitted: sources are loaded from content-addressed blobs under `sourceDir`, each verified against its SHA-256 filename.
  - `edgeCoverage: 'calls'` (what `validateSnapshot` passes): non-callee identifiers are skipped, so the partition holds call edges only.
- **Exceptions**
  - A read fails mid-scan: `readSources` stops dispatching and rethrows the first error; no partial source map is returned.
  - A blob's digest does not match its filename, or a blob/change path escapes `sourceDir`/root (lexically or via symlink): `validateSnapshot` throws and the rejection surfaces through `validate()`.
  - A file was not prefetched or not prepared: `parsePartition` throws `source was not prefetched` / `source analysis was not prepared`.
  - The worker crashes or exits: `#fail` rejects every pending `validate()` with the underlying error and marks the instance closed.
- **Postconditions** — one partition per source file, each with symbol rows of the seven kinds, `call`-attributed edge rows, sorted deduped dependencies, and an `unresolved` list; per-file analyses released from `context.perFile`.

### 3. Decide whether a changed path is worth reindexing

- **Goal** — filter a filesystem event down to paths that actually affect the graph.
- **Stakeholders** — anyone relying on the graph not churning on build output or editor temp files.
- **Actors** — the file watcher; the source policy.
- **Preconditions** — a policy built for the workspace root; the watcher supplies an absolute or root-relative path.
- **Basic Course of Events**
  1. Watcher calls `policy.acceptWatchPath(file)`.
  2. The policy normalizes the path to a root-relative POSIX string.
  3. If it is one of `.codegraphignore`, `.gitignore`, `jsconfig.json`, `tsconfig.json`, the policy returns true immediately.
  4. Otherwise it checks `isSourceRelative`: not ignored, allowed by `include`/`exclude`, and carrying one of the eight `SOURCE_EXTENSIONS`.
  5. It rejects the path if it lies inside a directory recorded as a symlink during `scan()`.
  6. It walks the parent chain up to the root with `lstatSync`, rejecting on any symlinked ancestor.
  7. It returns true, and the watcher schedules a reindex of that file.
- **Alternate Flows**
  - A control file changed: the caller can compare `controlFileHashes(root)` against a previous snapshot to see whether policy inputs actually changed.
  - A negated ignore pattern (`!pattern`) matches last: the path is un-ignored and accepted.
- **Exceptions**
  - The path is outside the root (normalizes to `../…` or stays absolute): `isIgnoredRelative` returns true and the path is rejected.
  - The path sits under `node_modules`, `vendor`, `third_party`, `.git`, `.codegraph`, `.codegraph-v2`, or a `BUILD_IGNORES` directory: rejected regardless of ignore files or `include`.
  - An `lstatSync` on an ancestor throws: treated as a symlink and rejected.
  - The extension is not in `SOURCE_EXTENSIONS`: rejected, and no configuration can override this.
- **Postconditions** — the watcher acts only on control files and on source files reachable without traversing a symlink; the graph's file set stays consistent with `policy.scan()`.

## Tests

Tests live in `codegraph/test/` and run with `npm test`. Covering this subsystem:

- `test/source-policy.test.mjs` — scan/ignore/include-exclude and watch-path acceptance.
- `test/source-reader.test.mjs` — concurrency validation, stats, read-failure propagation.
- `test/prefetched-file-system.test.mjs` — read shadowing, mutation rejection, path-escape and case-collision errors.
- `test/incremental-resolver.test.mjs` — `parseFile` fact extraction, `FileLocalResolver` change application, snapshot linking and caching.
- `test/parser-apartment-pool.test.mjs` — revision ordering, cancellation, affinity, timeout and worker replacement.
- `test/parse-diagnostics.test.mjs` — the diagnostics collector's thresholds, capacity and GC attribution.
- `test/file-index.test.mjs` — id interning/release and `PagedBitSet` behavior.
- `test/trace-profile.test.mjs` — the profiler spans emitted by `parser.mjs`.
- `test/engine.test.mjs`, `test/boundaries.test.mjs` — end-to-end indexing over the semantic path.

`parser.mjs` and `semantic-checker-worker.mjs` have no dedicated test file of their own; they are exercised through `test/engine.test.mjs` and `test/boundaries.test.mjs`.

## UI/UX

No UI/UX. This subsystem has no user-facing surface — it is a library consumed by the CLI, MCP server, and daemon ([mcp-and-cli.md](mcp-and-cli.md)) and rendered indirectly by [visualizer.md](visualizer.md). No mockup applies.

## Dependencies

- [storage-and-query.md](storage-and-query.md) — consumes the symbol rows, edge rows and partitions defined in Models.
- [mcp-and-cli.md](mcp-and-cli.md) — the callers that build a policy, read sources, and drive both parse paths.
- [visualizer.md](visualizer.md) — renders the resulting graph; inherits the property-edge and single-`call`-attribute limits from Sensitive Areas.
- External: `ts-morph` and `@ts-morph/common` (`Project`, `Node`, `SyntaxKind`, `ts`, `RealFileSystemHost`), `minimatch`, and Node's `worker_threads`, `fs`, `path`, `crypto`, `os`.

## Diagrams

The component/data-flow diagram is the ASCII block in Architecture above. No additional diagram is maintained for this subsystem.

## References

- TypeScript compiler API `ts.createSourceFile` / `SourceFile.update` — the incremental reparse mechanism used in `incremental-resolver.mjs` and `incremental-parser-worker.mjs`.
- `ts-morph` `Project` and `FileSystemHost` — the interface `PrefetchedFileSystemHost` implements.
- `minimatch` glob semantics — how `include`/`exclude`/ignore patterns are matched in `source-policy.mjs`.
- Node `worker_threads` `ref`/`unref` — why idle parser and checker workers do not keep the process alive.
