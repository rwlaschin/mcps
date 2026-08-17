# ⚡ CodeGraph — High-Performance Code Intelligence & Symbol Graph MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)

**CodeGraph** is an ultra-fast, zero-overhead type-resolved symbol and call graph engine for TypeScript and JavaScript codebases. Designed natively for AI coding agents and developers, CodeGraph exposes rich structural AST analysis over the **Model Context Protocol (MCP)** and CLI with sub-millisecond query latencies.

Instead of parsing entire files or reconstructing graph heaps on every prompt, CodeGraph combines **incremental worker apartments**, **binary memory-mapped query views (`mmap`)**, and **native OS kernel filesystem event subscriptions** to provide instant, validated code intelligence.

---

## 🚀 Key Features

- **Inverted Call Trees (`codegraph_callers`)**: Trace execution paths upward from deep helpers to top-level entry points (API routes, page controllers, event listeners).
- **Exact Reference Resolution (`codegraph_refs`)**: Locate all incoming references across modules with endpoint and line-level metadata.
- **Dependency Maps (`codegraph_deps`)**: Discover in-repo outgoing calls and imports for any function or file without noisy `node_modules` pollution.
- **Dead Export Analysis (`codegraph_dead`)**: Identify unreferenced exports across your project while respecting framework conventions.
- **Multi-Consistency Queries (`codegraph_query`)**: Switch seamlessly between instantaneous provisional syntax updates and checker-validated generation snapshots.
- **Interactive Visualizer**: Built-in streaming query visualizer UI for exploring your graph in the browser.

---

## 📊 Performance Benchmarks & Statistics

CodeGraph is engineered for extreme hotpath performance. All statistics are verified against real-world multi-thousand file repositories and continuous regression benchmarks:

| Operation | Benchmark / Metric | Performance |
| :--- | :--- | :--- |
| **Daemon Startup** | Cold start to ready socket | **~2.1ms – 4.2ms** |
| **First Primed Query** | Resolved references query | **< 1.2ms** (p50: 0.6ms) |
| **Warm 200-Row Query** | Validated symbols & edges | **< 0.03ms** (p99: 0.02ms) |
| **Large Mapped Lookup** | 22k symbols + 55k edges needle lookup | **~0.25ms** (p95: 2.1ms) |
| **Incremental Edit Apply** | 855-file workspace delta application | **< 0.09ms** (p50: 0.006ms) |
| **Query Memory Overhead** | Steady-state heap allocation during queries | **0 bytes** (direct binary mmap read) |

### 🛠 Why It's So Fast:
1. **Zero JSON Deserialization on Hotpaths**: Graph query results read directly from a shared binary memory-mapped cache (`query-view-cache.bin`) using a native C bridge (`mmap` / `MapViewOfFile`).
2. **Worker Apartment Pools**: AST parsing and semantic resolution run across isolated background worker apartments, keeping the coordinator completely unblocked.
3. **Atomic Generation Versioning**: Every index build produces immutable generation hashes, allowing long-running queries to stay pinned to historical revisions while disk reconciliation advances.

---

## 🌐 Cross-Platform Kernel File Watching

CodeGraph uses OS-native kernel event streams to maintain instant incremental graph freshness with minimal CPU and zero polling:

- **macOS (Kernel FSEvents)**: Enabled via `useFsEvents: true` with a single root event subscription, eliminating `EMFILE` descriptor limits.
- **Linux (inotify)**: Event-driven inotify monitoring with strict directory pruning to preserve system watch descriptors.
- **Windows (ReadDirectoryChangesW)**: Recursive asynchronous directory handle streaming with buffer overflow protection.

> Strict ignore filters automatically prune `.git`, `node_modules`, `dist`, `build`, `.output`, `.nuxt`, `.next`, `.cache`, and custom `.codegraphignore` patterns at the root boundary.

---

## 🤝 Community Call: Help Test on Windows & Linux!

While CodeGraph is designed from the ground up to be fully cross-platform (supporting POSIX and Win32 file systems, native `mmap` / fallback stores, and kernel-level event drivers), we are actively seeking community benchmarks and test results across different environments:

- **Windows 10/11 & Windows Server** (Native PowerShell, CMD, and WSL2)
- **Linux Distributions** (Ubuntu, Debian, Arch, Fedora, Alpine)
- **Various Filesystems** (ext4, Btrfs, ZFS, NTFS)

### How You Can Help:
1. Clone the repo and run the test suite:
   ```bash
   git clone https://github.com/rwlaschin/mcps.git
   cd mcps/codegraph
   npm install
   npm test
   ```
2. Report benchmark numbers or file an issue at: [https://github.com/rwlaschin/mcps/issues](https://github.com/rwlaschin/mcps/issues)
3. Share any platform-specific watch descriptor or path normalizer edge cases!

---

## 📦 Quick Start & Installation

### 1. Installation
```bash
npm install -g @mcps/codegraph
# or from source:
cd codegraph
npm install
```

### 2. Configure MCP Server in Your AI Agent
Add CodeGraph to your Model Context Protocol configuration (e.g. `claude_desktop_config.json`, Antigravity, Cursor, or Cline):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/path/to/mcps/codegraph/mcp.mjs"],
      "env": {
        "CODEGRAPH_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### 3. CLI Usage
```bash
# Build / index current repository
npx codegraph index

# Find callers of a function
npx codegraph callers --symbol myFunction

# Find dependencies of a file
npx codegraph deps --target src/server.ts

# Detect dead exports
npx codegraph dead --prefix src/

# Launch streaming visualizer UI
npx codegraph visualize
```

---

## 🧩 MCP Tools Reference

| Tool | Purpose | Key Arguments |
| :--- | :--- | :--- |
| `codegraph_index` | Force a full v3 symbol-graph build with call coverage | `root` (optional) |
| `codegraph_refs` | Find all incoming references to a symbol with caller locations | `symbol`, `root` |
| `codegraph_callers` | Inverted call-tree walking upward to root entry points | `symbol`, `depth`, `root` |
| `codegraph_deps` | In-repo outgoing dependencies and function calls | `target`, `root` |
| `codegraph_dead` | Analysis of exports with no resolved references | `prefix`, `root` |
| `codegraph_query` | Raw query with explicit consistency (`latest` vs `validated`) | `query`, `root` |
| `codegraph_refresh`| Reconcile persistent incremental index with disk | `root` (optional) |

---

## 📄 License

MIT © [Robert Wlaschin](https://github.com/rwlaschin)
