---
modified: 2026-07-06
dependencies: [stats-api, discovery-coordination]
---

# Platform UI

Nuxt 3 frontend at `mcp-code-vault/platform-ui` that gives the `mcp-code-vault` MCP server a human-facing dashboard: live stats, a config editor for models/prompts/agents/personas, a scan progress view, and generated docs. It never talks to MongoDB directly — everything goes through the stats/config HTTP backend (Fastify) that runs alongside the MCP server, reached either by direct browser fetch to a discovered port or through a Nitro server-side proxy. Read this doc before touching any file under `platform-ui/pages`, `components`, `composables`, `lib`, or `server`. See `docs/design/stats-api.md` for what the backend routes this UI calls actually do, and `docs/design/discovery-coordination.md` for the MCP-server side of the UDP pairing handshake described below.

## Sensitive Areas

- `server/plugins/discovery.server.ts` broadcasts a UDP datagram (port 9255) advertising this UI's `/api/register` URL so an MCP server process can find it and register its stats port. Changing the broadcast interval, port, or payload shape breaks the pairing between a running MCP server and this UI without any visible error — the dashboard just silently shows "Waiting for connection."
- `server/utils/discovery-store.ts` is an in-memory `Map`, pruned by `STALE_MS` (default 35s, `DISCOVERY_STALE_MS`). This value must stay comfortably above both the UI's broadcast interval (5s) and the MCP server's register throttle (5s) — the comment in the file explains a prior regression where too-short staleness caused `/api/servers` to go empty and the Config page to lose all agents/personas mid-session.
- Pages resolve the backend origin themselves (`streamTargetUrl` from Socket.IO discovery, falling back to `primaryBaseUrl`) and call the Fastify backend directly with `fetch(`${base}/...`)` — they do **not** route these through `/api/stats/*`. Only a few server routes (docs-context, register, servers) are Nitro-owned. Adding a new client-side data call means deciding, consciously, whether it goes direct-to-backend (current pattern for `/projects`, `/config/*`, `/metrics`, `/scan/*`) or through the `/api/stats/**` proxy (`server/utils/stats-nitro-catchall.ts` / `stats-http-proxy.ts`) — mixing conventions inconsistently will break in dev vs. prod differently.
- `useSelectedProjectKey` is a module-level singleton `Ref` backed by `localStorage`, shared by index/config/scan pages. Two pages racing to `reconcileSelectedProjectKey` against different `/projects` responses can fight over the value; the guard against this is the `''`-vs-populated-list check inside that function — do not "simplify" it without re-reading why it special-cases an empty project list.
- `config.vue`'s "Save" / "New" buttons are **not** in the panel components — they live in the page header (`pages/config.vue`) and drive the active panel through template refs (`modelsPanelRef`, `promptsPanelRef`, `agentsPanelRef`, `personasPanelRef`) exposing `submitDraft`/`startNewDraft`/etc. via `defineExpose`. Adding a new config section means wiring both the header buttons and the exposed methods, not just the panel body.
- The models inline-edit dirty-guard (`modelsInlineDirty`, `configNavGuardOpen`, `onBeforeRouteUpdate`/`onBeforeRouteLeave` in `config.vue`) blocks navigation away from Models with unsaved per-row edits. This is the only in-app "confirm before leaving" mechanism in the UI; it depends on `ConfigModelsPanel`'s `collectDirtyInlineUpdates`/`flushInlineSave` exposed methods staying in sync with its internal `inlineDraft` reactive map.

## Design Constraints

- Must run from `mcp-code-vault/platform-ui` (not the repo root) so `@nuxtjs/tailwindcss` resolves from local `node_modules`; `npm run dev:ui` from the workspace root is the supported shortcut (see `README.md`).
- Fixed dev port 2999 (`NUXT_PORT`/`NITRO_PORT` override) — deliberately distinct from the MCP/stats server's port 3000 so both can run side by side on one machine (`nuxt.config.ts` comment).
- DevTools are explicitly disabled in `nuxt.config.ts` — the component-inspector overlay was triggering a Vue warning by passing `style` to a fragment-root component. Do not re-enable without fixing that root cause.
- `socket.io-client` needs special Vite handling: it pulls in Node's `debug` package, whose browser build lacks an ESM default export, so `nuxt.config.ts` aliases `debug` and `debug/src/browser.js` to a local `debug-stub.js` and forces `optimizeDeps.include: ['socket.io-client']`. `lib/socketIoClient.ts` exists purely so pages `import('../lib/socketIoClient')` instead of dynamically importing the bare package (a raw dynamic import of a node_modules package resolves to a dev-only `/_nuxt/node_modules/...` path that 404s).
- `experimental.payloadExtraction: false` and per-route `prerender: false` on `/`, `/config`, `/docs`, `/scan` — all four pages are inherently live/dynamic (socket-driven or backend-driven) and must not be statically prerendered.
- Runtime config `statsBackend` is read from `NUXT_STATS_BACKEND`/`CODE_VAULT_STATS_URL`, but `server/utils/stats-backend.ts` re-reads the same env vars directly rather than going through Nuxt's `useRuntimeConfig()` — the nuxt.config comment flags this duplication as intentional/documented for ops, not an oversight to "fix" by consolidating.
- No dedicated state library — global cross-page state is a handful of `useState` singletons (`usePrimaryBaseUrl`, `useStreamTargetUrl`, `useDocsNavAgentEntries`) plus one custom module-singleton (`useSelectedProjectKey`) backed by `localStorage`. New cross-page state should follow one of these two patterns, not introduce Pinia or similar.

## Feature Overview

- **Stats dashboard** (`pages/index.vue`, route `/`) — live connection status to the MCP server, two ApexCharts (time series, requests-per-minute), scorecards (queries, documents returned, files read, model calls, tool calls, errors, cache hit rate), LLM latency/token percentile cards, a "Registered MCPs" strip (primary vs. secondary), and a scrollable Socket.IO event log with per-row expand and consecutive-event grouping.
- **Config** (`pages/config.vue`, route `/config`, hash-routed sections `#settings`, `#models`, `#prompts-global`, `#prompts-agents`, `#prompts-personas`) — project picker + per-project file-processing settings and MCP-tool/agent summary (`#settings`); saved LLM model providers grouped by account with an add/edit wizard for remote and local (Ollama/OpenAI-compatible) providers (`#models`); vault-wide prompt CRUD with optional structured-output presets (`#prompts-global`); agent CRUD (system prompt, tool_name, model category filters, personas, tool flags) (`#prompts-agents`); persona CRUD (`#prompts-personas`).
- **Docs** (`pages/docs.vue`, route `/docs`) — a single long-form reference page: MCP setup quick-start (with a live-templated MCP JSON snippet and copy button), a static reference for the built-in `ping`/`settings`/`config` MCP tools, one auto-generated reference subsection per configured agent (fetched from `/config/agents`), platform-UI run instructions, and a configuration-model overview.
- **Scan** (`pages/scan.vue`, route `/scan`) — project picker plus a live file-indexing heatmap (`ChunkUpdateGrid`) driven by `scan:progress` Socket.IO events, with a progress bar (processed/updated/total) and a demo/example dataset shown when no project is registered yet.
- **Discovery plumbing** — a small Nitro-side subsystem (UDP broadcast plugin + in-memory registered-server store + register/deregister/list API routes) that lets one or more running MCP server processes find and announce themselves to this UI without any manual port configuration.
- **Shared chrome** — `layouts/default.vue` renders the persistent left sidebar (Stats/Config/Scan/Docs nav, with sub-navigation for Config and Docs sections driven by scroll position and route hash) plus a mouse-tracked purple spotlight background and the global `ToastStack`.

## Architecture

The app is a standard Nuxt 3 `pages/` + `components/` + `composables/` + `server/` tree with no custom routing config beyond `app/router.options.ts` (scroll-to-hash behavior, deferred one frame for SSR/hydration).

**Client-side data flow.** Every page that needs live data resolves a "primary base URL" for the Fastify stats backend at runtime rather than hardcoding it:
1. `usePrimaryBaseUrl()` / `useStreamTargetUrl()` (both `useState` singletons) hold the resolved `http://<host>:<port>` origin.
2. Pages first call `GET /api/servers` (Nitro route backed by `discovery-store.ts`) to see which MCP servers have registered; if empty, they fall back to `GET /api/docs-context` for a best-guess port.
3. Once a URL is known, the page opens a Socket.IO connection to that origin directly (via `lib/socketIoClient.ts`) and also issues plain `fetch()` calls straight to that origin for REST endpoints (`/projects`, `/config/*`, `/metrics`, `/scan/*`, etc.) — these do not go through Nitro.
4. A small number of routes are Nitro-hosted instead: `/api/register` and `/api/servers/deregister` (discovery lifecycle, written to `discovery-store.ts`), `/api/docs-context` (returns cwd/port for the docs MCP snippet), and the catch-all `/api/stats/**` proxy (`stats-nitro-catchall.ts` → `stats-http-proxy.ts` → `stats-backend.ts`) for cases where a same-origin path is preferable to a cross-origin fetch.

**Component/page split.** `pages/config.vue` is the orchestrator: it owns all data fetching, all mutation functions (`savePrompt`, `saveAgent`, `saveModels`, etc.), all Socket.IO wiring, and the section-switch/hash logic. The four `Config*Panel.vue` components (`ConfigPromptsPanel`, `ConfigAgentsPanel`, `ConfigModelsPanel`, `ConfigPersonasPanel`) are presentational + form-state-owning children: each keeps its own draft `reactive()` form, its own dirty-check/switch-confirmation modal, and exposes an imperative API (`startNewDraft`, `submitDraft`, sometimes more) via `defineExpose` so the page's header buttons can drive them. Data and callbacks flow down as props/emits; the page never reaches into a panel's internals except through the exposed methods.

**Server-side layout.** `server/api/*.ts` are one-file-per-route Nitro handlers; `server/utils/*.ts` hold the logic they call into (kept separate so `stats-http-proxy.ts` and `discovery-store.ts` are independently unit-testable without spinning up Nitro). `server/plugins/discovery.server.ts` runs once at server boot to start the UDP broadcast loop (skipped when `NODE_ENV === 'test'`).

**Styling.** Tailwind (`@nuxtjs/tailwindcss`) plus a small set of CSS custom properties (`--accent`, `--surface-card`, `--surface`, etc., referenced throughout via `var(--accent)` and `color-mix()`), a dark violet/purple theme (`#100B1A` background), and `@nuxt/icon` (Lucide icon set) for iconography. `GlassCard.vue` is the one reusable "frosted glass panel" wrapper used for nearly every content block on every page.

## Functions

Rather than a flat API list, the meaningful logic is grouped by file:

- **`composables/useConfigRoute.ts`** — `isConfigPath`, `configHashFragment`, `normalizeConfigSectionHash`: pure functions reconciling `/config` hash fragments (including legacy aliases like `#personas` → `#prompts-personas`) between `route.hash` and `window.location.hash`, since a full page reload can leave the two briefly disagreeing.
- **`composables/useSelectedProjectKey.ts`** — `useSelectedProjectKey()` (module-singleton `Ref` synced to `localStorage`), `reconcileSelectedProjectKey(selected, projects)` (falls back to the first project if the stored key is stale or missing), `resetSelectedProjectKeyStateForTests()`.
- **`composables/usePlatformToast.ts`** — `usePlatformToast()` returns `{ toasts, success, error, dismiss }`; a shared `ref` array with auto-dismiss timers, rendered by `ToastStack.vue`.
- **`composables/usePrimaryBaseUrl.ts` / `useStreamTargetUrl.ts` / `useDocsNavAgentEntries.ts`** — thin `useState` wrappers for the three pieces of cross-page global state described in Architecture.
- **`lib/apiError.ts`** — `readApiErrorMessage(res)`: extracts a human-readable message from a failed `fetch` Response (`{error}`/`{message}` JSON, short plain text, or a status-line fallback), used everywhere a mutation can fail so toasts show something meaningful.
- **`lib/mongoId.ts`** — `mongoIdString(raw)`: normalizes `_id`/`id` values that may arrive as a plain string, an Extended-JSON `{ $oid }`, or a stringifiable object, for safe use in URL paths.
- **`lib/slugify.ts`** — `slugify(input)`: must stay byte-for-byte in sync with the backend's prompt-slug generator (`src/stats/routes/config.ts`), per its own comment.
- **`lib/modelCategories.ts`** — `normalizeModelCategoryToken`, `normalizeModelCategoriesInput`, `categoriesFromSavedModel`, `defaultModelCategoriesIfEmpty`: category-tag normalization shared between the Models and Agents panels, mirroring `src/utils/modelCategories.ts` on the backend.
- **`lib/socketIoClient.ts`** — re-exports `io` from `socket.io-client` so pages can dynamic-`import()` a local module instead of the bare package (avoids a dev-only 404).
- **`lib/promptStructurePresets.ts` / `lib/dumpYamlExtended.ts`** — power the "structured output" mode of the Prompts panel: preset definitions (field guide + sample document) and a YAML-with-extensions serializer used to preview a structured prompt's expected output shape.
- **`server/utils/discovery-store.ts`** — `register`, `deregister`, `pruneStale`, `getServers`: the in-memory registered-MCP-server table described in Sensitive Areas.
- **`server/utils/stats-backend.ts`** — `getStatsBackendOrigin()`: resolves the Fastify backend's origin from env vars for server-side proxying.
- **`server/utils/stats-http-proxy.ts`** — `executeStatsProxyRequest(params)`, `statsProxyPathFromParams(params)`: the actual proxy fetch (strips hop-by-hop headers, forwards method/body/content-type/authorization) used by the `/api/stats/**` catch-all.
- **`server/utils/stats-nitro-catchall.ts`** — `handleStatsNitroCatchall(event)`: H3 glue between an incoming Nitro request and `stats-http-proxy.ts`.

## Models

The UI holds no persistent models of its own (no database) — it only defines client-side TypeScript shapes for data it fetches from the stats backend. The important ones, defined inline in the consuming file:

- **`AgentItem`** (`pages/config.vue`, mirrored in `ConfigAgentsPanel.vue`) — `_id`, `name`, `description`, `system_prompt`, `tool_name`, `model_categories: string[]`, `persona_names: string[]`, `global_prompt_id: string | null` (+ `global_prompt_name`), `tools: { file_watch, db_read_write, web_search, run_shell }`, `save_to_seed`, `project_key?`.
- **`PromptItem`** (`ConfigPromptsPanel.vue`) — `_id`, `name`, `slug?`, `prompt`, `usage_type`, deprecated `prompt_type`, `category: 'fast'|'blended'|'thinking'`, `is_default`, `save_to_seed`, `structure_mode?: 'unstructured'|'structured'`, `structure_preset?`, `structure_mime?: 'application/json'|'application/x-yaml-extended'`.
- **`PersonaItem`** (`ConfigPersonasPanel.vue`) — `_id`, `name`, `description`, `prompt`, `save_to_seed`.
- **`SavedModel` / `DiscoveredModel`** (`ConfigModelsPanel.vue`) — saved: `_id`, `provider`, `name`, `label`, `credential_id?`, `category?`/`categories?`, `priority?`, `access_key?`, `api_base_url?`, `local_api_mode?: 'ollama'|'openai'`, `enabled?`, `capabilities?`, `is_custom?`. Discovered (from a provider's model-list API): `id`, `name`, `label`, `capabilities`, `description?`, `suggested_category?`.
- **`ProjectItem`** (`pages/config.vue`, `pages/scan.vue`) — `{ key, name }`, the minimal shape used by `PlatformProjectSelect`.
- **`StreamMetric`** (`pages/index.vue`) — `_id?`, `instance_id`, `operation`, `kind?: 'query'|'event'`, `started_at`, `ended_at`, `duration_ms`, `status: 'ok'|'error'`, `error_code?`, `metadata?` — the shape returned by both the initial `GET /metrics` load and the live `metric` Socket.IO event.
- **`ScanFileEntry` / `ScanProgressPayload`** (`pages/scan.vue`, `ChunkUpdateGrid.vue`) — a file's `{ relativePath, state: 'new'|'stale'|'fresh' }` and the aggregate `{ filesProcessed, filesUpdated, totalFiles?, isActiveScan?, files?, projectKey? }` driving the scan heatmap.
- **`RegisteredServer`** (`server/utils/discovery-store.ts`) — `{ projectName, port, lastSeen }`, the only server-side persisted (in-memory, non-durable) shape in this subsystem.

## Use Cases

### UC1 — Developer starts the MCP server for a new project

**Goal:** Get a newly-started MCP server process and this dashboard paired up automatically, with no manual port/URL configuration.

**Stakeholders:** The developer starting the server (wants the dashboard to "just work"); the platform-ui maintainers (own the pairing mechanism's reliability).

**Actors:** `server/plugins/discovery.server.ts` (UDP broadcast, this UI); the MCP server's stats backend process (external, registers itself); `server/utils/discovery-store.ts`; `server/api/register.post.ts`; `server/api/servers.get.ts`; the Config/Scan project pickers and the Stats page's "Registered MCPs" strip (all consumers of `/api/servers`).

**Preconditions:** This platform-ui app is already running (its Nitro server boots `discovery.server.ts`, which starts broadcasting a UDP datagram advertising its own `/api/register` URL every 5 seconds); the developer's MCP server process is not yet registered.

**Postconditions:** The new MCP server's `{port, projectName}` is stored in `discovery-store.ts`; the dashboard's "Registered MCPs" strip and the Config/Scan project pickers show the new project without any manual configuration.

**Basic Course of Events (BCE):**
1. Developer starts the MCP server process for their project.
2. The MCP server's stats backend receives this UI's UDP-broadcast register URL and POSTs `{port, projectName}` to it.
3. `server/api/register.post.ts` writes the entry into `discovery-store.ts`'s in-memory `Map`.
4. Pages polling `GET /api/servers` (Config, Scan, Stats) pick up the new entry within one 5-second poll cycle.
5. The Stats page's "Registered MCPs" strip and the Config/Scan project pickers render the new project — as primary if it's the first/only one, otherwise as a secondary.

**Alternate Flows:**
- A1 — A second MCP server process registers while one is already active: it appears as a secondary entry (sky-blue, radio icon) in the "Registered MCPs" strip rather than replacing the primary.

**Exceptions:**
- E1 — `DISCOVERY_STALE_MS` (default 35s) is set too close to the UI's 5s broadcast interval or the MCP server's 5s register throttle: `pruneStale` can evict a still-live registration between register cycles, causing `/api/servers` to go empty and the Config page to lose all agents/personas mid-session. This is a documented prior regression (see Sensitive Areas) — the current 35s default is a deliberate margin above both 5s intervals, not an arbitrary number, and should not be lowered without re-checking that margin.

### UC2 — Developer adds a new remote LLM provider

**Goal:** Register a new LLM provider's API key and select which of its available models to make usable by agents/prompts.

**Stakeholders:** The developer configuring the vault; agents/prompts that will later reference the saved models by category.

**Actors:** The developer; `ConfigModelsPanel.vue` (add-remote wizard); `pages/config.vue`'s `saveModels`; the backend's `POST /config/models/discover` and model/credential-creation routes.

**Preconditions:** Developer is on Config → Models (`#models`) with the account/provider they want to add not yet configured; they have a valid API key for that provider.

**Postconditions:** A `model_provider_credentials` row exists for the account; one `models` row exists per model the developer chose to save, each with its selected category/priority.

**Basic Course of Events (BCE):**
1. Developer clicks "Add remote" (header action button) and picks a provider.
2. Developer pastes an API key into the wizard form.
3. `ConfigModelsPanel` debounce-fetches the provider's model catalog by emitting `discover`, which calls `POST /config/models/discover`.
4. Developer reviews the searchable/filterable catalog (with select-all) and checks which models to save, setting per-model category/priority.
5. Developer confirms; `saveModels` in `pages/config.vue` first creates the `model_provider_credentials` row, then creates one `models` row per selected model.
6. The new models appear in the Models accordion, grouped under their provider account.

**Alternate Flows:**
- A1 — Developer adds a local provider instead (Ollama or an OpenAI-compatible endpoint): the wizard swaps the API-key field for an endpoint URL and a "Test connection" action; the rest of the flow (catalog fetch, per-model category/priority selection, `saveModels`) is the same.

**Exceptions:**
- E1 — The API key is invalid or the provider's catalog endpoint is unreachable: `POST /config/models/discover` fails and `readApiErrorMessage` (`lib/apiError.ts`) extracts a human-readable message for a toast (`usePlatformToast`), instead of the wizard silently showing an empty catalog.

### UC3 — Developer edits saved models' categories inline

**Goal:** Adjust category/priority tags on one or more already-saved models without reopening the add-provider wizard, and be protected from losing that work by an accidental navigation.

**Stakeholders:** The developer doing bulk cleanup of model categorization; other pages relying on `useSelectedProjectKey`/routing not silently discarding this developer's edits.

**Actors:** The developer; `ConfigModelsPanel.vue` (`inlineDraft`, `modelsInlineDirty`, `collectDirtyInlineUpdates`, `flushInlineSave`); `pages/config.vue`'s header "Save" button and `configNavGuardOpen`/`onBeforeRouteUpdate`/`onBeforeRouteLeave`.

**Preconditions:** Developer is on Config → Models with at least one saved model visible in the accordion.

**Postconditions (basic course):** All rows edited since the last save have their category/priority changes persisted via parallel PATCH requests, and `modelsInlineDirty` returns to false.

**Basic Course of Events (BCE):**
1. Developer expands a saved model's row and changes its category/priority directly in the inline editor (no wizard).
2. `ConfigModelsPanel` records the change in its `inlineDraft` reactive map for that row.
3. The header "Save" button becomes visible/enabled because `modelsInlineDirty` is now true.
4. Developer repeats steps 1-2 for additional rows.
5. Developer clicks the header "Save" button, which calls `modelsPanelRef.flushInlineSave()`.
6. `flushInlineSave` calls `collectDirtyInlineUpdates` to gather every dirty row, then `batchPatchModelInline` PATCHes each dirty row in parallel.
7. On success, `inlineDraft` is cleared for the saved rows and `modelsInlineDirty` returns to false.

**Alternate Flows:**
- A1 — Developer tries to navigate away (route change or leaving `/config`) while `modelsInlineDirty` is still true: `onBeforeRouteUpdate`/`onBeforeRouteLeave` intercepts the navigation and opens the `configNavGuardOpen` modal instead of letting it proceed. From there the developer either confirms save-and-continue (`configNavSaveAndGo`, which runs the same `flushInlineSave` path before completing the navigation) or cancels the modal and stays on the page with edits intact.

**Exceptions:**
- E1 — One of the parallel PATCH requests in `batchPatchModelInline` fails: `readApiErrorMessage` surfaces the failure via a toast; the failed row's entry remains in `inlineDraft` (still dirty) so the developer can retry without having to redo the successfully-saved rows.

### UC4 — Operator watches a live indexing run

**Goal:** See file-indexing progress for a project update in real time without refreshing the page.

**Stakeholders:** The operator monitoring the scan; developers who want confirmation their project's files were actually indexed.

**Actors:** The operator; `pages/scan.vue`; `fetchScanFileListing`; the `scan:replay`/`scan:progress` Socket.IO events; `mergeScanFilesFromPatch`; `ChunkUpdateGrid.vue`.

**Preconditions:** Operator is on `/scan`; at least one project is registered (has appeared via `/api/servers`).

**Postconditions:** The heatmap and progress bar reflect the current per-file indexing state (`new`/`stale`/`fresh`) and aggregate processed/updated/total counts for the selected project.

**Basic Course of Events (BCE):**
1. Operator selects a project in the project picker.
2. `fetchScanFileListing` loads the initial file listing for that project, with every file marked `new`.
3. The page issues a Socket.IO `scan:replay` request for that project.
4. As `scan:progress` events arrive, `mergeScanFilesFromPatch` patches each affected file's `state` into the existing in-memory list.
5. `ChunkUpdateGrid` re-renders: the progress bar's processed/updated/total segments update, and the heatmap block(s) for the affected file(s) change color/state — as individual animated DOM blocks below 72 files, or via a single `<canvas>` redraw at or above that threshold.
6. Hovering a heatmap block shows a teleported tooltip with that file's path and indexing status.

**Alternate Flows:**
- A1 — No project is registered yet (zero entries from `/api/servers`): the page shows a fixed 500-file example heatmap instead of an empty page, so the layout/behavior can be seen before any real project exists.

**Exceptions:** None — this page only consumes already-validated Socket.IO payloads (`ScanProgressPayload`) and has no user-triggered write path of its own to fail.

### UC5 — Support engineer diagnoses a disconnected dashboard

**Goal:** Determine whether the Stats page's live connection to the MCP server's stats backend is up, and see a trace of recent connection activity, without opening browser devtools.

**Stakeholders:** The support engineer triaging a "dashboard looks stuck" report; the end user who originally noticed the problem.

**Actors:** The support engineer; `pages/index.vue`; `streamStatus`; `addStreamLog`; the Socket.IO client (`lib/socketIoClient.ts`).

**Preconditions:** Support engineer has the Stats page (`/`) open; the dashboard's Socket.IO connection to the discovered backend origin is not in the `connected` state (disconnected, still waiting, or flapping).

**Postconditions:** The engineer can see, on-page, both the current connection status and a human-readable log of recent connect/disconnect/heartbeat events, sufficient to tell whether the problem is "never connected" vs. "connected then dropped."

**Basic Course of Events (BCE):**
1. Support engineer opens `/`.
2. Because `streamStatus !== 'connected'`, the page shows a pulsing amber "Waiting…"/"Disconnected" banner instead of the green "Connected" pill.
3. The engineer opens the scrollable stream event log panel, which has been accumulating human-readable trace lines via `addStreamLog` for every connect/disconnect/heartbeat transition, mirroring what would otherwise only be visible in the browser console.
4. From the sequence and timing of logged events, the engineer determines whether the backend was ever reachable and, if it dropped, roughly when.

**Alternate Flows:** None — this is a read-only observation flow; there is no alternate path through the same page for this goal.

**Exceptions:**
- E1 — The backend origin itself was never resolved (both `GET /api/servers` and the `GET /api/docs-context` fallback come back empty/unusable): the page has no origin to open a Socket.IO connection to at all, so it remains in a permanent "Waiting…" state rather than ever attempting and failing a connection — the event log stays empty rather than showing a connect attempt.

### UC6 — New agent is added in Config → Agents and appears in Docs

**Goal:** Make a newly-created agent immediately available both as an MCP tool candidate and as documentation, without a UI redeploy.

**Stakeholders:** The developer creating the agent; any reader of the Docs page looking for that agent's reference section.

**Actors:** The developer; `ConfigAgentsPanel.vue` / `pages/config.vue`'s `saveAgent`; `pages/docs.vue`'s `loadAgentsForDocs`; `useDocsNavAgentEntries`.

**Preconditions:** Developer is on Config → Agents (`#prompts-agents`) with a valid agent draft (system prompt, tool_name, model category filters, personas, tool flags) filled in.

**Postconditions:** The agent exists as a saved `AgentItem`; if/when the Docs page is loaded (or reloaded) afterward, it shows an auto-generated reference subsection for the agent and a corresponding sidebar table-of-contents anchor.

**Basic Course of Events (BCE):**
1. Developer fills out the agent draft form (system prompt, tool_name, model category filters, personas via the searchable multi-select, tool flags) and saves it via `saveAgent`.
2. The new agent is persisted and appears in the Agents master-detail list.
3. On the Docs page, `loadAgentsForDocs` re-fetches `GET /config/agents`.
4. For the new agent, a `tool-agent-<id>` anchor is registered via `useDocsNavAgentEntries`.
5. The Docs page's auto-generated per-agent reference subsection and the left-nav table of contents both include the new agent.

**Alternate Flows:**
- A1 — Developer needs a persona that doesn't exist yet while filling out the agent draft: the personas multi-select has an inline "+ Create" that opens a persona-creation modal without leaving the agent draft; on save, the new persona becomes selectable immediately.

**Exceptions:** None — creating an agent has no failure mode specific to this use case beyond the generic save-error handling already covered by `readApiErrorMessage`/toast pattern used across all Config panels.

Note: the Docs page's header search box and "Find" button are present in the markup but are not wired to any search logic (see UI/UX) — no use case in this document depends on that search box actually working.

## Tests

Vitest specs live under `platform-ui/__tests__/`, mirroring the source tree (`pages/`, `components/`, `composables/`, `lib/`, `server/api/`, `server/utils/`, `server/plugins/`, plus top-level config files). Coverage spans: page-level behavior for all four routes (`index.vue.test.ts`, `config.vue.test.ts` + a separate `config.reactive.test.ts` for reactivity edge cases, `docs.vue.test.ts`, `scan.vue.test.ts`); most components (`ChunkUpdateGrid`, `ConfigModelsPanel`, `ConfigPromptsPanel`, `GlassCard`, `ModelCategoriesInput`, `MuiOutlinedField`, `PlatformProjectSelect`, `ToastStack` — note `ConfigAgentsPanel.vue` and `ConfigPersonasPanel.vue` have no dedicated component test file, only indirect coverage via `config.vue.test.ts`); the two stateful composables (`useConfigRoute`, `useSelectedProjectKey`); several `lib/` helpers (`apiError`, `constants`, `dumpYamlExtended`, `modelCategories`, `mongoId`, `promptStructurePresets`, `socketIoClient`); the layout (`layouts/default.vue.test.ts`); and the full server-side discovery/proxy chain (`discovery-store`, `discovery.server` plugin, `register.post`, `servers.get`, `servers-deregister.post`, `docs-context.get`, `stats-backend`, `stats-http-proxy`, `stats-nitro-catchall`). Root-level config is also tested directly (`nuxt.config.test.ts`, `tailwind.config.test.ts`, `app.config.test.ts`, `app.vue.test.ts`, `router.options.test.ts`, `nuxt-plugins.test.ts`). This is a genuinely broad suite; the main gaps are the two untested Config panel components noted above.

## UI/UX

The whole app is a single dark theme (`#100B1A` background, violet `--accent`) with a persistent left sidebar (`layouts/default.vue`) containing four top-level links — Stats, Config, Scan, Docs — plus contextual sub-navigation that only appears while on Config or Docs. A soft purple radial-gradient spotlight tracks the mouse across the whole viewport (via CSS custom properties `--mouse-x`/`--mouse-y` set by `plugins/mouse-tracking.client.ts`), and page transitions use a named `page` transition in `out-in` mode.

The **Stats/index page** opens with a connection-status pill (green "Connected", amber "Waiting…"/"Disconnected") and, while disconnected, a pulsing amber banner. Below that sit two ApexCharts side by side (a 7-day area chart and a requests-per-minute bar chart, both dark-themed to match), a responsive scorecard grid (2 to 7 columns depending on breakpoint) for query/document/file/model/tool/error/cache-hit counts, four LLM latency/token percentile cards, a "Registered MCPs" chip strip that visually distinguishes a primary server (amber, server icon) from secondaries (sky blue, radio icon) with skeleton-pulse placeholders while waiting for the first registration, and a scrollable stream event log table with expandable rows and automatic grouping of consecutive identical events (e.g. a burst of heartbeats collapses into one row with a click-to-expand counter badge).

The **Config page** uses a sticky, mostly-transparent header showing a breadcrumb (`Config / <Section>`) and a subtitle explaining the current section, with section-specific action buttons (Save, Restore default, New, Add remote/local) rendered contextually in the header rather than inside each panel. The five sections are: Settings (project picker, a file-processing settings form with a segmented Prompt/Agent toggle for the indexing driver, and an MCP tools/agents summary with an inline "quick add agent" form); Models (accordion list grouped by provider account, each row showing masked key/endpoint info, an inline enabled-toggle + category/priority editor per model, and modal wizards for adding a remote provider — with a searchable/filterable model catalog and select-all — or a local Ollama/OpenAI-compatible endpoint with a "Test connection" action); Prompts (master-detail: saved-prompt list on the left, draft form on the right with a segmented Unstructured/Structured toggle that reveals a live tabbed preview of the expected output shape); Agents (same master-detail layout, plus a searchable multi-select for personas with an inline "+ Create" that opens a modal without leaving the agent draft, and a four-checkbox tool-flags block); Personas (simplest master-detail form: name, description, prompt body). Every "Saved" list uses a dirty-check confirmation modal before silently discarding an unsaved draft on selection change, and unsaved Model edits additionally block route navigation with a modal.

The **Docs page** is a single scrollable article with a sticky header (title + a non-functional-looking search box and "Find" button — present in the markup but not wired to any search logic) and a left-nav table of contents that highlights the in-view section via scroll-spy and keeps the URL hash synced. Content includes a live-templated, copy-to-clipboard MCP JSON config snippet, and one auto-generated reference block per configured agent.

The **Scan page** is the simplest: a project picker card and a single "Progress" card containing `ChunkUpdateGrid` — a segmented progress bar (solid "done" fill plus an animated diagonal-stripe "in-flight" barber-pole overlay while a scan is active) above a file heatmap that renders as individual animated DOM blocks for small file counts and switches to a single `<canvas>` draw (for performance) once the file count crosses 72, with a custom hover tooltip (teleported to `<body>`) showing each file's path and indexing status.

No files exist yet under `docs/mockups/` for any of these screens — the descriptions above were transcribed directly from the rendered templates and CSS, not from a design file, and there is no mockup to cross-check future visual changes against.

## Dependencies

- **Stats/config HTTP backend (Fastify, `mcp-code-vault`)** — the backend this entire UI is a client of. All REST calls (`/projects`, `/config/*`, `/metrics`, `/metrics/file-reads/window`, `/scan/files`) and the Socket.IO event stream (`heartbeat`, `connected`, `metric`, `scan:progress`, `primary:identified`, `secondary:connected`/`disconnected`, `query:received`, `db:connected`, `seed:checked`, `project`) it consumes are defined in `docs/design/stats-api.md`.
- **UDP discovery/registration mechanism** — the pairing protocol between one or more MCP server processes and this UI, implemented within this subsystem across `server/plugins/discovery.server.ts`, `server/utils/discovery-store.ts`, and `server/api/register.post.ts` / `server/api/servers/deregister.post.ts` / `server/api/servers.get.ts`. The MCP-server side of the same handshake is covered by `docs/design/discovery-coordination.md`.
- **Nuxt 3 / Nitro** — the application framework; `@nuxtjs/tailwindcss` and `@nuxt/icon` are the only Nuxt modules registered in `nuxt.config.ts`.
- **socket.io-client** — real-time transport for stats/scan events; requires the Vite alias workaround documented in Design Constraints.
- **vue3-apexcharts / apexcharts** — charting library for the Stats page; loaded via `plugins/apexcharts.client.ts` / `.server.ts` / `0.apexcharts.server.ts` and rendered only inside `<ClientOnly>` blocks.
- **Tailwind CSS** — utility styling, themed via CSS custom properties rather than a Tailwind color palette override.

## Diagrams

```
Browser (platform-ui pages)
  │
  ├─ fetch /api/servers, /api/docs-context, /api/register, /api/stats/**  ──►  Nitro server routes (this app)
  │                                                                              │
  │                                                                              ├─ discovery-store.ts (in-memory Map)
  │                                                                              └─ stats-http-proxy.ts ──► Fastify stats backend
  │
  └─ fetch <discovered-origin>/projects, /config/*, /metrics, /scan/*   ──►  Fastify stats backend (mcp-code-vault, same process as MCP server)
  └─ Socket.IO connect <discovered-origin>                              ──►  Fastify stats backend (live event stream)

MCP server process (mcp-code-vault)
  │
  ├─ stats backend binds a port and, on boot, POSTs {port, projectName} to the
  │   registerUrl advertised by this UI's UDP broadcast (discovery.server.ts)
  └─ UI's /api/register (Nitro) stores it in discovery-store.ts → surfaced via /api/servers
```

```
pages/config.vue (owns all state + mutations + sockets)
  │
  ├─ props/emits ──► ConfigPromptsPanel.vue   (draft form; exposes startNewDraft/submitDraft)
  ├─ props/emits ──► ConfigAgentsPanel.vue    (draft form + persona multi-select + create-persona modal)
  ├─ props/emits ──► ConfigModelsPanel.vue    (accordion + inline edit + add-remote/add-local wizards)
  └─ props/emits ──► ConfigPersonasPanel.vue  (draft form)

Page header buttons (Save / New / Restore default / Add remote / Add local)
  → call methods exposed via defineExpose on the currently active panel's template ref
```

## References

- `mcp-code-vault/platform-ui/README.md` — dev-server run instructions and the Tailwind-resolution gotcha.
- `mcp-code-vault/platform-ui/nuxt.config.ts` — module list, dev port/host, route rules, runtime config.
- `mcp-code-vault/platform-ui/pages/index.vue`, `config.vue`, `docs.vue`, `scan.vue` — the four routed pages.
- `mcp-code-vault/platform-ui/layouts/default.vue` — sidebar nav, hash-driven sub-navigation, background spotlight.
- `mcp-code-vault/platform-ui/components/` — `ChunkUpdateGrid.vue`, `ConfigAgentsPanel.vue`, `ConfigModelsPanel.vue`, `ConfigPersonasPanel.vue`, `ConfigPromptsPanel.vue`, `GlassCard.vue`, `ModelCategoriesInput.vue`, `MuiOutlinedField.vue`, `PersonaNamesMultiSelect.vue`, `PlatformProjectSelect.vue`, `ToastStack.vue`, `style-ui/Button.vue`.
- `mcp-code-vault/platform-ui/composables/` and `lib/` — cross-page state and pure helpers listed under Functions.
- `mcp-code-vault/platform-ui/server/` — Nitro API routes, utils, and the discovery plugin.
- `mcp-code-vault/platform-ui/__tests__/` — Vitest coverage mirroring the source tree.
- `docs/design/stats-api.md` — the Fastify backend contracts this UI consumes.
- `docs/design/discovery-coordination.md` — the MCP-server side of the UDP discovery/election handshake this UI's `discovery.server.ts` participates in.
