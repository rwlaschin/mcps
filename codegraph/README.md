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
| Consistency | Immediate provisional results or checker-validated generation snapshots |
| Dead-export review | Unreferenced export candidates with framework-convention safeguards |
| Visualization | Layered flow, heat map, sunburst, and coupling views with live reload |

## Visualizer

Run `node visualizer.mjs --root /path/to/repo --port 7331`. Each view also serves JSON from its
route, and all views flag calls that cross the configured `ui`, `hook`, `request`, `api`, `service`,
and `db` tiers in the wrong direction.

| View | Route | Use |
| :--- | :--- | :--- |
| Layered Call Flow | `/graph` | Trace entry points through architectural tiers and spot upward dependencies |
| Codebase Heat Map | `/heatmap` | Find central, high-traffic files that need extra test and review attention |
| Sunburst Partition | `/sunburst` | Compare code distribution across packages, directories, files, and functions |
| Module Coupling Chord | `/chord` | Find strong two-way coupling and safer package boundaries |

## Commands

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run visualize` | `node visualizer.mjs` | Start the visualizer on port 7331 |
| `npm run dev` | `node --watch-path=... visualizer.mjs` | Start the visualizer with live reload |
| `npm run index` | `node tool.mjs build` | Force a full repository index |
| `npm run mcp` | `node mcp.mjs` | Start the MCP server over stdio |
| `npm test` | `node --test` | Run the unit and end-to-end tests |
| `npm run performance -- --root /path/to/repository --symbol symbolName` | `node scripts/codegraph.performance.mjs` | Measure the production MCP against an existing repository cache |

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
CodeGraph was tested against the 866-source-file D&D Community and Marketplace project, covering all query endpoints, initial indexing, leaf updates, cascade updates, and full reindexing.

## Metrics

| Operation | Indexed | Leaf update | Cascade update |
| :--- | ---: | ---: | ---: |
| References | 20095.38 / 20432.35 ms | 779.21 / 811.29 ms | 5871.23 / 6410.27 ms |
| Dependencies | 8.31 / 15.87 ms | 6.10 / 6.87 ms | 3.71 / 6.78 ms |
| Callers | 94.64 / 110.55 ms | 90.78 / 99.36 ms | 105.96 / 139.45 ms |
| Dead exports | 332.29 / 356.49 ms | 307.57 / 326.63 ms | 340.05 / 441.96 ms |
| Named-symbol query | 3.41 / 4.78 ms | 2.64 / 6.35 ms | 2.92 / 3.61 ms |
| Symbol list (2,000 max) | 58.31 / 71.54 ms | 54.60 / 57.48 ms | 67.05 / 76.36 ms |
| Single-symbol query | 1.89 / 2.73 ms | 1.92 / 4.08 ms | 1.94 / 2.29 ms |

| Update | p50 / p90 | Parsed files | Validated files |
| :--- | ---: | ---: | ---: |
| CLI cold index | 13645.86 / 14957.40 ms | — | — |
| Leaf incremental update | 612.14 / 635.49 ms | 1 | 1 |
| Cascade incremental update | 4192.47 / 4811.27 ms | 1 | 385 |
| Full reindex | 11204.60 / 11590.55 ms | — | — |
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
