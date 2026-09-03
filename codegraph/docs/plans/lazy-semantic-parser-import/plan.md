---
modified: 2026-08-31
dependencies: [../../design/parsing-and-resolution.md, ../../design/mcp-and-cli.md]
supersedes: null
---

# Lazy Semantic Parser Import

## Problem

The persistent daemon main isolate statically loads `parser.mjs` and the full ts-morph semantic layer even though semantic indexing belongs to its worker. CPU and heap profiles therefore show duplicate ts-morph module loading and allocation in both isolates.

## Solution

Keep the existing `semantic-checker-worker.mjs` interface and worker URL unchanged, but conditionally import `parser.mjs` only inside its worker isolate. Remove the static semantic parser import from `tool-engine.mjs`, use `node:crypto` for lightweight hashes, and dynamically load semantic parsing only in the existing short-lived CLI and cold/historical fallback branches.

## Target Design Docs

- `docs/design/parsing-and-resolution.md`
- `docs/design/mcp-and-cli.md`

## Testing Requirements

- Use Node's built-in test runner for unit and integration tests in `test/engine.test.mjs`.
- Add failing module-boundary regression tests first: Node 22 child processes independently import `tool-engine.mjs` and `semantic-checker-worker.mjs` on the main thread without constructing an engine, and each ESM debug import graph must contain neither `parser.mjs` nor the exact `node_modules/ts-morph/dist/ts-morph.js` semantic wrapper. Keep these in `test/engine.test.mjs` because that file already owns the engine and real `SemanticCheckerWorker` protocol/ownership tests; reuse the child-loader technique established in `test/daemon-query-engine.test.mjs`.
- Preserve the existing `SemanticCheckerWorker` import path, exported class, worker URL, request methods, request shapes, and result shapes; existing worker protocol/index/hydrate/reference-overlay tests must pass unchanged.
- Prove retained persistent build, first edit, and current-generation reference overlay complete without loading the main semantic parser and return exact existing generations, partitions, symbol IDs, and reference rows.
- Pair the main-thread boundary checks with a real `SemanticCheckerWorker.index` operation proving worker evaluation does load semantic parsing and returns exact partitions through the unchanged public client entry.
- Prove default short-lived build/reconcile and cold or historical complete-reference fallback dynamically load semantic parsing and remain exact-output equivalent.
- Retain the existing rejected-worker, overlay-source-failure, failed-build publication, and reconcile-fallback tests as the dynamic-load/work failure contract: rejection propagates, `CURRENT` remains absent or byte-identical, no partial overlay/generation is readable, and retry remains possible.
- Preserve trace event names, counters, batched order, storage publication, failure atomicity, cancellation, and worker lifecycle behavior.
- Run the new test and focused ownership/protocol/overlay/fallback tests during implementation, then once run the full engine, MCP runtime, trace-profile, and performance test files with Node 22 and zero skips.
- Run `/Users/mac/.nvm/versions/node/v22.19.0/bin/node --experimental-test-coverage --test test/engine.test.mjs test/mcp-runtime.test.mjs test/trace-profile.test.mjs` and require 100% lines, branches, and functions for changed production files `tool-engine.mjs` and `semantic-checker-worker.mjs`. Node/V8 line coverage is the statement proxy because the built-in reporter has no independent statements metric; exact uncovered legacy paths are completion blockers rather than silently lowered gates.
- Manually change the conditional worker import back to a static import once and prove the main-thread boundary test fails; restore it. Then misdirect the engine's dynamic parser import once and prove the default build/historical fallback tests fail atomically; restore it.
- Capture new main/worker CPU and heap profiles plus a trace. Require the main profile to contain no `parser.mjs` or exact `ts-morph/dist/ts-morph.js` frames while the worker profile still contains semantic parsing; bare TypeScript compiler frames from `incremental-resolver.mjs` are expected in main.
- Compare cold start, full rebuild, first leaf, cascade, and reference medians against `.profiles/codegraph-performance-report-20260831-1918.md`; update README only from a repeatable isolated run.

## Parallel / Dependent Breakdown

1. Test Engineer writes the failing module-boundary and exact fallback parity tests.
2. Full-stack Engineer adds the two conditional/dynamic imports and lightweight hash; this depends on step 1.
3. Independent reviewer verifies the unchanged interface, import boundary, output parity, and fresh CPU/heap evidence.
4. Technical Writer folds verified behavior and measurements into the target design docs and README, then retires the plan.

## Success Criteria

- Importing `tool-engine.mjs` in the daemon main isolate does not load `parser.mjs` or the ts-morph semantic wrapper.
- `semantic-checker-worker.mjs` remains the same public client module and worker entry with identical messages and output.
- Persistent MCP indexing, validation, and warm overlays remain exact and do not load the main semantic parser.
- Default CLI and cold/historical fallbacks still load semantic parsing only when invoked and return exact output.
- Full correctness and performance suites pass with zero skips, and fresh profiles prove semantic ts-morph loading occurs only in the worker for the persistent path.
