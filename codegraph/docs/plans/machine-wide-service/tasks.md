---
modified: 2026-10-08
dependencies:
  - plan.md
---

# Machine-wide service tasks

- [ ] Test Engineer: Write focused service contract tests. Input: approved plan and existing daemon/runtime test conventions. Output: runnable failure receipts. Files: daemon/runtime and new machine-service tests, one QA-owned atomic group. Done when: resource, output, cancellation and eviction assertions exercise actual flows. Validation: test-guard and baseline failure classification.
- [ ] Backend Developer: Implement shared transport and runtime ownership. Input: approved requirements and QA tests. Output: existing MCP/CLI entry points use one service with total worker caps and retention cleanup. Files: query-daemon.mjs, mcp-server.mjs, mcp.mjs, tool.mjs, mcp-runtime.mjs, semantic-checker-worker.mjs; dependent atomic group. Done when: singleton races, output parity, scheduling, cleanup and budgets one/two/three pass. Validation: focused receipts, syntax, diff check and independent code-guard.
- [ ] Backend Developer: Route visualizer subscriptions through the service. Input: working authenticated service. Output: shared watcher ownership and preserved SSE events. Files: query-daemon.mjs, query-client.mjs, visualizer.mjs; dependent subscription atomic group. Done when: multiple visualizers/clients add no duplicate root watcher. Validation: focused actual subscription and visualizer receipts.
- [ ] Performance Engineer: Adapt and run service profiles. Input: verified shared service and frozen real repositories. Output: paired timing, resource and CPU/heap/trace artifacts. Files: scripts/codegraph.performance.mjs and repository profile directory; dependent profiling group. Done when: ten clients/six roots remain within resource limits and all owned profiling resources close. Validation: independent artifact inspection and receipt rerun.
- [ ] Technical Writer: Update verified design documents. Input: final actual implementation and measurements. Output: current ownership, transport and worker/retention contracts. Files: docs/design/mcp-and-cli.md, storage-and-query.md, parsing-and-resolution.md; documentation atomic group. Done when: statements match code and measured limits. Validation: scoped structural validator and independent review.
- [ ] Test Engineer: Complete final verification. Input: final diff and all runnable receipts. Output: independent scope/parity/resource results. Files: no production edits. Done when: focused tests pass without skips, full suite has run once, unrelated failures are classified and actual diff meets every approved requirement. Validation: test-guard, independent code-guard, final resource inventory.
