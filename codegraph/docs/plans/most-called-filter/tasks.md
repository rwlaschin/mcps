---
modified: 2026-10-08
dependencies: [plan.md, ../../design/visualizer.md]
---

# Most Called tasks

- [x] Senior Dev: confirm current ranking, filter branches, cache path and exact file scope.
- [x] Independent reviewer: verify plan and immutable approved checklist.
- [x] Test Engineer: review testing requirements and write focused failing tests before implementation.
- [x] Implementer: extract and reuse ranking without changing Layered semantics; run builder checks.
- [x] Implementer: wire summary routes, client filters and render hooks; run route/client checks.
- [x] Independent verifier: inspect actual feature diff against every approved requirement and rerun receipts.
- [ ] UI reviewer: verify actual browser filtering, switching, search, All reset and selection in all six views.
- [x] Technical Writer: integrate verified behavior into `docs/design/visualizer.md`.
- [x] Orchestrator: report completion and any material verification limitation.

Root rerun: 154/155 tests passed, zero skips or cancellations. The existing SSE file-watcher test at `test/visualizer-e2e.test.mjs:297` failed before and after this change. `--test-force-exit` was used for the broad run because that pre-existing subscription fixture retains handles. Focused independent checks passed without forced exit. Root browser checks on a three-function fixture passed all six views, retained filters, search, All restoration, keyboard card focus and dimmed Complexity selection. Screenshot: `/private/tmp/codegraph-most-called-browser.png`. The separate UI reviewer had no browser surface available, so its independent browser pass remains blocked. Temporary server and browser tab were closed; viewport reset.
