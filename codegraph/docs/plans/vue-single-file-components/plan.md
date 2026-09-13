---
modified: 2026-09-13
supersedes: null
---

# Vue Single File Components

## Problem

CodeGraph indexes JavaScript, TypeScript, JSX, and TSX, including React components and Vue components authored as JSX or TSX. It does not scan, watch, parse, resolve, or query `.vue` Single File Components. Treating only `<script>` blocks as source would omit the component references, directives, expressions, branches, loops, and calls authored in `<template>`, so it would not provide a complete graph of a Vue application.

Vue SFCs cannot be passed directly to the current ts-morph project. The Vue compiler combines normal scripts, `<script setup>` macros, template scopes, component resolution, and generated virtual TypeScript. Generated code does not share the physical layout of the `.vue` file, so every emitted symbol, edge, owner, control-flow node, diagnostic, and metric must be mapped back through official Vue language-tooling mappings. Generated helper names and runtime scaffolding must never appear in CodeGraph output.

## Solution

After the shared coordinator and TypeScript plug-in in the Go plug-in plan land, add a Vue SFC plug-in implementing that descriptor: unique `id`, `extensions: ['.vue']`, `controlFiles: []`, cache key, source matcher, provisional resolver, and semantic worker. The TypeScript plug-in owns `tsconfig.json` and `jsconfig.json`; the coordinator broadcasts an owned control-file change to dependent instantiated plug-ins, so Vue recomputes its compiler options and cache key without duplicate control ownership. Pin and test `@vue/language-core` 3.3.11, `@volar/typescript` 2.4.28, `@volar/source-map` 2.4.28, and `@vue/compiler-sfc` 3.5.42 as one compatibility tuple. Use `createParsedCommandLine` and `createVueLanguagePlugin`; use `SourceMap.toSourceRange` and `toSourceLocation` with cross-mapping fallback disabled. CodeGraph will not implement an independent template-to-TypeScript compiler.

The shared plug-in registry admits the Vue plug-in's `.vue` extension for scans, watch events, and query qualification such as `Component.vue` and `Component.vue:Symbol`. The Vue semantic worker installs the Vue language tooling so imports such as `./Card.vue`, template component tags, `<script setup>` bindings, Options API component registrations, and configured Vue globals resolve through one TypeScript program. Analyzer-private virtual filenames and Vue helper identifiers never enter manifests, partitions, queries, or visualization data.

The adapter accepts the physical root-relative file, complete SFC source, TypeScript compiler options, and `vueCompilerOptions`. It returns the physical source, generated Vue virtual code, compiler descriptor and diagnostics, a version key, and mapping functions that translate generated UTF-16 ranges to one monotonic physical range. CodeGraph emits a row only when the complete authored token maps to one physical interval in the same SFC. Unmapped helpers, global virtual files, split mappings, overlapping mappings, and non-monotonic mappings are rejected or suppressed according to whether they represent invalid input or compiler scaffolding. Lines are calculated from the complete physical SFC.

Normal `<script>` declarations, exports, imports, calls, references, CFG, and complexity keep their existing meanings. `<script setup>` top-level bindings and imported components participate in normal resolution. Vue compiler macros are compile-time constructs and do not create helper symbols or call edges; user-authored bindings and runtime expressions inside macro arguments remain visible.

Every non-empty template receives one CodeGraph-owned `$template` function owner at the physical template-content start. Template-local `v-for` aliases and slot bindings become non-exported variables scoped below that owner. Interpolations, bindings, conditions, loops, models, slots, dynamic arguments, event handlers, and directive expressions emit mapped references and calls from their authored locations. `@click="save"` is a reference and `@click="save()"` is a call. Authored template branches and loops contribute to CFG and complexity after generated repetitions are deduplicated by physical owner, physical range, resolved target, and call kind.

Component tags use Vue resolution rules for imported setup components, Options API registrations, self references, configured globals, PascalCase, kebab-case, and namespace or dot notation. A resolved component tag emits a call edge from `$template` to the component declaration at the physical tag name. Native HTML and SVG elements emit no component edge. Custom directives resolve through Vue's `vFoo` convention and emit call edges; built-in directives do not. Dynamic components emit a component edge only when the checker resolves a static declaration, while references and calls inside the `:is` expression are still indexed.

For an SFC with a user-authored default export, cross-file component references target that declaration. A `<script setup>` SFC whose default export exists only in generated code receives one synthetic component variable named from the physical file basename at the `<script setup>` start. The existing symbol, edge, partition, query, internal-partition, and MCP schemas remain unchanged.

The complete physical SFC determines `sourceHash`; styles and custom blocks therefore invalidate the source even though they emit no semantic rows. The Vue cache fingerprint includes CodeGraph's internal schema, TypeScript, Vue language-core, Vue compiler, normalized TypeScript and Vue compiler options, consumed global type/configuration files, and the SFC source hash. A `.vue` add, change, or unlink follows the existing atomic generation path and rebuilds the proven reverse dependency closure. Compiler failure preserves the prior validated generation.

Malformed SFCs, duplicate script blocks, incompatible script languages, compiler errors, invalid mappings, and mapped semantic tokens split across physical ranges reject the candidate generation with a physical filename and range. Empty templates, script-only SFCs, and template-only SFCs are valid. External `<script src>` and `<template src>` are rejected because the current row schema cannot truthfully represent multiple physical source owners. Non-HTML template languages require a configured official Vue language plugin; otherwise they are rejected. Dynamic runtime registrations that cannot be proven statically remain unresolved and do not produce guessed edges.

Core storage, publication, query, MCP, CLI, and visualization code remains language-neutral. The only core integration is registering the Vue descriptor in the built-in plug-in set when `.vue` support ships. No new MCP method, CLI command, HTTP route, request field, response field, symbol kind, edge kind, or persisted row shape is introduced.

## Target Design Docs

- Update `docs/design/parsing-and-resolution.md` after implementation with the Vue semantic adapter, mapping rules, template ownership, and invalidation behavior.
- Update `docs/design/mcp-and-cli.md` after implementation with `.vue` source and query support.
- Update `docs/design/storage-and-query.md` after implementation with Vue cache compatibility while preserving existing row schemas.
- Update `docs/design/visualizer.md` after implementation with `.vue` watch and rendering behavior.
- Update the top-level README after implementation with high-level Vue SFC support only.

## Use Cases

### 1. Query authored Vue behavior

**Goal:** Retrieve symbols and relationships authored anywhere in a Vue SFC through existing CodeGraph tools.

**Stakeholders:** Developers and coding agents analyzing Vue applications.

**Actors:** MCP or CLI caller, CodeGraph runtime, Vue semantic adapter, TypeScript checker.

**Preconditions:** The repository contains a valid `.vue` SFC and compatible Vue compiler settings.

**Postconditions:** Existing CodeGraph queries return physical `.vue` files and authored locations without generated Vue helpers.

**Basic Course of Events (BCE):**

1. Source policy admits the physical `.vue` file.
2. The Vue language plugin creates virtual TypeScript and generated-to-source mappings.
3. The TypeScript checker resolves script, script-setup, template, component, and directive references together.
4. CodeGraph maps complete semantic ranges back to the physical SFC.
5. CodeGraph filters compiler scaffolding and encodes existing symbol, edge, and internal-partition rows.
6. Existing tools return the mapped rows using the physical `.vue` path.

**Alternate Flows:** Script-only and template-only SFCs emit only the semantic content they contain; unresolved dynamic components produce no guessed edge.

**Exceptions:** Invalid SFC syntax, unsupported external blocks or template language, compiler failure, or invalid mappings reject the candidate generation and preserve the previous validated generation.

### 2. Resolve template components and directives

**Goal:** Trace a component or custom directive from template use to its declaration.

**Stakeholders:** Developers reviewing component composition, callers, references, and dead exports.

**Actors:** CodeGraph semantic worker, Vue language plugin, TypeScript checker.

**Preconditions:** The tag or directive is statically resolvable from setup imports, Options API registration, self reference, or configured globals.

**Postconditions:** The template owner has a mapped call edge to the exact declaration.

**Basic Course of Events (BCE):**

1. Vue virtual code resolves the authored tag or directive through Vue naming and scope rules.
2. CodeGraph maps the generated use to its physical tag or directive token.
3. Native elements and built-in directives are excluded.
4. CodeGraph emits one deduplicated call edge from `$template` to the declaration.
5. Reference, caller, dependency, and dead-export queries consume the edge without schema changes.

**Alternate Flows:** Dynamic `:is` expressions emit their internal references and calls; a component edge is emitted only for a statically resolved declaration.

**Exceptions:** Runtime-only registration or opaque plugin globals remain unresolved and never create speculative edges.

### 3. Refresh a changed Vue SFC

**Goal:** Publish a Vue script or template edit without corrupting the active graph.

**Stakeholders:** Developers relying on current graph answers during editing.

**Actors:** Repository watcher, CodeGraph runtime, Vue semantic adapter, semantic worker.

**Preconditions:** A validated generation exists and a watched `.vue` file changes.

**Postconditions:** The changed SFC and its proven dependent closure are atomically published, or the previous generation remains active.

**Basic Course of Events (BCE):**

1. The watcher admits the `.vue` event through the shared source policy.
2. The adapter updates the SFC virtual code and mappings in the retained semantic workspace.
3. The worker rebuilds the changed partition and required reverse dependencies.
4. CodeGraph validates physical ownership, mappings, rows, and cache compatibility.
5. The complete generation is published atomically.
6. Existing queries return the changed relationship.

**Alternate Flows:** Style or custom-block edits advance the physical source generation without emitting new semantic rows; compiler-option or Vue-global changes trigger a conservative full Vue rebuild.

**Exceptions:** Compiler, mapping, cancellation, or worker failure rejects all candidate output and retains the last validated generation.

## Testing Requirements

- Add a focused unit test and integration test coverage in `test/vue-sfc.test.mjs`, extending `test/source-policy.test.mjs`, `test/boundaries.test.mjs`, `test/incremental-resolver.test.mjs`, `test/engine.test.mjs`, `test/internal-graph.test.mjs`, `test/mcp-internals.test.mjs`, and `test/visualizer-e2e.test.mjs` only for their existing contracts.
- Add `test/language-analyzer.test.mjs` tests for descriptor validation, duplicate extension ownership, cache keys, one-time factory construction, O(1) `.vue` routing, and `stageChanges`/`commit`/`discard` atomicity after failed peer validation, success, stale commit, double commit, and discard.
- Add a dependency API contract test before integration that imports the pinned `createParsedCommandLine`, `createVueLanguagePlugin`, `SourceMap.toSourceRange`, `SourceMap.toSourceLocation`, and required mapping capability fields; fail immediately if any public export or mapping behavior differs.
- Prove a TypeScript-owned `tsconfig.json` or `jsconfig.json` event invalidates both the TypeScript and dependent Vue plug-ins exactly once without duplicate control ownership.
- Add focused Vue fixtures for normal JS/TS scripts, JSX/TSX, script setup and every supported macro, template-only and script-only SFCs, cross-`.vue` imports, Options API registration, self references, global components, custom directives, slots, `v-for`, conditionals, interpolations, events, bindings, models, dynamic arguments, and dynamic components.
- Assert exact physical `.vue` filenames, 1-based lines, UTF-16 ranges, symbol identities, edge targets, call flags, template owners, local scopes, CFG, and complexity across LF, CRLF, BOM, non-ASCII, and astral characters.
- Prove Vue compiler helpers and generated filenames never appear in symbols, dependencies, unresolved candidates, internal rows, query output, diagnostics, or visualization data.
- Test scan/watch/query qualification for `.vue`, including add, change, unlink, ignores, symlinks, `file.vue`, and `file.vue:Symbol`.
- Test component resolution for PascalCase, kebab-case, namespace tags, setup imports, Options API registration, self reference, configured globals, native tags, dynamic components, custom directives, and built-in directives.
- Test event-reference versus event-call behavior and deduplication of repeated generated mappings.
- Test wrong-type, null, missing, empty, malformed, and semantically invalid descriptor, mapping, worker, and protocol inputs; malformed SFCs, duplicate/incompatible scripts, unsupported external blocks, unsupported template languages, compiler diagnostics, unmapped/split/overlapping/out-of-range mappings, cancellation, worker failure, and preservation of `CURRENT` after every rejected update.
- Assert style/custom-block-only edits advance generation with byte-identical semantic partitions, compiler/global configuration changes force a full Vue rebuild, and runtime-only registrations or opaque globals remain unresolved without speculative edges.
- Test cold build, hydration, full validation, safe incremental validation, reference overlays, reverse-dependent updates, circular Vue imports, and cache invalidation for each version/configuration input.
- Compare existing JavaScript, TypeScript, JSX, and TSX partition bytes and query receipts before and after the integration; they must remain byte-identical.
- Run `node --experimental-test-coverage --test` and require 100% statements, branches, functions, and lines for every changed production JavaScript file; run focused Vue, source-policy, boundary, incremental, engine, internal-graph, MCP, visualizer, and profiling tests with zero skips, followed by the full suite.
- Mutate the descriptor collision guard, mapping validator, generated-helper filter, cache-key branch, and atomic publication guard and prove a named focused test fails for each mutation.
- Keep the frozen real-repository benchmark workload and methodology unchanged. Add a separate frozen Vue benchmark with five independent fresh-copy/fresh-MCP lifecycles; assert exact SFC and template-expression counts and report p50, p90, and MAD only for cold index, script leaf update, template-only leaf update, cross-`.vue` cascade update, and full reindex. Fail when counts or semantic hashes drift, median regression exceeds the larger of 5% or two baseline MADs, p90 exceeds 110% of baseline, the source repository changes, samples are incomplete, or shutdown is unclean.

## Parallel / Dependent Breakdown

- The shared coordinator and TypeScript plug-in from the Go plug-in plan must land with byte-identical TypeScript receipts before Vue implementation begins.
- Vue fixtures and failing plug-in contract tests can then be written before Vue production code.
- Dependency manifest and lockfile changes form one atomic group.
- The Vue descriptor, source matcher, provisional resolver, semantic worker, position mapping, and internal graph encoding form one dependent plug-in group.
- Registry admission, query qualification, module candidates, and visualizer watching derive from the descriptor and can proceed after its contract is fixed.
- End-to-end semantic, incremental, failure, and cache tests depend on the complete ingestion path.
- Performance comparison and current-state documentation depend on all correctness tests passing.

## Success Criteria

- `.vue` files are scanned, watched, indexed, refreshed, queried, and visualized through existing entry points.
- Script, script-setup, and template-authored declarations, references, calls, components, directives, branches, loops, CFG, and complexity are represented at exact physical SFC locations.
- Cross-`.vue` imports and template component uses resolve to physical declarations.
- Vue compiler macros and generated helper symbols never leak into graph output.
- Existing public and persisted schemas remain unchanged.
- Invalid Vue input or compiler output never publishes a partial generation.
- Existing JavaScript, TypeScript, JSX, and TSX output remains byte-identical.
- The unchanged frozen benchmark process reports no correctness drift and no accepted performance regression.
- Focused and full tests pass with zero skips, and code, test, documentation, and diff guards pass.
