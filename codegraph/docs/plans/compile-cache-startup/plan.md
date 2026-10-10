---
modified: 2026-10-09
dependencies: [../../design/parsing-and-resolution.md]
supersedes: null
---

## Problem
Direct service and benchmark startup bypass the existing Node compile-cache initialization. Direct CLI startup does not initialize it.

## Solution
Extract the existing initialization into one builtins-only module. Initialize before loading project dependencies and propagate the existing environment setting to children and workers.

## Scope
Add `compile-cache.mjs`; wire `mcp.mjs`, `cli.mjs`, `tool.mjs`, `mcp-server.mjs`, `visualizer.mjs`, both semantic and incremental parser worker modules, both performance scripts, and the existing ignored profile runner. Convert affected project imports to awaited imports after initialization; preserve APIs and exports. Preserve the existing cache directory, overrides, disabled-cache behavior, optional Node API support, worker configuration, dependencies, versions, and data formats. No other optimization.

## Target Design Docs
Update only the cache-startup description in `docs/design/parsing-and-resolution.md` after verification.

## Testing Requirements
Use `test/compile-cache.test.mjs` startup integration tests with focused child-process checks for actual enabled cache directory, inherited worker cache, override, disabled cache, absent API, and startup ordering. Syntax-check changed sources. Run the existing suite once after focused checks pass. Compare output and cold/warm timings on the unchanged saved 877-file snapshot with host-load monitoring; record actual cache status and distinguish empty from populated module caches. No timing gates.

## Parallel / Dependent Breakdown
Independent startup and scope review precede test writing. Tests precede source implementation. Independent diff and receipt verification precede the saved-snapshot measurements and design-document update.

## Success Criteria
Every listed startup initializes the existing compile cache before loading expensive project dependencies. Workers and subprocesses inherit it. Overrides, disable behavior, and absent API remain supported. Snapshot output remains consistent; cleanup receipts pass. No unrelated source, version, dependency, worker-budget, or format changes occur.
