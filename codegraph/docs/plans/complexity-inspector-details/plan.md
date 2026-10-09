---
modified: 2026-10-08
dependencies: [../../design/visualizer.md]
supersedes: null
---

# Focused Complexity inspector details

## Problem

The selected-function inspector requests a combined internal map capped at 2,000 records. Large functions exceed the cap before their details can be displayed.

## Solution

Return one compact selected-owner details record from existing node and call-relation iterators. Consume that record in the existing inspector without constructing its full syntax/CFG response.

## APPROVED REQUIREMENTS

1. The single-owner inspector must work for functions with more than 2,000 syntax/CFG records, preserving exact metrics, loop count, call count and unique called-target navigation IDs.
2. Query existing owner-filtered nodes for loop flags and relations for calls only; do not call the CFG-edge iterator, materialize full node/edge/relation arrays, or raise the 2,000-record limit. Return one compact selected-owner summary. Preserve existing partition validation and iterator implementation; do not claim zero CFG decoding or owner-only CPU work.
3. Preserve generation selection, errors, cancellation, Back navigation and the selected-cell marker.
4. Make no other behavior, indexing, dependency, schema, version or cache-format changes. Introduce no abstractions, fallbacks, request caps or locks.

## Scope

- `daemon-query-engine.mjs`: add the `details` operation in `DaemonQueryEngine.#pinInternal` before `collect` and `internalRows` materialize record arrays. Require the existing owner selector to resolve exactly one owner. Stream `view.nodes(owner.id)`, incrementing `forLoops` for `flags & 1`; stream `view.relations(owner.id)`, counting each `kind === 'call'` occurrence and collecting unique `targetSymbolId` values in first-occurrence order. Check the existing cancellation signal while iterating. Return existing metadata plus one details row. Preserve the legacy `map`, `metrics`, `search` and `paths` branches and their limits. In the optional acquired-cache branch, reject a missing `details` method explicitly instead of silently returning an empty array for this new operation; preserve release in `finally` and existing-operation behavior. Production `MmapQueryCache` currently has no `acquireInternal` implementation; verify the direct partition path rather than claiming a mapped details path exists.
- `visualizer.mjs`: change the existing `GET /internals` query from `map` to `details`, keeping file/owner validation, generation, `limit: 2000` and the `{ generation, records }` envelope. Update `selectSummaryItem` to consume `forLoops`, `functionCalls` and `targetSymbolIds` from the compact record, preserving existing item metrics, unique target links, unavailable-target labels, history and request-version handling. Remove the unused full-node array from this inspector only. Preserve the selection-marker synchronization.
- `test/visualizer-inspector-details.test.mjs`: independent QA adds real-partition operation and inspector regressions using existing daemon-query and served-script test conventions.
- `test/visualizer-e2e.test.mjs`: independent QA updates the focused route/client expectations and adds inspector-response checks; preserve valid unrelated tests.
- `docs/design/visualizer.md`: integrate verified compact-details behavior after implementation.
- `docs/plans/complexity-inspector-details/plan.md` and `tasks.md`: plan and execution checklist only.

## Contract

The existing endpoint queries `{ type: 'internals', operation: 'details', file, owner: { id: Number(ownerId) }, generation, limit: 2000 }`. Its response remains `{ generation, records }`, with exactly one record shaped `{ record: 'details', ownerId, forLoops, functionCalls, targetSymbolIds }`. `functionCalls` counts all call occurrences; `targetSymbolIds` contains unique IDs in first-occurrence order. Metrics remain those already present on the selected item. No imports or symbols are renamed.

## Atomic Edit Groups

1. Engine operation dispatch and compact record production form one transaction, validated with real-partition tests before endpoint wiring.
2. Endpoint operation plus all inspector record consumers form one transaction, validated with route/client tests before browser review.

## Target Design Docs

Update the inspector detail query, large-function support and test references in `docs/design/visualizer.md` after verification. Keep existing partition validation and full-map contracts accurately described.

## Testing Requirements

Independent QA writes unit/integration tests before implementation in `test/visualizer-inspector-details.test.mjs`, following `test/daemon-query-engine.test.mjs` and `test/visualizer-e2e.test.mjs` conventions. Construct a real internal partition with more than 2,000 selected-owner nodes/CFG records; verify exact loop counts, all call occurrences, first-occurrence unique target IDs and isolation from other owners. Verify historical generation pinning, default generation, missing file/owner errors, pre-aborted and mid-iteration cancellation, optional cache details dispatch/release and explicit unsupported-operation errors. Confirm existing full-map limits remain in force. Route tests assert the exact `details` request and unchanged validation/envelope; update the existing focused E2E request expectation together with route wiring. Client tests assert full metrics/counts/navigation, duplicate calls, no calls, unavailable targets, loading/error handling, stale-response rejection, Back navigation and preserved selection marker. Rerun `test/visualizer-complexity-selection.test.mjs`, source syntax checks and `git diff --check`. Independently inspect an actual large selected function in the browser, including called-target/Back navigation and the marker. Report browser blockers and unrelated test failures explicitly.

## Parallel / Dependent Breakdown

1. Architect and Senior Dev confirm the compact contract and exact source groups.
2. Independent reviewer verifies the plan; Test Engineer reviews coverage and writes failing tests.
3. Implementer completes and verifies the engine group, then endpoint/client group.
4. Independent verifier reviews the actual delta and reruns receipts; orchestrator verifies the running inspector and integrates documentation.

## Success Criteria

- A function exceeding 2,000 internal records displays inspector details without increasing limits.
- Counts and unique target navigation agree with the existing indexed data.
- The details query returns one record and does not materialize full record arrays or call `view.edges()`.
- Generation/error/cancellation behavior and selection history/marker remain intact.
- Existing map limits and unrelated behavior remain unchanged; focused tests pass without skips and browser verification is reported accurately.
