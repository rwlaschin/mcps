---
modified: 2026-09-13
dependencies:
  - plan.md
---

# Go Language Plug-in Tasks

- [ ] Test Engineer: Add failing analyzer-registry and TypeScript compatibility tests in `test/language-analyzer.test.mjs`; done when failures prove the missing boundary without modifying production code.
- [ ] Senior Developer: Add `language-analyzer.mjs` and `typescript-language-analyzer.mjs`, then atomically route `source-policy.mjs`, `query-target.mjs`, `incremental-resolver.mjs`, `parser.mjs`, `parser-apartment-pool.mjs`, `semantic-checker-worker.mjs`, `tool-engine.mjs`, `mcp-server.mjs`, `mcp-runtime.mjs`, `store.mjs`, and `visualizer.mjs` through direct analyzer references; done when focused tests pass and output is byte-identical.
- [ ] Performance Engineer: Run real D&D cold-build, distinct-query, leaf-update, and cascade-update comparisons; done when no repeatable regression outside measured variance is present.
- [ ] Test Engineer: Add failing real-Go fixture and integration tests in `test/go-language-analyzer.test.mjs` and `test/fixtures/go-project`; done when failures isolate missing Go behavior with zero skips.
- [ ] Go Developer: Add `go-language-analyzer.mjs`, `go-incremental-resolver.mjs`, `go-semantic-worker.mjs`, `go-analyzer`, and the optional build integration; done when helper protocol, existing semantic/internal partition schemas, package invalidation, atomic multi-analyzer publication, and explicit failures pass focused tests.
- [ ] Test Engineer: Verify Go MCP symbols, dependencies, references, callers, dead exports, leaf updates, cascade updates, mixed repositories, and worker failures; done when focused and full suites pass with zero skips.
- [ ] Performance Engineer: Extend `scripts/codegraph.performance.mjs` and its tests to report distinct query and update categories, then run the production MCP against the real Go repository; done when correctness hashes, restoration, CPU, heap, trace, and timing artifacts are complete.
- [ ] Technical Writer: Update README and the four target design docs to describe verified current behavior only; done when scoped documentation validation passes.
- [ ] Reviewer: Run code guard, test guard, package checks, full suite, diff check, and independent performance review; done when every success criterion has executable evidence.
