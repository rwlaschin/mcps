---
modified: 2026-08-31
---

# Lazy Semantic Parser Import Tasks

- [ ] Test Engineer: Add failing main-import-boundary and fallback parity tests in `test/engine.test.mjs`.
- [ ] Full-stack Engineer: Make `semantic-checker-worker.mjs` import semantic parsing only in its worker isolate without changing its public interface.
- [ ] Full-stack Engineer: Make `tool-engine.mjs` use local SHA-256 and dynamically import semantic parsing only in non-retained and cold/historical fallback branches.
- [ ] Reviewer: Run focused and full correctness/performance checks and capture fresh main/worker CPU, heap, and trace artifacts.
- [ ] Technical Writer: Update verified design/performance documentation and retire this completed plan.
