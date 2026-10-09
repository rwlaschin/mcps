---
modified: 2026-10-08
dependencies: [../../design/visualizer.md]
supersedes: null
---

# Complexity selection marker

## Problem

Selecting a Complexity cell updates the inspector but does not highlight the selected cell.

## Solution

Draw one accent-stroked SVG rectangle over the existing pinned cell. Synchronize it through the existing selection entry point and preserve the batched color paths.

## APPROVED REQUIREMENTS

1. Highlight the exact selected, pinned Complexity cell with a single accent-stroked SVG rectangle with pointer events disabled.
2. Preserve coordinates, batched paths, hit indices, filter/search/zoom behavior, existing keyboard activation and history.
3. Clear the old marker on view render and synchronize every existing pinned-selection path: click, Enter/Space and called-function navigation, including Back.
4. Confine production changes to `visualizer.mjs`; preserve all prior fixes. Make no backend, limit, ranking, dependency or version changes and create no per-cell nodes.

## Scope

- `visualizer.mjs`: update `selectSummaryItem` and `renderComplexity` as one atomic selection transaction. Reuse one unfilled overlay rectangle as a canvas child, sibling of the grid group, with accent-colored 2px non-scaling stroke and disabled pointer events. Use the selected item's existing `x`, `y`, `width` and `height`; preserve the hit-test group's bounds. Keep existing pinned selection as the single selection state. Reuse the pinned index when its item is already the selected object; only sidebar navigation may resolve another item with `indexOf`, with no new per-cell lookup allocation. Hide the marker for a target absent from the current grid. Keep the sibling marker visible through `applyFilter` path replacement, dimming and detail-request failures. Reset the overlay when the canvas is rendered anew. Preserve existing grid focus styling. No imports or symbols are renamed.
- `test/visualizer-complexity-selection.test.mjs`: independent QA owns focused renderer regressions following `test/visualizer-most-called.test.mjs` conventions.
- `docs/design/visualizer.md`: document verified selection behavior and focused tests after implementation.
- `docs/plans/complexity-selection/plan.md` and `tasks.md`: plan and execution checklist only.

## Target Design Docs

Update the Complexity interaction description in `docs/design/visualizer.md` after source and browser verification. Preserve unrelated subsystem descriptions.

## Testing Requirements

Independent QA writes integration tests in `test/visualizer-complexity-selection.test.mjs` before implementation. Execute the real served client script using the existing Node/DOM convention. Cover exact selected-cell geometry; replacing the previous marker; click, Enter and Space; called-target and Back navigation; missing-target marker hiding; filter/search repaint retaining selection; selection of dimmed cells; persistence during detail loading/failure; render reset and empty data; pointer events disabled; and a constant single marker without per-cell DOM nodes. Verify the overlay does not change grid bounds or existing path/hit-index geometry. Rerun existing Most Called and card-layout regressions, `node --check visualizer.mjs` and `git diff --check`. Independently inspect the actual running Complexity view in the browser at normal and zoomed scales, including a second selection and a filter repaint. Report any browser verification blocker explicitly.

## Parallel / Dependent Breakdown

1. Senior Dev and UI Designer confirm the exact marker placement, states and source transaction.
2. Independent reviewers verify this plan and its testing requirements; QA writes the failing regression tests.
3. One source implementer completes the atomic selection transaction after tests are ready.
4. An independent verifier inspects the actual source delta and reruns receipts; the orchestrator verifies real browser selection and integrates the verified documentation.

## Success Criteria

- Exactly one visible accent outline identifies the selected Complexity cell; selecting another moves it.
- Click, Enter/Space, called-function navigation and Back agree with the selected inspector item.
- Filter/search repaint preserves selection and a visible marker even on a dimmed cell.
- View rendering clears obsolete markers; empty views have no marker.
- Geometry, hit indices and batched color paths remain unchanged; one marker adds constant DOM overhead.
- Focused tests pass without skips and real browser verification is reported accurately.
