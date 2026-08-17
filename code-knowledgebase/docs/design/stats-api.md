---
modified: 2026-07-06
dependencies: [storage]
---

# Stats/config HTTP API — `mcp-code-vault`'s Fastify backend for the platform UI

Describes the Fastify HTTP server in `mcp-code-vault/src/stats/` that exposes project, config, metrics, scan, and server-instance data to the platform UI, plus the live streaming channel (Socket.IO + SSE) that pushes metric/scan events to connected clients. Read this before adding a new `/config/*`, `/metrics/*`, `/projects`, `/scan/*`, or `/servers` route, before changing what `pushToStream` broadcasts, or before touching how LLM provider credentials/models are discovered and stored. Consult it alongside `docs/design/storage.md` (per-project Mongo collections this API does not touch) since this layer instead reads/writes the global Mongo models (`Project`, `Metric`, `SystemPrompt`, `Persona`, `Agent`, `LLMModel`, `ModelProviderCredential`, `ServerInstance`, `FileReadHourBucket`).

## Sensitive Areas

- `createStatsServer()` in `src/stats/server.ts` runs Mongo connect, seeding (`runSeed`, `ensurePromptsFromSeed`), and — only when `MCP_PROJECT_NAME` is set — `ensureProjectFromConfig` + `ensureProjectCollections` + an `init` metric post, all before any route is registered. This ordering matters: routes that read `Project`/`SystemPrompt` assume seeding has already run.
- `routes/servers.ts` defines `serverRoutes` (`GET /servers`) but it is **never imported or registered** in `createStatsServer()` — grep confirms no `serverRoutes` import in `server.ts`, and no code path anywhere writes an `IServerInstance` document. The route and its test (`stats-servers-route.test.ts`) exercise the handler directly against a mocked model, not through the real server. Treat `/servers` as built-but-unwired, not live.
- There is no authentication or authorization on any route in this file. `FastifyCors` is registered with `origin: true` (reflects any caller) and allows the `Authorization` header through preflight, but nothing in any route handler reads or validates it. Anyone who can reach the stats port can read and write config, prompts, agents, models, and credentials (including provider API keys via `/config/models/credentials`).
- `assertDevSeedWriteAllowed()` (`configAdmin.ts`) is the only write gate in this subsystem: it blocks writes to `configs/seed/*.json` when `NODE_ENV === 'production'`. It does not gate any Mongo writes — only the seed-file mirroring (`save_to_seed`) on prompts/personas/agents.
- `streamChannel.ts`'s `pushToStream()` is a dual-fan-out: it calls `io.emit()` on the Socket.IO server (if `setSocketIO` was called) **and** resolves any pending SSE subscribers from `streamToUI()`. A caller only reaches one or the other depending on which transport the client used to connect — there is no shared event log, so a client that connects after an event fires never sees it (except scan progress, which is separately cached — see Architecture).
- `POST /metrics` with `operation: 'scan'` has a side effect beyond persisting the Metric document: it calls `ingestScanMetricMetadata` (writes into the in-memory `scanProgressCache`) and `emitScanProgressFromPayload` (broadcasts `scan:progress`). Removing or reordering this from the handler in `routes/metrics.ts` silently breaks the live scan progress UI even though the metric itself still saves correctly.
- `routes/config.ts`'s `llmModelUpsertFilter()` intentionally matches legacy rows with no `credential_id` via `$or: [{ credential_id: { $exists: false } }, { credential_id: null }]` — this lets old single-row-per-provider clients keep upserting the same document while newer credential-scoped rows coexist. Changing this filter without preserving both branches will duplicate or orphan legacy model rows.

## Design Constraints

- No URL prefix: every route in this subsystem is mounted at the Fastify root (`/config/...`, `/metrics`, `/projects`, `/scan/files`, `/servers`), not under a shared `/api` or `/stats` base. The Nuxt platform UI proxies these as `/api/stats/<path>` on its own side, but the Fastify app itself knows nothing about that prefix.
- Route registration is split one-file-per-resource under `src/stats/routes/`, each exporting a single `async function xRoutes(fastify: FastifyInstance)` that `server.ts` awaits via `fastify.register(...)`. New resources should follow this shape rather than adding routes directly in `server.ts`.
- Provider credentials and provider-hosted model discovery (`providerDiscovery.ts`) are provider-branching functions (`discoverOpenAiModels`, `discoverGeminiModels`, `discoverAnthropicModels`, `discoverOpenAiCompatibleModels`, `discoverGithubModelsCatalog`) rather than a single generic client — each vendor's list-models shape is different enough (OpenAI-style `{data:[{id}]}`, Gemini's `{models:[...]}`, Anthropic's `{data:[{id,display_name}]}`, GitHub's separate catalog REST surface) that a shared abstraction was not attempted. `discoverProviderModels()` is the single dispatch point new callers should use.
- `google` as a provider id is normalized to `gemini` everywhere in `config.ts` (`normalizeLlmProviderId`) to match the "Add remote" wizard; do not introduce a second spelling.
- Metric payloads always flow through `normalizeMetricPayload()` (`normalizeMetric.ts`) before being stored or sent, so `metadata.projectKey` is always present (falls back to `MCP_PROJECT_KEY`/`MCP_PROJECT_NAME`/`'default'`) and legacy `metadata.projectName` is dropped on write. Any new metric-producing code path must go through `postMetric`/`normalizeMetricPayload`, not construct a raw POST body.
- File-read metrics are rolled up into hourly buckets (`fileReadHourBuckets.ts`) rather than stored as one Metric document per read — this bounds the write volume for a chatty operation (every file read) while still supporting a rolling N-day window query.
- Pagination on `GET /scan/files` uses a cursor (last-seen relative path) with an n+1 fetch to compute `hasMore`/`nextCursor`, not offset/limit paging — consistent with this codebase's general pagination convention.

## Feature Overview

This subsystem is the HTTP surface the platform UI (a separate Nuxt app, not part of this repo scan) talks to for everything that is not itself an MCP tool call. It covers five areas:

1. **Project/scan browsing** — `GET /projects` lists registered projects; `GET /scan/files` enumerates a project's files on disk (via the scanner's ignore rules) with cursor pagination, tagging every entry `state: 'new'` (a stub — see Use Cases).
2. **Config administration** — `routes/config.ts` is the largest route file by far, covering CRUD for system prompts, personas, agents, LLM model rows, and provider credentials, plus `/config/project-file-processing` (per-project file-indexing tuning) and a catch-all `GET /config` that renders a human-readable settings/MCP-snippet blob.
3. **Metrics ingestion and query** — `POST /metrics` is the single ingestion endpoint every MCP instance (primary or client) posts operational telemetry to; `GET /metrics` queries it back with basic filters; `GET /metrics/file-reads/window` is a specialized rollup query over the hour-bucket table.
4. **Live streaming** — `streamChannel.ts` fans metric/scan/db-lifecycle events out over Socket.IO (primary transport) and Server-Sent Events (`GET /metrics/stream`, via `fastify-sse-v2`), so the UI does not have to poll.
5. **Server instance registry** — `routes/servers.ts` / `ServerInstance` model exist to let the UI list running server processes, but this feature is not wired up (see Sensitive Areas).

## Architecture

`createStatsServer()` (`src/stats/server.ts`) is the single constructor. It is Fastify (not Express), built with:

- `Fastify({ logger: ... })` — logging is silenced under `NODE_ENV=test` or stdio mode, otherwise writes to a pino file destination (`getLogPath()`/`ensureLogDir()`).
- `@fastify/cors` registered with `origin: true` (reflects caller), methods `GET/POST/PUT/PATCH/DELETE/OPTIONS`, allowed headers `Content-Type`/`Authorization`.
- `@fastify/compress` (gzip/deflate/br, global).
- `fastify-sse-v2` for the SSE stream route.

Startup sequence inside `createStatsServer()`:

1. `connectMongoose()`, then `pushToStream('db:connected', ...)`.
2. `runSeed()` + `ensurePromptsFromSeed()`, then `pushToStream('seed:checked', ...)`.
3. If `MCP_PROJECT_NAME` is set: `ensureProjectFromConfig(projectKey, rootPath)` (pushes a `'project'` event), then `ensureProjectCollections(projectKey)` (the per-project Mongo collections described in `storage.md`), then a `postMetric` with `operation: 'init'`, then (if an MCP server instance exists) `registerProjectAgentMcpTools(mcp)`.
4. Route registration, in this order: `streamRoutes`, `metricRoutes`, `projectRoutes`, `scanRoutes`, `configRoutes` — each via `fastify.register(...)`. `serverRoutes` is not in this list (see Sensitive Areas).
5. Two inline routes defined directly on `fastify` (not in a routes/ file): `GET /config` (builds a settings/MCP-snippet text blob via `buildSettingsContent`) and `GET /docs` (returns `{ docs: 'empty' }` — a stub).

**Full route list found in code**, grouped by file:

- `routes/stream.ts` (`streamRoutes`): `GET /metrics/stream` — SSE endpoint, `reply.sse(streamToUI())`.
- `routes/metrics.ts` (`metricRoutes`): `POST /metrics`, `GET /metrics`, `GET /metrics/file-reads/window`.
- `routes/projects.ts` (`projectRoutes`): `GET /projects`.
- `routes/scan.ts` (`scanRoutes`): `GET /scan/files`.
- `routes/config.ts` (`configRoutes`): `GET /config/prompts`, `POST /config/prompts`, `PUT /config/prompts/:id`, `POST /config/prompts/:id/restore-default`, `GET /config/personas`, `POST /config/personas`, `PUT /config/personas/:id`, `POST /config/personas/:id/restore-default`, `GET /config/agents`, `POST /config/agents`, `PUT /config/agents/:id`, `POST /config/agents/:id/restore-default`, `GET /config/models`, `POST /config/models/verify-local`, `POST /config/models/discover`, `POST /config/models/credentials`, `POST /config/models`, `PUT /config/models/:id`, `DELETE /config/models/:id`, `GET /config/project-file-processing`, `PUT /config/project-file-processing`.
- `routes/servers.ts` (`serverRoutes`, unregistered): `GET /servers`.
- Inline in `server.ts`: `GET /config` (project-name/Mongo/cwd/port settings text), `GET /docs` (stub).

**Streaming architecture** (`streamChannel.ts`): a single module-level `Set<Subscriber>` plus an optional `SocketIOServer` reference (`setSocketIO`). `pushToStream(event, data)` emits on Socket.IO (if attached) and resolves every pending SSE waiter, then clears the subscriber set. The SSE side (`streamToUI()`, consumed by `GET /metrics/stream`) is an async generator: yields `connected` immediately, then `heartbeat` immediately, then loops waiting up to `HEARTBEAT_MS` (5000ms) for the next pushed message before falling back to another synthetic `heartbeat`. This means an SSE client that misses a push during the gap between `waitNext` calls gets nothing for that event — there is no buffering or replay for arbitrary events (scan progress is the one exception, replayed from `scanProgressCache` on Socket.IO connect via `emitScanProgress`, not through this SSE path).

Scan progress specifically has its own tiny cache module, `scanProgressCache.ts`, keyed by `projectKey`, decoupled from the generic stream: `ingestScanMetricMetadata()` builds a `ScanProgressPayload` from a `scan`-operation Metric's `metadata` and stores it in a `Map`; `emitScanProgressFromPayload()` then broadcasts it over `pushToStream('scan:progress', ...)`. On a new Socket.IO connection, `emitScanProgress(socket)` replays the latest cached payload per project directly to that one socket (this call site is outside the files read for this doc, presumably in the Socket.IO connection handler).

## Functions

**`src/stats/server.ts`**
- `buildSettingsContent(projectNameOverride)` — assembles the human-readable text served by `GET /config` (project name, redacted Mongo URL lines, cwd/pwd/port, and a copyable MCP client JSON snippet).
- `createStatsServer()` — see Architecture; returns the built `FastifyInstance`.

**`src/stats/streamChannel.ts`**
- `setSocketIO(io)` / `getStreamRole()` / `setStreamRole(role)` — wiring set by the caller that owns the actual Socket.IO server (outside this file's scope).
- `pushToStream(event, data)` — the one fan-out function; everything else in this subsystem that wants to notify the UI calls this.
- `waitNext(timeoutMs)` — internal promise-based subscriber registration used by the SSE generator.
- `buildStreamHeartbeatPayload(statsPort, ts?)` — shared shape for heartbeat/connected payloads (`{ ts, port, projectKey }`).
- `streamToUI()` — the async generator backing `GET /metrics/stream`.

**`src/stats/scanProgressCache.ts`**
- `buildScanProgressPayloadFromScanMetadata(metadata)` — pure mapping from a scan Metric's metadata to the UI-facing `ScanProgressPayload` shape (also reused for DB-sourced replay, per its docstring).
- `ingestScanMetricMetadata(metadata)` / `emitScanProgressFromPayload(payload)` — write-then-broadcast pair called from `POST /metrics` when `operation === 'scan'`.
- `reportScanProgress(payload)` / `getScanProgress(projectKey)` / `emitScanProgress(socket)` — cache-only helpers for tests and for replaying to a newly connected socket.
- `resetScanProgressCacheForTesting()`.

**`src/stats/configAdmin.ts`**
- `isDevConfigSeedWrites()` — true unless `NODE_ENV === 'production'`.
- `assertDevSeedWriteAllowed(reply)` — sends a 403 and returns `false` when seed-file writes are disallowed; route handlers early-return on `false`.

**`src/stats/configSeedJson.ts`**
- `readPersonaSeedRows()` / `writePersonaSeedRows(rows)` and `readAgentSeedRows()` / `writeAgentSeedRows(rows)` — direct JSON file read/write against `configs/seed/personas.json` and `configs/seed/agents.json` (auto-creating the seed directory). No locking; last writer wins.

**`src/stats/fileReadHourBuckets.ts`**
- `isReadMetricOperation(operation)` — true for `'read'` or the legacy `'file_reads_batch'`.
- `formatLocalHourKey(d)` / `localCalendarHourKeyRange(numDays)` — local-timezone (not UTC) hour-key formatting (`yyyy/MM/dd HH`) and inclusive N-day range as `[minKey, maxKey]`, exploiting that the zero-padded string format sorts lexicographically the same as chronologically.
- `parseFileReadBatchEntries(meta)` — validates and extracts `{projectKey, count}[]` from a metric's `metadata.entries`, dropping malformed rows silently.
- `incrementFileReadBucketsAndSummarize(entries, windowDays, at?)` — `$inc`-upserts one bucket per `(projectKey, hourKey)` then returns the rolling-window summary.
- `summarizeFileReadWindow(windowDays)` — aggregates `FileReadHourBucket` over the local calendar window, grouped and summed by `projectKey`.

**`src/stats/metricsClient.ts`**
- `getStatsBase()` / `setStatsBaseUrl(url)` — resolves where to POST metrics; defaults to `http://127.0.0.1:<STATS_PORT|PORT|3000>`, overridable (used when this process is a client of a separate primary).
- `markServerReady(role)` — flips the internal `MetricSender` from queue-only to queue-then-flush-and-send mode; `role` also tags subsequent posts with `role: 'primary'|'client'`.
- `MetricSender` class — `post` (queues) is reassigned to `send` (real `fetch` POST to `/metrics`) once `markServerReady()` fires; failures are logged via `writeProcessLog`, never thrown.
- `resetMetricSenderForTesting()`.
- `postMetric(payload)` — normalizes via `normalizeMetricPayload` then hands off to the sender.
- `withMetrics(operation, kind, handler)` — higher-order wrapper that times an async handler and posts a `postMetric` call with `status: 'ok'|'error'` in a `finally` block, rethrowing the original error.

**`src/stats/normalizeMetric.ts`**
- `resolveProjectKeyForMetricMetadata(meta)` — `metadata.projectKey` (trimmed) else legacy `metadata.projectName` else `getProcessProjectKey()`.
- `ensureMetadataProjectKeyForRead(meta)` — read-side normalization: always emits `projectKey`, strips `projectName`, defaults to `'default'` for empty/legacy rows.
- `normalizeMetricPayload(body)` — write-side normalization used by both `postMetric` and the `POST /metrics` handler, so client-posted and server-received metrics always agree.

**`src/stats/providerDiscovery.ts`**
- `suggestedCategoryForDiscoveredModel(provider, model)` — heuristic-only mapping of a discovered model to `fast`/`blended`/`thinking` based on id/name/label/description substrings (per-vendor heuristics for Gemini, Anthropic, OpenAI-family); used purely as a UI default the user can override, not enforced.
- `openAiCompatibleModelsListUrl(baseUrl)` — appends `/models` if the base already ends in `/vN`, else `/v1/models`.
- `isGithubModelsHostUrl(raw)` / `normalizeGithubModelsCredentialBaseUrl(raw)` — special-cases `models.github.ai` URLs to the canonical inference root so stored credentials do not accumulate resource-path variants.
- `discoverGithubModelsCatalog(apiKey)`, `discoverOpenAiCompatibleModels(baseUrl, apiKey)`, `discoverOpenAiModels(apiKey)`, `discoverGeminiModels(apiKey)`, `discoverAnthropicModels(apiKey)` — one fetch-and-map function per provider shape.
- `discoverProviderModels(provider, apiKey, opts?)` — the single dispatch point; also holds `OPENAI_COMPATIBLE_PRESETS`, a map of vendor slug (`groq`, `together`, `mistral`, `openrouter`, `deepseek`, `xai`, `fireworks`, `perplexity`, `nebius`, `lepton`, `cerebras`, `novita`, `siliconflow`, `moonshot`, `glm`, `deepinfra`, `nvidia`, `sambanova`, `hyperbolic`) to its OpenAI-compatible base URL.
- `verifyLocalConnection(params)` — pings a local Ollama (`GET /api/tags`) or OpenAI-compatible server (`GET .../models`) to validate a base URL/model name before saving, without persisting anything itself.

## Models

This subsystem does not define new persistence models of its own beyond two; it otherwise reads/writes global Mongo models owned elsewhere (`Project`, `SystemPrompt`, `Persona`, `Agent`, `LLMModel`, `ModelProviderCredential` — all under `src/db/models/`, not detailed here since they belong to config/agent subsystems, not this API layer).

**`Metric`** (`src/db/models/Metric.ts`) — the operational-telemetry record every `POST /metrics` call persists.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| instance_id | string | yes | Identifies the posting MCP process. |
| operation | string | yes | Free-form verb, e.g. `init`, `scan`, `read`. |
| kind | `'query'` \| `'event'` | yes | Query = user-initiated; event = other (per `withMetrics` docstring). |
| started_at / ended_at | Date | yes | Stored as real Dates; POST body sends ISO strings, converted on write. |
| duration_ms | number | yes | |
| status | `'ok'` \| `'error'` | yes | |
| error_code | string | no | |
| metadata | Mixed (object) | no, defaults `{}` | Always normalized to include `projectKey` (see `normalizeMetric.ts`); for `scan` operations also gains the ingested progress fields, for `read`/`file_reads_batch` gains `totals`/`windowDays`. |

Indexes: `{instance_id:1, started_at:-1}`, `{operation:1, started_at:-1}`.

**`FileReadHourBucket`** (`src/db/models/FileReadHourBucket.ts`) — per-project, per-local-hour file-read counter.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| projectKey | string | yes | |
| hourKey | string | yes | `yyyy/MM/dd HH`, local wall clock, zero-padded so string sort equals chronological sort. |
| count | number | default 0 | Incremented via `$inc` upsert, one document per `(projectKey, hourKey)`. |

Unique compound index on `{projectKey:1, hourKey:1}`.

**`ServerInstance`** (`src/db/models/ServerInstance.ts`) — defined and read by the unregistered `GET /servers`, but nothing writes it (see Sensitive Areas). Schema: `started_at`, `last_seen` (Date, required), `port` (Number), `local_url` (String), `network_url` (String, optional), `log_path` (String), `pid` (Number); index on `{started_at:-1}`.

## Use Cases

### UC1 — UI subscribes to live operational state

**Goal:** The platform UI shows operational events (DB connection, seeding, project init, metrics, scan progress) as they happen, without polling.

**Stakeholders:** Platform UI maintainers (need a reliable low-latency event feed); end users watching the dashboard (need it to feel live).

**Actors:** Platform UI (client); `createStatsServer()` process (primary, event source).

**Preconditions:** The stats server has completed `createStatsServer()` startup (Mongo connected, seed checked) or is in the process of doing so. The UI has network access to the stats port.

**Postconditions:** The UI holds an open Socket.IO connection (or SSE connection to `GET /metrics/stream`) and has received every event pushed via `pushToStream()` since that connection opened.

**Basic Course of Events (BCE):**
1. UI opens a Socket.IO connection to the stats server.
2. Server's `createStatsServer()` startup sequence calls `pushToStream('db:connected', ...)`, then `pushToStream('seed:checked', ...)`, then (if `MCP_PROJECT_NAME` is set) `pushToStream('project', ...)`.
3. `pushToStream()` calls `io.emit()`, delivering each event to the connected socket immediately.
4. As the server later handles metric posts and scans, it calls `pushToStream('metric', ...)` and `pushToStream('scan:progress', ...)`, which the UI receives the same way.
5. On a fresh Socket.IO connection, `emitScanProgress(socket)` separately replays the latest cached `ScanProgressPayload` per project from `scanProgressCache`, so a client that connects mid-scan still sees current progress.

**Alternate Flows:**
- A1 — UI cannot use Socket.IO (e.g. proxy strips WebSocket upgrade): UI instead opens `GET /metrics/stream` (SSE, via `fastify-sse-v2`). `streamToUI()` yields `connected` immediately, then `heartbeat` immediately, then loops yielding either the next pushed event or a synthetic `heartbeat` every `HEARTBEAT_MS` (5000ms).

**Exceptions:**
- E1 — UI connects after an event fires: for arbitrary events (`metric`, `db:connected`, etc.) there is no buffering or replay — `pushToStream()` clears its subscriber set after each push, so that event is lost to late connectors. Only `scan:progress` is exempt, via the separate `scanProgressCache` replay in E-step 5 above.
- E2 — SSE client's `waitNext` call window misses a push: the event is dropped for that client with no retry; the next thing it receives is the following heartbeat or event.

### UC2 — MCP instance reports telemetry

**Goal:** Every MCP server process (primary or client) records operational telemetry centrally so it can be queried and streamed to the UI.

**Stakeholders:** Platform operators diagnosing MCP behavior; the primary stats server (source of truth for `Metric` documents).

**Actors:** An MCP server process, either acting as `primary` (embeds `createStatsServer()`) or `client` (points at a remote primary).

**Preconditions:** The MCP process has determined its role (`markServerReady('primary'|'client')` has been called) and, if a client, `setStatsBaseUrl()` points at a reachable primary.

**Postconditions:** A `Metric` document exists in Mongo reflecting the operation, normalized via `normalizeMetricPayload()`; the primary has fanned the event out via `pushToStream('metric', ...)`.

**Basic Course of Events (BCE):**
1. Application code calls `withMetrics(operation, kind, handler)` or directly `postMetric(payload)` around/after an operation (e.g. a file read, a scan).
2. `postMetric()` normalizes the payload via `normalizeMetricPayload()` and hands it to the module-level `MetricSender`.
3. If `markServerReady()` has already fired, `MetricSender.post` is bound to `send`, which does a real `fetch` POST to `<statsBase>/metrics`; otherwise the call queues until `markServerReady()` flips it over.
4. The receiving `POST /metrics` handler (`routes/metrics.ts`) re-normalizes via the same `normalizeMetricPayload()`, saves the `Metric` document, and calls `pushToStream('metric', ...)`.

**Alternate Flows:**
- A1 — Process is a client of a remote primary: `setStatsBaseUrl(url)` overrides the default `http://127.0.0.1:<STATS_PORT|PORT|3000>` target, and `markServerReady('client')` tags subsequent posts with `role: 'client'` before they reach the primary's `POST /metrics`.
- A2 — `operation: 'scan'`: the handler additionally calls `ingestScanMetricMetadata()` (writes `scanProgressCache`) and `emitScanProgressFromPayload()` (broadcasts `scan:progress`), on top of the normal save.

**Exceptions:**
- E1 — The POST fails (non-OK HTTP or network error): `MetricSender` logs via `writeProcessLog` and does not throw; `withMetrics()` still rethrows the original handler error (if any) from its `finally` block, but the metric itself is silently dropped.
- E2 — Schema validation fails server-side (e.g. missing required field): `POST /metrics` responds 400 and no document is saved.

### UC3 — Chatty file-read telemetry avoids write amplification

**Goal:** Track file-read volume per project over a rolling window without one `Metric` document per read.

**Stakeholders:** Platform operators viewing read-activity dashboards; the Mongo instance (write-volume concern).

**Actors:** MCP client process (batches reads); `GET /metrics/file-reads/window` caller (platform UI).

**Preconditions:** The MCP client has accumulated one or more file-read events to report.

**Postconditions:** `FileReadHourBucket` documents reflect an incremented per-`(projectKey, hourKey)` count; a window query returns an accurate rolling-N-day sum per project.

**Basic Course of Events (BCE):**
1. Client batches file reads client-side into `metadata.entries: {projectKey, count}[]` and posts once via `postMetric()` with `operation: 'read'` (or legacy `'file_reads_batch'`).
2. `POST /metrics` handler detects a read operation via `isReadMetricOperation()`, calls `parseFileReadBatchEntries()` to validate/extract entries.
3. `incrementFileReadBucketsAndSummarize()` `$inc`-upserts one `FileReadHourBucket` per `(projectKey, hourKey)` (local-timezone hour key) and returns a rolling-window summary, which is merged into the stored metric's metadata.
4. Later, the UI calls `GET /metrics/file-reads/window`, which runs `summarizeFileReadWindow(windowDays)` — one aggregation over `FileReadHourBucket` grouped by `projectKey` — instead of scanning per-read `Metric` documents.

**Alternate Flows:**
- A1 — Legacy client still posts `operation: 'file_reads_batch'`: `isReadMetricOperation()` treats it identically to `'read'`.

**Exceptions:**
- E1 — A malformed entry in `metadata.entries` (missing `projectKey`/`count`): `parseFileReadBatchEntries()` drops that row silently rather than failing the whole batch.

### UC4 — Admin configures prompts/personas/agents/models from the UI

**Goal:** Let an administrator manage system prompts, personas, agents, and LLM model rows without editing Mongo or seed files directly.

**Stakeholders:** Platform administrators; downstream MCP tool calls that read `SystemPrompt`/`Persona`/`Agent`/`LLMModel` at runtime.

**Actors:** Admin user (via platform UI); `routes/config.ts` (`configRoutes`).

**Preconditions:** The stats server is running and seeded (`runSeed()` / `ensurePromptsFromSeed()` have completed).

**Postconditions:** The relevant Mongo document (`SystemPrompt`, `Persona`, `Agent`, or `LLMModel`) is created/updated/deleted; if the admin opted to mirror to seed, the corresponding `configs/seed/*.json` file reflects the change (dev only).

**Basic Course of Events (BCE):**
1. Admin creates or edits a system prompt, persona, or agent via the UI, which calls the matching `POST`/`PUT /config/{prompts|personas|agents}[/:id]` route.
2. Handler validates required fields, checks for slug collisions (409 on conflict), and writes the document; if `is_default` is set, a cascading `updateMany` unsets it on siblings.
3. Optionally, the admin triggers "save to seed," which calls `assertDevSeedWriteAllowed()` then `writePersonaSeedRows()`/`writeAgentSeedRows()` to mirror the row into `configs/seed/*.json`.
4. For models: admin registers an `LLMModel` row via `POST /config/models`, optionally backed by a `ModelProviderCredential` saved via `POST /config/models/credentials`; `llmModelUpsertFilter()` ensures legacy credential-less rows and new credential-scoped rows coexist without duplicating.
5. Admin can call `POST /config/{prompts|personas|agents}/:id/restore-default`, which resets the row back to its seed baseline.

**Alternate Flows:**
- A1 — Admin verifies a local/OpenAI-compatible endpoint before saving a model: `POST /config/models/verify-local` pings the endpoint (`verifyLocalConnection`) without persisting anything.
- A2 — Admin discovers provider-hosted models: `POST /config/models/discover` (see UC5) is used instead of manually entering model ids.

**Exceptions:**
- E1 — Seed-file write attempted in production: `assertDevSeedWriteAllowed()` returns `false` and the route sends a 403; the Mongo write (if already applied) is not rolled back.
- E2 — Slug collision on create: route responds 409 without writing.
- E3 — Provider is changed on `PUT /config/models/:id`: rejected — provider is immutable after creation.

### UC5 — Provider model discovery flow

**Goal:** Let an admin populate `LLMModel` rows from a real provider's model catalog instead of typing ids by hand.

**Stakeholders:** Platform administrators; end users relying on correctly-categorized (Fast/Blended/Thinking) models at chat time.

**Actors:** Admin user (via platform UI); `providerDiscovery.ts` dispatch functions; the external provider's API (OpenAI, Gemini, Anthropic, GitHub Models, or an OpenAI-compatible host).

**Preconditions:** Admin has a valid API key (or, for local/OpenAI-compatible, a reachable base URL) for the target provider.

**Postconditions:** Zero or more new `LLMModel` documents exist, each optionally linked to a saved `ModelProviderCredential`.

**Basic Course of Events (BCE):**
1. Admin selects a provider and pastes an API key (or base URL) in the UI.
2. UI calls `POST /config/models/discover`, which dispatches to `discoverProviderModels(provider, apiKey, opts?)`.
3. `discoverProviderModels()` routes to the provider-specific function (`discoverOpenAiModels`, `discoverGeminiModels`, `discoverAnthropicModels`, `discoverOpenAiCompatibleModels`, or `discoverGithubModelsCatalog`), which fetches and maps that vendor's list-models response into a common shape.
4. For each discovered model, `suggestedCategoryForDiscoveredModel()` heuristically proposes a Fast/Blended/Thinking category, which the UI shows as an editable default.
5. Admin selects rows to keep and saves; UI calls `POST /config/models/credentials` (if not already saved) then `POST /config/models` per selected row, creating `LLMModel` documents.

**Alternate Flows:**
- A1 — Provider id `google` is submitted: `normalizeLlmProviderId()` normalizes it to `gemini` before dispatch, matching the "Add remote" wizard's spelling.
- A2 — Provider is an OpenAI-compatible preset (e.g. `groq`, `together`, `mistral`, ...): `discoverOpenAiCompatibleModels()` is used with the preset's base URL from `OPENAI_COMPATIBLE_PRESETS`.
- A3 — Host is `models.github.ai`: `normalizeGithubModelsCredentialBaseUrl()` canonicalizes it before the credential is stored, avoiding duplicate resource-path variants.

**Exceptions:**
- E1 — Provider API returns non-OK HTTP: the discover function propagates the error; route responds 502.
- E2 — Unknown/unsupported provider id: `discoverProviderModels()` has no matching branch; route responds 400.

## Tests

- `stats-server.test.ts` — exercises `createStatsServer()` end-to-end (with Mongo/seed/metrics dependencies mocked): asserts the `db:connected`/`seed:checked`/`project` push sequence, the `init` metric post shape, and that `GET /config`, `GET /docs`, and the `/metrics/stream` route are registered.
- `stats-routes.test.ts` — covers `streamRoutes` wiring and the SSE generator directly: `connected` first, `heartbeat` immediately after, a delayed `heartbeat` fallback, `pushToStream` broadcast fan-out, and that scan-progress events reach the stream in the legacy `{filesProcessed, filesUpdated}` shape.
- `stats-config-models-routes.test.ts` — the LLM-model half of `configRoutes`: legacy `category`→`categories` mapping, `google`→`gemini` provider normalization, credential-filled `access_key`, discover/verify-local/credentials validation and error codes (400/502), full upsert/update/delete flows for `/config/models`, including that provider is immutable on `PUT` and that a linked credential gets patched too.
- `stats-config-more-routes.test.ts` — the prompts/personas/agents half: required-field validation, slug-collision 409s, `is_default` cascading `updateMany`, restore-default falling back to seed baseline, agent creation resolving a project by explicit key vs. default vs. "no project exists" 404, and `model_categories`/`persona_names` round-tripping.
- `stats-metrics-routes.test.ts` — schema validation 400 on `POST /metrics`, successful create + stream push, scan-metadata ingestion into the progress cache, `read`/legacy `file_reads_batch` operations merging window totals into stored metadata, `GET /metrics/file-reads/window` summarization, and `GET /metrics` query-param filtering.
- `stats-projects-scan-routes.test.ts` — `GET /projects` list/empty-list, and `GET /scan/files`'s n+1 cursor pagination including the final page (no `nextCursor`).
- `stats-servers-route.test.ts` — exercises `serverRoutes` directly against a mocked `ServerInstance` (not through `createStatsServer()`, consistent with the route being unregistered there): basic list mapping and limit clamping.
- `fileReadHourBuckets.test.ts` — `formatLocalHourKey` zero-padding/local-clock behavior, that `localCalendarHourKeyRange` spans the configured window and is lexicographically ordered, and that `parseFileReadBatchEntries` filters invalid rows.
- `metricsClient.test.ts` / `metricsClient.more.test.ts` — queue-then-flush behavior around `markServerReady`, POST target resolution from `PORT`/`STATS_PORT`/explicit override, client-role tagging, that failed sends log rather than throw (both non-OK HTTP and network errors), and `withMetrics` success/error status posting.
- `normalizeMetric.test.ts` — `projectKey` vs. legacy `projectName` precedence and fallback chain (`MCP_PROJECT_KEY` → `MCP_PROJECT_NAME` → `'default'`), and that both the read-side and write-side normalizers consistently drop `projectName`.
- `providerDiscovery.test.ts` — URL-building for OpenAI-compatible model listing, per-provider error propagation on non-OK HTTP, the Gemini/OpenAI-family category heuristics (including a flash-vs-flash-thinking precedence case), GitHub Models catalog/base-URL normalization, and `discoverProviderModels`'s dispatch across presets/custom/unknown providers.

## UI/UX

This is a pure API layer with no rendered surface of its own — `GET /config` and `GET /docs` return plain text/JSON blobs for tooling, not HTML pages. The actual visual consumer is the platform UI (a separate Nuxt frontend that proxies these routes under `/api/stats/<path>` and renders the config/prompts/agents/models screens, the live metrics/scan stream, and the project picker); that frontend is not part of this repository scan and does not yet have its own design doc — if one is added, it should be named something like `platform-ui.md` and referenced here.

## Dependencies

- `storage.md` — this API layer's `createStatsServer()` startup path calls `ensureProjectCollections()` (the per-project Mongo collections documented there) once per boot when `MCP_PROJECT_NAME` is set, and `GET /scan/files` / `GET /config/project-file-processing` expose data adjacent to that per-project file-processing pipeline. This file does not read or write those two per-project collections directly, only triggers their creation and surfaces related `Project`-document settings.
- Fastify plugin ecosystem: `@fastify/cors`, `@fastify/compress`, `fastify-sse-v2` — all registered once in `createStatsServer()` and load-bearing for every route (CORS for the cross-origin UI, compression globally, SSE for the stream route).
- `socket.io` (`Server` type imported in `streamChannel.ts`) — the primary live-update transport; wired externally via `setSocketIO()`, so this file cannot be understood as "the" streaming implementation without also reading wherever `setSocketIO`/`emitScanProgress` are called (outside the files read for this doc).
- Global Mongo models this layer depends on but does not own: `Project`, `SystemPrompt`, `Persona`, `Agent`, `LLMModel`, `ModelProviderCredential` (all `src/db/models/`) — config/agent-subsystem concerns, not detailed here.

## Diagrams

No diagram is currently maintained for this subsystem. A useful one to add later would be a sequence diagram of a metric's path from `postMetric()` (client) through `POST /metrics` (server), Mongo write, `normalizeMetricPayload`/`ensureMetadataProjectKeyForRead`, optional `fileReadHourBuckets`/`scanProgressCache` side effects, and finally `pushToStream` fan-out to Socket.IO and SSE subscribers.

## References

- `mcp-code-vault/src/stats/server.ts`, `routes/config.ts`, `routes/metrics.ts`, `routes/projects.ts`, `routes/scan.ts`, `routes/servers.ts`, `routes/stream.ts`, `streamChannel.ts`, `scanProgressCache.ts`, `configAdmin.ts`, `configSeedJson.ts`, `fileReadHourBuckets.ts`, `metricsClient.ts`, `normalizeMetric.ts`, `providerDiscovery.ts`.
- `mcp-code-vault/src/db/models/Metric.ts`, `FileReadHourBucket.ts`, `ServerInstance.ts`, `Project.ts`.
- Tests: `stats-server.test.ts`, `stats-routes.test.ts`, `stats-config-models-routes.test.ts`, `stats-config-more-routes.test.ts`, `stats-metrics-routes.test.ts`, `stats-projects-scan-routes.test.ts`, `stats-servers-route.test.ts`, `fileReadHourBuckets.test.ts`, `metricsClient.test.ts`, `metricsClient.more.test.ts`, `normalizeMetric.test.ts`, `providerDiscovery.test.ts`.
