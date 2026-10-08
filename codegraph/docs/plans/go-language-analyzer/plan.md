---
modified: 2026-09-13
dependencies:
  - ../../design/parsing-and-resolution.md
  - ../../design/storage-and-query.md
  - ../../design/mcp-and-cli.md
  - ../../design/visualizer.md
supersedes: null
---

# Go Language Plug-in

## Problem

CodeGraph has unverified partial Go edits that mix language behavior into shared modules and prevent an authentic test-first baseline. Go support must become an independent JavaScript/WASM plug-in while existing TypeScript/JavaScript output and public contracts remain unchanged.

## Solution

First isolate the partial Go diff and restore the affected production and test files to their pre-Go baseline. Then execute six dependent red-test, implementation, focused-green groups that establish language-owned analysis and generic atomic coordination.

## Approved Requirements

1. One independent plug-in per language/code type owns recognition, parser/runtime, symbols, imports, references, calls, exports, CFG/complexity, cache inputs, and invalidation.
2. Shared core owns filesystem safety, analyzer coordination, generic validation/merge, atomic publication, storage, queries, MCP, and visualization; shared modules contain no language routing literal or analyzer-ID branch.
3. Go runs in the JavaScript CodeGraph process using packaged prebuilt WASM syntax assets, with no Go toolchain, native helper, build, child process, install compilation, or runtime download.
4. Go provides the supported endpoint behavior below through existing row schemas. Its resolver emits only bindings proven by Go package/import/declaration/selector rules; it does not claim compiler parity.
5. TypeScript-only, Go-only, and mixed repositories work in one atomic generation without inferred cross-language edges.
6. TypeScript/JavaScript results remain byte-identical.
7. A separate Test Engineer writes each failing test group; implementation starts only after its authentic red receipt and ends with the named focused green command.
8. Dependencies remain exactly `web-tree-sitter@0.27.0` and `tree-sitter-wasm@1.1.8`, pending install verification.
9. Public MCP, CLI, query, visualizer, and persisted schemas remain unchanged.
10. Implementation and test ownership never overlap: implementers do not edit tests or fixtures.

## Supported Go Matrix

| Area | Supported and required | Conservative boundary |
| --- | --- | --- |
| Declarations | Package functions; value and pointer receiver methods; named types, structs, interfaces, aliases, package variables/constants, and `init` | Declarations outside parsed active source remain absent |
| Imports | Direct imports; aliased imports; blank dependency-only imports; dot-import lookup of exported names | Unresolved import paths remain unresolved |
| Proven relations | Same-package identifier references and calls; imported-package selectors; statically declared receiver method calls; duplicate names bind only through package and import context | Dynamic or interface dispatch, promoted methods, generic instantiation, and any ambiguous target remain unresolved and never guessed |
| Source selection | Ordinary repository Go source and module/workspace controls | Files with leading `//go:build`, legacy `// +build`, or `import "C"` are excluded unconditionally and emit no rows; marker transitions conservatively reload the complete Go plug-in |
| CFG and metrics | Function/method owners; return; if/else; for/range; switch/type-switch/select; branch edges; short-circuit expressions; break/continue/fallthrough/goto labels; defer/go/panic call relations; unreachable marking; UTF-16 positions | Unsupported flow constructs remain representable only when existing generic row kinds prove them |

## User-facing Output Matrix

All outputs use existing schemas and ordering rules.

| Surface | Required Go behavior |
| --- | --- |
| Refs | `refs` returns proven incoming reference rows |
| Deps | `deps` returns package dependencies and proven outgoing relation rows |
| Callers | `callers` returns proven direct callers |
| Dead exports | `dead` evaluates exported Go declarations using the existing dead-export response |
| Raw symbols | Raw list and single-symbol queries return Go symbol rows and file-qualified lookup |
| Internals | `internals` map, search, paths, and metrics return existing owner/node/edge/relation and complexity rows |
| MCP and CLI | Existing MCP tools and CLI commands return equivalent rows for the same request |
| Visualizer | Existing generic graph, symbol, edge, internal, and metric views render Go rows without Go-specific rendering |

### Deterministic source membership

- A `.go` file whose leading comments contain `//go:build` or legacy `// +build`, or whose imports include `"C"`, emits no source, file, partition, symbol, edge, dependency, unresolved, diagnostic, or internal row because this plug-in has no build-configuration or cgo engine.
- Excluded-file absence is distinct from ambiguous binding: an included file may emit an existing-schema unresolved row for an uncertain reference, while an excluded file emits nothing.
- Adding, changing, or unlinking a file in a way that adds, removes, or changes one of those markers forces a full Go-plug-in reload while compatible TypeScript partitions remain reusable.

## Test Matrices

### Descriptor and partition EP/BVA

| Subject | Equivalence partitions | Boundary values |
| --- | --- | --- |
| Descriptor collection | `null`, `undefined`, wrong type, valid array | zero, one, many analyzers |
| Descriptor fields | missing, `null`, wrong type, empty, valid for `id`, recognition metadata, controls, cache key, analyzer/stage functions | zero/one/many extensions and controls; duplicate within one descriptor and across descriptors |
| Analyzer inputs | unsupported file, owned source, owned control | zero, one, many files |
| Staged result | missing/wrong-type partitions, valid partitions | zero, one, many partitions; zero, one, many symbols and edges |
| Partition rows | wrong owner/file, duplicate symbol ID, dangling `from`, dangling `to`, valid rows | first/last file ordering and zero/one/many dependencies, unresolved rows, internal owners/nodes/edges/relations |

### Pairwise publication and invalidation

Use pairwise coverage that covers every pair of values across columns; do not generate the Cartesian product.

| Matrix | Dimensions |
| --- | --- |
| Publication | Repository composition: TypeScript, Go, mixed × path: initial, forced-full, incremental change, add/unlink, control × analyzer outcome: success, failure, malformed |
| Invalidation | Event: add, change, unlink, control × export fingerprint: same, changed, unprovable × reverse closure: none, direct, transitive, unknown |

Every publication pair asserts analyzer metadata, complete partition membership, commit count, and `CURRENT`. Every invalidation pair asserts the exact reparsed/reused files; unknown or unprovable values reload the complete Go plug-in.

## Immutable Fixture Table

Only the Test Engineer changes these fixtures. Expected rows are literal assertions and are never regenerated from implementation output.

| File | Required constructs | Expected rows or absence |
| --- | --- | --- |
| `test/fixtures/go-project/go.mod` | Module `example.com/codegraph-fixture` | Package import paths use that literal module; control hash participates in Go cache key |
| `test/fixtures/go-project/model/user.go` | Named struct/interface/alias, package var/constant, `init`, duplicate `Run`, value and pointer methods, Unicode before a referenced identifier | Declaration rows for each supported kind; receiver-qualified methods; exact UTF-16 offsets; interface/dynamic and generic-instantiation targets unresolved |
| `test/fixtures/go-project/service/service.go` | Direct, alias, blank, and dot imports; duplicate `Run`; same-package calls, imported selectors, static receiver calls | Direct/alias selector edges bind to imported package; blank import emits dependency only; dot exported name binds through its import; duplicate names bind by context |
| `test/fixtures/go-project/cmd/app/main.go` | Calls into service plus return, if/else, for/range, switch/type-switch/select, short circuit, break/continue/fallthrough, goto/label, defer, go, panic, and unreachable statement | Exact function owner, generic CFG edges/relations, call relations, unreachable flag, and metrics rows |
| `test/fixtures/go-project/excluded/go-build.go` | Leading `//go:build` | No source, partition, dependency, unresolved, diagnostic, or internal row |
| `test/fixtures/go-project/excluded/legacy-build.go` | Leading `// +build` | No source, partition, dependency, unresolved, diagnostic, or internal row |
| `test/fixtures/go-project/excluded/cgo.go` | `import "C"` | No source, partition, dependency, unresolved, diagnostic, or internal row |
| `test/fixtures/go-project/broken/syntax.go` | Malformed Go syntax loaded only by failure tests | Analyzer rejects staged output and `CURRENT` is unchanged |
| `test/fixtures/go-project/web/app.ts` | TypeScript lookalike names matching Go declarations | Byte-identical TypeScript rows and no inferred cross-language edge |

## Literal Endpoint Receipts

The Test Engineer asserts these fixture receipts on Go and repeats the equivalent request shape against `test/fixtures/typescript-analyzer-baseline` to prove TypeScript parity.

| Surface and test file | Literal request | Literal result assertion |
| --- | --- | --- |
| Refs, `test/query-client.test.mjs` and `test/daemon-query-engine.test.mjs` | `{ type: 'refs', name: 'Greeting', resolved: true }` | `['Welcome -> Greeting']` |
| Deps, same files | `{ type: 'deps', file: 'service/service.go', resolved: true }` | dependency files equal `['model/user.go']` |
| Callers, `test/daemon-query-engine.test.mjs` | MCP `codegraph_callers` for `model/user.go:Greeting` | caller names equal `['Welcome']` |
| Dead exports, `test/dead-exports.test.mjs` | MCP `codegraph_dead` with `prefix: 'model'` | result includes the fixture's unused exported declaration and excludes referenced `Greeting` |
| Raw list, `test/query-client.test.mjs` | `{ type: 'symbols', limit: 200 }` | names include `['Greeting', 'NewUser', 'User', 'Welcome', 'main']` in existing deterministic order |
| Raw single, same file | `{ type: 'symbols', file: 'model/user.go', name: 'Greeting', limit: 1 }` | one row with `{ file: 'model/user.go', name: 'Greeting', kind: 'method' }` |
| Internals, `test/mcp-internals.test.mjs` and `test/internal-graph.test.mjs` | `codegraph_internals` operations `map`, `search`, `paths`, and `metrics` for `cmd/app/main.go:main` | each returns existing record kinds; metrics contains the fixture's literal asserted cyclomatic value |
| MCP/CLI, `test/daemon-query-engine.test.mjs` and `test/dead-exports.test.mjs` | MCP and `node cli.mjs` issue the same symbols/deps request | normalized row arrays are deeply equal |
| Visualizer, `test/visualizer.test.mjs` and `test/visualizer-e2e.test.mjs` | Load a real Go-only generation, then a real mixed generation | generic rendered rows contain `Greeting` and `Welcome`; mixed render also contains the TS `app.ts` symbol and no cross-language edge |

## Atomic Scope

### Group 0. Restore an authentic baseline

| Field | Instruction |
| --- | --- |
| Input | Current Go-related diff in `package.json`, `query-target.mjs`, `source-policy.mjs`, `test/go-language-analyzer.test.mjs`, `tool-engine.mjs`, `visualizer.mjs`, `go-language-analyzer.mjs`, `language-analyzer.mjs`, and `typescript-language-analyzer.mjs` |
| Action | Save an exact patch of those nine files outside the repository, restore only their Go-related tracked hunks to `HEAD`, remove only the three untracked analyzer files after the patch is verified readable, and preserve all unrelated work plus this plan and task document |
| Output | Pre-Go production/test baseline with the partial work recoverable from the isolated patch |
| Done | `git diff --` for the nine files is empty; `git status --short` confirms unrelated changes and both corrected plan files remain; no test is called red until this baseline exists |
| Commands | `mkdir -p /private/tmp/codegraph-go-partial-2026-09-13`; `git diff -- package.json query-target.mjs source-policy.mjs test/go-language-analyzer.test.mjs tool-engine.mjs visualizer.mjs > /private/tmp/codegraph-go-partial-2026-09-13/tracked.patch`; `cp go-language-analyzer.mjs language-analyzer.mjs typescript-language-analyzer.mjs /private/tmp/codegraph-go-partial-2026-09-13/`; `git apply --check --reverse /private/tmp/codegraph-go-partial-2026-09-13/tracked.patch`; `git restore --source=HEAD -- package.json query-target.mjs source-policy.mjs test/go-language-analyzer.test.mjs tool-engine.mjs visualizer.mjs`; `git apply --check /private/tmp/codegraph-go-partial-2026-09-13/tracked.patch`; `mv go-language-analyzer.mjs language-analyzer.mjs typescript-language-analyzer.mjs /private/tmp/codegraph-go-partial-2026-09-13/`; `git diff -- package.json query-target.mjs source-policy.mjs test/go-language-analyzer.test.mjs tool-engine.mjs visualizer.mjs go-language-analyzer.mjs language-analyzer.mjs typescript-language-analyzer.mjs`; `git status --short` |

### Group 1. Plug-in contract and TypeScript ownership

| Field | Instruction |
| --- | --- |
| Test files | `test/language-analyzer.test.mjs`, `test/engine.test.mjs` |
| Red behavior | Complete descriptor ownership; duplicate ownership rejection; lazy analyzer runtime initialization; staged commit/discard; initial, forced-full, and incremental analyzer metadata; frozen TypeScript bytes and query receipts |
| Implementation files | `language-analyzer.mjs`, `typescript-language-analyzer.mjs`, `source-policy.mjs`, `tool-engine.mjs`, `mcp-runtime.mjs` |
| Output | TypeScript/JavaScript plug-in owns its complete existing recognition, semantic worker, partition, CFG/metrics, cache, and invalidation path; coordinator handles generic batches only |
| Focused command | `node --test test/language-analyzer.test.mjs test/engine.test.mjs` |
| Done | Authentic red receipt precedes implementation; focused command passes with zero skips and frozen TypeScript fixture remains byte-identical |

### Group 2. Generic routing, manifest activation, and architecture boundary

| Field | Instruction |
| --- | --- |
| Test files | `test/language-analyzer.test.mjs`, `test/boundaries.test.mjs`, `test/source-policy.test.mjs`, `test/mcp-runtime.test.mjs`, `test/mmap-query-cache.test.mjs`, `test/visualizer.test.mjs`, `test/visualizer-e2e.test.mjs` |
| Red behavior | Analyzer-driven source/control/qualified-target/watch routing; every initial, forced-full, and incremental publication writes analyzer metadata; every qualified and unqualified mmap activation checks metadata and reconciles incompatible or legacy non-TypeScript state; read-only cache behavior; architecture scan of `source-policy.mjs`, `query-target.mjs`, `tool-engine.mjs`, `mcp-server.mjs`, `mcp-runtime.mjs`, and `visualizer.mjs` rejects Go and TypeScript/JavaScript routing literals and analyzer-ID branches |
| Implementation files | `query-target.mjs`, `source-policy.mjs`, `tool-engine.mjs`, `mcp-server.mjs`, `mcp-runtime.mjs`, `visualizer.mjs` |
| Output | Shared modules consume descriptor metadata for every build, reconcile, refresh, query activation, and watch path |
| Focused command | `node --test test/language-analyzer.test.mjs test/boundaries.test.mjs test/source-policy.test.mjs test/mcp-runtime.test.mjs test/mmap-query-cache.test.mjs test/visualizer.test.mjs test/visualizer-e2e.test.mjs` |
| Done | Focused command passes with zero skips; explicit shared-module scan finds no language routing literals or IDs; existing cache filename/schema and public interfaces are unchanged |

### Group 3. Packaged Go runtime

| Field | Instruction |
| --- | --- |
| Test file | `test/go-language-analyzer.test.mjs` |
| Red behavior | Runtime asset and Go grammar asset resolve independently by local ESM path; each missing-asset case fails explicitly; one parser initializes per Go analyzer; runtime succeeds with network unavailable; source and lifecycle scripts contain no forbidden build/helper/process/download behavior |
| Implementation files | `package.json`, `package-lock.json`, `go-language-analyzer.mjs` |
| Output | Exact packaged runtime and prebuilt grammar parse Go inside JavaScript |
| Dependency receipts | Update the lock with `npm install --package-lock-only --ignore-scripts`; create a disposable copy with `CG_INSTALL_COPY=$(mktemp -d /private/tmp/codegraph-go-install.XXXXXX)` and `rsync -a --exclude node_modules --exclude .git ./ "$CG_INSTALL_COPY/"`; in that copy run `npm ci --ignore-scripts`, `npm ls web-tree-sitter@0.27.0 tree-sitter-wasm@1.1.8`, `node -e "Promise.all([import('web-tree-sitter'),import('tree-sitter-wasm')]).then(()=>console.log('local ESM assets resolved'))"`, and `npm pkg get scripts`. The runtime test injects throwing replacements for global `fetch`, `node:http`/`node:https` request/get, `node:net` connect/createConnection, `node:tls.connect`, and `node:dgram.createSocket`, asserts zero calls, and runs the focused command without an environment-flag substitute |
| Focused command | `node --test --test-name-pattern='runtime|asset|grammar|parser|network|lifecycle' test/go-language-analyzer.test.mjs` |
| Done | Lockfile integrity reflects the exact versions, `npm ls` reports them without invalid/extraneous entries, lifecycle audit shows no new compilation, both missing-asset cases are distinguished, and focused command passes with zero skips |

### Group 4. Go endpoints, semantics, CFG, and metrics

| Field | Instruction |
| --- | --- |
| Test files | `test/go-language-analyzer.test.mjs`, `test/query-client.test.mjs`, `test/daemon-query-engine.test.mjs`, `test/dead-exports.test.mjs`, `test/mcp-internals.test.mjs`, `test/internal-graph.test.mjs`, `test/visualizer.test.mjs`, `test/visualizer-e2e.test.mjs` |
| Fixture files owned only by Test Engineer | Every path in the Immutable Fixture Table |
| Red behavior | Every supported-matrix row; duplicate names resolved only by import/package context; uncertain included-file bindings emit unresolved rows; excluded build/cgo files emit no rows; exact refs, deps, callers, dead, raw list/single, internals map/search/paths/metrics, MCP/CLI-equivalent rows, and generic visualizer-compatible rows |
| Implementation file | `go-language-analyzer.mjs` |
| Output | Deterministic existing-schema Go semantic and internal partitions with proven bindings and UTF-16 positions |
| Focused command | `node --test test/go-language-analyzer.test.mjs test/query-client.test.mjs test/daemon-query-engine.test.mjs test/dead-exports.test.mjs test/mcp-internals.test.mjs test/internal-graph.test.mjs test/visualizer.test.mjs test/visualizer-e2e.test.mjs` |
| Done | Focused command passes with zero skips; no uncertain edge is emitted. Any fixture defect returns to the Test Engineer, who changes only fixture/test files and regenerates the authentic red receipt before implementation resumes |

### Group 5. Invalidation and atomic mixed publication

| Field | Instruction |
| --- | --- |
| Test files | `test/language-analyzer.test.mjs`, `test/go-language-analyzer.test.mjs`, `test/engine.test.mjs` |
| Red behavior | Descriptor/partition EP and BVA table; both pairwise matrices; TS-only never initializes Go; Go-only never initializes TypeScript semantics; mixed emits no cross-language edge; private edit, exported edit, add, unlink, controls, and excluded-marker transitions; syntax failure preserves `CURRENT`; malformed missing partition, wrong owner/file, duplicate symbol, and dangling endpoint; injected commit throw; re-entry/concurrent publication; duplicate events; read-only cache rejects publication without corrupting the prior generation |
| Implementation files | `language-analyzer.mjs`, `typescript-language-analyzer.mjs`, `go-language-analyzer.mjs`, `tool-engine.mjs` |
| Output | Analyzer-owned invalidation stages compatible partitions. The coordinator serializes publication, coalesces duplicate events, performs every fallible parse/validation/encoding/durable-generation write before commit, then calls each analyzer's synchronous infallible `commit(staged)` pointer swap, and only then switches `CURRENT`. `commit` contains no allocation, I/O, callback, or user code. If an injected fake analyzer nevertheless throws from `commit`, `CURRENT` remains unchanged and the engine becomes failed/disposed so any already-swapped in-memory analyzer pointer is unobservable. Re-entry queues behind the active publication |
| Focused command | `node --test test/language-analyzer.test.mjs test/go-language-analyzer.test.mjs test/engine.test.mjs` |
| Done | Initial, forced-full, incremental source, add/unlink, control-file, and excluded-marker paths all carry analyzer metadata and use the same atomic validation rule; no fallible step remains between the first analyzer commit and `CURRENT`; focused command passes with zero skips |

### Group 6. Production path and current-state docs

| Field | Instruction |
| --- | --- |
| Test file | `test/codegraph.performance.test.mjs` |
| Implementation file | `scripts/codegraph.performance.mjs` |
| Documentation files | `README.md`, `docs/design/parsing-and-resolution.md`, `docs/design/storage-and-query.md`, `docs/design/mcp-and-cli.md`, `docs/design/visualizer.md` |
| Red behavior | Bounded real-Go production path verifies cold build, each user-facing query class, leaf update, cascade update, full rebuild, source restoration, and clean process exit while the existing TypeScript workload remains frozen |
| Focused command | `node --test test/codegraph.performance.test.mjs` |
| Done | Focused command passes with zero skips; production receipt completes within its existing ceiling; docs state only verified behavior |

## Target Design Docs

- Update `docs/design/parsing-and-resolution.md` with the verified plug-in contract, supported Go matrix, and unresolved boundary.
- Update `docs/design/storage-and-query.md` with analyzer metadata on every publication and mmap compatibility checks.
- Update `docs/design/mcp-and-cli.md` with endpoint parity across TypeScript-only, Go-only, and mixed repositories.
- Update `docs/design/visualizer.md` with descriptor-driven watching and generic Go row rendering.

## Use Cases

### 1. Query a Go or mixed repository

**Goal:** Query supported Go relationships through every existing CodeGraph surface.

**Stakeholders:** Developers and agents using TypeScript-only, Go-only, or mixed repositories.

**Actors:** MCP or CLI client, `CodeGraphEngine`, analyzer coordinator, active plug-ins.

**Preconditions:** Exact packaged WASM assets are installed locally and the repository cache is writable.

**Postconditions:** One analyzer-described generation serves existing-schema Go and TypeScript rows through MCP, CLI, raw query, internals, and visualizer surfaces.

**Basic Course of Events (BCE):**

1. `language-analyzer.mjs` resolves active plug-in ownership.
2. `source-policy.mjs` applies shared filesystem safety to plug-in candidates.
3. Each active plug-in stages generic partitions.
4. `language-analyzer.mjs` validates the complete merge without language branches.
5. `tool-engine.mjs` durably prepares one analyzer-described generation without switching `CURRENT`, commits the infallible analyzer pointers, then switches `CURRENT`.
6. Existing query, MCP, CLI, internals, and visualizer code consumes unchanged schemas.

**Alternate Flows:** A TypeScript-only repository never initializes Go; a Go-only repository never initializes TypeScript semantics; a mixed repository publishes both without a cross-language edge.

**Exceptions:** Missing runtime asset and missing grammar asset fail distinctly; malformed partitions, duplicate symbols, dangling endpoints, or read-only cache failure publish nothing and preserve the prior generation.

### 2. Refresh Go source or controls

**Goal:** Publish a supported Go update while reusing compatible unaffected partitions.

**Stakeholders:** Developers and agents relying on current incremental query results.

**Actors:** Repository watcher, analyzer coordinator, Go plug-in, `CodeGraphEngine`.

**Preconditions:** A compatible validated generation exists and the shared watcher accepts the event.

**Postconditions:** A new complete analyzer-described generation is active, or `CURRENT` still names the prior generation.

**Basic Course of Events (BCE):**

1. `mcp-runtime.mjs` forwards normalized source or control events.
2. `language-analyzer.mjs` groups events by owner.
3. `go-language-analyzer.mjs` stages the affected package and supported reverse-import closure.
4. The coordinator validates staged and reused partitions together.
5. `tool-engine.mjs` durably prepares the generation, commits the infallible analyzer pointers, then switches `CURRENT` once.

**Alternate Flows:** Add, unlink, module/workspace control, build-constrained, cgo, or unprovable closure events conservatively reload the Go plug-in while compatible TypeScript partitions remain reusable.

**Exceptions:** Syntax failure, analyzer failure, malformed output, or publication failure discards every stage and leaves `CURRENT` unchanged.

## Testing Requirements

- Unit tests are the named `test/*.test.mjs` files in Groups 1 through 5; end-to-end tests are in `test/visualizer-e2e.test.mjs`; production-path tests are in `test/codegraph.performance.test.mjs`.
- Every group records its exact red command before implementation and reruns the same command green with zero skips. Test/fixture changes belong only to the separate Test Engineer.
- Group 2 tests every publication path and every mmap activation path for analyzer metadata, plus scans the explicit shared-module list for language routing literals and analyzer IDs.
- Group 4 tests the full supported semantic/output matrices and conservative unresolved boundary.
- Group 5 tests all initial, forced-full, incremental source, add/unlink, and control publication outcomes, including rollback and `CURRENT` preservation.
- Group 4 adds post-Go `test/visualizer.test.mjs` and `test/visualizer-e2e.test.mjs` cases backed by a real Go-only generation and a real mixed generation.
- `test/assert-language-coverage.mjs`, owned only by the Test Engineer, runs each per-file command with `NODE_V8_COVERAGE` set to a fresh temporary directory, parses the emitted V8 JSON, and requires every executable V8 range as the statement proxy to have a positive execution count. Node's supported thresholds separately require 100% lines, branches, and functions. The script fails if the named file is absent from either report; uncovered or unreachable production code must be removed.
- Final commands: `npm test`; `node test/assert-language-coverage.mjs`; `node /Users/mac/.agents/skills/docs-integrate/scripts/validate.js docs/plans/go-language-analyzer/plan.md docs/plans/go-language-analyzer/tasks.md README.md docs/design/parsing-and-resolution.md docs/design/storage-and-query.md docs/design/mcp-and-cli.md docs/design/visualizer.md`; `git diff --check`.
- Final validation requires zero failures and zero skips. Targeted coverage must exercise changed coordinator and Go modules; no repository-wide 100% threshold is added.
- Per-file commands, each executed with a fresh `NODE_V8_COVERAGE` directory by `test/assert-language-coverage.mjs`, are: `language-analyzer.mjs`, `typescript-language-analyzer.mjs`, and `tool-engine.mjs` with Group 1 and Group 5 suites; `source-policy.mjs` and `mcp-runtime.mjs` with the Group 2 suite; `query-target.mjs` and `mcp-server.mjs` with the Group 2 suite; `visualizer.mjs` with Group 2 and Group 4 suites; `go-language-analyzer.mjs` with Group 3, Group 4, and Group 5 suites; `scripts/codegraph.performance.mjs` with `test/codegraph.performance.test.mjs`. Each invocation uses `node --experimental-test-coverage --test --test-coverage-include=<exact-file> --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 <mapped-test-files>`.
- Record six exact manual mutation receipts: duplicate analyzer/symbol IDs → `test/language-analyzer.test.mjs` and `test/engine.test.mjs` duplicate tests fail; force export-fingerprint equality → `test/go-language-analyzer.test.mjs` cascade test fails; switch `CURRENT` before commit → `test/engine.test.mjs` injected-commit test fails; resolve an ambiguous selector to the first candidate → `test/go-language-analyzer.test.mjs` ambiguity test fails; add a `.go`, `.ts`, or analyzer-ID routing branch to any explicit shared module → `test/language-analyzer.test.mjs` architecture scan fails; bypass endpoint validation or inject an edge whose `to` is a missing symbol ID → the named dangling-endpoint test in `test/engine.test.mjs` fails. Revert each mutation before continuing.

## Parallel / Dependent Breakdown

- Group 0 precedes all tests. Groups 1 through 6 execute in order.
- Within each group, the Test Engineer finishes the red receipt before the implementer starts; the implementer finishes the green receipt before the next group starts.
- Documentation starts only after runtime, endpoint, incremental, and production-path receipts pass.

## Success Criteria

- The nine partial files are restored or isolated before any red receipt, with unrelated work and corrected plan documents preserved.
- Shared routing modules contain no Go or TypeScript/JavaScript language-routing literal or analyzer-ID branch.
- TypeScript/JavaScript partition bytes and public query results remain identical.
- Exact packaged WASM assets install and run locally with lifecycle scripts audited and runtime network unavailable.
- Every supported Go matrix row reaches every named user-facing output through existing schemas; uncertain included-file bindings remain unresolved, while excluded build/cgo files emit no rows.
- Every initial, forced-full, and incremental publication carries analyzer metadata, and every mmap activation validates it.
- TypeScript-only, Go-only, and mixed updates publish atomically; every failure class preserves `CURRENT`.
- Every group has authentic red and green receipts, all final commands pass with zero skips, and all six mutation receipts fail as expected.
