---
modified: 2026-07-06
dependencies: [storage]
---

# MCP server — protocol surface exposed to AI agent clients

Describes the part of `mcp-code-vault` that speaks the Model Context Protocol over stdio: how the `McpServer` instance is built and connected, the built-in tools (`ping`, `settings`, `config`), the per-agent tools registered dynamically from Mongo, and how the process boots (primary vs. secondary, stdio framing, logging, shutdown). Read this before touching `src/mcp/*.ts`, `src/index.ts`, `src/stdioMode.ts`, or before adding/renaming an MCP tool. It does not cover how project data is scanned or stored (see `storage`) — only how that data (plus agent config) gets exposed to an MCP client like Cursor.

## Sensitive Areas

- `main()` in `src/index.ts` guards against double-initialization via the module-level `processInstanceId` — if `main()` is called twice in the same process it logs and returns instead of re-registering tools/servers. Tests reset this via `__resetProcessInstanceIdForTest()`; do not remove the guard to "fix" a test without restoring an equivalent reset path.
- `registerProjectAgentMcpTools()` in `src/mcp/registerAgentTools.ts` is guarded by a module-level `agentMcpToolsRegistered` flag and is a no-op on the second call within a process — required because both the primary path (`createStatsServer()`) and the stdio client path (`secondaryStartup()`) can each attempt registration. Tests reset it with `__resetAgentMcpToolsRegistrationForTest()`.
- `createLoggingStdioTransport()` in `src/mcp/transportLogger.ts` decides whether transport-close triggers process shutdown based on `getShutdownOnTransportClose()` (set in `src/shutdown.ts`). This flag is `true` only for a secondary/stdio-client process; a primary process must NOT exit on transport close because its TCP/discovery servers need to keep running for other secondaries. Flipping this flag's default would kill the primary the moment one MCP client disconnects.
- Tool names for agents come straight from Mongo (`Agent.tool_name`) and are validated with the SDK's `validateToolName` plus checked against a `RESERVED` set (`ping`, `settings`, `config`) and previously-used names in the same pass — invalid, empty, reserved, or duplicate names are silently skipped (logged as a warning), not thrown. Any change here must preserve "bad agent config never crashes MCP startup."
- `stdioMode` (`src/stdioMode.ts`) is derived from `process.stdout.isTTY !== true` (overridable with `MCP_STDIO=0`) and controls whether the process behaves like an MCP-host-launched process (strict required env, no stdout writes) or a dev/TTY run. Getting this detection wrong means either leaking non-JSON-RPC bytes onto stdout (breaks the protocol for a real MCP client) or refusing to start under `npm run dev`.

## Design Constraints

- Only JSON-RPC framing may go on stdout when running as an MCP server — all human-readable logging goes to stderr and/or `logs/mcp-requests.log` / the process log file, never `console.log`/stdout, because stdio is the actual transport (`StdioServerTransport`).
- When run by an MCP host (`stdioMode === true`), `MONGO_URL`, `MCP_PROJECT_NAME`, `WORKING_DIRECTORY`, and `PORT` are all required; `main()` aborts with `process.exit(1)` and a copy-pasteable example config if any are missing. Non-stdio (TTY) runs do not enforce this.
- Exactly three built-in tools are hardcoded in `createMcpServerApp()`: `ping`, `settings`, `config`. All other tools are per-agent and registered dynamically — there is no code path that hardcodes an agent-specific tool name.
- Agent tool names must pass MCP tool-name validation (`validateToolName` from the SDK) and must not collide with the reserved built-in names or with another agent's tool name in the same project; the first agent (sorted by name) wins a collision, later ones are skipped.
- `registerProjectAgentMcpTools()` only ever registers tools for the single project identified by `MCP_PROJECT_NAME` — there is no cross-project tool registration in one server process.
- The stdio transport wrapper (`createLoggingStdioTransport`) must remain a passthrough `Transport` (same `send`/`start`/`close`/`onmessage`/`onclose`/`onerror` contract as `StdioServerTransport`) — it only adds logging and shutdown side effects, it must not alter message content.

## Feature Overview

`mcp-code-vault` runs as a Model Context Protocol server that AI coding agents (e.g. Cursor) connect to over stdio. On connect, the server tells the client (via `instructions` returned at construction, see `getInstructions()` in `src/mcp/server.ts`) what tools exist: `ping` to verify the connection, `settings` to read the current working directory/port/Mongo config, `config` to change working directory and/or port at runtime, and one additional tool per configured "vault agent" for the active project. Each agent tool, when called, returns that agent's fully resolved execution bundle — its system prompt, tool-capability flags, model categories, an optional global prompt, and any linked personas — as JSON text, so the calling AI agent can use it as a ready-to-run configuration without a second round trip.

Because the same physical machine can run multiple `mcp-code-vault` processes (e.g. one per open Cursor window/project), the process elects a "primary" (which runs the shared stats HTTP/Socket.IO server, Mongo connection, and file-processing watcher) via UDP discovery on port 9255, and all other processes become "secondaries" that proxy metrics to the primary over TCP 9256. Every process — primary or secondary — still runs its own `McpServer` over its own stdio, since that's the one connection per MCP host.

## Architecture

**Startup entry points.** `src/run.ts` is the dev/tsx entry (`npm run dev`): it wraps `require('./index.ts')` and `main()` in a top-level try/catch so load-time and startup crashes are written to stderr instead of crashing silently. `src/index.ts` is the real implementation: it loads `.env` (package root first, then cwd, so it works when launched by an MCP host with a different cwd), then defines `main()`.

**`main()` flow** (`src/index.ts`): assigns a random `processInstanceId` (no-ops on a second call in-process); in `stdioMode`, validates that `MONGO_URL`, `MCP_PROJECT_NAME`, `WORKING_DIRECTORY`, `PORT` are all set or exits with `process.exit(1)`; wires process-log sinks (file + stderr); resolves `port` (defaults to 3000 in stdio mode if `PORT` unset, else throws); calls `setServerContext(cwd, port)` (`src/mcp/context.ts`); calls `createMcpServer()` (`src/mcp/server.ts`) to build and connect the `McpServer` over stdio; registers `process.stdin`'s `'end'` handler and `SIGTERM`/`SIGINT` handlers to call `disconnectFromPrimary()` then `runShutdown()`; then calls `tryStartDiscoveryAsPrimary(port)` to decide primary vs. secondary.

**Primary path** (`runAsPrimary()`): sets `shutdownOnTransportClose(false)` (primary must survive a single client's stdio closing); starts the primary TCP server (`startPrimaryServer`) and UDP announcer (`startPrimaryAnnouncer`) first so secondaries can attach early; builds the stats HTTP server (`createStatsServer`) and Socket.IO server on top of it; wires Socket.IO events (`connected`, `heartbeat`, `primary:identified`, `scan:progress` replay, `secondary:connected`); starts the file-processing watcher for `MCP_PROJECT_NAME` if set; starts UDP discovery broadcast handling. If the stats server fails to bind, in stdio mode this logs and returns (letting the bare MCP stdio connection keep working without the stats side); otherwise it rethrows.

**Secondary path** (`secondaryStartup()`): sets `shutdownOnTransportClose(true)` (this process should exit when its stdio transport closes); loops (`maxRetries` = 100, small random jitter) attempting `discoverPrimary()` (via UDP broadcast) then `connectToPrimary()` over TCP. On successful connect: points metrics at the primary's stats port (`setStatsBaseUrl`); if in `stdioMode`, additionally connects Mongoose directly (`connectMongoose`), runs seed steps (`runSeed`, `ensurePromptsFromSeed`), ensures the `Project` row exists (`ensureProjectFromConfig`), ensures its two per-project collections exist (`ensureProjectCollections`, see `storage`), and calls `registerProjectAgentMcpTools(mcp)` against the already-connected `McpServer` instance (fetched via `getMcpServerInstance()`) — this is the step that adds the per-agent tools for stdio-launched clients, since the primary's `createStatsServer()` path handles that differently. Registers `onPrimaryDisconnect` to redo `secondaryStartup` with fresh jitter if the primary connection drops (failover). If discovery/connect both fail, it retries `tryStartDiscoveryAsPrimary` (the process may itself become primary if it wins the race) before giving up after `maxRetries`.

**MCP server construction** (`src/mcp/server.ts`): `createMcpServerApp()` builds a bare `McpServer` (`name: 'mcp-code-vault'`, `version: '0.1.0'`, `capabilities: { tools: {} }`, `instructions` from `getInstructions()`) and registers the three built-in tools directly on it, each handler wrapped in `withMetrics(operationName, 'query', handler)` (`src/stats/metricsClient.ts`) so every tool call is timed and posted as a metric (status ok/error, duration_ms) regardless of MCP transport logging. `createMcpServer()` calls `createMcpServerApp()`, stores the instance in the module-level `activeMcpServer` (retrievable via `getMcpServerInstance()` — this is how `secondaryStartup()` gets a handle to register agent tools later), builds a `createLoggingStdioTransport()`, and calls `server.connect(transport)`.

**Request logging / transport wrapper** (`src/mcp/transportLogger.ts`, `src/mcp/requestLog.ts`): `createLoggingStdioTransport()` wraps a real `StdioServerTransport`, proxying `start`/`send`/`close`/`onerror` untouched, but intercepting the `onmessage` setter to call `appendRequestLog(method)` before invoking the real handler, and intercepting the `onclose` setter so that if `getShutdownOnTransportClose()` is true it calls `disconnectFromPrimary()`, invokes the original close handler, then `runShutdown()`; if false, it only invokes the original handler (primary keeps running). `appendRequestLog()` appends a timestamped `[MCP] request <method>` line to `logs/mcp-requests.log` (path from `getLogDir()`), swallowing any fs errors so logging failures never break the protocol.

**Context/settings state** (`src/mcp/context.ts`): module-level `serverCwd`/`serverPort` initialized from `WORKING_DIRECTORY`/`PORT` env vars, mutable at runtime via `applyConfig()` (used by the `config` tool). `getSettingsContent()` builds the human-readable text returned by the `settings` tool: project name, a redacted Mongo URL block (`mongoUrlLinesForSettingsContent`), cwd/pwd/port, and a ready-to-paste Cursor `mcpServers` JSON snippet reflecting current `serverCwd`/`serverPort`.

**Per-agent tool registration** (`src/mcp/registerAgentTools.ts`): `registerProjectAgentMcpTools(server)` looks up the `Project` by `MCP_PROJECT_NAME`, loads all `Agent` rows for that project sorted by name, and for each one with a valid, non-reserved, non-duplicate `tool_name`, registers an MCP tool whose handler (wrapped in `withMetrics(tool_name, 'query', ...)`) calls `loadAgentExecutionBundleById(id)` and returns the bundle as pretty-printed JSON text, or an `isError: true` text result if the agent can't be loaded. It is idempotent per process via the `agentMcpToolsRegistered` flag.

**Execution bundle assembly** (`src/agent/loadAgentExecutionBundle.ts`): `loadAgentExecutionBundleById`/`loadAgentExecutionBundleByName` fetch an `Agent` row, then `bundleFromAgentLean()` assembles the `AgentExecutionBundle`: the agent's own fields (`name`, `description`, `system_prompt`, `tool_name`, `model_categories`, `tools` capability flags), an optional `globalPrompt` resolved from `SystemPrompt` via `global_prompt_id` (defaulting `usage_type` based on whether `prompt_type === 'agent'`, and defaulting `structure_mode`/`structure_mime`/`structure_preset` to safe fallbacks if unset), and a `personas` array resolved from `persona_ids` via the `Persona` model, sorted by name.

## Functions

- `getMcpServerInstance()` / `createMcpServerApp()` / `createMcpServer()` (`src/mcp/server.ts`) — build, connect, and expose the singleton `McpServer` for the process.
- `getInstructions()` (`src/mcp/server.ts`, private) — builds the `instructions` string (cwd, port, tool list, docs pointer) shown to the connecting MCP client.
- `getServerCwd()` / `getServerPort()` / `setServerContext(cwd, port)` / `applyConfig(input)` / `getSettingsContent()` (`src/mcp/context.ts`) — read/write the server's working-directory and port state and render it for the `settings` tool.
- `registerProjectAgentMcpTools(server)` / `__resetAgentMcpToolsRegistrationForTest()` (`src/mcp/registerAgentTools.ts`) — register one MCP tool per valid agent for the current project; test-only reset of the idempotency guard.
- `createLoggingStdioTransport()` (`src/mcp/transportLogger.ts`) — wraps `StdioServerTransport` to log each inbound method and to run shutdown-on-close logic conditionally.
- `appendRequestLog(method)` (`src/mcp/requestLog.ts`) — append one line per inbound MCP request to `logs/mcp-requests.log`.
- `main()` / `runAsPrimary(port, opts)` / `secondaryStartup(fromFailover, port, maxRetries, projectName)` / `localNetworkHost()` / `__resetProcessInstanceIdForTest()` (`src/index.ts`) — the full process boot sequence, primary/secondary role assumption, and a test-only reset hook.
- `stdioMode` (const) / `setProcessLogSink(sink)` / `addProcessLogSink(sink)` / `writeProcessLog(message)` (`src/stdioMode.ts`) — stdio-vs-TTY detection and the process-log fan-out used instead of stdout/stderr writes elsewhere in the codebase.
- `isValidMcpToolNameId(s)` (`src/utils/mcpToolName.ts`) — a standalone 1–128-char `[A-Za-z0-9._-]` tool-id validator (SEP-986-style); note `registerAgentTools.ts` actually validates via the SDK's own `validateToolName`, not this helper — this utility exists as a separate/lighter check used elsewhere (e.g. UI-side validation of a proposed tool name before save).
- `MCP_BUILTIN_TOOL_IDS` / `MCP_BUILTIN_TOOL_SUMMARIES` / `DEFAULT_AGENT_TOOLS_ON_CREATE` (`src/utils/defaultAgentTools.ts`) — the canonical list of built-in tool ids and one-line summaries (used by UI/docs), and the default `tools` capability flags applied when an agent is created without explicit flags.
- `loadAgentExecutionBundleById(agentId)` / `loadAgentExecutionBundleByName(name)` (`src/agent/loadAgentExecutionBundle.ts`) — resolve an `Agent` row (plus its linked `SystemPrompt` and `Persona`s) into the JSON bundle returned by that agent's MCP tool.

## Models

This subsystem has no persisted schema of its own — it reads the `Project`, `Agent`, `SystemPrompt`, and `Persona` Mongoose models (defined elsewhere in `src/db/models/`) to build tool registrations and execution bundles. The one shape defined here is the in-memory `AgentExecutionBundle` type (`src/agent/loadAgentExecutionBundle.ts`):

| Field | Type | Notes |
| --- | --- | --- |
| `agent.name`, `agent.description`, `agent.system_prompt`, `agent.tool_name` | string | Copied directly from the `Agent` row. |
| `agent.model_categories` | string[] | Copied (empty array if not an array on the row). |
| `agent.tools.{file_watch,db_read_write,web_search,run_shell}` | boolean | Coerced with `Boolean(...)`; see `DEFAULT_AGENT_TOOLS_ON_CREATE` for the create-time defaults these usually start from. |
| `globalPrompt` | object or `null` | `null` unless `Agent.global_prompt_id` resolves to a `SystemPrompt`; when present includes `slug`, `name`, `prompt`, `category`, `usage_type` (defaulted from `prompt_type`), `prompt_type`, `structure_mode` (`'structured'` or `'unstructured'`), `structure_preset` (default `'agent_pipeline_steps'`), `structure_mime` (`'application/json'` or `'application/x-yaml-extended'`, default JSON). |
| `personas` | array of `{ name, description, prompt }` | Resolved from `Agent.persona_ids`, sorted by name; empty array if none. |

## Use Cases

### UC1 — MCP host connects over stdio and gets a working tool surface

**Goal:** Let an MCP host (e.g. Cursor) launch `mcp-code-vault` as a subprocess and end up with a connected `McpServer` exposing `ping`/`settings`/`config` plus one tool per configured agent for the active project.

**Stakeholders:** The developer using Cursor (or another MCP host) who expects the vault's tools to "just work" after adding it to their MCP config; platform operators who don't want one misconfigured window to break every other open project.

**Actors:** The MCP host process; `main()`, `createMcpServer()`/`createMcpServerApp()` (`src/mcp/server.ts`), `tryStartDiscoveryAsPrimary()`, `runAsPrimary()`/`secondaryStartup()` (`src/index.ts`).

**Preconditions:** The host launches the process with `MONGO_URL`, `MCP_PROJECT_NAME`, `WORKING_DIRECTORY`, `PORT` set in its environment (required because `stdioMode` is true for a host-launched, non-TTY process).

**Postconditions:** A connected `McpServer` is listening on this process's stdio with `ping`, `settings`, `config`, and (once role election and, for a secondary, agent-tool registration complete) one tool per valid agent for `MCP_PROJECT_NAME`.

**Basic Course of Events (BCE):**
1. The host spawns the process and connects its own stdio to it.
2. `main()` validates that `MONGO_URL`, `MCP_PROJECT_NAME`, `WORKING_DIRECTORY`, `PORT` are all present (stdio mode enforces this).
3. `main()` calls `setServerContext(cwd, port)` then `createMcpServer()`, which builds the `McpServer` (three built-in tools registered, each wrapped in `withMetrics`) and connects it over `createLoggingStdioTransport()` — the host can already call `ping`/`settings`/`config` at this point.
4. `main()` calls `tryStartDiscoveryAsPrimary(port)` to decide the process's role (see UC5's Design Constraints on the underlying election; out of scope here).
5. If this process becomes primary, `runAsPrimary()` starts the stats/Socket.IO/Mongo/file-watch side; agent tools for this project are registered via that path's own project setup.
6. If this process becomes a secondary, `secondaryStartup()` connects to the primary over TCP, and — because this is a stdio-launched MCP client — additionally connects Mongoose directly, runs seed steps, ensures the `Project` row and its two collections exist, then calls `registerProjectAgentMcpTools(getMcpServerInstance())` against the already-connected `McpServer` from step 3, so the per-agent tools appear in this client's `tools/list`.

**Alternate Flows:**
- A1 — Non-stdio (TTY) run (e.g. `npm run dev`): env validation is skipped; the rest of the flow (steps 3–6) proceeds the same way.

**Exceptions:**
- E1 — A required env var is missing in stdio mode: `main()` calls `process.exit(1)` after logging a copy-pasteable example config; no `McpServer` is ever constructed.
- E2 — `main()` is invoked a second time in the same process (e.g. a double `require`): the module-level `processInstanceId` guard makes it log and return without re-registering tools or servers.
- E3 — The stats server fails to bind during `runAsPrimary()`: in stdio mode this is logged and swallowed so the bare `McpServer` connection from step 3 keeps working without the stats side; outside stdio mode it rethrows.

### UC2 — Client calls a built-in tool (`ping` / `settings` / `config`)

**Goal:** Let a connected MCP client check liveness, read current server settings, or change the working directory/port at runtime, without needing an agent configured.

**Stakeholders:** The developer/agent driving the MCP host; anyone debugging a vault connection.

**Actors:** The connected MCP client; the `ping`/`settings`/`config` handlers (`src/mcp/server.ts`); `getSettingsContent()`/`applyConfig()` (`src/mcp/context.ts`).

**Preconditions:** UC1 has completed through step 3 — the `McpServer` is connected and these three tools are registered.

**Postconditions:** The client receives a text response; for `config`, the process's in-memory `serverCwd`/`serverPort` may have changed.

**Basic Course of Events (BCE) — `ping`:**
1. Client calls `ping` with no arguments.
2. Handler (wrapped in `withMetrics('ping', 'query', ...)`) returns `{ content: [{ type: 'text', text: 'pong' }] }`.

**Basic Course of Events (BCE) — `settings`:**
1. Client calls `settings` with no arguments.
2. Handler returns the text built by `getSettingsContent()`: project name, a redacted Mongo URL block, cwd/pwd/port, and a ready-to-paste Cursor `mcpServers` JSON snippet reflecting the current `serverCwd`/`serverPort`.

**Basic Course of Events (BCE) — `config`:**
1. Client calls `config` with `{ workingDirectory, port }` (or the `cwd` alias for `workingDirectory`).
2. `applyConfig(input)` mutates the module-level `serverCwd`/`serverPort` in `src/mcp/context.ts` for any fields provided.
3. Handler returns `Set: <fields>` listing what changed.

**Alternate Flows:**
- A1 — `config` called with neither `workingDirectory`/`cwd` nor `port`: `applyConfig()` sets nothing; response text explains that nothing was provided instead of listing a change.

**Exceptions:** None — all three handlers are pure reads/writes of in-memory state with no external I/O that can fail from the caller's perspective; `withMetrics` records status/duration around each call but does not change what the client receives.

### UC3 — Client calls an agent's tool

**Goal:** Let a calling AI agent fetch a configured vault agent's full execution bundle (system prompt, capability flags, model categories, optional global prompt, personas) in one round trip, so it can run as that agent without a second lookup.

**Stakeholders:** The AI agent/developer invoking the tool; whoever configured the vault agent (its `system_prompt`, `tools` flags, linked personas/global prompt) in the Platform UI.

**Actors:** The connected MCP client; the per-agent tool handler registered by `registerProjectAgentMcpTools()` (`src/mcp/registerAgentTools.ts`); `loadAgentExecutionBundleById()` (`src/agent/loadAgentExecutionBundle.ts`).

**Preconditions:** UC1 completed including agent-tool registration (primary path or secondary's stdio-client path); the target agent has a valid, registered `tool_name` (e.g. `code_reviewer`).

**Postconditions:** The client receives the agent's `AgentExecutionBundle` as pretty-printed JSON text.

**Basic Course of Events (BCE):**
1. Client calls the agent's tool (e.g. `code_reviewer`) with no arguments.
2. The handler (wrapped in `withMetrics(tool_name, 'query', ...)`) calls `loadAgentExecutionBundleById(id)`.
3. `bundleFromAgentLean()` assembles the bundle: the agent's own fields (`name`, `description`, `system_prompt`, `tool_name`, `model_categories`, `tools` capability flags), an optional `globalPrompt` resolved via `global_prompt_id`, and a `personas` array resolved via `persona_ids`, sorted by name.
4. Handler returns the bundle as pretty-printed JSON text.

**Alternate Flows:**
- A1 — Agent has no `global_prompt_id`: `globalPrompt` is `null` in the returned bundle.
- A2 — Agent has no `persona_ids`: `personas` is an empty array in the returned bundle.

**Exceptions:**
- E1 — The agent can't be loaded (e.g. deleted after the tool was registered): the handler returns `{ isError: true, ... }` text instead of a bundle.

### UC4 — Agent misconfiguration is skipped, not fatal

**Goal:** Ensure one badly configured agent (empty, invalid, or colliding `tool_name`) never prevents the MCP server from starting or from registering other agents' tools.

**Stakeholders:** Every user of the project's vault, since a single bad `Agent` row must not take down the whole tool surface; whoever misconfigured the agent, who needs a way to notice.

**Actors:** `registerProjectAgentMcpTools()` (`src/mcp/registerAgentTools.ts`); the SDK's `validateToolName`; the `RESERVED` name set (`ping`, `settings`, `config`).

**Preconditions:** At least one `Agent` row for `MCP_PROJECT_NAME` has an empty, invalid (fails `validateToolName`), reserved (collides with `ping`/`settings`/`config`), or duplicate (collides with another agent already processed in this pass) `tool_name`.

**Postconditions:** The offending agent gets no MCP tool; a warning is logged (`agent_mcp_tool_skip`); every other valid agent still gets its tool registered; startup completes normally.

**Basic Course of Events (BCE):**
1. `registerProjectAgentMcpTools(server)` loads all `Agent` rows for the project, sorted by name.
2. For each agent, its `tool_name` is checked: non-empty, passes `validateToolName`, not in `RESERVED`, and not already used earlier in this same pass.
3. If the check fails, the agent is skipped with `logger.warn(...)`, and the loop continues to the next agent.
4. If the check passes, the tool is registered as in UC3.

**Alternate Flows:**
- A1 — Two agents collide on the same `tool_name`: the first one (in name-sorted order) wins; the later one is skipped as in step 3.

**Exceptions:** None beyond the skip-and-continue behavior itself — this use case exists specifically because a bad row must never throw or abort the registration loop.

### UC5 — Host disconnects or process is signaled — graceful shutdown

**Goal:** Let the process shut down cleanly when the MCP host disconnects it (disables/removes the server) or the OS signals it, without leaving other secondaries stranded if this process happens to be the primary.

**Stakeholders:** The developer closing Cursor or their project window; other secondary processes relying on this one if it's the primary.

**Actors:** `process.stdin`'s `'end'` handler; `SIGTERM`/`SIGINT` handlers (registered in `main()`); the transport's `onclose` interception (`createLoggingStdioTransport()`, `src/mcp/transportLogger.ts`); `disconnectFromPrimary()`, `runShutdown()` (`src/shutdown.ts`).

**Preconditions:** The process has completed `main()` and has an active `McpServer`/transport (and, if a secondary, a connection to a primary).

**Postconditions:** `disconnectFromPrimary()` and `runShutdown()` have both run; if this process is a secondary, its stdio transport closing also triggers the same shutdown path; if this process is the primary, transport close alone does not shut it down.

**Basic Course of Events (BCE):**
1. The MCP host disables/removes the server, or the process receives `SIGTERM`/`SIGINT`, or stdin ends.
2. The corresponding handler registered in `main()` calls `disconnectFromPrimary()` then `runShutdown()`.

**Alternate Flows:**
- A1 — This process is a secondary and only the stdio transport closes (host-initiated, not a signal): `createLoggingStdioTransport()`'s `onclose` wrapper checks `getShutdownOnTransportClose()`, finds it `true` (set by `secondaryStartup()`), and itself calls `disconnectFromPrimary()`, invokes the original close handler, then `runShutdown()` — the same end state as the BCE, reached via the transport path instead of a signal.

**Exceptions:**
- E1 — This process is the primary and its stdio transport closes: `getShutdownOnTransportClose()` is `false` (set by `runAsPrimary()`), so `createLoggingStdioTransport()`'s `onclose` wrapper only invokes the original close handler and does NOT call `runShutdown()` — the primary must keep running its TCP/discovery/stats servers for any other secondaries still depending on it. Only an explicit signal (BCE) or stdin end shuts down a primary.

### UC6 — Primary dies while a secondary is connected (failover)

**Goal:** Let a secondary process recover its tool surface and metrics connection when the primary it depends on disappears, without the developer having to restart their MCP host.

**Stakeholders:** The developer whose Cursor window is a secondary and should not notice the primary died; other secondaries going through the same recovery independently.

**Actors:** `onPrimaryDisconnect` callback (registered in `secondaryStartup()`, `src/index.ts`); `secondaryStartup()` itself; `registerProjectAgentMcpTools()`.

**Preconditions:** This process is a secondary with an established TCP connection to a primary (per UC1's secondary branch); that primary process exits or its connection drops.

**Postconditions:** This process has either reconnected to a (possibly new) primary and re-registered its agent tools, or has itself become the new primary.

**Basic Course of Events (BCE):**
1. The primary connection drops; `onPrimaryDisconnect` fires.
2. It calls `disconnectFromPrimary()` and re-invokes `secondaryStartup()` with fresh random jitter.
3. `secondaryStartup()` retries `discoverPrimary()` (UDP) then `connectToPrimary()` (TCP) — the underlying election/rediscovery mechanics belong to `discovery-coordination`, not this doc.
4. On reconnecting to a (new) primary, this process repeats its stdio-client setup from UC1 step 6: `setStatsBaseUrl` to the new primary, and — specific to this doc's surface — since `agentMcpToolsRegistered` was already set true from the first registration, `registerProjectAgentMcpTools()` is a no-op on this call; the agent tools already registered on this process's `McpServer` instance remain valid and do not need to be re-created, since failover changes which primary this process talks to, not which `McpServer` instance is serving this client's stdio connection.

**Alternate Flows:**
- A1 — Discovery/connect both fail after retries: `secondaryStartup()` calls `tryStartDiscoveryAsPrimary` again, and this process may itself win the election and become primary (see UC1's primary branch).

**Exceptions:**
- E1 — Retries are exhausted (`maxRetries`, default 100): `secondaryStartup()` gives up; this process's own `McpServer`/stdio connection (already established in UC1) is unaffected and keeps serving `ping`/`settings`/`config`/agent tools, but its stats/metrics link to a primary and any primary-dependent features remain unavailable until a future reconnect attempt succeeds.

## Tests

- `mcp-code-vault/__tests__/mcp-server.test.ts` — `createMcpServerApp()` returns a connectable server instance; direct assertions on the `ping`/`settings`/`config` tool handlers (pong text, settings text, config apply/no-op/report-applied-keys branches).
- `mcp-code-vault/__tests__/mcp-server-connect.test.ts` — `createMcpServer()` actually connects a transport and returns the server.
- `mcp-code-vault/__tests__/index.test.ts` — `localNetworkHost()` (first non-internal IPv4 or null); `main()` throws on invalid `PORT`; a second `main()` call is a no-op after successful init; primary-path wiring (`setServerContext` → `createMcpServer` → stats server listen); the secondary/client branch (`tryStartDiscoveryAsPrimary` false, `connectToPrimary` succeeds → `setStatsBaseUrl`, `markServerReady('client')`, no stats server) and that `disconnectFromPrimary` gets registered for shutdown.
- `mcp-code-vault/__tests__/stdioMode.test.ts` — `stdioMode` constant truth table (`isTTY` undefined/true, `MCP_STDIO=0` override); `writeProcessLog` fan-out across `setProcessLogSink` + `addProcessLogSink`.
- `mcp-code-vault/__tests__/run.test.ts` — `run.ts` loads `index.ts` and calls `main().catch(onFatal)`; `onFatal` writes to stderr and exits on a load error.
- `mcp-code-vault/__tests__/registerAgentTools.test.ts` — registers a tool per valid agent; no-ops when `MCP_PROJECT_NAME` is unset; idempotent across repeated calls in the same process.
- `mcp-code-vault/__tests__/transportLogger.test.ts` — `getMethod` fallback to `'unknown'`; `onclose` runs disconnect+shutdown when `getShutdownOnTransportClose()` is true and skips disconnect when false; `onmessage` logs the method before delegating; `start`/`send`/`close` delegate to the inner transport.
- `mcp-code-vault/__tests__/requestLog.test.ts` — `appendRequestLog` writes a line to `logs/mcp-requests.log` and does not throw when the path is writable.
- `mcp-code-vault/__tests__/loadAgentExecutionBundle.test.ts` — `loadAgentExecutionBundleById` returns `null` for a missing agent; maps `tool_name`/`tools` onto `bundle.agent`; includes `globalPrompt` structure metadata when a `global_prompt_id` is linked; `loadAgentExecutionBundleByName` delegates to the by-id path.
- `mcp-code-vault/__tests__/integration/mcp-stdio.test.ts` — end-to-end: spawns the real server process via `npx tsx src/index.ts` and drives it with the SDK's real `StdioClientTransport`/`Client` (the same path an actual MCP host like Cursor uses), asserting `ping` and `config` appear in `tools/list` and that calling `ping` returns text `'pong'`. Skips automatically if `MONGO_URL` is not set in the environment.

## UI/UX

This subsystem is a backend protocol server with no visual surface of its own — its only "UI" is the MCP `instructions` text and the tool descriptions/schemas an MCP host (e.g. Cursor) renders in its own tool-picker UI. The human-facing configuration surface (viewing/editing agents, tool names, project settings) lives in the separate Platform UI referenced by `getInstructions()` (e.g. `http://localhost:2999/docs`), which is out of scope for this doc.

## Dependencies

- **storage** — the per-project MongoDB collections (`{projectKey}_knowledge_base`, `{projectKey}_FileProcessor`) are created by `ensureProjectCollections()`, which the stdio-client startup path in `src/index.ts` calls directly before registering agent tools; this doc assumes that collection/index setup as given.
- `@modelcontextprotocol/sdk` — `McpServer`, `StdioServerTransport`, `validateToolName`, and the `Transport`/`JSONRPCMessage` types this whole subsystem is built on.
- `mongoose` (`Types.ObjectId`) plus the `Agent`, `Project`, `Persona`, `SystemPrompt` models (`src/db/models/*`) — read by `registerAgentTools.ts` and `loadAgentExecutionBundle.ts`.
- `socket.io` — used only in the primary path (`runAsPrimary`) for the live stats/discovery stream, not by the MCP protocol handling itself.
- Internal modules this subsystem calls into directly: `src/stats/metricsClient.ts` (`withMetrics`, `markServerReady`, `setStatsBaseUrl`), `src/stats/server.ts` (`createStatsServer`), `src/stats/streamChannel.ts`, `src/stats/scanProgressCache.ts`, `src/logFile.ts` (`getLogDir`, `getLogPath`, process log file), `src/logger.ts`, `src/shutdown.ts` (`registerShutdown`, `runShutdown`, `setShutdownOnTransportClose`, `getShutdownOnTransportClose`), `src/db/mongoose.ts`, `src/db/seed.ts`, `src/db/ensureProject.ts`, `src/db/projectDb.ts`, `src/fileProcessingStartup.ts`, `src/discoveryClient.ts`, `src/primaryServer.ts`, `src/primaryClient.ts`, `src/projectKey.ts`, `src/utils/redactMongoUrl.ts`.

## Diagrams

```
MCP host (e.g. Cursor)
   │  stdio (JSON-RPC)
   ▼
createLoggingStdioTransport()  ──appendRequestLog()──▶ logs/mcp-requests.log
   │
   ▼
McpServer  (name: mcp-code-vault)
   ├── ping     ─┐
   ├── settings  ├─ withMetrics(op,'query', handler) ─▶ postMetric (stats)
   ├── config   ─┘
   └── <agent.tool_name> × N  ── loadAgentExecutionBundleById(id) ──▶ Agent / SystemPrompt / Persona (Mongo)

Process role election (per src/index.ts):
   main() → tryStartDiscoveryAsPrimary(port)
       ├── true  → runAsPrimary(): stats HTTP + Socket.IO + Mongo + file-watch + UDP announce (9255) + TCP (9256)
       └── false → secondaryStartup(): discoverPrimary (UDP) → connectToPrimary (TCP)
                       └── if stdioMode: connectMongoose, seed, ensureProject, ensureProjectCollections,
                                          registerProjectAgentMcpTools(activeMcpServer)
```

## References

- `mcp-code-vault/src/mcp/server.ts`, `context.ts`, `registerAgentTools.ts`, `requestLog.ts`, `transportLogger.ts`
- `mcp-code-vault/src/index.ts`, `stdioMode.ts`, `run.ts`
- `mcp-code-vault/src/utils/mcpToolName.ts`, `defaultAgentTools.ts`
- `mcp-code-vault/src/agent/loadAgentExecutionBundle.ts`
- `mcp-code-vault/src/shutdown.ts`, `primaryClient.ts`, `discoveryClient.ts`, `primaryServer.ts`
- `mcp-code-vault/__tests__/mcp-server.test.ts`, `mcp-server-connect.test.ts`, `index.test.ts`, `stdioMode.test.ts`, `run.test.ts`, `registerAgentTools.test.ts`, `transportLogger.test.ts`, `requestLog.test.ts`, `loadAgentExecutionBundle.test.ts`, `integration/mcp-stdio.test.ts`
- `docs/design/storage.md`
