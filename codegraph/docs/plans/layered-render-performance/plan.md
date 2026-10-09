---
modified: 2026-10-08
dependencies: [../../design/visualizer.md]
supersedes: null
---

# Layered rendering performance

## Problem

The live Layered Flow page mounts 20,327 symbol cards and 122,304 DOM elements for a graph with 31,093 edges. Pan and zoom transform the complete SVG tree, and selected-node filtering repeats adjacency scans for every symbol.

## Solution

Retain complete graph data and existing row positions while mounting only cards intersecting the viewport plus fixed world-space padding. Use existing row geometry to bound candidate traversal, and compute selected-neighbor membership once per filter update.

## APPROVED REQUIREMENTS

1. Preserve every graph symbol, edge, position, ordering, color, count, filter result and existing interaction; do not cap or discard graph data.
2. Mount only viewport-intersecting Layered Flow cards plus 216 world units of padding on each side. Use sorted row bounds and arithmetic column ranges; do not scan all graph nodes on each pan or zoom frame.
3. Preserve selected-node inspector, caller/callee navigation, all existing selected and violation edges, connected-node filter exceptions, highlighted styling, deselection and offscreen navigation. Remounted cards derive their appearance from current state.
4. Compute the selected-neighbor Set once per filter update, never once per node. Keep the unselected filter semantics unchanged.
5. Keep other views, HTTP contracts, graph building, indexing, dependencies, schema, cache formats and versions unchanged. Add no controls, fallbacks, locks, waits, request caps or framework abstractions.

## Scope

- `visualizer.mjs`: preserve `renderGraph` row geometry and complete `nodeMap`, adjacency maps and `posMap`; retain per-row y bounds and ordered nodes. Replace eager card creation with bounded viewport mounting integrated with `scheduleTransform`, `renderGraph`, `selectNode`, Layered Flow `applyFilter` and window resize. Keep the existing six-element card markup and activation handler. Scope all mounting operations to the currently rendered Layered Flow canvas; invalidate Layered-only DOM references when another view renders. Preserve existing edge creation and sidebar content.
- `test/visualizer-layered-viewport.test.mjs`: independent QA adds served-client regressions following `test/visualizer-most-called.test.mjs` client harness conventions.
- `docs/design/visualizer.md`: integrate verified mounting and selection-filter behavior after completion.
- `docs/plans/layered-render-performance/plan.md` and `tasks.md`: specification and traced checklist.

No existing symbols or imports are renamed. The new test belongs in the existing `test/` directory; the plan directory follows existing `docs/plans/<feature>/` conventions. No other file changes are planned.

## Atomic Edit Groups

1. Selected-neighbor membership: compute the Set and replace both per-node adjacency scans together, retaining filter exceptions and deselection behavior. Verify this transaction before proceeding.
2. Layered viewport mounting: row metadata, card construction, mounted-card map lifecycle, inverse-transform viewport bounds, sorted-row lookup, arithmetic column lookup, RAF updates, resize updates, filter visibility, selection highlights and cross-view guards form one transaction. Do not land a partially wired mounting lifecycle.
3. Verified design documentation and final receipt checklist form the documentation transaction after source and browser verification.

## Implementation Constraints

- Invert `transform.x`, `transform.y` and positive `transform.k` using the SVG viewport dimensions. Add 216 world units to each bound. Card intersection uses existing `NODE_WIDTH` and `NODE_HEIGHT`, including partially visible cards and boundary equality.
- Store row metadata during the existing `renderGraph` position pass. Rows remain sorted by world y; use lower-bound search to find the first candidate row and stop beyond the viewport bottom. Derive candidate columns from `PADDING_X` and `NODE_SPACING_X`, clamped to that row's real length.
- Retain `posMap` for all symbols. Navigation must find offscreen positions, update selection and animate pan; frames mount the destination as it enters the viewport without changing graph layout.
- `nodeElements` contains mounted cards only in Layered Flow. `selectNode` must not assume every selected or connected node has an element. Newly mounted cards reproduce current highlight, opacity and filter visibility from model state; absent DOM never means absent data.
- Compute filter-visible IDs from the complete model before consulting `nodeElements`; the existing absent-element early `continue` must not exclude offscreen endpoints from Violations edges. A full model pass on filter changes is allowed; a full model pass on pan/zoom frames is not.
- Avoid retaining detached cards or active-highlight DOM references. Do not build a repository-sized card cache. Reconcile the bounded mounted set against viewport candidates and remove stale entries.
- Keep row bands, headers and badges at their existing geometry. Preserve all active selection edges and the Violations filter's complete edge output; edge virtualization is outside this change.
- The shared `nodeElements` map is also used by Heat Map, Sunburst and Chord. Guard viewport reconciliation by current view and current Layered canvas ownership, including pending RAF callbacks during tab switches. Do not alter those renderers or their selection semantics.
- Preserve the existing transform scheduling and animation cancellation. Add no per-card listeners beyond existing activation, and no new persistent timer or observer.

## Target Design Docs

Update only verified Layered Flow rendering, mounting lifecycle and tests in `docs/design/visualizer.md` after independent verification. Preserve descriptions of the complete data model and other views.

## Testing Requirements

Unit tests and E2E tests exercise the served client script without changing the graph response contract.

Independent QA reviews and writes focused unit and E2E regressions before source changes in `test/visualizer-layered-viewport.test.mjs`, using the existing served-script harness convention. Cover empty graphs, partially intersecting cards, viewport boundaries, disjoint rows, horizontal offscreen columns, zoom and resize; prove candidate traversal is bounded by visible rows/columns rather than scanning all symbols per frame. Verify complete `nodeMap`/`posMap` and unchanged graph stats/order/positions while mounted DOM scales with the visible cards. Cover selected-node and selected-neighbor filter exceptions, deselection, search intersection, Most Called/Orphans/Violations, filtering before pan, highlighting after remount, offscreen caller/callee navigation and preserved selection/violation edges. Cover a pending Layered frame followed by another view and return to Layered without stale mutations or detached-card retention.

Rerun `test/visualizer-most-called.test.mjs`, `test/visualizer-complexity-selection.test.mjs`, `test/visualizer-card-layout.test.mjs`, `test/visualizer-inspector-details.test.mjs` and `test/visualizer.test.mjs`; run `node --check visualizer.mjs` and `git diff --check`. The existing `test/visualizer-e2e.test.mjs` watcher failure is reported separately if encountered, never repaired or skipped within this scope. No lint or typecheck script is declared in `package.json`.

Root or an independent verifier repeats the same real-repository page load and pan/zoom actions at `http://127.0.0.1:7331/#layered`, with the same viewport, graph generation, filter and transform. Preserve baseline profiles `/private/tmp/codegraph-layered-baseline.cpuprofile` and `/private/tmp/codegraph-layered-zoom-baseline.cpuprofile`; save corresponding post-change CPU profiles and report mounted DOM count, elapsed action time and sampled client work. Inspect actual rendered cards, filter results, selected edges, sidebar navigation, other tabs and screenshot output. Do not claim performance success from synthetic timing or DOM count alone.

Copy baseline profiles and `/private/tmp/codegraph-layered-zoom-metrics.json` into `profiles/layered-render-performance-2026-10-08/baseline/` before comparison; save post-change profiles, metrics, timings and screenshots under the sibling `after/` directory. The existing `profiles/` directory is the durable project artifact location.

## Parallel / Dependent Breakdown

1. Senior Dev confirms source scope and lifecycle constraints; independent reviewer and Test Engineer review the plan in parallel.
2. After approval, independent QA writes focused failing regressions.
3. Implementer verifies selected-neighbor membership first, then completes the full mounting transaction.
4. Independent verifier inspects the actual diff and reruns focused receipts; root performs matching real-page performance and UI checks.
5. Integrate verified documentation and report exact results, profile files and any remaining limitations.

## Success Criteria

- All 20,327 real-page symbols and 31,093 edges remain in the same graph with unchanged positions, counts, filters and navigation.
- Mounted cards match viewport intersection plus the specified padding; pan/zoom candidate work depends on visible rows and columns rather than total graph size.
- The initial real-page viewport contains fewer than 10% of the baseline 122,304 DOM elements, and matching before/after profiles establish reduced Layered client rendering/transform work and elapsed action time.
- Selected-neighbor filtering performs one adjacency traversal per update, preserving existing behavior.
- Focused tests pass without skips; actual browser verification and profile paths are reported. No unrelated source behavior or format/version changes occur.
