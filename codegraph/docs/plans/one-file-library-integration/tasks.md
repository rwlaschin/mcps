---
modified: 2026-10-07
dependencies:
  - plan.md
---

# One-file library integration tasks

- [x] Test Engineer: Write focused complete-output and retained-worker integration tests specified in plan.md.
- [x] Senior Dev: Extract the existing one-file options reader and verify unchanged factory output.
- [x] Senior Dev: Expose library context/timing and wire the retained change/add branch with one latest session; enable completed-analysis reuse with unchanged relevant cached dependencies and preserve existing lifecycle.
- [x] Independent Reviewer: Inspect the actual diff, rerun focused receipts, and record real cold/warm worker measurements (18 focused tests; 8 real Plot.tsx outputs match byte-for-byte; eligible warm median 22 ms versus 562 ms baseline, including transport).
- [x] Independent Reviewer: Measure application cold indexing and ordinary one-file update latency separately.
- [x] Independent Reviewer: Attempt full-suite verification and independently compare the engine.test.mjs:959 parser-pool mock stall against the baseline.
- [ ] Independent Reviewer: Obtain a passing full-suite receipt after the existing parser-pool mock stall is resolved.
- [x] Technical Writer: Update parsing-and-resolution.md after verified focused implementation.
- [ ] Technical Writer: Integrate the completed plan after remaining verification.
