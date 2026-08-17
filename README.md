# 🛠 MCPS — Model Context Protocol Servers & Developer Tools Monorepo

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A monorepo of high-performance Model Context Protocol (MCP) servers, code intelligence engines, and developer tools for AI coding agents.

---

## 📦 Packages

| Package | Path | Description |
| :--- | :--- | :--- |
| **[`@mcps/codegraph`](./codegraph)** | [`/codegraph`](./codegraph) | Ultra-fast TypeScript/JavaScript symbol and call-graph MCP server with memory-mapped query views and kernel event watching. |
| **`code-knowledgebase`** | [`/code-knowledgebase`](./code-knowledgebase) | Comprehensive codebase context, embedding store, and code intelligence vault. |

---

## ⚡ Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/rwlaschin/mcps.git
cd mcps
```

### 2. Run CodeGraph MCP Server
```bash
cd codegraph
npm install
npm test
node mcp.mjs
```

See individual package READMEs for configuration details and usage instructions.

---

## 📄 License

MIT © [Robert Wlaschin](https://github.com/rwlaschin)
