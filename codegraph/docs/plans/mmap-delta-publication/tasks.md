---
modified: 2026-09-21
dependencies:
  - plan.md
---

# Mmap Delta Publication Tasks

- [x] One production MCP benchmark lifecycle and real-repository baseline.
- [x] Sparse one-file semantic request/result with exactly one parsed and validated file.
- [x] Parent-linked staged generation delta and atomic `CURRENT` commit.
- [x] Existing mmap upgraded to the v4 base/frame format; `appendGeneration()` writes exact replacement/unlink frames without changing base or scratch bytes.
- [x] Finish `appendGeneration()` correctness: alternate-slot failure atomicity, one-frame reserved headroom, strict base/slot validation, and bounded exact latest-parent verification.
- [ ] Measure isolated append time, allocations/GC, bytes written, and cyclomatic complexity; simplify the hot path based on evidence without adding another API or binary representation.
- [ ] Add delta-first symbol/tombstone reads to the existing mapped view and measure lookup by frame count.
- [ ] Add relationship/dangling transitions to that same reader and verify delete/re-add and duplicate identities.
- [ ] Wire `tool-engine.mjs` to `stageGenerationDelta()` -> `appendGeneration()` -> `commitGeneration()` and delete the old one-file full-publication path.
- [ ] Run the real-repository MCP profile; add compaction only if this measurement supplies a break-even threshold.
- [ ] Run focused parity/coverage once and the complete suite once with zero skips.
- [ ] Update `AGENTS.md`, `README.md`, and verified design docs; retire superseded plans.
