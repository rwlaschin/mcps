# CodeGraph performance contract

Scope: this file applies only to the CodeGraph directory.
This local contract supplements the parent verified-orchestration contract.

## mmap / SSPL traversal

No decode, deserialization, or locale comparator in the traversal hot path.
Writer and reader comparators must be symmetric and locale-independent.
Use the existing SSPL and Maps/Sets as keyed lookup structures.
The existing custom three-legged SharedArray search is allowed.

## Changed-file-only invalidation

Never compute an export-surface fingerprint or reverse dependency closure for a single-file edit.
Never skip dependent work only after already paying its cost.
Current generations store complete partitions so a single-file update can patch exact edge and dangling-reference records from cached facts.

## Incremental cache integrity

No whole-workspace cache key guaranteed to miss on mutation.
Never clone or reparse every source for one staged edit.
Retain and patch indexes and cached facts.
One changed or deleted file never reads, parses, scans, resolves, or validates dependent source files.
Consult cached facts, patch exact edge/status records, and report dangling references.
No unbounded copy-on-write overlay ancestry.
Reject stale staged commits.
A one-file update makes one pass over the relevant changed data: no sorting, resorting, full-document or repository scan, or index rebuild for the edit.

## Hot-path memory

Avoid extra allocations and repository-sized temporary memory. Reuse bounded, preallocated scratch storage.
Do not use allocating `slice`, `splice`, `filter`, `map`, or `Array.from` in hot paths.

## Parser workers

Never bypass the worker pool.
Cold and legitimate multi-file batches parallelize with CPU-1 by default or exactly 3 configured workers.
A one-file edit dispatches exactly one parser job.
Profiled worker CPU and heap destinations are unique; trace output is process-wide.
Profiled parser requests have no timeout.

## DRY indexes and derivations

Do not duplicate reverse indexes, resolver matchers, or profiler artifact derivation.

## Truthful cache receipts

Never report cache reuse when upstream work was recomputed.
On incremental paths, every applicable retained cache and index must be used; none may be ignored or rebuilt.

## Deterministic CI gates

Use deterministic counters and invariants; never gate CI on wall-clock thresholds.
All valid existing tests must pass. Performance changes do not require new tests by default.
If a test breaks, review whether its assertion is valid before modifying it.
Use timers appropriate to the measured operation in benchmarks.

## File versions

Every file-version change requires the user's explicit approval each time.
Every approved version change must migrate and preserve existing cache data; rejecting the old version and rebuilding after a cache miss is not migration.

## Performance profiling process

Use an external script against a real repository and real code path.
Measure cold and warm separately.
Capture a baseline before each fix and a post-fix profile of the exact same problem.
Use standard V8 CPU, heap, and trace profiles.
Run profiles outside the sandbox with host process access.
Allow runs longer than 60 seconds and impose no arbitrary profile cap.
Inspect hot paths, allocations, and garbage collection.
Obtain independent scope, design, and effectiveness review after every stage.
Run focused tests during slices and the full suite once at the end.
