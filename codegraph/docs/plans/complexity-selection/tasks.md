---
modified: 2026-10-08
dependencies: [plan.md, ../../design/visualizer.md]
---

# Complexity selection tasks

- [x] Senior Dev: verify current renderer, filter repaint, navigation and exact file scope.
- [x] UI Designer: confirm marker geometry and selected, dimmed, empty and render-reset states.
- [x] Independent reviewer: verify plan against approved requirements and current source.
- [x] Test Engineer: review testing requirements and write focused failing renderer regressions.
- [x] Implementer: add the single marker and synchronize all existing selection paths in one transaction.
- [x] Independent verifier: inspect the actual delta and rerun focused receipts without skips.
- [x] UI reviewer: verify the actual browser cell marker, changed selection, zoom and filter repaint.
- [x] Technical Writer: integrate verified behavior into `docs/design/visualizer.md`.
- [x] Orchestrator: report the result and any material verification limitation.

Root and independent verifier reran 42 focused tests, all passed with zero skips. Actual source delta is 16 added lines in `visualizer.mjs`. Root browser checks on a three-cell fixture confirmed first/second selection, a single marker, identical grid hit bounds, filter persistence and zoom alignment with 2px non-scaling stroke. Screenshot: `/private/tmp/codegraph-complexity-selection-browser.png`. Separate reviewer browser surface was unavailable; its source/test review passed. Temporary tabs and local server closed; viewport reset. Inspector record-limit behavior is outside this fix.
