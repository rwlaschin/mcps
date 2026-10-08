---
modified: 2026-09-21
dependencies:
  - plan.md
---

# Performance Cache Integrity Tasks

- [x] Capture real-repository pre-fix cold and warm baselines as host jobs without an arbitrary timeout.
- [x] Add named, separate-process mmap, semantic, and provisional profiling phases with CPU, heap, trace, diagnostic-log, and deterministic work receipts.
- [x] Replace decoded/locale mmap traversal with page-byte comparison; add zero-decode and comparator-symmetry tests; independently review the stage.
- [x] Make one changed, added, or deleted file the entire incremental semantic work set; patch exact edges and dangling references from cached facts; reject malformed receipts.
- [x] Remove reverse-closure and export-surface-fingerprint work from the single-file hot path.
- [x] Publish current generations with complete partitions and keep calls-only overlays only for legacy-generation compatibility.
- [x] Retain and patch per-file provisional indexes; reject stale staged commits; keep copy-on-write overlays flat.
- [x] Use the parser worker pool for cold/multi-file batches and exactly one job for a one-file edit; give profiled workers unique CPU/heap artifacts and a process-wide trace.
- [x] Capture post-fix real-repository semantic receipts: cold index 44,209.01 ms; cold changed surface 6,038.29 ms with 1/1 `src/types/index.ts`; warm changed surface 5,785.94 ms with 1/1 `src/types/index.ts`.
- [x] Add the CodeGraph-scoped performance/cache contract and deterministic boundary test.
- [ ] Run final focused coverage, the full suite once, and the final independent scope/DRY/design/effectiveness review.
