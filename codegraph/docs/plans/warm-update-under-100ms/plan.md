---
modified: 2026-09-08
dependencies:
  - ../../design/parsing-and-resolution.md
  - ../../design/storage-and-query.md
supersedes: null
---

# Warm Single-File Updates Under 100 ms

## Problem

A retained real-repository single-file update takes 740.56 ms because provisional linking, semantic dependency discovery, partition materialization, and complete-reference work repeat repository-wide work.

## Solution

Reuse generation-matched in-memory state, maintain worker dependency indexes, update the existing provisional graph incrementally, and parse each affected file once with complete coverage. Return the calls partition and non-call reference fragment together so main can validate both without a second worker request.

## Target Design Docs

- `docs/design/parsing-and-resolution.md`
- `docs/design/storage-and-query.md`

## Testing Requirements

- Add unit tests in test/incremental-resolver.test.mjs with exact-output content-only and structural-edit cases proving the fast path preserves graph shape and ordering.
- Add integration tests in test/engine.test.mjs for retained leaf, cascade, unresolved-candidate, hydrate, full-fallback, malformed-overlay, stale-generation, concurrent-edit, worker-failure, and publication-failure behavior.
- Prove a retained leaf edit advances the validated generation, parses and validates exactly one file, and returns refs, dependencies, callers, dead-export, and raw-query results exactly equal in content and order to a clean rebuild of the edited source state.
- After index, hydrate, and full-validation initialization, dependency-changing and formerly unresolved edits must publish results exactly equal to a clean rebuild. After failed, stale, or superseded validation, the rejected generation must never become current and the next accepted edit must still reach clean-rebuild parity.
- Preserve the existing zero-change, add, delete, rename, control-file, leaf, cascade, rapid-edit coalescing, worker-exit, disposal, stale-engine, and cache-compatibility tests. Add a new case only where the changed contract is not already observable through an existing case.
- Require new branches in the three changed runtime files to be executed by focused tests under Node's `--experimental-test-coverage`; do not assert private helper calls, internal container shapes, or a fixed fast-path threshold.
- Run focused Node tests with zero skips, then the full engine test file once after source stabilization.
- Run `npm run performance -- --root /Users/mac/Documents/Projects/dnd-community-and-marketplace --samples 10` after one warmup, using its disposable mirror and reversible appended comment in `src/utils/plotSameSelectedItem.ts`. Extend the existing reporter to measure from submitting the edit through validated generation publication and completion of the first complete-reference query. Require nearest-rank p90 below 100 ms; report p50, p90, maximum, parsed files, and validated files; fail on timeout or receipt/parity mismatch.
- Capture CPU and trace profiles separately from timing and store them only in `trace-analyzer/profiles`.

## Parallel / Dependent Breakdown

1. Test Engineer writes failing observable behavior and performance-contract tests.
2. Developer removes repeated provisional, validation, partition, and overlay work in measured stages.
3. Reviewer verifies exact output, failure atomicity, cache compatibility, and source scope.
4. Performance Engineer runs the real D&D timing and profile gates.
5. Technical Writer updates the target design documents and removes this completed plan.

## Success Criteria

- A real D&D retained warm leaf edit plus its first complete-reference query reaches an exact validated result in less than 100 ms nearest-rank p90 across ten measured samples.
- Query results exactly match a clean rebuild of each edited source state; generation atomicity, current cache compatibility, and cold behavior remain unchanged.
- The optimized worker contract returns call partitions and non-call overlay fragments from one complete parse. Main validates exact membership and endpoints before publishing the generation, then writes the generation-keyed overlay through the existing overlay path; an overlay failure never corrupts the generation and remains recoverable through the existing fallback.
- Worker dependency and unresolved-candidate indexes are rebuilt after successful index, hydrate, and full validation and patched after successful worker-side delta validation. If main rejects, supersedes, or cannot publish the result, it invalidates worker hydration and must hydrate from the accepted generation before reuse.
- No new runtime files, persistent cache formats, dependencies, worker types, or fallback paths are introduced.
- Both target design documents are updated to replace their calls-only-plus-overlay description with the verified parse-once contract before this plan is retired.
