---
modified: 2026-10-08
dependencies: [../../design/visualizer.md]
supersedes: null
---

# Most Called in every view

## Problem

Most Called uses different ranking rules in the aggregate views. Call Tree and Complexity fall through the Layered Flow filter branch and do not filter their rendered items.

## Solution

Use Layered Flow's existing ranking for every view. Mark functions directly and aggregate containers when any contained function matches; dim summary items in place and reapply filters after rendering.

## APPROVED REQUIREMENTS

1. Preserve Layered Flow's eligible symbol universe and distinct source/target pair counting across every accepted existing edge, irrespective of `edge.call`. Sort positive incoming degrees descending; select the threshold at `floor(positiveCount * 0.1)` and include positive degrees at or above it, including ties.
2. Support all six views. Map ranked symbol IDs to functions directly and to files, modules, directories, root and collapsed Sunburst groups when any contained function matches.
3. Dim nonmatching Call Tree and Complexity items in place. Preserve geometry, hit-test indices, All restoration, search intersection, selection, empty states and loading behavior.
4. Reapply the current filter after data loads, reloads and view switches.
5. Production edits are confined to `visualizer.mjs` and `visualizer-graph.mjs`. Preserve prior edits, engines, indexing, dependencies, schemas and versions. Keep Complexity's `metricsOnly: true` summaries. Obtain ranking graph data through existing `graphForRequest` and `cachedRawGraph`; a cold summary request additionally loads the graph, while warm requests reuse it.
6. Reuse the existing ranking primitive or extract a small helper. Do not build Layered Flow layout solely to obtain ranking, query on filter clicks, or scan all graph symbols for each rendered item.

## Scope

- `visualizer-graph.mjs`: extract shared ranking from `buildLayeredGraph`; replace only `isMostCalled` heuristics in `buildHeatmapData`, `buildSunburstData` and `buildChordData`. Add ranking flags to `buildCallTreeData` and `buildComplexityData` through `options.mostCalledIds`, a Set of ranked symbol IDs. Preserve density colors and geometry.
- `visualizer.mjs`: import and use the shared ranking for `/calltree` and `/complexity` through `graphForRequest`; pass `mostCalledIds` to both builders; add summary filter branches to `applyFilter`; update summary render/load hooks to reapply state. For batched Complexity paths, partition matching and dimmed cells without changing coordinates or summary-array order. In Chord's Most Called filter path, use keyed module lookup instead of repeated per-ribbon module scans.
- `test/visualizer-most-called.test.mjs`: independent QA writes new focused Node unit, route and actual client-renderer/filter regression tests before source changes, following `test/visualizer.test.mjs`, `test/visualizer-e2e.test.mjs` and `test/visualizer-card-layout.test.mjs` conventions.
- `test/visualizer-e2e.test.mjs`: independent QA updates the existing Complexity exact-query expectation to include the cached raw graph ranking request while preserving the metrics-only summary assertion.
- `docs/design/visualizer.md`: after verification, replace inconsistent ranking descriptions, document summary graph-cache cost, all-six-view filtering and focused test coverage.
- `docs/plans/most-called-filter/plan.md` and `tasks.md`: planning and dependency checklist only.

No renames, new dependencies or new production files. Existing `docs/plans/` and `test/` directories are confirmed.

## Confirmed Built / Open

- Built: `buildLayeredGraph` filters eligible symbols and deduplicates incoming edges (`visualizer-graph.mjs:250–290`); positive-degree threshold and flags exist at `:337–358`.
- Built: `graphForRequest` reuses `cachedRawGraph` through `fetchRawGraph` (`visualizer.mjs:2679–2716`). Complexity uses metrics-only summaries (`:2902`).
- Open: Heat Map uses heat/top-15% flags (`visualizer-graph.mjs:522`); Sunburst uses unconditional root/call-count flags (`:867`, `:910`, `:951`, `:987`, `:1017`); Chord uses average flow (`:1108`). Replace these flags only.
- Open: `applyFilter` has Sunburst, Chord, Heat Map and Layered branches (`visualizer.mjs:2478–2607`), but no summary branch. `renderSummaryCards` and `renderComplexity` do not reapply filters (`:1195–1264`).

## Atomic Edit Groups

1. Extract shared ranking and replace all builder usages together in `visualizer-graph.mjs`; retain Layered output parity. Verify builder/ranking tests before proceeding.
2. Add summary ranking imports, both route usages, summary client branches and render hooks together in `visualizer.mjs`, with any corresponding options consumers in `visualizer-graph.mjs`. Verify route and renderer tests before proceeding.
3. Update the authoritative design document only after implementation and independent verification.

## Use Cases

### 1. Highlight busiest functions in any view

**Goal:** Use one Most Called ranking across all views.

**Stakeholders:** Developers inspecting call traffic.

**Actors:** Developer, visualizer server and browser.

**Preconditions:** An indexed root is available and a view loads successfully.

**Postconditions:** Functions selected by the Layered ranking remain emphasized directly or through their containing aggregates.

**Basic Course of Events:**
1. The developer selects the existing `data-filter="most-called"` control; its handler sets `currentFilter` and calls `applyFilter` in `visualizer.mjs`.
2. `applyFilter` reads `isMostCalled` flags from the active view data and updates visibility or opacity without a network request.
3. The developer changes tabs; `switchView` loads or reuses view data and its renderer reapplies the filter.
4. `/calltree` and `/complexity` retain their summary queries and obtain raw ranking data through `graphForRequest`; builder options mark returned functions by symbol ID.

**Alternate Flows:**
- Search intersects the active filter; All restores normal rendering.
- Include Tests recomputes ranking over the same eligible universe as Layered Flow with that option enabled.
- Existing selections and summary hit-test indices survive filter changes.

**Exceptions:**
- No eligible positive incoming degrees: no function is Most Called; aggregate flags are false.
- A summary function has no eligible graph symbol: its flag is false.
- A summary or graph fetch fails: retain the existing error/loading behavior; do not silently substitute a different ranking.

## Testing Requirements

Independent QA writes unit tests and integration tests in `test/visualizer-most-called.test.mjs` before implementation, and updates the existing exact-query expectation in `test/visualizer-e2e.test.mjs`. Unit cases cover duplicate edges, unknown/filtered endpoints, zero incoming calls, threshold ties, Include Tests, function IDs, aggregate ancestor/group membership and unchanged Layered output. Route cases cover both summary routes, preserved `metricsOnly: true`, cold graph loading, warm shared-cache reuse and error propagation. Client cases execute served renderer/filter code for all six views, filter/search intersection, All restoration, loaded and cached switches, reloads, preserved summary geometry/order, batched Complexity dimming and selection/hit testing.

Run `node --check visualizer.mjs`, `node --check visualizer-graph.mjs`, `git diff --check` and `node --test test/visualizer-most-called.test.mjs test/visualizer.test.mjs test/visualizer-e2e.test.mjs test/visualizer-card-layout.test.mjs test/internal-graph.test.mjs`. No TypeScript typecheck applies to these JavaScript files. Independently inspect actual browser behavior across all six tabs, including a cold summary landing, filter retained across tab changes, search, All reset and summary selection. Report unavailable browser execution explicitly.

## Parallel / Dependent Breakdown

1. Plan and independent QA review run before source edits.
2. Independent QA writes tests and establishes failures; implementation waits for that receipt.
3. Source groups execute sequentially with verification between groups.
4. Independent diff review and rerun precede browser review and documentation integration.

## Success Criteria

All six views agree with Layered ranking. Summary filtering changes emphasis without changing positions, data order or selection targets. Existing tests and focused new tests pass without skips. No filter click triggers a query or full Layered layout. Only the two named production files change for this feature; independent review and browser receipts establish completion.

## Target Design Docs

Update `docs/design/visualizer.md` Feature Overview, Architecture, Functions, Models, Use Cases and Tests with verified all-six-view ranking and summary filtering. No mockup is required because controls and layout remain unchanged.
