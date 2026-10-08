---
modified: 2026-09-12
dependencies:
  - parsing-and-resolution.md
  - storage-and-query.md
  - visualizer.md
---

# MCP server and CLI

This subsystem is codegraph's two **entry points**: the MCP stdio server (`mcp.mjs`) that
exposes the graph to MCP clients, and the `codegraph` CLI (`cli.mjs`) that exposes a subset of
the same answers to a terminal. It also covers the per-repository runtime that keeps an MCP
session fresh (`mcp-runtime.mjs`), the engine facade both paths ultimately reach
(`tool-engine.mjs`), the raw engine harness (`tool.mjs`), and the trace profiler
(`trace-profile.mjs`).

Read this if you are changing a tool's name/schema/output, changing what triggers a rebuild,
debugging "why is codegraph answering with stale data", or reconciling the top-level `README.md`
against what the code actually does. Consult it before adding a tool, before changing the watch
policy, and before trusting `codegraph_dead` output. For how symbols and edges are produced see
`parsing-and-resolution.md`; for generations, partitions and the mmap query cache see
`storage-and-query.md`; for the `visualize` command's target see `visualizer.md`.

---

## Sensitive Areas

- **`codegraph_dead` (MCP) does not withhold framework-convention exports, but its own tool
  description says it does.** `mcp.mjs:68` states "Framework-convention exports are withheld from
  the output for this reason", yet the implementation (`mcp.mjs:263-269`) filters only on
  `symbol.exported && !referenced.has(symbol.id)` plus an optional path prefix. The framework
  filter (`FRAMEWORK_EXPORTS` at `cli.mjs:154-158`, `FRAMEWORK_FILES` at `cli.mjs:162-163`) exists
  only in the CLI's `cmdDead` (`cli.mjs:165-185`). An agent that trusts the MCP description will
  see Next.js route handlers, `page.tsx` default exports and `generateMetadata` in the list.
- **`runCli` in `mcp.mjs:99-112` is unreachable.** No entry in the `call` map uses it; every tool
  goes through `queryEngineFor`/`runtimeFor` in-process. `mcp.mjs:326-329` nonetheless exits the
  server with status 1 if `cli.mjs` is missing, so the server has a hard startup dependency on a
  file it never executes.
- **Watched-file set is hardcoded.** `SOURCE_EXTENSIONS` (`source-policy.mjs:8`) is a closed set:
  `.ts .tsx .js .jsx .mts .cts .mjs .cjs`. There is no registration hook, option, or env var to
  extend it. Every watch path in both runtimes funnels through `policy.acceptWatchPath`
  (`mcp-runtime.mjs:77`, `mcp-runtime.mjs:95`, `mcp.mjs:156`, `mcp.mjs:174`), so `.sql`, `.prisma`,
  `.json` (other than the control files below), `.vue`, `.svelte` and `.py` are never watched and
  never indexed. Only `.codegraphignore`, `.gitignore`, `jsconfig.json`, `tsconfig.json`
  (`source-policy.mjs:9`) are accepted as non-source paths, and a change to one forces a full
  rebuild (`tool-engine.mjs:115`).
- **Symlinked directories are silently excluded from watching.** `acceptWatchPath`
  (`source-policy.mjs:98-108`) walks every parent directory and returns `false` if any is a
  symlink, and returns `false` if `lstatSync` throws. Files under a symlinked directory can be
  indexed by `scan` but never receive change events.
- **The result cap is an error, not a truncation.** `MAX_MCP_RESULTS = 2_000` (`mcp.mjs:227`);
  exceeding it throws from `cappedRows` (`mcp.mjs:232`), from `codegraph_callers`
  (`mcp.mjs:258`) and from `codegraph_dead` (`mcp.mjs:267`). A large repo's `codegraph_dead` with
  no `prefix` fails outright rather than returning a partial list.
- **Tool errors are returned as successful JSON-RPC results.** `mcp.mjs:315` replies with
  `{ content: [...], isError: true }` rather than a JSON-RPC error, so a client that only checks
  for `error` sees the string `error: <message>` as content.
- **CLI and MCP read different index formats.** The CLI reads `.codegraph/graph.bin` +
  `meta.json` (`cli.mjs:39`, `cli.mjs:51-70`) and self-heals by shelling out to
  `tool.mjs build` (`cli.mjs:26-35`); the MCP path reads generations/partitions through
  `GraphStore` (`tool-engine.mjs`). The staleness test differs too: the CLI compares file mtimes
  against `meta.maxMtimeMs` with a 1000 ms slack (`cli.mjs:43-47`), while the MCP server compares
  content hashes and control hashes (`mcp.mjs:196-204`).
- **The CLI's mtime check cannot see added files.** `staleReason` iterates only
  `meta.files` (`cli.mjs:43`), so a brand-new source file does not mark the index stale.
- **`codegraph_index` and `codegraph_refresh` bypass the light watcher and force the full
  runtime** (`mcp.mjs:270`, `mcp.mjs:272-275` via `runtimeFor`), which loads the parser. They are
  not cheap calls.

## Design Constraints

- **No MCP SDK.** `mcp.mjs` speaks raw newline-delimited JSON-RPC on stdio
  (`mcp.mjs:288-290`, `mcp.mjs:331-344`), so the server needs nothing beyond node builtins plus
  the already-installed `chokidar` — stated as deliberate at `mcp.mjs:2-4`.
- **Repo-agnostic.** The target repository is a per-call `root` argument (`ROOT_PARAM`,
  `mcp.mjs:24-28`); `CODEGRAPH_ROOT` is only a fallback default (`mcp.mjs:16`, `mcp.mjs:123-133`).
  One server process serves many checkouts via the `runtimes`/`queryEngines` maps keyed by root
  (`mcp.mjs:137`, `mcp.mjs:149`).
- **Node >= 18, ESM only** (`package.json:44-46`, `"type": "module"`).
- **One recursive watch per repository.** `mcp-runtime.mjs:43-48` uses a single
  `fs.watch(root, { recursive: true })`; the comment records that per-path watching leaked ~900
  fds per repo on macOS kqueue and starved the network stack.
- **Freshness must be disclosed, never assumed.** `SCOPE` (`mcp.mjs:21-22`) is prefixed to every
  tool description (`mcp.mjs:97`), and `codegraph_query` returns `freshness`, `coverage`,
  `revision`, `validatedGeneration` as its first line (`mcp.mjs:283-285`).
- **Cancellation is honored.** `notifications/cancelled` aborts the request's `AbortController`
  (`mcp.mjs:295-298`, `mcp.mjs:311`), and every tool threads `signal` into the engine.
- **Explicit generation pins are always validated.** Combining `generation` with
  `consistency: 'latest'` is rejected (`mcp.mjs:280`).
- **CLI output is plain text for humans**; `tool.mjs` output is one JSON record per line
  (`tool.mjs:22-25`).

## Feature Overview

Codegraph's analysis engine is useless without a mouth. This subsystem is the mouth, in two
shapes for two consumers.

The MCP server exists because coding agents reach for `grep` and get wrong answers: text search
false-hits same-named symbols, misses re-exports and aliases, and cannot tell a
framework-invoked export from an unused one. Each tool description is written to steer the agent
away from those failure modes — `codegraph_dead`'s description is mostly a warning that its
output is not a deletion list (`mcp.mjs:68`).

`codegraph_internals` inspects one file's executable structure at a validated generation. It can return a normalized map, search structural nodes, find bounded intraprocedural paths, or report cyclomatic complexity, branch count, and nesting depth without reparsing the repository.

The server is in-process rather than a CLI shell-out because an MCP session is long-lived: it can
afford to keep a warm engine, a persistent index and a filesystem watcher per repository, so the
second query costs a memory read instead of a parse. A successful mapped query returns from the
validated mmap cache immediately, then starts the existing per-root runtime asynchronously. That
runtime reconciles persisted generation metadata without reading unchanged source. Every
`CodeGraphEngine` uses the same worker-owned pipeline: cold and multi-file indexing are batched,
while a one-file edit creates one parser job and validates only that file. Cached complete
partitions patch exact edge and dangling-reference records without dependent source access. That
warmth is staged. A first query
installs a cheap watcher only (`watchForChanges`, `mcp.mjs:183-195`) that loads no parser; the
first accepted change promotes it to the full `McpProjectRuntime` (`promoteRuntime`,
`mcp.mjs:153`). Native `fs.watch` failure (macOS FSEvents/fd exhaustion) degrades to a chokidar
polling watcher rather than going blind — both in the light path (`startPollingWatcher`,
`mcp.mjs:158-182`) and the full runtime (`#startFallback`, `mcp-runtime.mjs:58-87`), documented at
`mcp-runtime.mjs:63-64`.

The CLI exists for humans and for one-off scripted use where a persistent process is
inappropriate. It carries its own self-healing rebuild (`cli.mjs:26-35`) because the previous
behavior — warning on stderr — was swallowed by MCP clients, so the one signal that answers were
untrustworthy was the least likely to be seen (`cli.mjs:23-25`).

`tool.mjs` is the unadorned engine harness the CLI shells out to for builds, and the process
entry point for the query daemon and the line-oriented `serve` protocol.

## Architecture

```
MCP client ──stdio JSON-RPC──> mcp.mjs
                                 ├── TOOLS[]                (mcp.mjs:30-97)
                                 ├── call.<tool>            (mcp.mjs:238-286)
                                 ├── queryEngineFor(root)   (mcp-server.mjs:196-217)
                                 │     └── DaemonQueryEngine ──> runtimeFor(root)
                                 ├── watchForChanges(root)  light fs.watch  (mcp.mjs:183)
                                 │     └── startPollingWatcher  chokidar    (mcp.mjs:158)
                                 └── runtimeFor(root) ──> McpProjectRuntime (mcp-runtime.mjs)
                                                            ├── CodeGraphEngine
                                                            │     └── SemanticCheckerWorker
                                                            │          index / hydrate / validate / reference-overlay
                                                            ├── engine.reconcile()
                                                            ├── DebouncedBuildQueue (150 ms)
                                                            └── fs.watch → chokidar fallback

human ──> cli.mjs ──ensureIndex()──> .codegraph/graph.bin (CSR Int32Array)
             ├── index      ─execFileSync─> tool.mjs build ──> CodeGraphEngine
             └── visualize  ─execFileSync─> visualizer.mjs
```

Two independent read paths:

- **MCP path.** `queryEngineFor(root)` (`mcp-server.mjs:196-217`) lazily creates a `DaemonQueryEngine`
  whose `engineFactory` resolves to `(await runtimeFor(root)).engine`, registers the light
  watcher, and starts a one-shot background freshness check: if `diskMatchesGeneration`
  (`mcp-server.mjs:187-195`)
  finds the on-disk generation's control hashes, file list and per-file content hashes all match,
  the mapped answer remains immediately available. After any successful mapped tool call,
  `handle` calls `promoteRuntime(root)` without awaiting it (`mcp-server.mjs:321-331`), starting
  the per-root runtime in the background. An unchanged reconcile compares persisted metadata and
  starts no semantic worker; the first accepted edit creates it lazily. `latest` queries and true
  cache misses still await the runtime.
- **CLI path.** `loadIndex` (`cli.mjs:51-70`) mmap-style reads a flat `Int32Array` of two CSR
  adjacency structures (forward and reverse: `offsets`, `target`, `line`, `call`) plus a
  `meta.json` symbol/file table, and builds a name → ids map. No type checker at query time
  (`cli.mjs:2-3`).

`McpProjectRuntime.start()` (`mcp-runtime.mjs:33-56`) reconciles the engine, snapshots
`engine.registeredFiles()`, then wires a `DebouncedBuildQueue` (150 ms default,
`mcp-runtime.mjs:32`) that calls `engine.incremental(events)` and maintains the registered set.
The queue collapses event pairs before draining (`mcp-runtime.mjs:10-14`): add+unlink cancels,
unlink+add becomes add, add+change stays add.

`enqueue` (`mcp-runtime.mjs:90-96`) derives `add`/`change`/`unlink` from disk plus the registered
set because `fs.watch` reports only `rename`/`change`, and gates non-unlink events on
`policy.acceptWatchPath(file)` (`mcp-runtime.mjs:95`).

## Functions

### `mcp.mjs`

| Function | Line | What it does |
| --- | --- | --- |
| `TOOLS` | 30-97 | The seven tool descriptors; `.map` at 97 prefixes `SCOPE` to every description |
| `runCli` | 99-112 | Shells out to `cli.mjs` with `--root`. **Unreferenced by any tool.** |
| `required(a, key)` | 115-121 | Rejects a missing/blank string argument rather than `String(undefined)` |
| `resolveRoot(a)` | 123-133 | `a.root` → `CODEGRAPH_ROOT` → throw; resolves and asserts it is a directory |
| `runtimeFor(root)` | 138-147 | Memoized `McpProjectRuntime(root).start()`; stops the light watcher first; deletes the map entry on failure |
| `stopLightWatcher` / `promoteRuntime` | 152-153 | Close the light watcher; promote to full runtime, reporting failures to stderr |
| `isWatchedChange` | 154-157 | `acceptWatchPath(file)` OR (file gone AND `isSourceRelative(rel)`) — the deletion case |
| `startPollingWatcher` | 158-182 | chokidar `usePolling` fallback; `ignored` predicate mirrors the runtime's |
| `watchForChanges` | 183-195 | Light recursive `fs.watch`; falls back to polling on throw or `error` |
| `diskMatchesGeneration` | 196-204 | Control hashes + file list + per-file content hashes vs the stored generation |
| `queryEngineFor` | 196-217 | Creates/returns the `DaemonQueryEngine` and starts the background freshness check |
| `cappedRows` | 228-236 | Drains an async iterator, aborting on `signal` and throwing past `MAX_MCP_RESULTS` |
| `loc(graph, id)` | 237 | `file:line` for a symbol id, or the raw id |
| `handle(req)` | 292-322 | `notifications/cancelled`, `initialize`, `tools/list`, `tools/call`, `ping`; unknown → `-32601` |
| stdin reader | 331-344 | Newline-delimited JSON-RPC framing; bad JSON logged to stderr |
| stdin `end` | 345-349 | Closes light watchers, then all runtimes, then all query engines |

Tool implementations (`mcp.mjs:238-286`) — the real request each builds:

| Tool | Line | Engine request |
| --- | --- | --- |
| `codegraph_refs` | 238-242 | `pinQuery({ type:'refs', edgeCoverage:'complete', resolved:true, ...qualifiedQuery(symbol) })` |
| `codegraph_deps` | 243-248 | `pinQuery({ type:'deps', resolved:true, ...qualifiedQuery(target) })` |
| `codegraph_callers` | 249-262 | `pinQuery({ type:'graph', edgeCoverage:'calls', limit:1 })`, then a local BFS over a reversed call-edge map |
| `codegraph_dead` | 263-269 | `pinQuery({ type:'graph', edgeCoverage:'complete', limit:1 })`, then `exported && !referenced` |
| `codegraph_index` | 270 | `(await runtimeFor(root)).engine.build()` |
| `codegraph_refresh` | 272-275 | `runtime.engine.reconcile()` |
| `codegraph_query` | 276-286 | Passes the caller's `query` through with a resolved `consistency` and a clamped `limit` |
| `codegraph_internals` | 329 | Returns generation-pinned `map`, `search`, `paths`, or `metrics` records for one file |

### `cli.mjs`

`rebuild(why)` (26-35) execs `tool.mjs build --root ROOT`; `staleReason()` (38-49) returns the
reason string or `null`; `loadIndex()` (51-70) decodes the CSR buffer; `ensureIndex()` (74-78)
rebuilds if stale then loads; `resolve(query)` (91-100) accepts `file.ext` (all non-module
symbols in it), `file.ext:name`, or `name`; `edges(csr, id, callsOnly)` (81-88) walks CSR
adjacency; `cmdRefs` (102-115), `cmdDeps` (117-127, restricted to `fn`/`method`/`class` kinds),
`cmdCallers` (131-149, frontier expansion over an `Int32Array` visited bitset), `cmdDead`
(165-185).

### `mcp-runtime.mjs`

`DebouncedBuildQueue` — `push` (8-18), `hasPending` (19), `#drain` (20-25), `idle` (26),
`#settle` (27), `close` (28). `McpProjectRuntime` — `start` (33-56), `#report` (57),
`#startFallback` (58-87), `enqueue` (90-96), `close` (97).

### `tool-engine.mjs` (consistency mechanism)

- `applyChanges` / `applyFileChanges` record changed sources and schedule worker validation.
- `#scheduleValidation` (468-478) allows at most one active plus one pending validation; a
  superseded pending request resolves `null`.
- `#runValidation` hands the pinned generation, source ids, and changes to
  `SemanticCheckerWorker.validate`. A one-file request starts the worker lazily if an unchanged
  restart did not need one. Direct reconcile and daemon-driven refresh use this same path.
- `build` delegates initial parsing to worker `index`. An unchanged reconcile adopts persisted
  generation metadata without source reads or worker startup. The coordinator accepts only exact
  source/partition membership and matching file/source hashes when a worker result is present.
- `#acceptValidation` discards stale revisions/epochs and validates the worker receipt against the
  pinned generation. A delta must contain exactly one changed/add partition or unlink tombstone;
  extra or dependent partitions are rejected. It reuses unchanged partition ids, patches dangling
  edge status from cached complete partitions, publishes a complete manifest, and returns
  `validationMode` plus sorted `validatedFiles` diagnostics.
- `pinQuery` serves a published validated generation, preferring a cached `complete` view for
  `refs`/`graph`.
- `#completeQueryView` returns current complete generations directly. It materializes a validated
  compatibility overlay only for an older calls-only generation.
- `#buildReferenceOverlay` is therefore a legacy compatibility path. It validates exact fragment
  membership and every edge before writing; malformed worker output publishes no partial overlay.
- `build` publishes `edgeCoverage: 'complete'`; `#incremental` submits one changed source or unlink
  tombstone to worker validation and retains unchanged complete partitions.

### `tool.mjs`

Arg parsing and `--profile` validation (6-14); commands `build` (27), `incremental <events>` (31),
`reconcile` (36), `query <request>` (40), `daemon` (46), `serve` (53, max 8 concurrent, `cancel`
op at 71); usage string at 78.

### `trace-profile.mjs`

`createTraceProfiler(destination, deps)` returns `null` when `destination === undefined` (7) —
this is how profiling stays entirely off by default. Otherwise `begin(name, args, {memory})`
(19-31), `end(token)` (32-43), and `write()` (44-54), which writes Chrome Trace Event JSON to a
`.pid.timestamp.tmp` sibling with mode `0o600` and renames it into place.

The build trace contract is phase-based, not an interleaving guarantee: the optimized batched
order is `codegraph.build`, `scan`, `read-sources`, `semantic-project`, `parse-index`, `publish`.
Semantic work may execute inside the worker while the coordinator records the enclosing phase.

## Models

**Tool input schemas as declared** (`mcp.mjs:30-97`). Every tool takes the optional `root`
string; the type is `object` in all cases.

| Tool | Properties | Required |
| --- | --- | --- |
| `codegraph_refs` | `symbol` (string), `root` | `symbol` |
| `codegraph_callers` | `symbol` (string), `depth` (integer, default 3 at `mcp.mjs:250`), `root` | `symbol` |
| `codegraph_deps` | `target` (string), `root` | `target` |
| `codegraph_dead` | `prefix` (string), `root` | *(none)* |
| `codegraph_index` | `root` | *(none)* |
| `codegraph_refresh` | `root` | *(none)* |
| `codegraph_query` | `query` (object), `root` | `query` |

**Tool output shapes** — every response is a single `{ type: 'text', text }` content block
(`mcp.mjs:313`); there is no structured content.

- `codegraph_refs` — newline-separated `from.file:from.line -> to.file:to.line[ call]`, or
  `(no results)` (`mcp.mjs:241`).
- `codegraph_deps` — line 1 is `JSON.stringify(pinned.metadata)` (the full metadata object, not
  the four-field subset), then the same edge lines (`mcp.mjs:247`).
- `codegraph_callers` — an indented tree, two spaces per level, of `file:line`
  (`mcp.mjs:257`, `mcp.mjs:261`).
- `codegraph_dead` — header `"<n> export(s) with no resolved reference. NOT PROOF OF DEAD
  CODE."` then `file:line  name` per row (`mcp.mjs:268`).
- `codegraph_index` — `JSON.stringify(engine.build())`: `{ generation, edgeCoverage: 'complete',
  parsedFiles, reusedFiles }` (`tool-engine.mjs:109`).
- `codegraph_refresh` — `JSON.stringify(engine.reconcile())`: `{ generation, edgeCoverage,
  parsedFiles, reusedFiles, validationMode?, validatedFiles? }`. Validation completes
  asynchronously and fills these diagnostics after its `validation` promise resolves.
- `codegraph_query` — line 1 is `{ freshness, coverage, revision, validatedGeneration }`
  (`mcp.mjs:283-285`), then one JSON row per line.

**Consistency modes.** `query.consistency` accepts `'latest'` and `'validated'`, defaulting to
`'validated'`. Both serve a published worker-validated generation; an explicit `generation` pins
that generation and cannot be combined with `'latest'`.

**Watch event.** `{ type: 'add' | 'change' | 'unlink', path: <repo-relative posix> }`, optionally
carrying `source` (`mcp-runtime.mjs:95`, `tool-engine.mjs:129`).

**Watched file set.** `SOURCE_EXTENSIONS = { .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs }`
(`source-policy.mjs:8`) plus `CONTROL_FILES = [.codegraphignore, .gitignore, jsconfig.json,
tsconfig.json]` (`source-policy.mjs:9`). Closed sets — no registration hook exists.

**CLI index format** (`cli.mjs:51-70`): `graph.bin` is `[n, m, fwd.offsets(n+1),
fwd.target(m), fwd.line(m), fwd.call(m), rev.offsets(n+1), rev.target(m), rev.line(m),
rev.call(m)]` as `Int32Array`; `meta.json` holds `{ files: string[], symbols: [{ name, file,
line, kind, exp }], maxMtimeMs }`.

**Dead-export withholding sets** (CLI only): `FRAMEWORK_EXPORTS` — `GET POST PUT PATCH DELETE
HEAD OPTIONS default middleware generateMetadata generateStaticParams generateViewport metadata
viewport revalidate dynamic dynamicParams runtime fetchCache preferredRegion maxDuration`
(`cli.mjs:154-158`). `FRAMEWORK_FILES` — a regex over Next.js file conventions `page layout route
template default error global-error loading not-found sitemap robots manifest icon apple-icon
opengraph-image twitter-image instrumentation middleware` with `.ts|.tsx|.js|.jsx`
(`cli.mjs:162-163`), because a default export keeps its own function name and a name check alone
misses it.

**Environment variables.** `CODEGRAPH_ROOT` only, read in four places: `cli.mjs:13`,
`mcp.mjs:16`, `tool.mjs:8`, `visualizer.mjs:12`. In `mcp.mjs` it is a fallback default and also
triggers an eager warm-up at startup (`mcp.mjs:351`). No other env var is read by this subsystem.

**Trace event** (`trace-profile.mjs:21`): `{ name, cat: 'codegraph', ph: 'X', ts, dur, pid, tid,
args }`, with `<field>Before/After/Delta` for `rss heapUsed heapTotal external arrayBuffers` when
`{ memory: true }`.

## Use Cases

### 1. Resolve every reference to a symbol (`codegraph_refs`)

- **Goal.** Find all type-resolved references to a symbol before renaming, changing a signature,
  or deleting it.
- **Stakeholders.** The developer whose refactor must not miss a call site; reviewers relying on
  the change being complete.
- **Actors.** An MCP client (coding agent) calling `codegraph_refs`.
- **Preconditions.** The server process is running; `root` resolves to an existing directory
  (`mcp-server.mjs:111-124`); the repository contains at least one file matching `SOURCE_EXTENSIONS`.
- **Basic Course of Events.**
  1. Client sends `tools/call` with `{ name: 'codegraph_refs', arguments: { symbol, root } }`.
  2. `handle` registers an `AbortController` under the request id (`mcp-server.mjs:319`).
  3. `resolveRoot` resolves, canonicalizes, and validates `root` (`mcp-server.mjs:111-124`).
  4. `queryEngineFor(root)` returns the memoized `DaemonQueryEngine`, installs the light watcher,
     and starts a background freshness check; a matching stored generation remains available to
     the mapped query immediately (`mcp-server.mjs:196-217`).
  5. `required(a, 'symbol')` then `qualifiedQuery` split the target into `{ name, file }`
     (`mcp.mjs:239`).
  6. `engine.pinQuery({ type:'refs', edgeCoverage:'complete', resolved:true, ...target })` selects
     a validated view, preferring a cached `complete` view (`tool-engine.mjs:281-284`); a missing
     complete view is materialized by the reference overlay (`tool-engine.mjs:253-274`).
  7. `cappedRows` drains the row iterator under the 2 000-row cap (`mcp.mjs:228-236`).
  8. Rows are formatted `from.file:from.line -> to.file:to.line[ call]` (`mcp.mjs:241`).
  9. After the mapped answer succeeds, `handle` starts `promoteRuntime(root)` without awaiting it,
     replies with one text content block, and removes the controller in `finally`
     (`mcp-server.mjs:321-331`).
- **Alternate Flows.**
  - `symbol` is `file.ts:name` — `qualifiedQuery` yields both `name` and `file`, and matching
    accepts an exact or suffix file match (`tool-engine.mjs:302`).
  - No rows match — the text is `(no results)` (`mcp.mjs:241`).
  - `root` omitted with `CODEGRAPH_ROOT` set — the env default is used (`mcp.mjs:124`), and that
    root was already warmed at startup (`mcp.mjs:351`).
  - Disk did not match the stored generation — the freshness check starts `runtimeFor` in the
    background; mapped validated reads remain non-blocking, while `latest` queries and cache misses
    await the runtime (`mcp-server.mjs:206-215`, `daemon-query-engine.mjs:42-53`, `96-103`).
- **Exceptions.**
  - `symbol` missing/blank → `missing required argument "symbol"` (`mcp.mjs:118`).
  - `root` missing and no `CODEGRAPH_ROOT` → `missing required argument "root"` (`mcp.mjs:126`).
  - `root` not a directory → `"<root>" is not a valid directory` (`mcp.mjs:130`).
  - More than 2 000 rows → `result exceeds MCP cap of 2000; narrow the query` (`mcp.mjs:232`).
  - Client cancels → `notifications/cancelled` aborts the controller (`mcp.mjs:296`) and the loop
    throws `request cancelled` (`mcp.mjs:231`).
  - Any throw is returned as `error: <message>` with `isError: true` (`mcp.mjs:315`).
- **Postconditions.** The client holds every resolved reference edge for the symbol at the served
  generation. The generation and index are unchanged; a watcher is registered and the per-root
  runtime is registered for later edits.

### 2. Trace how execution reaches a function (`codegraph_callers`)

- **Goal.** Walk upward from a symbol to the entry points that can reach it.
- **Stakeholders.** Whoever must understand or change a request path without reading every
  intermediate file.
- **Actors.** An MCP client calling `codegraph_callers`.
- **Preconditions.** As UC-1, and the served complete generation includes call edges.
- **Basic Course of Events.**
  1. Client sends `{ symbol, depth?, root? }`.
  2. `queryEngineFor(root)` yields a warm engine (as UC-1 steps 3-4).
  3. `pinQuery({ type:'graph', edgeCoverage:'calls', limit:1 })` returns the whole graph as one
     row (`mcp.mjs:250`).
  4. `depth` is coerced: `Math.max(0, Number(a.depth ?? 3))` (`mcp.mjs:250`).
  5. Root symbols are selected by name and optional exact-or-suffix file match
     (`mcp.mjs:252`).
  6. A reverse map is built from call edges only (`edge.call` truthy) (`mcp.mjs:253`).
  7. A breadth-first frontier walk emits `'  '.repeat(level) + file:line`, skipping already-seen
     ids and stopping at `level === depth` (`mcp.mjs:254-260`).
  8. The indented tree is returned as text (`mcp.mjs:261`).
- **Alternate Flows.**
  - `depth: 0` — only the matched roots are printed.
  - Negative or non-numeric `depth` — clamped to 0 by `Math.max(0, Number(...))`; `NaN` fails the
    `level < depth` comparison, so the walk stops after the roots.
  - Symbol matched in several files — every match seeds the frontier (`mcp.mjs:254`).
  - No match — `(no results)` (`mcp.mjs:261`).
- **Exceptions.**
  - Missing `symbol` / bad `root` — as UC-1.
  - Output exceeding 2 000 lines → `result exceeds MCP cap of 2000; lower depth`
    (`mcp.mjs:258`).
  - Cancellation mid-walk → `request cancelled` (`mcp.mjs:256`).
- **Postconditions.** The client holds a depth-bounded inverted call tree. Nothing on disk
  changed.

### 3. Scope a refactor by outgoing dependencies (`codegraph_deps`)

- **Goal.** See what a file or symbol calls, in-repo only.
- **Stakeholders.** The developer judging refactor blast radius or looking for seams in an
  oversized module.
- **Actors.** An MCP client calling `codegraph_deps`.
- **Preconditions.** As UC-1; `target` is a repo-relative file path or a symbol name.
- **Basic Course of Events.**
  1. Client sends `{ target, root? }`.
  2. `queryEngineFor(root)` yields a warm engine.
  3. `required(a, 'target')` then `qualifiedQuery(target)` build
     `{ type:'deps', resolved:true, ... }` (`mcp.mjs:244-245`).
  4. `pinQuery` serves the validated `calls`-coverage view — `deps` does not request the complete
     overlay (`tool-engine.mjs:281-282`).
  5. `cappedRows` drains the rows (`mcp.mjs:246`).
  6. The response is `JSON.stringify(metadata)` on line 1 followed by the edge lines
     (`mcp.mjs:247`).
- **Alternate Flows.**
  - `target` is a file path — `qualifiedQuery` yields `{ file }` with no `name`, so every symbol
    in the file contributes its outgoing edges (`tool-engine.mjs:302-307`).
  - No outgoing edges — the edge section is `(no results)` while line 1 still carries metadata.
- **Exceptions.**
  - Missing `target` → `missing required argument "target"` (`mcp.mjs:118`).
  - Over the cap → `result exceeds MCP cap of 2000; narrow the query` (`mcp.mjs:232`).
  - Cancellation → `request cancelled`.
- **Postconditions.** The client holds the resolved outgoing edges plus the freshness metadata of
  the view they came from.

### 4. List exports with no external reference (`codegraph_dead`)

- **Goal.** Produce a candidate list of exports that no other file references, for a human to
  judge.
- **Stakeholders.** The developer considering deletion; everyone who suffers if a
  framework-invoked export is deleted.
- **Actors.** An MCP client calling `codegraph_dead`, or a human running `codegraph dead`.
- **Preconditions.** As UC-1. For the MCP path, the complete-coverage view can be materialized
  (`tool-engine.mjs:253-274`).
- **Basic Course of Events (MCP path).**
  1. Client sends `{ prefix?, root? }` — no argument is required.
  2. `queryEngineFor(root)` yields a warm engine.
  3. `pinQuery({ type:'graph', edgeCoverage:'complete', limit:1 })` returns the graph
     (`mcp.mjs:264`).
  4. A `referenced` set is built from every `edge.to` (`mcp.mjs:264`).
  5. Symbols are filtered to `exported && !referenced.has(id)`, plus `file.startsWith(prefix)`
     when `prefix` is given (`mcp.mjs:265`).
  6. The response is the count, the literal warning `NOT PROOF OF DEAD CODE.`, then
     `file:line  name` per row (`mcp.mjs:268`).
- **Alternate Flows.**
  - **CLI path (`codegraph dead [prefix]`).** `ensureIndex()` rebuilds if stale
    (`cli.mjs:216`), then `cmdDead` (`cli.mjs:165-185`) skips `module`-kind symbols, keeps a
    symbol only when no reverse edge originates in a *different* file (`cli.mjs:171`), and — this
    is what "respecting framework conventions" means in code — counts as `withheld` and omits any
    symbol whose name is in `FRAMEWORK_EXPORTS` or whose file matches the `FRAMEWORK_FILES`
    Next.js-convention regex (`cli.mjs:172-176`). Output states the withheld count
    (`cli.mjs:179-181`), the `NOT PROOF OF DEAD CODE` line, and
    `Do NOT delete anything from this list without explicit human approval.` (`cli.mjs:182-183`).
  - **CLI `--include-framework`.** `cli.mjs:225` passes the flag so withheld symbols are listed
    anyway (still counted as withheld only when the flag is absent).
  - Empty result — the count line reads `0 export(s)` and no rows follow.
- **Exceptions.**
  - Result over 2 000 rows (MCP) → `result exceeds MCP cap of 2000; pass a path prefix`
    (`mcp.mjs:267`).
  - Cancellation before filtering → `request cancelled` (`mcp.mjs:266`).
  - CLI with no index → `rebuild('no index')`; a failed rebuild exits 1 with
    `index rebuild failed: ...` (`cli.mjs:33`).
- **Postconditions.** The client holds a candidate list carrying its own not-proof warning. No
  code is modified by this tool. On the MCP path a complete-coverage overlay may now be cached on
  disk (`tool-engine.mjs:440`).

### 5. Force a full build or reconcile with disk (`codegraph_index`, `codegraph_refresh`)

- **Goal.** Rebuild the graph from scratch, or bring the persistent incremental index back in
  line with disk.
- **Stakeholders.** The agent whose previous answers looked stale; anyone debugging watcher
  failure.
- **Actors.** An MCP client calling `codegraph_index` or `codegraph_refresh`.
- **Preconditions.** `root` resolves to a directory. Both calls load the parser, so the full
  runtime will exist afterward.
- **Basic Course of Events (`codegraph_index`).**
  1. Client sends `{ root? }`.
  2. `runtimeFor(root)` stops any light watcher and starts `McpProjectRuntime`, which itself
     reconciles and installs the recursive watcher (`mcp.mjs:138-147`,
     `mcp-runtime.mjs:33-56`).
  3. `engine.build()` is enqueued on the engine's serialized operation tail
     (`tool-engine.mjs:77`, `462-467`).
  4. `#build` discards prior state, re-creates the source policy, scans, and reads sources. In the
     persistent runtime it asks the semantic worker to index and retain the project; a short-lived
     engine uses the local build path. The coordinator validates every returned partition before it publishes
     `{ version: 3, edgeCoverage: 'complete' }`.
  5. `validatedGeneration`, `validatedSourceBlobs` and `validationEpoch` are advanced and
     `validationChanges` cleared (`tool-engine.mjs:104-107`).
  6. The result object is returned as JSON text (`mcp.mjs:270`).
- **Alternate Flows.**
  - **`codegraph_refresh`.** `engine.reconcile()` (`mcp.mjs:272-275`) compares control hashes
    first and delegates to `#build` if they moved (`tool-engine.mjs:154-157`); otherwise it
    compares scan metadata with persisted `sourceMetadata`, reads only added or changed sources,
    and runs `#incremental` when events result; with no events it adopts the validated generation
    without reading source blobs or starting a semantic worker.
  - **CLI `codegraph index`.** `cli.mjs:202-206` execs `tool.mjs build --root ROOT` with inherited
    stdio and exits — deliberately forwarding `--root` so `tool.mjs` does not index cwd.
  - A profiler is configured (`tool.mjs --profile <path>`) — the result carries
    `{ profile: { path, format: 'chrome-trace-event' } }` and a trace file is written
    (`tool-engine.mjs:581-587`, `trace-profile.mjs:44-54`).
- **Exceptions.**
  - Worker index/hydrate rejects or returns malformed membership — the operation fails, readiness
    is cleared, and `CURRENT` remains absent or byte-identical; an existing validated generation
    remains queryable. Persistent reconcile does not silently create a main-thread fallback project.
  - If no stored generation exists, `#reconcile` runs the same worker-owned full build.
  - The engine is disposed — `codegraph engine is disposed` (`tool-engine.mjs:463`).
  - `--profile` with no path (CLI/`tool.mjs`) — exits 1 with
    `codegraph: --profile requires a file path` (`tool.mjs:10-13`).
- **Postconditions.** A new generation is published and `validatedGeneration` points at it; a full
  `McpProjectRuntime` with a recursive watcher now exists for `root`.

### 6. Query the graph with an explicit consistency mode (`codegraph_query`)

- **Goal.** Read a checker-validated graph, optionally pinned to a stored generation.
- **Stakeholders.** Consumers that need stable graph generation metadata.
- **Actors.** An MCP client calling `codegraph_query`.
- **Preconditions.** `root` resolves; `query` is an object with a `type` the engine understands
  (`symbols`, `refs`, `deps`, `graph` — `tool-engine.mjs:308-316`).
- **Basic Course of Events.**
  1. Client sends `{ query: { type, ... }, root? }`.
  2. `queryEngineFor(root)` yields a warm engine (`mcp.mjs:277`).
  3. `query` is asserted to be an object (`mcp.mjs:278`).
  4. `consistency` is resolved: `'validated'` if `query.generation` is present, else
     `query.consistency ?? 'validated'` (`mcp.mjs:279`).
  5. `limit` is clamped to `min(query.limit ?? 2000, 2000)` (`mcp.mjs:281`).
  6. `pinQuery` picks the requested validated generation.
  7. `cappedRows` drains the rows (`mcp.mjs:282`).
  8. Line 1 is `{ freshness, coverage, revision, validatedGeneration }`; each subsequent line is
     one JSON row (`mcp.mjs:283-285`).
- **Alternate Flows.**
  - `consistency: 'latest'` — the latest published worker-validated generation is served.
  - `query.generation` pinned — always validated, and the pinned generation is echoed back as
    `validatedGeneration` (`tool-engine.mjs:284`).
  - `type: 'refs'` or `'graph'` under `validated` — a cached complete-coverage view is preferred,
    so `coverage` may come back `'complete'` rather than `'calls'`
    (`tool-engine.mjs:282`).
  - `resolved: true` on `refs`/`deps` — each row gains `fromSymbol`/`toSymbol` endpoint objects
    (`tool-engine.mjs:322-332`).
- **Exceptions.**
  - `query` missing or not an object → `missing required argument "query"` (`mcp.mjs:278`).
  - `generation` combined with `consistency: 'latest'` → `explicit generation is validated and
    cannot be combined with latest consistency` (`mcp.mjs:280`).
  - Unknown `type` → `unknown query type: <type>` (`tool-engine.mjs:316`).
  - `complete` coverage requested for a generation that has not materialized one →
    `complete query view for <generation> has not been materialized` (`tool-engine.mjs:403`).
  - Over the cap → `result exceeds MCP cap of 2000; narrow the query` (`mcp.mjs:232`).
- **Postconditions.** The client holds rows plus the metadata identifying exactly which view
  produced them.

### 7. Keep an MCP session fresh as files change (watcher)

- **Goal.** Have subsequent queries reflect edits without the client asking for a rebuild.
- **Stakeholders.** The agent editing and re-querying in the same session.
- **Actors.** The filesystem (via `fs.watch` or chokidar polling) as the triggering actor; the
  `DebouncedBuildQueue` as the scheduled worker.
- **Preconditions.** At least one query has been served for `root`, so `queryEngineFor` installed
  a watcher and the successful call started background runtime hydration
  (`mcp-server.mjs:196-217`, `321-331`). The changed path satisfies `policy.acceptWatchPath`, i.e. its
  extension is in `SOURCE_EXTENSIONS` or it is one of the four control files, it is not ignored,
  and no ancestor directory is a symlink (`source-policy.mjs:74`, `98-108`).
- **Basic Course of Events.**
  1. A developer writes a `.ts` file inside `root`.
  2. The successful earlier query already called `promoteRuntime`, which closed the light watcher
     and memoized the full `McpProjectRuntime` (`mcp-server.mjs:129-144`, `321-331`).
  3. The runtime reconciles stored metadata without reading unchanged source. If no worker was
     required at startup, the first accepted edit starts it lazily.
  4. `start()` reconciles the engine, snapshots `registeredFiles()`, creates the
     `DebouncedBuildQueue`, and installs one recursive `fs.watch` for the tree
     (`mcp-runtime.mjs:33-56`).
  5. Further writes call `enqueue(null, file)`, which normalizes the path, drops ignored paths,
     derives `add`/`change`/`unlink` from disk plus the registered set, and gates non-unlink
     events on `policy.acceptWatchPath` (`mcp-runtime.mjs:90-96`).
  6. The queue coalesces pending events per path and drains after 150 ms of quiet
     (`mcp-runtime.mjs:8-25`).
  7. `engine.incremental(events)` parses and resolves only the changed file, publishes the provisional
     revision, and schedules background semantic validation
     (`tool-engine.mjs:112-148`, `194-222`, `468-478`).
  8. Validation processes exactly that file (or one unlink tombstone); `#acceptValidation` patches
     cached edge/dangling status and publishes a new generation, advancing
     `validatedGeneration` (`tool-engine.mjs:507-532`).
  9. The next `validated` query serves the new generation; a `latest` query would already have
     served the provisional revision.
- **Alternate Flows.**
  - Native `fs.watch` throws or emits `error` — the light path falls back to a chokidar polling
    watcher (`mcp.mjs:193-194`, `158-182`) and the full runtime to `#startFallback`
    (`mcp-runtime.mjs:50`, `58-87`), deliberately trading CPU for surviving exhausted macOS watch
    resources (`mcp-runtime.mjs:63-64`).
  - A control file changes — `#incremental` detects it and escalates to a full `#build`
    (`tool-engine.mjs:115`).
  - A file is deleted — `acceptWatchPath` fails on a nonexistent path, so `isWatchedChange` falls
    back to `!fs.existsSync(file) && policy.isSourceRelative(rel)` (`mcp.mjs:156`); the runtime
    enqueues `unlink` only when the path is registered or already pending
    (`mcp-runtime.mjs:95`).
  - Multiple disk-backed files change at once — their source text is submitted together for
    worker validation.
  - A `.sql`, `.prisma`, `.json` (non-control) or other non-listed file changes — no event is
    accepted anywhere and nothing is re-indexed.
  - A newer change arrives while validation is in flight — the pending validation is superseded
    and resolves `null`; the stale result is discarded on epoch/revision mismatch
    (`tool-engine.mjs:473-476`, `509`).
- **Exceptions.**
  - `engine.incremental` throws — `DebouncedBuildQueue` routes it to `onError` and keeps running
    (`mcp-runtime.mjs:24`); `McpProjectRuntime` reports watcher errors through `#report`
    (`mcp-runtime.mjs:57`).
  - The full runtime fails to start — the error is written to stderr and the map entry deleted so
    the next change retries (`mcp.mjs:144`, `153`).
  - `chokidar` import or construction fails — the light path promotes the full runtime directly
    (`mcp.mjs:181`), and the runtime reports and gives up on fallback watching
    (`mcp-runtime.mjs:86`).
  - stdin closes — all light watchers are stopped, then runtimes closed, then query engines
    disposed (`mcp.mjs:345-349`).
- **Postconditions.** A full `McpProjectRuntime` exists for `root` with exactly one recursive
  watcher (or one polling watcher), and the published generation reflects the accepted changes.

### 8. Answer the same questions from a terminal (CLI)

- **Goal.** Get refs/deps/callers/dead answers, a rebuild, or the visualizer from a shell,
  without a persistent server.
- **Stakeholders.** A developer at a terminal; scripts and CI steps.
- **Actors.** A human (or script) invoking `codegraph <command>` (`package.json:7-9` binds the
  `codegraph` bin to `cli.mjs`).
- **Preconditions.** `ROOT` — `--root <dir>`, else `CODEGRAPH_ROOT`, else cwd — exists and is a
  directory (`cli.mjs:9-17`).
- **Basic Course of Events.**
  1. The user runs e.g. `codegraph refs Foo --root /repo`.
  2. `--root` and its value are stripped from `argv` before command parsing
     (`cli.mjs:187-188`).
  3. `help`/no command prints the command list and exits 0 (`cli.mjs:190-200`); `index` and
     `visualize` exec out and exit before any index load (`cli.mjs:202-214`) — deliberate, so
     neither triggers a build merely by starting up (`cli.mjs:72`).
  4. `ensureIndex()` runs `staleReason()`; a non-null reason prints `# <why> — rebuilding index
     for <repo>…` to stderr and execs `tool.mjs build` (`cli.mjs:26-35`, `74-78`).
  5. `loadIndex()` decodes `graph.bin` into forward/reverse CSR arrays and builds the name index
     (`cli.mjs:51-70`).
  6. `--verbose` prints `# <n> symbols, <m> edges in <root>` to stderr (`cli.mjs:217`).
  7. `depth` is read from `--depth N`, default 3 (`cli.mjs:219-220`).
  8. The command runs: `refs` → `cmdRefs`, `deps` → `cmdDeps`, `callers` → `cmdCallers`,
     `dead` → `cmdDead` (`cli.mjs:222-226`), printing to stdout.
- **Alternate Flows.**
  - Query is a bare file name (`Foo.tsx`) — `resolve` matches the file by suffix and returns every
    non-`module` symbol declared in it (`cli.mjs:92-95`).
  - Query is `file.ts:name` — name ids are filtered by file suffix (`cli.mjs:97-99`).
  - `codegraph visualize [--port N]` — args are forwarded to `visualizer.mjs` with `--root`
    (`cli.mjs:208-214`); see `visualizer.md`.
  - `codegraph dead --include-framework` — framework-convention exports are listed rather than
    withheld (`cli.mjs:225`, `cli.mjs:179`).
  - `codegraph callers X --depth 1` — the recursive walk stops one level up; a repeated id is
    printed with a ` (seen)` marker instead of being re-expanded (`cli.mjs:139-140`).
- **Exceptions.**
  - `ROOT` not a directory → exit 1 with `pass --root <repo> or set CODEGRAPH_ROOT`
    (`cli.mjs:14-17`).
  - No `graph.bin` at load time → `fail('no index at <dir>')` (`cli.mjs:52`).
  - Rebuild fails → exit 1 with `index rebuild failed: <stderr|message>` (`cli.mjs:33`).
  - `meta.json` unparseable or missing `files`/`maxMtimeMs` → treated as stale
    (`index unreadable` / `index format changed`) and rebuilt (`cli.mjs:41-42`).
  - A file in `meta.files` no longer stats → `source changed`/`source file removed` → rebuild
    (`cli.mjs:44-47`).
  - Unknown symbol → exit 1 with `no symbol named "<query>"` (`cli.mjs:104`, `133`) or
    `no symbol matching "<query>"` for `deps` (`cli.mjs:119`).
  - Unknown command → exit 1 with `unknown command "<cmd>"` (`cli.mjs:226`).
- **Postconditions.** The answer is printed to stdout. `.codegraph/graph.bin` and `meta.json` are
  present and non-stale by the mtime test; no watcher and no persistent process remain.

## Tests

Node's built-in runner (`npm test` → `node --test`). Performance tests run separately with
`npm run performance`. Tests for this subsystem
live in `codegraph/test/`:

- `test/mcp-runtime.test.mjs` — `DebouncedBuildQueue` coalescing/draining and
  `McpProjectRuntime` watch/enqueue behavior.
- `test/engine.test.mjs` — `CodeGraphEngine` build/incremental/reconcile and the consistency
  modes.
- `test/source-policy.test.mjs` — `scan`, `acceptWatchPath`, ignore and control-file handling,
  i.e. the watched-file set this subsystem depends on.
- `test/trace-profile.test.mjs` — `createTraceProfiler` begin/end/write, including the
  `undefined`-destination no-op.
- `test/daemon-query-engine.test.mjs`, `test/query-daemon.test.mjs` — the query engine the MCP
  path drives.
- `test/boundaries.test.mjs` — the only tests that assert on `mcp.mjs` directly, and they do it by
  reading `mcp.mjs` as **text** and asserting on substrings rather than by calling anything
  (`boundaries.test.mjs:15`, `20`, `43`, `56`, `67`, `76`, `86`, `97`, `104`, `111`). Covered:
  both entry point files exist and the tool names are present (`:13`); MCP reads use the
  lightweight query path while `index`/`refresh` retain the watched runtime (`:19`);
  complete-graph consumers await enrichment while `callers` keeps the eager call-only path
  (`:42`); `codegraph_query` forwards explicit consistency and returns
  freshness/coverage/revision/validatedGeneration (`:55`); explicit generation cannot be combined
  with `latest` (`:66`); `codegraph_deps` pins rows and metadata through one query handle (`:75`);
  configured-root startup stays lightweight and stdin `end` closes runtimes, query engines and
  light watchers (`:85`); polling-watcher errors fail closed by promoting the root (`:96`);
  mapped reads wait for an in-flight promotion (`:103`); first-read freshness hashes disk content
  against generation source ids (`:110`).
- `test/daemon-query-engine.test.mjs:300-400` — the only end-to-end exercise of the real
  processes: it runs `cli.mjs index --root <tmp>` (`:306`, `:334`, `:360`, `:382`), then spawns
  `mcp.mjs` and pipes a real `tools/call` JSON-RPC line for `codegraph_deps` on stdin
  (`:317`, `:345`, `:365`, `:394`), covering the configured-`CODEGRAPH_ROOT` path, a source
  changed before the first read, and a `tsconfig.json` change forcing heavy reconciliation.

Not covered by any test: the `TOOLS` input schemas as declared, the per-tool output text
formatting of `codegraph_refs`/`callers`/`dead`, the `MAX_MCP_RESULTS` cap paths, the
`notifications/cancelled` handler, and `cli.mjs` command dispatch beyond `index`.

## UI/UX

Two interaction surfaces, both textual; no visual mockup applies, and nothing in
`docs/mockups/` covers this subsystem.

**CLI terminal output.** Deliberate conventions, all verifiable in `cli.mjs`:

- **stdout is the answer, stderr is the machinery.** Results print to stdout; the rebuild notice
  (`# <why> — rebuilding index for <repo>…`, `cli.mjs:27`), the `--verbose` symbol/edge count
  (`cli.mjs:217`) and all failures (`cli.mjs:20`) go to stderr — so piping stdout yields only
  data.
- **Leading `#` marks non-data lines** on stderr (`cli.mjs:27`, `217`), matching comment syntax so
  a pasted transcript stays readable.
- **`refs` output is a per-symbol block**: a blank line, then `<kind> <name>  <file>:<line>`, then
  a count line `<n> reference(s), <m> outside its own file`, then four-space-indented
  `<file>:<line>  in <name>()` rows (`cli.mjs:109-113`). The "outside its own file" count is
  surfaced because that is the number that decides whether a rename is local.
- **`callers` output is an indented tree**, two spaces per level, with a ` (seen)` suffix instead
  of re-expanding an already-visited node (`cli.mjs:139-141`) — so a cycle terminates visibly
  rather than silently.
- **`dead` output leads with the count and the warnings, before the list**: the count, the
  withheld-framework-export count when any were withheld, `NOT PROOF OF DEAD CODE. Dynamic/
  string-keyed access is invisible here.`, and `Do NOT delete anything from this list without
  explicit human approval.` — only then the sorted rows (`cli.mjs:178-184`). Warnings precede
  data so a reader who stops at the first lines has still read the caveat.
- **`help` is the default.** No command, or `help`, prints the command list with a one-line gloss
  per command and exits 0 (`cli.mjs:190-200`).
- **Errors are one line and exit 1**: `codegraph: <message>` (`cli.mjs:20`).
- **`index` and `visualize` inherit stdio** (`cli.mjs:204`, `212`), so the child's progress and
  the visualizer's own output stream straight to the terminal.

**MCP tool surface as an interaction surface.** The tool *descriptions* are the UX for an agent
and are written to steer behavior, not merely to name the tool: `SCOPE` is prefixed to every
description so no tool can be read as repository-agnostic (`mcp.mjs:21-22`, `97`), and
`codegraph_dead`'s description is mostly a prohibition — "READ-ONLY ANALYSIS… is NOT a deletion
list. Never delete, comment out, or modify anything based on this output" (`mcp.mjs:68`). Every
response is a single plain-text block (`mcp.mjs:313`), and `codegraph_query`/`codegraph_deps` put
machine-readable metadata on line 1 ahead of the rows (`mcp.mjs:247`, `285`).

The `visualize` command hands off to a separate subsystem with its own interaction — see
`visualizer.md`.

## Dependencies

Design docs: `parsing-and-resolution.md` (how partitions, symbols and edges are produced —
`parser.mjs`, `incremental-resolver.mjs`, `semantic-checker-worker.mjs`, `source-policy.mjs`),
`storage-and-query.md` (`store.mjs`, generations, overlays, `mmap-query-cache.mjs`,
`daemon-query-engine.mjs`, `query-daemon.mjs`), `visualizer.md` (the `visualize` target).

In-repo modules imported directly by the scoped files: `daemon-query-engine.mjs`,
`query-target.mjs`, `source-policy.mjs`, `store.mjs` (by `mcp.mjs`); `tool-engine.mjs` (by
`mcp-runtime.mjs` and `tool.mjs`); `source-policy.mjs`, `parser.mjs`, `store.mjs`,
`trace-profile.mjs`, `source-reader.mjs`, `file-index.mjs`, `incremental-resolver.mjs`,
`semantic-checker-worker.mjs`, `mmap-query-cache.mjs`, `native/mmap-adapter.mjs` (by
`tool-engine.mjs`); `query-daemon.mjs` (lazily, by `tool.mjs`); `visualizer.mjs` and `tool.mjs`
(as child processes, by `cli.mjs`).

External: `chokidar` (polling fallback), `ts-morph`/`@ts-morph/common` and `minimatch` reached
transitively (`package.json:58-63`). Node builtins only in `mcp.mjs`'s hot path.

## Diagrams

The ASCII component/flow diagram in **Architecture** is the diagram for this subsystem. No
additional diagram files exist.

## References

- Model Context Protocol — the JSON-RPC methods implemented are `initialize`, `tools/list`,
  `tools/call`, `ping`, and the `notifications/cancelled` notification (`mcp.mjs:292-322`); the
  default protocol version echoed when the client sends none is `2024-11-05` (`mcp.mjs:302`).
- Chrome Trace Event Format — the output format of `trace-profile.mjs`, declared as
  `format: 'chrome-trace-event'` (`tool-engine.mjs:583`).
- Next.js file and export conventions — the source of `FRAMEWORK_EXPORTS` and `FRAMEWORK_FILES`
  (`cli.mjs:154-163`).
- `codegraph/README.md` — the user-facing description. See **Sensitive Areas** for the places it
  and the code disagree.
