---
modified: 2026-09-21
dependencies:
  - ../../design/parsing-and-resolution.md
  - ../../design/storage-and-query.md
  - ../../design/mcp-and-cli.md
supersedes: null
---

# Performance Cache Integrity

## Problem

Mapped lookup decoded page strings in its binary-search loop. Incremental semantic validation and provisional resolution also rebuilt or revisited repository-wide state after a one-file edit despite already-persisted partitions and indexes.

## Implemented design

- Mapped indexes compare UTF-8 bytes directly in the SSPL page. Lookup performs no string decoding or locale comparison before result materialization.
- One changed, added, or deleted source file is the complete incremental work set. CodeGraph reads, parses, resolves, and validates only that file. It consults retained partitions and indexes to patch exact edge/status records and expose dangling references; it never opens dependent source files.
- Current generations store `complete` partitions. Complete queries use those partitions directly instead of lazily reparsing stale files. Compatibility overlay support remains only for older calls-only generations.
- There is no export-surface fingerprint and no reverse-dependency closure on the one-file path. Multi-file and cold builds remain full batches.
- Provisional resolution retains per-file graph, reference, and dependency indexes and patches the changed file transactionally. Stale staged commits are rejected and copy-on-write overlays remain flat.
- Cold and legitimate multi-file batches use the parser worker pool (`CPU-1` by default, or exactly three configured workers). A one-file edit dispatches exactly one parser job.
- `scripts/codegraph.performance.mjs` is an external measurement harness, not an application dependency.

## Verification contract

- CI gates exact work counters and semantic output, never elapsed time or heap-size thresholds.
- Mmap tests cover zero-decode traversal, duplicate keys, shared prefixes, absent keys, Unicode byte ordering, and writer/reader comparator symmetry.
- Engine tests assert that change, add, and unlink operations touch exactly one file, preserve unchanged partitions, patch dangling references, reject malformed worker receipts, and match clean graph semantics.
- Resolver tests assert exact `{resolvedFiles, reusedFiles, fullRebuild}` receipts, transactional stale-commit rejection, flat copy-on-write state, and real worker use.
- Run focused tests during each slice, then the complete suite and coverage checks once at the end. Preserve unrelated work.

## Profiling process

Run the production MCP path against a real repository in a host process with standard V8 CPU, heap, and trace profiles. Do not run profiles in the sandbox and do not impose an arbitrary timeout. Capture the same named phase before and after its fix.

Cold and warm are separate processes and separate receipts:

- **Cold** removes index/mmap state, starts a fresh MCP process, performs the initial index, then measures the first named operation.
- **Warm** starts a separate MCP process with an existing index and established caches, then measures only the named operation.

Never average or combine cold and warm. Every receipt records the phase, temperature, mutation, exact expected and observed work sets, artifact paths, and artifact parse status. Profiles diagnose hot frames, allocation, and garbage collection; deterministic counters remain the correctness gate.

## Verified changed-surface receipts

Real repository: `/Users/mac/Documents/Projects/dnd-community-and-marketplace` (877 source files at measurement time).

| Receipt | Elapsed | Parsed | Validated | File |
| --- | ---: | ---: | ---: | --- |
| Cold initial index | 44,209.01 ms | 877 | 877 | full repository |
| Cold changed surface | 6,038.29 ms | 1 | 1 | `src/types/index.ts` |
| Warm changed surface | 5,785.94 ms | 1 | 1 | `src/types/index.ts` |

Historical pre-fix changed-surface measurements were 17,367 ms cold and 15,020 ms warm with 1 parsed file but 395 validated files. They are comparison baselines only; they do not describe current behavior.

## Completion gates

- Every single-file mutation has an exact one-file read/parse/resolve/validate receipt, including deletion (zero parse, one tombstone).
- Cached facts patch exact edges and dangling-reference status without dependent source access.
- Current generations publish complete partitions; legacy calls-only generations remain readable.
- Mmap traversal remains zero-decode and comparator-symmetric.
- Each runtime stage receives independent scope, design, and optimization-effectiveness review.
- `codegraph/AGENTS.md` and its boundary test preserve these constraints.
