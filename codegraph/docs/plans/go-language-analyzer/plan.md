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

CodeGraph documents language plugins but hardcodes TypeScript and JavaScript throughout source discovery, parsing, workers, module resolution, and watching. Go repositories cannot produce CodeGraph symbols or relationships through the shared MCP interface.

## Solution

Land the shared language plug-in contract, resolve built-in plug-ins once per engine, route files through an extension map, preserve TypeScript and JavaScript output exactly, and add a persistent Go plug-in that emits the existing partition schema. Keep storage, publication, queries, MCP tools, and visualization language-neutral. This is the first plug-in implementation and establishes the contract used by later Vue and C# plug-ins.

## Contract

### Analyzer coordination

- Add an `AnalyzerCoordinator` owned by `CodeGraphEngine` with one extension map, one analyzer-owned provisional resolver, semantic worker, and cache key per language, and one file-to-analyzer map.
- Construct the analyzer set and direct function references once per engine. Perform no registry scan or analyzer dispatch inside node, symbol, identifier, or partition loops.
- Scan once through the shared source policy, group files by analyzer, run analyzer builds concurrently, validate every batch, merge partitions in file-path order, reject duplicate symbol IDs or dangling edge endpoints, and publish one generation only after the complete merge succeeds.
- Stage incremental results per analyzer, validate every staged batch before committing any provisional revision, merge semantic results with compatible unaffected partitions, and publish one generation atomically. Any analyzer failure retains the prior validated generation.
- A provisional resolver implements `stageChanges(changes, revision)`, returning an opaque staged result plus proposed partitions without mutating visible resolver state; `commit(staged)` makes it visible only after every analyzer batch and merged generation validates; `discard(staged)` releases it without advancing revision. TypeScript and Go use this same transaction boundary.
- Support TypeScript-only, Go-only, and mixed repositories. Do not infer cross-language edges.

### Language analyzer

- Each analyzer provides a unique `id`, unique owned `extensions`, `controlFiles`, a non-empty `cacheKey`, `createSourceMatcher(root)`, `createProvisionalResolver(root, options)`, and `createSemanticWorker(options)`.
- TypeScript and JavaScript retain their existing source policy, parsing, identity, partition, ordering, worker ownership, and lazy semantic imports byte-for-byte.
- Go owns `.go`, `go.mod`, `go.sum`, `go.work`, and `go.work.sum`.
- `query-target.mjs` recognizes `file.go`, `file.go:Symbol`, and existing TypeScript/JavaScript qualified targets without changing MCP request or response schemas.

### Go helper

- Ship Go helper source, `go.mod`, and `go.sum`; pin `golang.org/x/tools v0.49.0` and use `go/packages`, `go/cfg`, `go/ast`, `go/token`, `go/types`, and `go/types/objectpath`.
- Extend the existing optional install build to create `go-analyzer/bin/<platform>-<arch>/codegraph-go-analyzer` with `go build -trimpath -ldflags="-s -w" .`. Do not download at runtime or use `go run`.
- Allow TypeScript/JavaScript installation without Go. If active Go source exists without a compatible helper, fail explicitly with instructions to install Go and run `npm rebuild @mcps/codegraph`.
- Require the helper handshake `{protocol:1, analyzer:"go", analyzerVersion:"1", xTools:"v0.49.0", goVersion}` before indexing.
- Use NDJSON requests `{id,op,payload}` and replies `{id,result}` or `{id,error:{code,message}}` for `index`, `hydrate`, `validate`, `reference-overlay`, `cancel`, and `shutdown`.
- Serialize helper requests, propagate `AbortSignal` through `cancel`, enforce a 60-second ceiling for index/hydrate and a 30-second ceiling for validate/overlay, terminate after a one-second cancellation grace, reject all pending requests on crash, retain the last 64 KiB of stderr, restart and hydrate only on the next request, and leave no helper after engine disposal.
- Shutdown by acknowledged request within two seconds, then `SIGTERM` for one second, then `SIGKILL`; an acknowledged shutdown must exit zero.

### Go identities, partitions, and internals

- Emit the existing semantic partition, symbol, edge, unresolved-dependency, and encoded internal-partition schemas.
- Hash Go symbol IDs from the `go` namespace, module path, package import path, relative file, qualified path, kind, name, canonical signature, and ordinal; truncate SHA-256 to 24 hexadecimal characters.
- Map package functions to `function`, methods to `method`, named types and structs to `type`, interfaces to `interface`, and package variables/constants to `variable`. Determine `exported` from an uppercase Unicode identifier.
- Prefix qualified paths with the package import path and receiver type for methods. Resolve dependencies at package membership and call/reference edges to exact declarations.
- Emit existing internal owner, node, control-flow edge, and call/read/write relation kinds for Go functions, methods, literals, branches, loops, range, switch, type switch, select, labels, goto, fallthrough, calls, assignments, returns, panic, defer, goroutines, short-circuit expressions, and unreachable statements.
- Preserve existing UTF-16 source offsets. Encode Go rows with the existing internal partition writer and introduce no new persisted node or edge codes.

### Go invalidation

- Rebuild every partition in the changed file's package.
- Compute a deterministic package export fingerprint from import path, active compiled membership, exported object paths, canonical types, constants, exported named-type method sets including unexported methods, embedded fields, interface terms, and package diagnostics.
- Recheck the complete reverse-import closure when the export fingerprint changes; reuse importer partitions when it does not.
- Fully reload Go analysis for add/unlink, package-name or build-constraint changes, cgo membership changes, module/workspace control changes, package/type errors, changed unresolved candidates, or any unprovable closure.

### Cache compatibility

- Keep `query-view-cache.bin` and its binary schema unchanged.
- Add analyzer cache keys to generation manifests. Treat manifests without analyzer metadata as compatible legacy TypeScript generations only.
- Before activating any mapped page, `mcp-server.mjs` synchronously compares the manifest analyzer set with analyzers discovered from current source/control files. If a current analyzer is absent, bypass mmap and await reconciliation; this applies to qualified and unqualified queries.
- Hash helper protocol/version, analyzer version, x/tools version, `GOVERSION`, `GOOS`, `GOARCH`, `CGO_ENABLED`, `GOFLAGS`, `GOEXPERIMENT`, `GO111MODULE`, resolved `GOWORK`, explicit build tags, and hashes of `go.mod`, `go.sum`, `go.work`, and `go.work.sum` into the Go cache key.
- Validate `manifest.analyzers` before mapped activation in `mcp-server.mjs` and before both initial and incremental publication in `tool-engine.mjs`.
- Rebuild only incompatible analyzer partitions and reuse compatible content-addressed partitions. Never rename cache files or abandon a compatible TypeScript cache.

### Go control-flow mapping

- Encode `goto` as a `statement` node with `next` to its label, `fallthrough` as `next` to the following case, and `panic` as a `call` relation plus `throw` to function exit.
- Place deferred calls in LIFO order on every return and throw exit path. Encode `go f()` as a `call` relation plus normal `next`, and `select` as a `condition` node with `case` edges.
- Use the existing schema's ordinary statement, condition, exit, relation, and edge codes; add no Go-only persisted kinds.

## Target Design Docs

- Update `docs/design/parsing-and-resolution.md` after implementation to describe the built-in analyzer set, shared output contract, Go package invalidation, and cross-language limitation.
- Update `docs/design/mcp-and-cli.md` after implementation only where analyzer failures and supported repository behavior affect the existing entry points.
- Update `docs/design/visualizer.md` after implementation to remove the duplicated extension-list constraint.
- Update `docs/design/storage-and-query.md` after implementation to describe analyzer cache keys and compatibility of existing TypeScript-only generations.

## Use Cases

### 1. Query a Go repository

**Goal:** Retrieve type-resolved Go symbols and relationships through the existing CodeGraph MCP tools.

**Stakeholders:** Developers and AI agents analyzing Go or mixed Go and TypeScript repositories.

**Actors:** MCP client, `CodeGraphEngine`, TypeScript analyzer, and Go analyzer.

**Preconditions:** The repository contains valid Go source, the Go toolchain and helper are available, and CodeGraph can write its repository cache.

**Postconditions:** One validated generation contains all active analyzer partitions and existing MCP tools return Go relationships without changing their schemas.

**Basic Course of Events (BCE):**

1. `CodeGraphEngine` constructs the built-in analyzer set and an extension-to-analyzer map.
2. `source-policy.mjs` routes `.go` files and Go control files to the Go analyzer while retaining shared ignore and symlink rules.
3. `go-language-analyzer.mjs` starts one persistent helper and loads packages with `go/packages` and `go/types`.
4. The Go analyzer returns existing symbol, edge, dependency, unresolved, and internal-partition records.
5. `tool-engine.mjs` validates and merges all analyzer partitions before publishing the generation.
6. Existing `codegraph_refs`, `codegraph_deps`, `codegraph_callers`, `codegraph_dead`, and raw-query handlers read the shared graph unchanged.
7. Qualified `file.go:Symbol` targets resolve to the named declaration.

**Alternate Flows:** A TypeScript-only repository initializes only the TypeScript analyzer and never starts the Go helper; a mixed repository runs both analyzers and merges their partitions without inventing cross-language edges.

**Exceptions:** Duplicate extension ownership fails engine construction; unavailable Go tooling, package-load errors, missing partitions, malformed rows, or duplicate symbol IDs reject publication and retain the last validated generation.

### 2. Refresh a changed Go file

**Goal:** Make a Go source edit queryable without rebuilding unaffected language partitions.

**Stakeholders:** Developers and AI agents relying on current relationships during iterative edits.

**Actors:** Repository watcher, `CodeGraphEngine`, and Go analyzer.

**Preconditions:** A validated generation exists and the changed path belongs to the Go analyzer.

**Postconditions:** The changed package and proven reverse-import closure are validated and atomically published, or the prior generation remains active after failure.

**Basic Course of Events (BCE):**

1. `mcp-runtime.mjs` forwards the accepted path from the shared source policy.
2. `tool-engine.mjs` groups the change by analyzer using the precomputed extension map.
3. The Go analyzer reparses and rechecks the containing package.
4. The Go analyzer rechecks reverse importers transitively when exported behavior changed.
5. `tool-engine.mjs` validates partition ownership and publishes the complete generation.
6. The MCP query path returns the changed relationship from the new validated generation.

**Alternate Flows:** Changes to `go.mod`, `go.sum`, `go.work`, package declarations, build tags, file membership, or an unprovable closure trigger a full Go reload while compatible TypeScript partitions remain reusable.

**Exceptions:** Worker failure, malformed output, or package diagnostics abort publication and preserve the previous validated generation.

## Testing Requirements

- Unit tests live in `test/language-analyzer.test.mjs`, `test/go-language-analyzer.test.mjs`, and the existing focused `test/*.test.mjs` files named below. End-to-end tests live in `test/visualizer-e2e.test.mjs` and the production MCP performance runner.
- Add table-driven registry tests in `test/language-analyzer.test.mjs` for zero/one/many analyzers, invalid collections and analyzer fields, duplicate IDs, duplicate extensions within/across analyzers, unsupported paths, mixed repositories, one-time factory resolution, and TypeScript defaults.
- Add an instrumented hot-path unit test that parses zero, one, and many files with increasing node, symbol, identifier, and partition counts; assert analyzer-set and extension-map construction occur once per engine, per-file routing is one O(1) map lookup, and registry iteration or strategy-resolution counts remain zero inside every parsing/merge loop regardless of graph size.
- Capture immutable pre-refactor TypeScript/JavaScript partition buffers, normalized generation manifests, and literal MCP receipts from named checked-in fixtures; compare them with `Buffer.equals` and `assert.deepEqual` after extraction without regenerating baselines.
- Add exact `query-target.mjs` boundary tests for `file.go`, `file.go:Symbol`, unqualified symbols, and all existing supported suffixes in `test/boundaries.test.mjs`.
- Add literal Go semantic expectations for functions, methods, pointer/value receivers, types, structs, interfaces, variables, constants, aliases, embedded types, generics, exports, `init`, aliased/blank/dot imports, same-name declarations across packages, build tags, dependencies, references, callers, dead exports, raw queries, and deterministic row order.
- Add exact Go internal graph tests for empty functions, branches, loops/range, switch/type-switch/select, fallthrough/default, labelled flow/goto, returns/unreachable code, panic/recover, defer LIFO, goroutines, short-circuit expressions, nested literals, call/read/write relations, Unicode UTF-16 positions, binary round trip, and all `codegraph_internals` operations.
- Add source-policy scan/watch tests for Go source, all Go control files, ignores, symlinks, normalized/absolute paths, suffix boundaries, add, and unlink.
- Add package-update tests for private-body versus exported API changes, same package, direct/transitive/unrelated importers, membership changes, package rename, build tags, module/workspace controls, unresolved candidates, add/unlink, and conservative full reload.
- Add failure tests for missing/non-executable helper, protocol mismatch, permission failure, malformed/truncated/empty/out-of-order/unknown-ID replies, package diagnostics, missing partitions, duplicate IDs, dangling edges, helper crash/restart, cancellation, timeout, shutdown in flight, stale revisions, overlapping analyzer events, and rapid add/unlink. Assert `CURRENT` remains unchanged after every rejected publication.
- Add fake-clock helper-protocol unit tests for every NDJSON operation and reply shape, wrong-type/null/missing/empty/semantically invalid payloads, serialized concurrent requests, 60-second and 30-second boundaries immediately before/at/after expiry, one-second cancellation grace, stderr retention at 65,535/65,536/65,537 bytes, rejection of every pending request on crash, no eager restart, hydrate before the first post-crash operation, two-second acknowledged shutdown, SIGTERM then one-second SIGKILL escalation, and rejection of a nonzero exit after acknowledgment.
- Add `test/language-analyzer.test.mjs` transaction tests proving failed peer validation calls `discard` and never `commit`, successful validation commits each staged result exactly once, and stale/double commit or discard never advances the visible revision.
- Add optional-build tests proving installation succeeds without Go for TypeScript-only use, a present Go toolchain builds the exact platform/architecture binary, build failure remains optional until active Go is discovered, unsupported targets fail explicitly, incompatible helpers produce the remediation message, and runtime code contains neither `go run` nor download behavior.
- Add cache tests proving the stable cache filename/schema, legacy TypeScript manifest activation, synchronous reconciliation before qualified and unqualified Go queries against a legacy cache, and one-at-a-time cache-key sensitivity for every named input. Prove compatible reuse, Go-only incompatibility preserves TypeScript partitions, and legacy TypeScript caches are not abandoned.
- Add literal export-fingerprint tests for unchanged private bodies and changes to active membership, object path, canonical type, constant value, an unexported method on an exported named type, embedded field, interface term, diagnostics, and inactive build-tagged membership; assert exact importer recheck identities and publication outcome.
- Add mixed-repository tests proving both analyzer partitions publish together, no cross-language edge is invented, unchanged TypeScript partitions are reused after a Go-only edit, Go failure prevents partial publication, and TypeScript-only repositories never construct a Go helper.
- Add an all-pairs parameter test covering repository composition (TypeScript, Go, mixed), event (add, change, unlink, control), impact (private, exported, membership), outcome (success, diagnostic, crash), and cache state (none, current, legacy, stale), including mixed plus Go-control failure with a current cache retaining the prior complete generation.
- Add visualizer end-to-end cases proving `.go` and every Go control-file event broadcasts exactly once, ignored Go paths do not broadcast, and mixed repositories render/query Go rows without a duplicated extension list.
- Extend `test/source-policy.test.mjs`, `test/engine.test.mjs`, `test/parser-apartment-pool.test.mjs`, `test/mcp-runtime.test.mjs`, `test/mcp-internals.test.mjs`, `test/internal-graph.test.mjs`, `test/mmap-query-cache.test.mjs`, `test/native-startup.test.mjs`, `test/visualizer.test.mjs`, `test/visualizer-e2e.test.mjs`, and `test/codegraph.performance.test.mjs` only for their existing changed contracts.
- Run `npm test` with zero skips. Run `node --experimental-test-coverage --test` and require 100% statements, branches, functions, and lines per changed production JavaScript file. Run `go test -coverprofile=coverage.out ./...` and `go tool cover -func=coverage.out` in `go-analyzer`, requiring 100.0% statements. Remove unreachable branches rather than excluding them.
- Mutate at least the extension collision guard, duplicate-symbol guard, helper protocol guard, publication guard, and export-fingerprint branch and prove a focused test fails for each mutation.
- Run the existing frozen D&D benchmark without changing its snapshot, workloads, lifecycle isolation, sample count, statistics, mutation sequence, or report format; fail on semantic hash drift, repository mutation, incomplete samples, or unclean shutdown.
- Add a separate frozen Go benchmark against `/Users/mac/Documents/Projects/Brain/sslp-memory-test` using five independent fresh-copy/fresh-helper lifecycles. Report p50, p90, and MAD for cold index, refs, deps, callers, dead exports, internals, cyclomatic complexity, leaf update, cascade update, and full reindex; fail when median regression exceeds the larger of 5% or two baseline MADs, p90 exceeds 110% of baseline, semantic hashes drift, the source repository changes, or helper cleanup fails.
- Require all focused and full tests to pass with zero skips.

## Parallel / Dependent Breakdown

- Tests for registry validation and TypeScript compatibility can be authored before production changes.
- The analyzer registry, shared source policy, TypeScript analyzer extraction, worker injection, visualizer routing, and engine integration form one dependent atomic change.
- TypeScript correctness and performance gates must pass before Go implementation begins.
- Go fixtures and failing behavioral tests can be authored after the analyzer contract is fixed.
- The Go helper, Go analyzer, Go workers, engine merge behavior, and package invalidation form one dependent atomic change.
- Documentation and package metadata depend on verified TypeScript parity and verified Go runtime behavior.

## Success Criteria

- TypeScript and JavaScript partition bytes, symbol IDs, edge order, graph output, and MCP responses remain identical.
- Analyzer factories resolve once per engine and parsing loops contain no registry scan or strategy dispatch.
- TypeScript-only repositories never start the Go helper.
- Mixed Go and TypeScript repositories publish complete partitions for both analyzers.
- Qualified `.go` file and `file.go:Symbol` queries resolve correctly.
- Go symbols, methods, types, interfaces, variables, dependencies, references, callers, and exports are returned through existing query schemas.
- Go executable internals and CFG-derived metrics are returned through `codegraph_internals` using the existing internal schema.
- Go leaf and reverse-import cascade edits become queryable through the actual MCP watcher.
- Analyzer failure never publishes a partial generation.
- Real D&D performance passes the explicit median, p90, and MAD thresholds in Testing Requirements.
- Real Go CPU, heap, trace, cold, warm, leaf-update, and cascade-update results are reported from the production MCP path.
- All focused and full tests pass with zero skips, and code, test, documentation, and diff guards pass.
