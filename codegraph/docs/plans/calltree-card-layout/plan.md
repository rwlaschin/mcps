---
modified: 2026-10-08
dependencies: [../../design/visualizer.md]
supersedes: null
---

# Call Tree card layout

## Problem

Call Tree labels overflow their cards. Native SVG group focus outlines include the overflowing label bounds.

## Solution

Clip the two text rows to the existing content width and draw visible keyboard focus on the existing card rectangle.

## APPROVED REQUIREMENTS

1. Preserve existing 200×48 card geometry, positions, 40px gaps and edge paths.
2. Contain both SVG text rows within the existing 180px content width. Preserve current character truncation, full tooltip text, accessible labels and sidebar details; introduce no per-card text-measurement loops.
3. Suppress native summary-group outlines and indicate keyboard focus with an accent-colored stroke on its existing rectangle. Preserve click, Enter and Space activation.
4. Confine source edits to `visualizer.mjs`. Preserve prior changes, other views, empty/loading/error behavior and backend/indexing behavior.

## Target Design Docs

Update the Call Tree card sizing, label containment, focus and test details in `docs/design/visualizer.md` after verification. The state mockup is `docs/mockups/calltree-card-layout.html`.

## Testing Requirements

An independent test engineer writes integration tests using existing Node/DOM conventions before implementation. Execute the actual card renderer with long/wide labels; assert bounded text viewport and rectangle geometry, complete tooltip/accessible labels and existing click/keyboard selection. Check summary focus styling is scoped to cards, retains a visible accent indicator and does not affect other graph views. Independently inspect the rendered result in a browser; report any browser verification blocker explicitly.

## Parallel / Dependent Breakdown

1. Senior Dev and UI Designer inspect source and establish the narrow card/focus contract.
2. Independent QA writes renderer regressions.
3. One source worker implements the literal checklist.
4. The orchestrator reviews the exact delta, reruns checks and inspects rendered cards and focus.

## Success Criteria

- Both visible text rows stay inside each card.
- Keyboard focus follows the existing rectangle rather than overflowing text bounds.
- Card and path coordinates remain unchanged; full details and activation remain available.
- Focused regression checks pass with zero skips and actual rendered verification is reported accurately.
