# CodeGraph — Extensible Code Intelligence for AI Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)

**CodeGraph** is primarily a Model Context Protocol (MCP) code-search server. It makes an LLM's
code journey faster and more efficient by replacing repeated file searches and reads with semantic
answers about references, callers, dependencies, and symbols. Agents spend their context making
changes instead of reconstructing relationships.

Its plugin system provides shared AI code search, a code graph, and a dependency visualizer across
language-specific parsers. The current TypeScript and JavaScript plugin resolves declarations
through imports, aliases, and files while a resident daemon updates the graph incrementally.

## MCP Setup

CodeGraph is not distributed through npm. Point your MCP client at `mcp.mjs` in your local clone:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/mcps/codegraph/mcp.mjs"]
    }
  }
}
```

## Query Tools

### Find every use of a symbol

Use this before changing or removing a function. CodeGraph follows imports, aliases, and re-exports,
so renamed imports such as `useSessionEvent as useSession` are included.

```claude
Use CodeGraph to find how useSessionEvent is used.
```

CodeGraph identifies the declaration and the actual call sites:

```text
useSessionEvent — src/query/event.ts:202

Called as useSession:
  src/pages/game/GamePopoutShell.tsx
  src/pages/game/Champion.tsx
  src/pages/game/Storyteller.tsx
  src/pages/game/Scryer.tsx
```

### Find which files import a symbol

Use this when you need the affected files, not every individual call.

```claude
Use CodeGraph to find which files import useSettings.
```

The answer stays focused on file-level dependencies:

```text
useSettings — src/query/settings/index.ts

Imported by:
  src/hooks/usePlayerAvatarResolver.ts
  src/pages/Settings.tsx
  src/pages/marketplace/seller/Setup.tsx
```

### Trace callers back through the application

Use this to understand how a function is reached before changing its behavior.

```claude
Use CodeGraph to trace callers of fetchSessionStoryArcState in
src/services/data/session/storyArcState.ts.
```

CodeGraph walks backward through resolved calls instead of returning same-name text matches:

```text
fetchSessionStoryArcState — src/services/data/session/storyArcState.ts:99
└── src/query/session.ts:251
```

### Review potentially unused exports

Use this as a review queue, not an automatic deletion list. Dynamic and framework-driven usage may
not appear as a static reference.

```claude
Use CodeGraph to find exports under src/query that have no references outside their own file.
Review only. Do not modify anything.
```

CodeGraph reports the candidate, its declaration, and the limitation of the result:

```text
Potentially unused export:
  src/query/example.ts:12 — unusedExample

Not proof of dead code: dynamic and string-keyed access cannot be resolved statically.
```

The LLM supplies the active repository root automatically. Indexing and refresh are automatic;
`codegraph_index` forces a rebuild, `codegraph_refresh` reconciles the index with disk, and
`codegraph_query` exposes raw references, dependencies, symbols, and graph rows.

### Inspect function internals

`codegraph_internals` inspects the indexed structure inside a function without reparsing its source. It can return the function's control-flow map, find structural elements such as calls or returns, trace execution paths between two nodes, and report metrics derived from the control-flow graph.

| Operation | Use |
| :--- | :--- |
| `map` | Return the selected function, its syntax nodes, control-flow edges, and optionally symbol relations |
| `search` | Find nodes by kind, role, outgoing edge, or read, write, and call relation |
| `paths` | Trace bounded control-flow paths between two nodes, with an optional node to avoid |
| `metrics` | Report cyclomatic complexity, branch count, and nesting depth |

Ask for a control-flow map when you need to see how execution branches through a function:

```claude
Use CodeGraph to show the control-flow map for choose in src/example.ts.
```

The response is JSON Lines. It begins with the validated index generation, followed by the selected owner, nodes, and edges. For example:

```jsonl
{"revision":null,"freshness":"validated","coverage":"calls","internalCoverage":"syntax-and-cfg","validatedGeneration":"mu01uv3n-d9c71df1420a-561e93f73eac"}
{"record":"owner","owner":{"id":2,"kind":"function","name":"choose","start":0,"end":95,"entryNodeId":6,"exitNodeId":7,"cyclomatic":2,"branchCount":1,"nestingDepth":1,"symbolId":"6afd316e6f6550dacd2e5a66","parentOwnerId":0,"file":"src/example.ts","line":1,"column":1,"endLine":4,"endColumn":2}}
{"record":"edge","ownerId":2,"edge":{"ownerId":2,"from":9,"to":11,"kind":"true"}}
{"record":"edge","ownerId":2,"edge":{"ownerId":2,"from":9,"to":8,"kind":"false"}}
```

Structural search scopes the match to one file and, optionally, one function:

```claude
Use CodeGraph to find return nodes in choose in src/example.ts.
```

```jsonl
{"record":"match","owner":{"id":2,"kind":"function","name":"choose","start":0,"end":95,"entryNodeId":6,"exitNodeId":7,"cyclomatic":2,"branchCount":1,"nestingDepth":1,"symbolId":"6afd316e6f6550dacd2e5a66","parentOwnerId":0,"file":"src/example.ts","line":1,"column":1,"endLine":4,"endColumn":2},"node":{"id":8,"ownerId":2,"parentId":null,"kind":"return","role":"body","start":80,"end":93,"unreachable":false,"line":3,"column":3,"endLine":3,"endColumn":16},"ancestors":[]}
```

Path queries show each control-flow route between two uniquely selected nodes:

```claude
Use CodeGraph to show up to two paths from the entry to the exit of choose in src/example.ts.
```

```jsonl
{"record":"path","ownerId":2,"nodeIds":[6,9,8,7],"edges":[{"ownerId":2,"from":6,"to":9,"kind":"next"},{"ownerId":2,"from":9,"to":8,"kind":"false"},{"ownerId":2,"from":8,"to":7,"kind":"return"}],"truncated":false}
{"record":"path","ownerId":2,"nodeIds":[6,9,11,10,7],"edges":[{"ownerId":2,"from":6,"to":9,"kind":"next"},{"ownerId":2,"from":9,"to":11,"kind":"true"},{"ownerId":2,"from":11,"to":10,"kind":"next"},{"ownerId":2,"from":10,"to":7,"kind":"return"}],"truncated":false}
```

Metrics summarize the same indexed control-flow graph:

```claude
Use CodeGraph to report cyclomatic complexity, branch count, and nesting depth for choose in src/example.ts.
```

```jsonl
{"record":"metrics","owner":{"id":2,"kind":"function","name":"choose","start":0,"end":95,"entryNodeId":6,"exitNodeId":7,"cyclomatic":2,"branchCount":1,"nestingDepth":1,"symbolId":"6afd316e6f6550dacd2e5a66","parentOwnerId":0,"file":"src/example.ts","line":1,"column":1,"endLine":4,"endColumn":2},"profile":"codegraph-cfg-v1","metrics":{"cyclomatic":2,"branchCount":1,"nestingDepth":1}}
```

## Why CodeGraph?

Text search matches strings, not symbol identity, and cannot reliably distinguish same-named uses
or follow aliased re-exports. CodeGraph uses the TypeScript checker to resolve those relationships
and avoids rebuilding the graph for every query or file change. It is used on the D&D Community
and Marketplace codebase behind [GameRogue](https://gamerogue.net).

### Always Fresh

CodeGraph refreshes only the affected relationships after every file update. Your LLM queries the current
graph without rescanning the repository or waiting for a full rebuild.

| Capability | Result |
| :--- | :--- |
| Language plugins | TypeScript and JavaScript parsing today behind one graph, MCP interface, daemon, and visualizer |
| References and calls | Type-resolved incoming references, outgoing dependencies, and inverted call trees |
| Code structure | Function-level control flow with cyclomatic complexity, branch count, and nesting depth |
| Consistency | Published checker-validated generation snapshots with optional generation pinning |
| Dead-export review | Unreferenced export candidates with framework-convention safeguards |
| Visualization | Layered flow, heat map, sunburst, coupling, call-tree, and complexity views with live reload |

## Visualizer

Run `node visualizer.mjs --root /path/to/repo --port 7331`. Each view also serves JSON from its route, and relationship views flag calls that cross the configured `ui`, `hook`, `request`, `api`, `service`, and `db` tiers in the wrong direction.

| View | Route | Use |
| :--- | :--- | :--- |
| Layered Call Flow | `/graph` | Trace entry points through architectural tiers and spot upward dependencies |
| Codebase Heat Map | `/heatmap` | Find central, high-traffic files that need extra test and review attention |
| Sunburst Partition | `/sunburst` | Compare code distribution across packages, directories, files, and functions |
| Module Coupling Chord | `/chord` | Find strong two-way coupling and safer package boundaries |
| Function Call Tree | `/calltree` | Follow execution across functions and compare their complexity bands |
| Complexity | `/complexity` | Find complex functions by directory, file, distribution, and metric |

## Commands

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run visualize` | `node visualizer.mjs` | Start the visualizer on port 7331 |
| `npm run dev` | `node --watch-path=... visualizer.mjs` | Start the visualizer with live reload |
| `npm run index` | `node tool.mjs build` | Force a full repository index |
| `npm run mcp` | `node mcp.mjs` | Start the MCP server over stdio |
| `npm test` | `node --test` | Run the unit and end-to-end tests |
| `npm run performance -- --root /path/to/repository --symbol symbolName` | `node scripts/codegraph.performance.mjs` | Measure CodeGraph performance |

## Configuration Options

The quick-start configuration needs no project path. The LLM automatically supplies the active
repository's absolute path as `root` on each tool call.

| Option | Default | Use |
| :--- | :--- | :--- |
| Tool argument `root` | Active repository supplied by the LLM | Query a specific repository |
| `CODEGRAPH_ROOT` | None | Set a fixed default repository when a tool call omits `root` |
| `CODEGRAPH_PARSER_WORKERS` | Available CPU parallelism minus one | Limit parser worker threads |
| `NODE_COMPILE_CACHE` | `$TMPDIR/codegraph-compile-cache` | Override the automatic V8 compile-cache location |
| `.codegraphignore` | None | Exclude additional project paths from indexing and updates |

To set a fixed repository, add `"env": { "CODEGRAPH_ROOT": "/absolute/path/to/project" }` to the
`codegraph` object in the MCP configuration. Restart or reload the client after configuration
changes.

## Community Testing

CodeGraph supports POSIX and Win32 paths, native `mmap` with a fallback store, and platform kernel
watchers. From a checkout at `mcps/codegraph`, run `npm test`, then report the platform,
filesystem, results, and watcher or path-normalization failures in a
[GitHub issue](https://github.com/rwlaschin/mcps/issues).

## Performance and Product Comparison

<!-- codegraph-performance:start -->
CodeGraph was tested against the 877-source-file D&D Community and Marketplace project, covering all query endpoints, initial indexing, leaf updates, cascade updates, and full reindexing.

## Metrics

| Operation | Indexed | Leaf update | Cascade update |
| :--- | ---: | ---: | ---: |
| References | 21612.98 / 23993.19 ms | 2.41 / 3.16 ms | 5461.53 / 10902.77 ms |
| Dependencies | 24.11 / 37.35 ms | 2.64 / 3.84 ms | 5.34 / 43.51 ms |
| Callers | 99.47 / 138.37 ms | 75.68 / 91.81 ms | 157.57 / 274.56 ms |
| Dead exports | 230.94 / 335.53 ms | 256.11 / 275.02 ms | 353.55 / 582.32 ms |
| Named-symbol query | 2.86 / 5.33 ms | 4.24 / 13.61 ms | 2.50 / 16.91 ms |
| Symbol list (2,000 max) | 46.28 / 58.34 ms | 69.31 / 110.29 ms | 50.91 / 94.88 ms |
| Single-symbol query | 3.37 / 6.21 ms | 3.83 / 6.34 ms | 2.62 / 7.18 ms |
| Cyclomatic complexity | 14.66 / 16.50 ms | 10.55 / 25.82 ms | 8.62 / 22.83 ms |

| Update | p50 / p90 | Parsed files | Validated files |
| :--- | ---: | ---: | ---: |
| CLI cold index | 20429.80 / 39933.92 ms | — | — |
| Leaf incremental update | 1153.89 / 1476.76 ms | 1 | 1 |
| Cascade incremental update | 10233.90 / 13029.95 ms | 1 | 395 |
| Full reindex | 25927.54 / 43766.40 ms | — | — |
<!-- codegraph-performance:end -->

### Updating Performance Metrics

Run the production MCP server against a real, already-indexed repository. The reporter writes both machine-readable JSON
and the Markdown used above.

```shell
npm run performance -- --root /absolute/path/to/repository --symbol useSessionEvent --samples 5 --json /absolute/path/to/report.json --markdown /absolute/path/to/report.md --readme README.md
```

Profile artifacts are optional and remain with the trace analyzer. To include existing artifacts,
pass `--profile` and set `CODEGRAPH_PROFILE_CPU`, `CODEGRAPH_PROFILE_HEAP`,
`CODEGRAPH_PROFILE_TRACE`, and optionally `CODEGRAPH_PROFILE_GC_SAMPLES`.

## License

MIT © [Robert Wlaschin](https://github.com/rwlaschin)

## About Me

I am a CTO, Certified AI professional, and Certified Chief AI Officer (CAIO). I am also a former
3DO game developer and advertising architect.
