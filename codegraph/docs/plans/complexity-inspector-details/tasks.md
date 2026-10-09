---
modified: 2026-10-08
dependencies: [plan.md, ../../design/visualizer.md]
---

# Focused inspector details tasks

- [x] Architect: define the compact details request and response contract.
- [x] Senior Dev: verify current operation dispatch, production cache coverage and exact source groups.
- [x] Independent reviewer: verify plan and immutable approved requirements.
- [x] Test Engineer: review testing requirements and write focused failing regressions.
- [x] Implementer: add and verify the early details operation.
- [x] Implementer: wire the endpoint and all inspector consumers together.
- [x] Independent verifier: inspect actual diff and rerun focused receipts without skips.
- [x] UI reviewer: inspect large-function details, target/Back navigation and selection marker in the running browser.
- [x] Technical Writer: integrate verified behavior into `docs/design/visualizer.md`.
- [x] Orchestrator: report the result and material verification limitations.

Verification: root reran 60 focused tests with zero failures or skips. The real indexed Plot owner returned 44 calls and 31 unique targets, exactly matching independent partition iteration. Browser verification used a one-owner summary view with the real details engine; metrics, counts and marker rendered without the prior limit error. Target/Back navigation was verified by automated client tests, not this one-owner browser view. Temporary server and tab were closed.
