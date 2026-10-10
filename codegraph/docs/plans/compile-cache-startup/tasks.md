---
modified: 2026-10-09
dependencies: [../../design/parsing-and-resolution.md]
---

- [x] Test Engineer: Write and run focused startup probes from the approved requirements; demonstrate the missing initialization before source implementation.
- [x] Developer: Extract the existing initializer, wire listed starts, and defer affected project imports until initialization; preserve all other behavior.
- [x] Reviewer: Independently inspect the complete diff and rerun focused receipts and syntax checks.
- [x] Performance Reviewer: Verify cache status and compare cold and warm saved-snapshot results with host-load and cleanup evidence.
- [x] Documentation: Update the existing design document only after verified implementation.
