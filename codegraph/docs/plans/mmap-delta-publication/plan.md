---
modified: 2026-09-21
dependencies:
  - ../../design/storage-and-query.md
  - ../../design/parsing-and-resolution.md
  - ../../design/mcp-and-cli.md
supersedes:
  - performance-cache-integrity
  - warm-update-under-100ms
---

# Mmap Delta Publication

## Problem

One-file updates allocate repository-wide JavaScript state, rewrite a complete mmap page, and serialize complete generation maps.

## Solution

Keep the existing mmap cache and base `publish()` path. Use the already-implemented `appendGeneration()` only for one-file deltas, make mapped queries read those deltas, connect the engine, measure the real path, and add compaction only if measurement proves it is needed.

## Target Design Docs

- `docs/design/storage-and-query.md`
- `docs/design/parsing-and-resolution.md`
- `docs/design/mcp-and-cli.md`

Update these documents only after runtime and performance receipts verify the implemented base/delta layout, publication ordering, query behavior, single MCP measurement path, and any compaction rule that measurement actually requires.

## Binary and Transaction Contract

- Bump `CACHE_SCHEMA_VERSION` to 4. Export every magic, size, offset, flag, state code, and row width below from `query-cache-schema.mjs` and use those exports in writer, reader, and tests. Use `FILE_MAGIC = 0x43474d4d`, `BASE_MAGIC = 0x43515047`, `SLOT_MAGIC = 0x43475334`, `SLOT_COMMIT_MAGIC = 0x43474334`, `FRAME_MAGIC = 0x43474434`, `TRAILER_MAGIC = 0x43475434`, and `FRAME_COMMIT_MAGIC = 0x43474634`.
- Keep `FILE_HEADER_BYTES = 256` and `ALIGNMENT_BYTES = 8`. Bytes `0..31` are the super-header: file magic, schema, root fingerprint, capacity, header bytes, slot bytes, alignment, and reserved-frame bytes as eight little-endian `u32` fields.
- Keep `SCRATCH_BYTES = 4096` at bytes 256..4351 and set `PAGE_GUARD_BYTES = 4096`. Let `midpoint = alignDown(capacity / 2, 8)`. Page 0 is `[4352, midpoint)` and page 1 is `[midpoint + PAGE_GUARD_BYTES, capacity)`. Reject capacities where either span is empty or cannot hold a base plus twice `maximumDeltaFrameBytes(pageCapacity)`. Scratch and guard bytes are never part of a base, frame, or CRC and remain zero except while streaming initial-base or compaction chunks through scratch.
- Store two `COMMIT_SLOT_BYTES = 112` slots at offsets 32 and 144. Each slot stores little-endian `u32` fields at relative offsets: magic 0, serial 4, base page 8, base offset 12, base length 16, base CRC 20, delta start 24, committed delta end 28, latest frame offset 32, frame count 36, coverage code 40, base serial 44, latest generation digest low/high 48/52, base generation digest low/high 56/60, reserved headroom bytes 64, maximum frame bytes 68, compaction source serial 72, reserved zeroes 76..103, slot CRC 104 over bytes 0..103, and commit magic 108 written last. Readers reject equal valid serials and otherwise select the valid slot with the greatest serial.
- Compute `pageCapacity = pageEnd - pageStart` for the selected span and `maximumDeltaFrameBytes(pageCapacity) = min(32 * 1024 * 1024, alignDown(pageCapacity / 8, 8))`. Require `baseOffset = pageStart`, `baseLength > 0`, `deltaStart = alignUp(baseOffset + baseLength, 8)`, and `baseOffset + baseLength <= deltaStart <= committedDeltaEnd <= pageEnd`. The base CRC covers exactly `[baseOffset, baseOffset + baseLength)`. Reject a base unless its page retains at least twice the maximum frame after `deltaStart`. Never append a frame larger than that value or consume the final one-frame headroom.
- Use `DELTA_FRAME_HEADER_BYTES = 192`. Store little-endian `u32` fields at relative offsets: magic 0, schema 4, header bytes 8, frame length 12, serial 16, previous frame offset 20, parent generation digest low/high 24/28, generation digest low/high 32/36, coverage 40, flags 44, string offset/length 48/52, changed-file string offset 56, partition offset/length 60/64, symbol offset/count 68/72, transition offset/count 76/80, name-index offset/count 84/88, file-index offset/count 92/96, id-index offset/count 100/104, incoming-index offset/count 108/112, outgoing-index offset/count 116/120, identity-index offset/count 124/128, tombstone offset/count 132/136, trailer offset 140, and reserved zeroes 144..191.
- Align every frame and section start to 8 bytes and require zero padding. Encode all frame offsets relative to the frame start. Store frame strings as length-prefixed UTF-8. Use 16-byte index rows: key string offset or numeric key, record index, owner ordinal or secondary key, and flags/reserved.
- Use `DELTA_SYMBOL_BYTES = 40`: id, file, name, kind string offsets at 0/4/8/12; signed line at 16; qualified-path and signature offsets at 20/24; ordinal at 28; exported flag at 32; and flags/reserved at 36.
- Use `FILE_TOMBSTONE_BYTES = 16`: file string offset at 0, owning frame serial at 4, replacement/unlink flags at 8, and reserved zero at 12. A frame contains exactly one changed-file tombstone; replacement frames also contain symbol additions, while unlink frames do not.
- Use 56-byte transition rows: owner-file string offset, owner/reference ordinal, before state kind/from/to/line/call/reason, and after state kind/from/to/line/call/reason as fourteen little-endian `u32` fields. State kinds are none, resolved, and dangling. Use `0xffffffff` for an absent string/line/reason field.
- End each frame with a 16-byte trailer containing trailer magic, frame length, payload CRC over the header and payload, and commit magic. A frame is visible only when wholly within the selected slot's committed delta end and its bounds, padding, trailer, digest chain, coverage, and CRC validate.
- Derive each 64-bit generation digest from SHA-256 over the UTF-8 generation id: digest bytes 0..3 become the low `u32` and bytes 4..7 become the high `u32`, both read little-endian. Store the full generation id in the base/frame string region and require exact full-string verification after digest lookup.
- Keep the active base page immutable. Encode one frame with its local strings, changed packed partition or file tombstone, symbol additions, transition rows, and delta-local indexes.
- Key every resolved or dangling transition by the existing durable reference identity `(ownerFile, referenceOrdinal)`. Key partition-local edges by `(ownerFile, edgeOrdinal)`. Do not derive identity from endpoints, line, or call state.
- Encode `before` and `after` states for resolved-edge and dangling-edge transitions. A file tombstone hides every older symbol and partition-owned edge for that file; a newer frame for the file supersedes the tombstone.
- Stage publication in this order: persist the changed source and packed partitions; write the parent-linked generation manifest without changing `CURRENT`; append and flush the mmap frame and trailer; write and flush the alternate commit slot; atomically advance `CURRENT`.
- Persist a base generation as the existing complete version-4 manifest plus `{parentGeneration: null, queryBaseSerial, queryCommitSerial}`. Persist a delta generation as `{version: 4, generation, createdAt, parentGeneration, root, edgeCoverage, controlHashes, analyzers, change: {type, file, sourceId, sourceMetadata, partitionId, internalPartitionId, partitionHash}, edgeTransitions, danglingTransitions, parsedFiles: [file], validatedFiles: [file], queryCommitSerial}`; unlink fields that have no value are `null`.
- Add `GraphStore.stageGenerationDelta(input)`. It validates the delta-manifest input above, creates and atomically writes the generation file without changing `CURRENT`, and returns the completed manifest; malformed input or write/rename failure throws and leaves `CURRENT` unchanged.
- Add `GraphStore.commitGeneration(generation)`. It verifies the staged manifest and parent chain, atomically writes `CURRENT`, and returns the committed manifest; missing/corrupt/cyclic/duplicate ancestry or write/rename failure throws and preserves the prior `CURRENT`.
- Keep durable source, partition, internal-partition, hash, and stat metadata only in the existing base/delta generation manifests. Do not add a file-record sidecar or duplicate those fields in the mmap query format. A one-file update reads its changed-file values directly from the staged delta; complete legacy-compatible manifest materialization is allowed only in explicit compaction or persisted-generation fallback paths.
- Keep the existing `MmapQueryCache.publish({generation, coverage, view}, {signal})` as the only full-base publication operation. Do not add `publishBase`, an overload, or a second base writer.
- Keep the existing `MmapQueryCache.appendGeneration({parentGeneration, generation, coverage, changedFile, partitionBytes, symbols, transitions, tombstone}, {signal})` as the one-file delta writer. It returns `{committed, serial, deltaBytesAppended, baseBytesWritten: 0, compactionTriggered, reason?}`; invalid input throws before writing, while capacity, lease, abort, flush, or commit failure returns `committed: false` with the prior slot authoritative.
- Keep `MmapQueryCache.acquire({generation, coverage})` returning `{value, release}` or `null`; `value.mappedView` exposes the same query methods over a captured base/delta snapshot.
- Do not add compaction code until the production MCP measurement identifies a frame-count or byte threshold where delta lookup is slower than rebuilding the inactive page. If no break-even appears before physical capacity, use only the physical-capacity boundary.
- A lease captures the selected base descriptor, committed delta end, and target frame serial. Later appends do not change that snapshot. The active base and its committed frames provide mapped current/history lookup. If compaction is later justified, a lease on the previous base must remain valid until release.
- If measurement requires compaction, reuse `publish()` to stream the newest visible state into the inactive unleased page through the existing scratch region. Flip only if the captured source serial is still current. The triggering update never waits for compaction. The final one-frame headroom remains a correctness reserve, not a performance threshold.

## Testing Requirements

- Use Node unit tests through the repository's existing `node --test` runner; no timing threshold is a CI correctness assertion.
- Extend `test/codegraph.performance.test.mjs` with a production-path contract proving one MCP process and daemon identity perform the initial `codegraph_index` and every measured one-file update. Remove and negatively assert rejection of temperature, phase, direct-engine, provisional-child, and external-build selectors.
- Extend `test/engine.test.mjs` with sparse one-file semantic receipts, one-file generation manifests, exact publication counters, staged commit ordering, append failure atomicity, no full-graph materialization across the entire update lifecycle, changed/add/unlink behavior, and byte-normalized clean-rebuild parity for every public query family.
- Extend `test/mmap-query-cache.test.mjs` one invariant at a time: immutable base/scratch, exact frame bytes, slot commit failure, delta-first symbols, then relationships. Use one representative corruption case per validation branch; do not build a cross-product matrix.
- Extend `test/engine.test.mjs` with table-driven generation cases: zero, one, and many parents; missing, corrupt, cyclic, and duplicate generation identities; staged-manifest write/rename failure; `CURRENT` write/rename failure; and restart preserving the prior readable generation.
- Cover change, add, unlink, and delete/re-add once through the public query families. Reuse those fixtures; do not duplicate them per record state or generation when the same reader branch is exercised.
- Cover exact identity behavior: remove one of two equal edges; equal endpoints/line/call owned by different ordinals; changed-file symbol reorder; owner delete/re-add; tombstone followed by add; and repeated replacement across at least three frames.
- Cover lease behavior only where bytes can be overwritten: a captured view survives append, and—only if compaction is implemented—the inactive leased page is not overwritten.
- Cover physical boundaries once: empty replacement, unlink, maximum ordinal, exact frame capacity, and one byte over capacity. Threshold tests exist only if measurement produces a threshold.
- Independently poison forbidden full-graph/full-page builders during one-file tests, hash the immutable base before and after change/add/unlink, and inspect V8 heap/allocation profiles. Treat any work proportional to base file or record count as repository-sized even if a counter is renamed or omitted.
- Extend `test/daemon-query-engine.test.mjs` only where its existing fixtures must prove the mapped delta generation is served without constructing the fallback engine.
- Extend `test/boundaries.test.mjs` with static architecture checks that reject repository-wide graph materialization, complete-page encoding, complete-manifest serialization, and alternate performance routes on a one-file update.
- During each slice, run only the named focused test and its directly affected parity tests. After all runtime slices stabilize, run the focused storage/engine/daemon/performance/boundary set once, then the complete suite once.
- Run focused coverage once after the complete mmap writer/reader path is green. Do not create per-slice mutation worktrees.
- Use exactly `npm run performance -- --root /Users/mac/Documents/Projects/dnd-community-and-marketplace --samples 10 --profile --cpu /private/tmp/codegraph-mmap-delta/main.cpuprofile --heap /private/tmp/codegraph-mmap-delta/main.heapprofile --trace /private/tmp/codegraph-mmap-delta/main.trace.json --diagnostic-log /private/tmp/codegraph-mmap-delta/diagnostics.jsonl --json /private/tmp/codegraph-mmap-delta/report.json --markdown /private/tmp/codegraph-mmap-delta/report.md` for the existing baseline, the first fully wired mmap-delta lifecycle, and the final receipt. Small writer/reader fixes use a focused operation benchmark, not another 10-sample repository run.
- Use `src/types/index.ts` and the harness's reversible unique exported type mutation for every measured update. Record initial-index time, update-publication time, first-query time, V8 CPU/heap/trace artifacts, GC evidence, parsed and validated file counts, partition bytes written, delta bytes appended, base bytes rewritten, repository records materialized, repository-sized containers allocated, and compaction status.
- Ordinary one-file samples must report `parsedFiles = 1`, `validatedFiles = 1`, `baseBytesRewritten = 0`, `repositoryRecordsMaterialized = 0`, `repositorySizedContainersAllocated = 0`, and `compactionTriggered = false`.

## Remaining Order

1. Finish `appendGeneration()` correctness: alternate-slot atomicity, reserved headroom, and base/slot validation. Measure isolated append time, allocations, GC, and cyclomatic complexity once this writer is complete.
2. Make the existing mapped reader consult committed frames newest-first for symbols and tombstones. Measure lookup cost by frame count.
3. Extend that same reader to relationships and dangling transitions. Do not create a second reader or materialized overlay graph.
4. Connect the existing sparse engine update to `stageGenerationDelta()`, `appendGeneration()`, and `commitGeneration()` in that order. Remove the old one-file full-page/full-manifest publication path instead of retaining a fallback branch.
5. Run the unchanged real-repository MCP profile. Only if it finds a measured delta-depth break-even, add compaction by reusing `publish()` and the existing scratch region.
6. Run focused parity/coverage once, the complete suite once, then update verified documentation and `AGENTS.md`.

Work is sequential. Use one focused test, one small fix, and one independent review per completed step; no parallel implementation and no repeated full-repository profile for microscopic edits.

## Success Criteria

- The mapped base bytes remain unchanged for every ordinary one-file change, add, and unlink.
- A one-file update persists only its changed packed partition or tombstone, one parent-linked generation manifest, and one committed mmap delta frame.
- A committed frame contains exact symbol, resolved-edge, and dangling-edge additions/removals keyed by stable owner file and ordinal; duplicate equal edges remain distinct.
- Name, file, id, incoming, outgoing, dependency, reference, and full-graph queries return the same content and order as a clean rebuild while consulting newest deltas before the base and honoring tombstones.
- A torn or invalid frame, header slot, generation parent, append, or flush cannot advance `CURRENT` or hide the last valid mapped generation. The same applies to compaction only if compaction is implemented.
- If measurement requires compaction, it occurs only at the measured break-even or physical-capacity boundary, uses the inactive unleased page, and never blocks the triggering one-file publication on a full rebuild.
- The complete one-file lifecycle, including request creation, worker validation, coordinator validation, persistence, mmap commit, and indexed first exact query, allocates no internal JavaScript array, map, set, object graph, or buffer proportional to base repository files or records and reports zero repository records materialized. Caller-requested `graph` output may allocate only the returned result rows; it may not build a second internal repository graph, index, or cache.
- One production MCP lifecycle is the only performance path: it performs initial indexing and all measured updates without cold/warm, MCP/direct-engine, or external-build branches.
- Every completed step has focused red/green receipts and one independent scope/design/effectiveness review. The unchanged real-repository MCP command is run after engine integration and at final completion, not after each microscopic edit.
- Final focused coverage and the complete suite pass with zero skips, and the target design documents describe only the verified implementation.
