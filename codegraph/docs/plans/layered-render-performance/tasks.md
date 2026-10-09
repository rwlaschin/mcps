---
modified: 2026-10-08
dependencies: [plan.md, ../../design/visualizer.md]
---

# Layered rendering performance tasks

- [x] Senior Dev: confirm complete file scope, row geometry and shared-map lifecycle against `visualizer.mjs`; output reviewed plan and exact atomic groups; done when real symbols and callers are cited; validation is independent source spot-check.
- [x] Independent reviewer: review `plan.md` against the current source and baseline profiles; output resolved feasibility findings; done when all lifecycle/performance criteria are checkable; validation is scoped document validation.
- [x] Test Engineer: review Testing Requirements and write failing regressions in `test/visualizer-layered-viewport.test.mjs` after approval; input approved plan and existing client harness; output focused coverage of mounting and preserved behavior; done when failures demonstrate the missing behavior with zero skips; validation is independent test review.
- [x] Implementer: complete selected-neighbor membership atomic group in `visualizer.mjs`; input existing selection/filter state; output one adjacency traversal per filter; done when selected/neighbor exceptions and deselection retain their behavior; validation is focused QA receipts and source syntax check.
- [x] Implementer: complete viewport mounting atomic group in `visualizer.mjs`; input existing row geometry and transforms; output bounded mounted cards with complete data and stable navigation; done when all approved mounting/lifecycle tests pass; validation is focused tests, source syntax and diff check.
- [x] Independent verifier: inspect actual source diff against every approved requirement and rerun tests; input implementation delta and runnable receipts; output independent result; done when every scoped receipt passes without skips and no unapproved additions exist; validation includes existing visualizer regressions.
- [x] UI reviewer: repeat matching real-page actions and profiles; input baseline files and actual URL7331; output after profiles, timings, DOM counts and screenshots; done when reduced real-page work and preserved UI/navigation are demonstrated; validation is browser inspection.
- [x] Technical Writer: integrate verified rendering behavior into `docs/design/visualizer.md`; input independent results; output current-state documentation; done when descriptions match source and receipts; validation is scoped docs validation.
- [x] Orchestrator: report measured outcome and profile paths; input complete independent receipts; output concise result with unresolved limitations; done when owned temporary processes and tabs are cleaned up.

Verification: root reran 109 focused tests with zero failures or skips. Independent review passed the five approved requirements; the final two-line RAF ordering delta remains pending independent confirmation. Root inspected the complete real graph with unchanged symbol, edge and row counts, viewport mounting, a 300px pan, selected offscreen navigation and filter/deselection behavior. Cross-view return was inspected without waiting for complete Complexity population; automated coverage verifies that lifecycle. Latest measured layout work is 4.026ms versus baseline 342.441ms; instrumented browser task time is 102.298ms versus baseline 1,126.569ms. No complete page-load or frame-rate result is established. Artifacts remain in profiles/layered-render-performance-2026-10-08/.

Final receipt: independent final review and root both ran 109 tests with zero failures or skips. Final RAF trace records 0.212 ms in the transform callback versus 12.929 ms before ordering correction. Browser viewport override and profiling were stopped; the current user-facing tab and the updated visualizer on port 7331 remain available intentionally.
