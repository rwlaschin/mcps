---
modified: 2026-10-07
dependencies:
  - ../../design/parsing-and-resolution.md
supersedes: null
---

# One-file library integration

## Problem

The retained one-file validation branch creates a fresh semantic project for every edit (`semantic-checker-worker.mjs:307`). The standalone library already retains raw TypeScript nodes and cached node access but is not used by the application.

## Solution

Use one retained library session for consecutive edits to the same file in the retained-cache branch. Preserve existing dependency resolution and publication contracts. The user approved installation of the completed-analysis cache in production on 2026-10-07, including cached dependency contexts.

## Scope

- `one-file-semantic-library.mjs`: expose the latest normal-analysis context and accept existing semantic timing instrumentation. Enable eligible completed-analysis reuse for stable known-file and cached-partition contexts. Compare only relevant imported dependency partition identities and source hashes; exclude the changed file's own replaced partition.
- `parser.mjs`: extract the existing one-file compiler-options reader from `createOneFileSemanticProject`; reuse that helper in the factory without changing options or filesystem behavior.
- `semantic-checker-worker.mjs`: replace only the retained-cache change/add parse at line307 with the session. Store at most the latest session on the existing cache; reuse it only for the same root, file, and compiler options. Preserve the existing membership facade, cached partitions, context, reference repair, source-map receipt, counters, and generation acknowledgement. Clear the session on unlink; cache replacement during index, hydrate, explicit-base validation, or full validation naturally discards it. Existing worker termination disposes its session. Leave the explicit-base/restart branch at line356 and cold/multi-file paths unchanged.
- `test/one-file-semantic-library.test.mjs` and `test/engine.test.mjs`: extend focused parity and worker integration coverage.
- `docs/design/parsing-and-resolution.md`: after implementation, update Architecture, Functions, and Tests to describe the retained library path and conservative analysis-cache eligibility.
- No renames, new runtime files, versions, dependencies, storage changes, global caches, or generation protocol changes. No UI/UX required.

## Target Design Docs

Update `docs/design/parsing-and-resolution.md` Architecture, Functions, and Tests after verified implementation. Describe the retained library session, its one-session lifetime, unchanged cached dependency resolution, and conservative analysis-cache eligibility. Keep cold and restart behavior descriptions intact.

## Testing Requirements

Unit tests in `test/one-file-semantic-library.test.mjs` compare complete partitions, fingerprints, and binary bytes against the existing Project oracle after prefix insertion, renaming, and options changes. Preserve existing numeric-return cache tests. Assert cache hits with imported targets and misses after dependency replacement, options changes, file switches, and unlink/re-add.

Integration tests in `test/engine.test.mjs` cover retained same-file edits, cached imports, file switches, unlink/re-add, explicit base replacement, failed publication followed by retry, and the existing context/overlay contract. Assert one changed file, zero dependent-source reads, exact graph parity, and unchanged receipt contracts. Keep timing thresholds out of tests.

Run from `codegraph`:

```sh
node --test test/one-file-semantic-library.test.mjs test/one-file-semantic-parity.test.mjs
node --test --test-name-pattern='explicit base partitions|unhydrated public-surface|unhydrated unlink|consecutive single-file|one retained leaf|all-pairs parity|deleting and re-adding|delta write failure' test/engine.test.mjs
node --test --test-name-pattern='one-file semantic delta|zero worker reads' test/remaining-performance-contracts.test.mjs
node --test test/boundaries.test.mjs
git diff --check
```

Run the newly added integration tests without filtering. Capture separate before/after cold-first-worker-request and warm retained-edit timings in an external real-Plot.tsx worker reproducer, including output equality and CPU/heap/trace artifacts. Measure application load/index/update behavior with the existing host performance harness:

```sh
npm run performance -- --root /Users/mac/Documents/Projects/dnd-community-and-marketplace --samples 2 --json /private/tmp/codegraph-library-app.json --markdown /private/tmp/codegraph-library-app.md
```

## Parallel / Dependent Breakdown

1. Test Engineer writes focused tests before runtime edits.
2. Senior Dev extracts the options helper; verifies the existing factory's parity before proceeding.
3. Senior Dev updates library context/timing and the retained worker call together as one transaction; no incomplete import/body changes land separately.
4. Independent Reviewer inspects the actual diff, reruns focused receipts, and measures cold/warm performance.
5. Technical Writer updates the existing design document after verified implementation.

## Success Criteria

- Consecutive retained edits to the same file use the library session and preserve complete semantic/binary output and existing publication behavior.
- At most one latest session is retained; file switches and cache replacement release the old session.
- Dependency partitions and membership inputs remain intact; no dependent source reads or repository-sized containers are added.
- Cold initial indexing, persisted hydration, and the restart branch retain their existing implementation.
- Report cold and warm application measurements separately. Eligible production edits use completed-analysis reuse with cached dependency facts. Report measured production times; preserve complete fingerprints using the parser's actual semantic target array.
- Focused tests pass with zero skips; independent scope review and diff checks pass.
