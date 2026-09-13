---
modified: 2026-09-13
supersedes: null
---

# C# Language Plug-in

## Problem

CodeGraph's shared language plug-in contract can route source files to language-owned resolvers and semantic workers, but no C# plug-in exists. A useful C# graph must follow evaluated solutions and projects, compiler options, project references, NuGet assets, generated inputs, partial declarations, overload resolution, and Roslyn control flow. Scanning `.cs` text without MSBuild and Roslyn would produce incomplete or incorrect references, callers, dependency closure, dead exports, and complexity.

## Solution

Implement one C# analyzer descriptor using the shared plug-in interface: `id`, owned extensions, control matchers, cache key, source matcher, provisional resolver, and semantic worker. The descriptor owns `.cs`; its matcher recognizes root-contained `.sln`, `.slnx`, and `.csproj` suffixes plus exact or case-normalized `global.json`, `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `NuGet.config`, `packages.lock.json`, and `obj/project.assets.json` paths. The shared coordinator rejects overlapping extension or control matches between plug-ins. Shared source discovery, publication, storage, queries, MCP tools, and visualization remain language-neutral and contain no C# branches.

The semantic worker owns one persistent .NET 10 helper using Roslyn and `MSBuildWorkspace`. Pin `Microsoft.CodeAnalysis.CSharp.Workspaces` 5.9.0, `Microsoft.CodeAnalysis.Workspaces.MSBuild` 5.9.0, and `Microsoft.Build.Locator` 1.11.2. The optional package build publishes the helper when a compatible SDK exists and never downloads tooling at install or runtime. Repositories without C# never locate or start `dotnet`. Active C# without a compatible helper fails with an actionable rebuild message rather than a syntax-only fallback.

The helper speaks the standard analyzer NDJSON protocol with handshake `{protocol:1, analyzer:'csharp', analyzerVersion:'1', roslynVersion:'5.9.0', targetFramework:'net10.0', dotnetVersion, msbuildVersion, runtimeIdentifier}` and operations `index`, `hydrate`, `validate`, `reference-overlay`, `cancel`, and `shutdown`. It enforces 60-second index/hydrate and 30-second validate/overlay ceilings, serializes workspace mutations, maps cancellation to `CancellationTokenSource`, retains a bounded stderr tail, rejects pending work after a crash, and restarts lazily by hydrating the last validated generation. The Node plug-in converts helper results into existing semantic and internal partitions; no C#-specific public record is introduced.

Workspace discovery prefers one root-contained `.sln` or `.slnx`. Without a solution it opens all root-reachable `.csproj` files in normalized path order. Zero projects is a valid empty C# plug-in result; multiple solutions fail with their candidate paths. Each project must evaluate to exactly one target framework; a multi-target project fails with its target list because the current graph has no configuration dimension. MSBuild evaluation is authoritative for compile membership, constants, nullable context, implicit/global usings, project and package references, analyzers, source generators, and linked files. Referenced external projects and assemblies participate in resolution but emit no repository partition.

Roslyn declarations backed by root-contained authored source map into existing symbol kinds. Classes and records map to `class`; interfaces to `interface`; enums to `enum`; structs, record structs, delegates, and type parameters to `type`; methods, constructors, destructors, operators, conversions, and accessors to `method`; local functions to `function`; fields, constants, properties, events, enum members, parameters, locals, pattern variables, range variables, and top-level variables to `variable`. Namespace declarations contribute qualified paths without adding a new kind. Top-level statements receive a synthetic `<top-level>` function owner. Compiler-generated, implicit, and source-generator-only declarations participate in binding but emit no row; references targeting them are counted as external and intentionally omit an edge.

Stable IDs include the C# namespace, assembly identity, fully qualified metadata container, physical file, qualified path, existing kind, name, canonical Roslyn signature, and ordinal. Partial declarations share one symbol identity at the deterministic first physical declaration; other parts contribute authored references, bodies, and internals without duplicating the symbol. `exported` means externally visible from the assembly, including eligible protected members only when their containing types are externally visible.

The helper walks each syntax tree and uses `SemanticModel`, `IOperation`, and resolved symbols. It must not run `SymbolFinder.FindReferencesAsync` once per declaration. Authored invocations, object creation, constructors, delegates, operators, conversions, and resolved accessors emit `call:true`; other resolved authored references emit `call:false`. Lowering duplicates are deduplicated by owner, target, physical UTF-16 start, and call kind. External metadata symbols do not create dangling edges. Dependencies remain sorted root-relative `.cs` declaration files. Ambiguous or unresolved source candidates retain the existing unresolved shape without guessed edges.

For each executable body, Roslyn `ControlFlowGraph` and `IOperation` map into the existing owner, node, flow-edge, and semantic-relation codes. Methods, accessors, constructors, operators, local functions, lambdas, initializers, and top-level statements cover conditions, loops, switch forms, patterns, exception flow, using, locking, yield, throw, goto, short circuiting, coalescing, conditional access, calls, reads, and writes. All spans use Roslyn's physical UTF-16 coordinates. Compiler-only blocks may connect authored nodes but never become visible nodes. Cyclomatic complexity counts authored decisions rather than Roslyn lowering artifacts.

Incremental edits stage an immutable Roslyn `Solution` and become visible only after the coordinator validates every plug-in and publishes the combined generation. A private body-only edit rebuilds its document. A project-internal declaration change rechecks that project. A public-surface change rechecks the transitive reverse project-reference closure. Adds, removals, renames, project/control changes, source-generator changes, ambiguous membership, binding diagnostics, or unprovable impact reload the C# workspace. Other language partitions remain reusable, but publication stays atomic across plug-ins.

The C# cache key includes the helper/protocol build, Roslyn, MSBuild, .NET SDK/runtime, selected workspace and target framework, normalized compiler/MSBuild options, relevant environment, and hashes of all C# control and asset files. Per-project public and internal fingerprints cover compilation identity, membership, references, usings, externally visible declarations, signatures, base types, interfaces, constraints, attributes affecting binding, constants, defaults, nullable annotations, and diagnostics. Existing mmap and partition schemas stay unchanged.

Compilation, workspace, helper, protocol, path, mapping, span, duplicate-ID, dangling-edge, or CFG failures reject candidate publication and preserve the previous generation. Orphan `.cs` files outside evaluated compile items are excluded. Initial support excludes `.csx`, Razor, XAML-generated bindings, C++/CLI, and multi-target union graphs because their semantics require additional plug-ins or a public configuration dimension. Cross-language edges are not inferred.

## Target Design Docs

- Update `docs/design/parsing-and-resolution.md` after implementation with the C# plug-in, Roslyn semantics, and invalidation contract.
- Update `docs/design/mcp-and-cli.md` after implementation with `.cs` query and helper availability behavior.
- Update `docs/design/storage-and-query.md` after implementation with analyzer cache compatibility and unchanged row schemas.
- Update `docs/design/visualizer.md` after implementation with registry-derived C# watch and rendering behavior.
- Update the top-level README after implementation with high-level C# support only.

## Use Cases

### 1. Query a C# solution

**Goal:** Retrieve compiler-resolved C# symbols and relationships through existing CodeGraph tools.

**Stakeholders:** Developers and coding agents analyzing .NET repositories.

**Actors:** CodeGraph coordinator, C# plug-in, Roslyn helper, MCP or CLI caller.

**Preconditions:** A compatible helper and SDK exist, and one unambiguous solution or project set evaluates successfully.

**Postconditions:** One validated generation contains physical C# partitions queryable through unchanged schemas.

**Basic Course of Events (BCE):**

1. The shared registry routes C# sources and controls to the C# plug-in.
2. The helper evaluates the workspace with MSBuild.
3. Roslyn resolves declarations, references, calls, dependencies, and control flow.
4. The plug-in validates and converts results into existing partition schemas.
5. The coordinator validates all language batches and publishes one complete generation.
6. Existing queries return physical `.cs` declarations and edges.

**Alternate Flows:** A repository without a solution loads its deterministic root-contained projects; external references contribute semantic resolution without repository rows.

**Exceptions:** Ambiguous solutions, unavailable tooling, failed evaluation, compiler failure, or invalid helper output preserve the previous validated generation.

### 2. Refresh a C# change

**Goal:** Publish the smallest correct C# update and dependent closure.

**Stakeholders:** Developers relying on current references, callers, dead exports, and complexity.

**Actors:** Repository watcher, C# plug-in, Roslyn workspace, analyzer coordinator.

**Preconditions:** A compatible validated C# workspace exists and a watched source or control path changes.

**Postconditions:** Correct C# partitions are atomically published with all other language partitions, or the prior generation remains active.

**Basic Course of Events (BCE):**

1. The plug-in stages the physical source change in an immutable Roslyn solution.
2. It classifies body, project-internal, public-surface, membership, or control impact.
3. It rebuilds the document, project, reverse project closure, or workspace required by that impact.
4. The coordinator validates every staged analyzer result.
5. The coordinator commits plug-in state and publishes one generation.
6. Existing queries return the changed relationship.

**Alternate Flows:** A private body edit reuses unaffected project partitions; a public-surface edit rechecks reverse project references.

**Exceptions:** Cancellation, diagnostics, helper crash, invalidation uncertainty, or publication failure discards staged state and preserves the prior generation.

## Testing Requirements

- Add a focused unit test and integration coverage in `test/csharp-language-plugin.test.mjs`, extending `test/language-analyzer.test.mjs`, `test/source-policy.test.mjs`, `test/boundaries.test.mjs`, `test/engine.test.mjs`, `test/mcp-runtime.test.mjs`, `test/mcp-internals.test.mjs`, `test/mmap-query-cache.test.mjs`, `test/native-startup.test.mjs`, and `test/visualizer-e2e.test.mjs` only for shared contracts.
- Add .NET unit tests in `csharp-analyzer/test/CodeGraph.CSharpAnalyzer.Tests/ProtocolTests.cs`, `WorkspaceTests.cs`, `SemanticIndexerTests.cs`, `InternalGraphTests.cs`, and `IncrementalWorkspaceTests.cs`; add Node integration tests in `test/csharp-language-plugin.test.mjs`.
- Add a checked-in solution with library, consumer, and unrelated projects covering declarations, overloads, partials across zero/one/many files, generics, every visibility combination, attributes, calls, operators, properties, events, patterns, lambdas, local functions, top-level statements, references, unresolved candidates, project references, and circular graph behavior.
- Test zero/one/many solutions and projects, normalized solutionless project order, zero/one/many target frameworks, linked files inside/on/outside root, external semantic resolution without rows, source-generated target omission, private partition reuse, and the exact transitive reverse-project recheck set.
- Test descriptor validation, duplicate ownership, pattern control routing, one-time construction, O(1) extension lookup, cache keys, and source matching. Prove failed peer validation calls `discard` with zero commits, success commits every staged result exactly once, and stale/double commit or discard cannot advance the visible revision.
- Test every authored C# control-flow construct and exact physical UTF-16 location, including CRLF, Unicode, astral characters, generated-code filtering, and lowering deduplication.
- Test ambiguous solutions, missing/incompatible SDK and helper, restore/evaluation failures, diagnostics, linked/out-of-root files, unsupported projects, wrong-type/null/missing/empty and well-typed but semantically invalid payloads for every operation, malformed/truncated/out-of-order/unknown-ID replies, pending-request rejection, cancellation boundaries, timeouts, lazy restart, hydrate-before-retry, shutdown acknowledgment and TERM/KILL escalation, and preservation of the prior generation.
- Test C#-free, C#-only, and mixed repositories; assert other plug-in outputs remain byte-identical and no cross-language edges or partial generations appear.
- Test add/change/unlink and every invalidation class, including private body, same-project declaration, public API reverse-project cascade, project/control changes, source generators, and cache-key inputs.
- Run `node --experimental-test-coverage --test` and require 100% statements, branches, functions, and lines for every changed production JavaScript file. Run `dotnet test csharp-analyzer/CodeGraph.CSharpAnalyzer.sln -c Release --collect:'XPlat Code Coverage'` and require 100% lines, branches, and methods for changed helper code. Run focused and full suites, package/install checks, code guard, test guard, documentation validation, and diff validation with zero skips.
- Mutate extension collision, workspace selection, UTF-16 span validation, duplicate-ID and dangling-edge rejection, publication atomicity, and fingerprint classification and prove a named focused test fails for each mutation.
- Keep the frozen TypeScript benchmark unchanged. Add a separate frozen C# benchmark with five independent fresh-copy/fresh-helper lifecycles, reporting p50, p90, and MAD for cold index, indexed queries, internals, cyclomatic complexity, private leaf update, project update, public reverse-project cascade, and full reindex. Fail when median regression exceeds the larger of 5% or two baseline MADs, p90 exceeds 110% of baseline, semantic hashes drift, the source repository changes, samples are incomplete, or helper cleanup fails.

## Parallel / Dependent Breakdown

- The shared plug-in coordinator and TypeScript compatibility receipts from the Go plug-in plan must land first.
- C# fixtures and failing Node/.NET contract tests can be authored in parallel after the shared interface is frozen.
- Helper protocol, workspace loading, semantic indexing, internal graph construction, and fingerprints form one dependent .NET group.
- The Node descriptor, helper client, provisional resolver, semantic worker, and one built-in registration form one dependent plug-in group.
- Optional packaging and install behavior depend on a working helper artifact.
- Mixed-repository, failure, cache, and performance tests depend on the complete plug-in path.
- Current-state documentation depends on verified implementation receipts.

## Success Criteria

- C# is implemented as one analyzer plug-in with no C# conditionals in the shared graph pipeline.
- Evaluated C# solutions and projects produce deterministic existing-schema rows for root-contained authored declarations; generated and external targets are resolved for binding but intentionally omitted as graph endpoints.
- Source, project, and public-surface edits rebuild the smallest proven correct closure.
- Invalid C# work never publishes a partial generation.
- Repositories without C# incur no .NET startup or dependency cost.
- Existing TypeScript, JavaScript, Vue, and Go plug-in output remains unchanged.
- Existing MCP, CLI, storage, mmap, and visualization schemas remain unchanged.
- Frozen TypeScript and separate C# performance receipts pass their correctness and regression gates.
- Focused and full tests pass with zero skips, and code, test, documentation, package, and diff guards pass.
