---
modified: 2026-10-08
dependencies:
  - ../../design/parsing-and-resolution.md
supersedes: null
---

# Whole semantic runtime

## Problem

Cold indexing, hydration, full validation, and restart validation still construct Project or wrapped nodes. Ordinary edits still rebuild file analysis. A narrow numeric-return cache does not establish whole-pipeline performance.

## APPROVED REQUIREMENTS

1. Replace Project and createWrappedNode across every production semantic path with direct TypeScript API access.
2. Retain owned syntax, import, declaration, binding, and CFG facts for ordinary edits. Use existing keyed facts; single-file work must not scan the repository or read unchanged dependent sources.
3. Preserve complete partitions, fingerprints, binary bytes, query results, compiler configuration, library semantics, and publication behavior.
4. Measure real cold indexing, hydration, and ordinary warm updates. Target a 40-fold initial-load improvement; report actual paired measurements and remaining costs. Narrow eligible edits do not satisfy this requirement.
5. Use the existing worker class for configured cold-batch concurrency, including CPU-count-one and configured-three-worker cases. Dispatch one semantic job for a single edit.
6. Preserve dependency versions, cache versions, stored formats, existing data, and unrelated work. Do not introduce unrelated abstractions, protocols, fallback paths, locks, waits, or repairs.

## Solution

Use the existing raw-node library for all semantic factories and retain reusable per-file facts in the existing worker lifecycle. Optimize measured whole-pipeline costs after complete output parity is established. Implement one atomic group, verify it, then proceed.

## Scope

- `one-file-semantic-library.mjs`: share raw-node caches across the full source set. Make source-file identity, module lookup, configuration, and library access correct together. Retain ordinary-edit facts rather than limiting reuse to numeric-return edits.
- `parser.mjs`: replace semantic factory implementations and affected imports together. Preserve `createSemanticProject`, `createOneFileSemanticProject`, `prepareSemanticProject`, and `parsePartition` interfaces.
- `internal-graph.mjs`: remove standalone Project construction from `buildInternalGraph` through the shared raw adapter; preserve graph and encoder contracts.
- `semantic-checker-worker.mjs`: install the shared runtime in cold index, hydrate, full validation, explicit-base validation, restart, multi-file validation, retained one-file validation, and reference overlays. Retain per-file sessions and implement configured concurrency in the existing worker class without changing generation or partition transport protocols.
- `cached-binding-resolver.mjs`: extend the existing reference index with symbol membership and raw-edge endpoint buckets. Reclassify only incident changed facts and retain ordered publication patches and dangling records, including inherited patches on hydration.
- `tool-engine.mjs`: validate delta membership directly, retain and patch keyed base partitions after successful publication, and consume retained publication facts without flattening or reclassifying the repository. Preserve pinned query views and failure behavior.
- `store.mjs`: expose the existing small CURRENT identity separately from full manifest deserialization, retaining existing recovery behavior. Complete manifest JSON serialization, output materialization, and movement of ordered output slots remain unavoidable costs; no graph rescan or repository sort is justified by those costs.
- `test/one-file-semantic-library.test.mjs`, `test/one-file-library-integration.test.mjs`, and `test/remaining-performance-contracts.test.mjs`: independent validation of raw-node parity, all worker paths, retained ordinary edits, concurrency, and bounded changed-file work. Preserve valid existing tests.
- `docs/design/parsing-and-resolution.md`: describe the verified final runtime, lifetime, and measured performance boundaries after implementation.
- No renames. No UI/UX required. Existing engine and analyzer factory call interfaces remain intact.

## Target Design Docs

Update `docs/design/parsing-and-resolution.md` Architecture, Functions, and Tests to describe the shared direct-API runtime, retained per-file facts, full worker lifecycle, and configured concurrency.

## Testing Requirements

The independent validation agent owns test selection and edits. Compare complete outputs against the preserved baseline, including internal bytes and fingerprints, for cold indexing, hydration, full and multi-file validation, explicit-base/restart validation, and ordinary single-file edits. Cover imports, renames, positional edits, add/unlink, dependency changes, generation transitions, and reference overlays. Verify configured-three-worker cold batching, CPU-count-one behavior, and one-edit/one-job dispatch. Assert no dependent source reads or repository-sized changed-file allocations.

Run each changed focused test file without skips, existing relevant parser/internal-graph/worker contracts, syntax checks for changed runtime files, and `git diff --check`. Preserve unrelated failures separately. Run code-guard after runtime edits and test-guard after test edits.

Use `/private/tmp/codegraph-whole-before` as the preserved runtime baseline. Run the existing production performance harness against frozen real D&D sources and a larger real dataset, with paired before/after runs on the same machine and equivalent cache state. The final frozen datasets contain 931 and 1,907 eligible files; the earlier 877-file measurement is not an equivalent baseline. Record cold index, hydrate, ordinary warm update, CPU, heap, trace, diagnostics, and complete-output/query parity. Keep timings out of correctness assertions.

## Parallel / Dependent Breakdown

1. A: Implement all production raw-API paths through the shared multi-file adapter as atomic factory/import/body changes. Verify configuration/library semantics and complete output before proceeding.
2. B: Retain ordinary changed-file syntax, imports, declarations, bindings, and CFG facts in existing keyed structures. Verify invalidation and bounded work before proceeding.
3. C: Profile the complete pipeline, optimize actual remaining costs, and implement configured concurrency through the existing worker class. Verify deterministic parity and dispatch contracts after each change.
4. D: Independently compare complete 931-file output and real application cold/warm performance against the preserved baseline; repeat on the larger 1,907-file dataset. Record achieved speedups and remaining costs.
5. Update the design document only after verified implementation and measurements.

## Success Criteria

- Every production semantic path uses direct TypeScript API access without Project or createWrappedNode construction.
- Ordinary edits reuse retained facts correctly with bounded keyed changed-file work.
- Complete semantic, binary, fingerprint, query, and publication parity holds across all paths.
- Configured semantic concurrency and one-edit/one-job behavior are independently verified.
- Real paired whole-application measurements establish the achieved improvement against the 40-fold target; report any shortfall explicitly.
- Dependency versions, cache/storage formats, old data, and unrelated changes are preserved.

## Verified implementation and measurements

All production semantic factories use the shared direct TypeScript API runtime. Ordinary edits retain per-file syntax/import/declaration/CFG facts and keyed reference/publication facts. Cold structural jobs use the existing pool, with a shared main-side thread budget and a bounded source-order window around one repository Program/checker. Hydration adopts verified partitions without constructing source ASTs; actual legacy overlays still construct their semantic context. Empty queued requests perform no semantic work, full builds reset old delta patches, and publication preserves newer same-file and different-file changes during acknowledgement.

Measured on October 8 using Node 26.9.0, fixed real sources and CPU/heap/trace profiling. The application measurements use the existing MCP lifecycle harness and fresh graph stores; five ordinary type-declaration additions supply the update median. Larger-corpus numbers measure worker operations, not the complete application. Cold measurements are single paired observations, not statistical throughput guarantees.

| Operation | Preserved baseline | Final candidate | Elapsed reduction |
| --- | ---: | ---: | ---: |
| Full MCP app cold load, 931 D&D files | 14.330 s | 12.706 s | 11.3% |
| MCP ordinary update, median of five | 327.725 ms | 226.412 ms | 30.9% |
| Cold worker indexing, 1,907 larger-corpus files | 16.886 s | 13.127 s | 22.3% |
| Worker hydration, same 1,907 files | 3.213 s | 1.363 s | 57.6% |
| First comment insertion, actual 895,850-byte REPL file | 301.352 ms | 333.166 ms | 10.6% slower |
| Restoration of that file | 200.718 ms | 191.098 ms | 4.8% |

The **40-fold cold-load target is not achieved**. The final D&D worker spends 8.624 seconds in identifier resolution, including lazy Program/checker initialization; it makes 318,747 actual checker calls. Conservative lexical memoization saves 19,401 repeated calls. Native cold traversal reduces semantic wrappers from 1,016,003 to 784,237. None of these measurements justify extrapolating a narrow cached-edit result to whole-application cold loading. The larger first-edit regression remains visible in the results rather than being averaged away.

Complete symbols, internal bytes and fingerprints match the immutable baseline for all 2,838 files across the two datasets. Ten D&D edit sequences and five larger-corpus hydrated edits also match. The 125 focused existing tests pass with zero skips. Independent external proofs cover legacy overlays, inherited patch reset, empty/multi-file requests, pinned queries, failed publication, root/config transitions, concurrent owner ordering, shared three-worker budgets and queued public incremental changes during generation acknowledgement. Hydration instrumentation records zero full-project constructions for hydration and empty overlays, one for the first required legacy overlay and zero for its repeat.

Rerunnable receipts are retained under `/private/tmp`: `codegraph-whole-oracle.mjs`, `codegraph-whole-edits-oracle.mjs`, `codegraph-whole-app-profile.mjs`, `codegraph-engine-batch-oracle.mjs`, `codegraph-minimal-batch-oracle.mjs`, `codegraph-engine-incremental-ack-oracle.mjs`, `codegraph-hydrate-overlay-oracle.mjs`, and `codegraph-full-fallback-oracle.mjs`. The app's final artifact stem is `codegraph-whole-paired-final-ack`; the larger cold stem is `codegraph-anthropic-final-pre-hydrate`, and final hydration artifacts and their JSON validation are listed in `codegraph-final-profile-artifact-receipts.json`. Parent, semantic and all seven structural worker CPU/heap artifacts have unique paths; traces are process-wide. Failed profiling runs are excluded from the table.

The broad suite is not clean: its recorded run reports 776 tests, 728 passes and 48 failures, with zero skips. A stalled engine fixture was terminated after other files drained; the same fixture stalls against the frozen baseline. Subsequent focused checks repair the introduced source-lookup compatibility method, metadata spelling and public semantic-worker counter. Existing failures are compared against the frozen runtime without changing their tests. The broad run is retained at `/private/tmp/codegraph-whole-final-suite.tap`; these counts describe that run before the compatibility repairs, not a successful final full-suite run.
