---
modified: 2026-07-06
dependencies: [storage]
---

# Config, defaults, and DB seeding — `mcp-code-vault`

Describes how `mcp-code-vault` resolves its fixed/env-driven configuration, ensures a `Project` document and its per-project collections exist on startup, and seeds personas/models/projects/agents/prompts into MongoDB from JSON files under `configs/seed/`. Read this before touching `src/config.ts`, `src/db/seed.ts`, `src/db/ensureProject.ts`, `src/db/projectDefaults.ts`, `src/db/mongoose.ts`, `src/db/migrateAgentToolName.ts`, or any file under `configs/seed/`. Also relevant to anyone building the Config admin UI (`src/stats/routes/config.ts`, `src/stats/configSeedJson.ts`, `src/stats/configAdmin.ts`) since seed JSON doubles as the "restore to default" baseline for personas/agents/prompts.

## Sensitive Areas

- `runSeed()` in `src/db/seed.ts` gates on `Persona.countDocuments() > 0` — the *entire* seed (personas, models, projects, agents, prompts) is skipped if even one persona document exists anywhere in the database. This is a single idempotency gate for five different collections; a partially-seeded DB (e.g. personas inserted but the process crashed before agents were created) will never retry the missing collections.
- `ensurePromptsFromSeed()` has its own, separate idempotency gate (`SystemPrompt.countDocuments() > 0`) and is called both inside `runSeed()` and again independently at every startup (`src/index.ts`, `src/stats/server.ts`). Do not assume prompts and personas/agents share one seed lifecycle — they don't.
- `migrateAgentFocusToToolName()` runs unconditionally inside `connectMongoose()` on every single connect (not just first-ever startup). It is a live, permanent part of the connection path, not a one-off script — removing the `focus`/`seed_baseline_focus` fields from old documents in production depends on this function continuing to run.
- `Agent` has a compound unique index `{ project_id: 1, tool_name: 1 }` (`src/db/models/Agent.ts`). Seed data or admin-created agents that collide on `tool_name` within the same project will fail at the Mongoose/Mongo level, not with a friendly validation message from `seed.ts`.
- `mcp-code-vault/src/db/ensureProject.ts` explicitly does **not** store `MONGO_URL` or any secret in the `Project` document — only `key`, `name`, `root_path`. Do not add credential fields to this path.
- Two parallel DB connection mechanisms exist: `src/db/mongoose.ts` (Mongoose, used by nearly everything) and `src/db.ts` (raw `mongodb` `MongoClient`, used only by `src/manager.ts` and `src/scanner.ts`). They connect independently and cache separately — connecting one does not connect the other.

## Design Constraints

- `config.ts` intentionally exposes only one fixed value (`DB_NAME: 'mcp_code_vault'`) — described in its own comment as "values we fix; the user does not set these." Anything the user or operator can set belongs in env vars or the seed JSON, not in this file.
- Seed data lives on disk as JSON under `configs/seed/*.json`, not hardcoded in TypeScript, so an operator can edit/replace the seed set without a code change. `configSeedJson.ts` provides read/write helpers (`readPersonaSeedRows`, `readAgentSeedRows`, `writePersonaSeedRows`, `writeAgentSeedRows`) so the Config admin UI can persist edits back to those same files.
- Seed JSON also acts as the **restore-to-default baseline** for personas and agents: each seeded `Persona`/`Agent`/`SystemPrompt` document stores `save_to_seed` plus `seed_baseline_*` fields (e.g. `seed_baseline_name`, `seed_baseline_prompt`, `seed_baseline_tool_name`) captured at seed time, and the `/config/*/restore-default` routes fall back to re-reading the on-disk JSON (`readPersonaSeedRows()`/`readAgentSeedRows()`) if the baseline fields are missing on the document itself.
- Writing to seed JSON via the Config API is gated to non-production only: `assertDevSeedWriteAllowed()` in `src/stats/configAdmin.ts` returns a 403 whenever `NODE_ENV === 'production'`, so seed files can only be edited from `npm run dev` / local environments.
- `MONGO_URL` is a hard requirement with no fallback — both `connectMongoose()` (`src/db/mongoose.ts`) and `connectToDatabase()` (`src/db.ts`) throw `'MONGO_URL is required'` if the env var is unset or empty, rather than defaulting to `localhost`.
- The two per-project Mongo collections are created idempotently and only via `ensureProjectCollections()` (documented in `docs/design/storage.md`); `projectDefaults.ts`'s `ensureProjectDefaults()` is a thin wrapper that exists specifically so project-bootstrap call sites don't need to import `projectDb.ts` directly.

## Feature Overview

This subsystem covers three related jobs that all happen at server startup:

1. **Config resolution** — a small, mostly-fixed config surface (`src/config.ts`) plus environment variables read directly where needed (`MONGO_URL`, `WORKING_DIRECTORY`, `PORT`, `MCP_PROJECT_NAME`, `MCP_PROJECT_KEY`, `NODE_ENV`). There is no config-file/precedence chain beyond "env var overrides the process default"; `src/config.ts` itself holds no env-derived values, only the one hardcoded `DB_NAME`.
2. **Project bootstrap** — ensuring a `Project` document exists in Mongo matching the server's current project key and root path (`ensureProjectFromConfig()` in `src/db/ensureProject.ts`), and ensuring that project's two per-project collections exist (`ensureProjectDefaults()` / `ensureProjectCollections()`).
3. **DB seeding** — populating a brand-new database with a starter set of personas, models, a default project, agents, and system prompts, read from JSON files in `configs/seed/` (`runSeed()` and `ensurePromptsFromSeed()` in `src/db/seed.ts`). This runs automatically on every server startup but is a no-op once data exists.

A fourth, closely related piece is a permanent data-shape migration (`migrateAgentFocusToToolName()` in `src/db/migrateAgentToolName.ts`) that runs on every Mongoose connection to rename a legacy `Agent.focus` field to `Agent.tool_name` on any documents that still have the old shape.

## Architecture

**Startup sequence** (both the primary MCP server path in `src/index.ts` and the stats server in `src/stats/server.ts` follow the same order):

1. `connectMongoose()` (`src/db/mongoose.ts`) — connects Mongoose to `${MONGO_URL}/${config.DB_NAME}`, then immediately runs `migrateAgentFocusToToolName()` before marking itself connected.
2. `runSeed()` (`src/db/seed.ts`) — seeds personas, models, the default project, and agents if the `Persona` collection is empty.
3. `ensurePromptsFromSeed()` — seeds `SystemPrompt` documents if that collection is empty (called both from inside `runSeed()` for the initial seed pass and again standalone right after, so it also self-heals if prompts were cleared independently of personas).
4. `ensureProjectFromConfig(projectKey, rootPath)` (`src/db/ensureProject.ts`) — upserts the `Project` document for the current project key/root path (only runs when a project key is resolvable — `MCP_PROJECT_NAME` in `stats/server.ts`, or the `projectName`/`getProcessProjectKey()` value in `index.ts`'s secondary/client startup path).
5. `ensureProjectCollections(projectKey)` (`src/db/projectDb.ts`, documented in `docs/design/storage.md`) — creates the project's `_knowledge_base` and `_FileProcessor` collections and indexes.

`src/db/projectDefaults.ts` sits alongside this as a small helper module: `ensureProjectDefaults(projectKey)` just calls `ensureProjectCollections(projectKey)`, and `readCurrentBranchFromRoot(projectRoot)` reads `.git/HEAD` under a project root to resolve the current branch name (for branch-aware features elsewhere) — it is not currently wired into the startup sequence above.

**Two independent Mongo connections coexist in this codebase**: `src/db/mongoose.ts` (Mongoose ODM, used by all the model-backed code — Agent, Persona, SystemPrompt, Project, Symbol, LLMModel) and `src/db.ts` (raw `mongodb` driver `MongoClient`, used only by `src/manager.ts` and `src/scanner.ts` for lower-level collection access). Both read `MONGO_URL` and both target the same `config.DB_NAME` database, but each keeps its own connection cache (`connected` boolean in `mongoose.ts`; `client`/`db` module-level variables in `db.ts`).

**Seed data flow:**

```
configs/seed/personas.json  ─┐
configs/seed/models.json    ─┤
configs/seed/projects.json  ─┼─► runSeed() ─► Persona / LLMModel / Project / Agent collections
configs/seed/agents.json    ─┘        │
                                       └─► ensurePromptsFromSeed() (also called standalone)
configs/seed/prompts.json  ───────────────► SystemPrompt collection
(configs/seed/global-prompts.json = legacy fallback path if prompts.json is absent)
```

`configs/personas/*.json` (e.g. `security-analyst.json`, `senior-code-reviewer.json`, `system-architect.json`) exist on disk with a `{ name, description, prompt }` shape matching individual entries in `configs/seed/personas.json`, but no source file under `src/` reads from the `configs/personas/` directory — the actual seed input for personas is exclusively `configs/seed/personas.json`. These per-file persona configs appear to be a reference/authoring convenience rather than a live input.

`mcp-code-vault/mcp.config.json` (currently `[{ "root_path": "./", "name": "DefaultProject" }]`) is likewise not read by any file under `src/` — no `grep` hit for `mcp.config.json` outside this file itself. Project bootstrap instead relies purely on env vars (`MCP_PROJECT_NAME` / `MCP_PROJECT_KEY`) and the `configs/seed/projects.json` seed row (`{ name: "Default Project", key: "default" }`).

## Functions

- `config` (`src/config.ts`) — a single frozen object, `{ DB_NAME: 'mcp_code_vault' }`; not a function, but the sole "forced config" export.
- `connectMongoose()` / `disconnectMongoose()` (`src/db/mongoose.ts`) — connect/disconnect Mongoose, guarded by a module-level `connected` boolean so repeated calls to `connectMongoose()` are no-ops after the first. `connectMongoose()` throws if `MONGO_URL` is unset/empty, and always runs `migrateAgentFocusToToolName()` as part of connecting.
- `connectToDatabase()` / `closeDatabase()` (`src/db.ts`) — the parallel raw-driver connection helper; same `MONGO_URL` requirement and fail-fast behavior, cached via module-level `db`/`client` variables.
- `migrateAgentFocusToToolName()` (`src/db/migrateAgentToolName.ts`) — runs two `updateMany` aggregation-pipeline updates against the raw `Agent.collection`: one renaming `focus` → `tool_name` wherever `tool_name` doesn't exist but `focus` does, one doing the same for `seed_baseline_focus` → `seed_baseline_tool_name`. Wraps both in try/catch; logs `agent_tool_name_migration` (info) if anything was modified, or `agent_tool_name_migration_failed` (warn) if it throws — it never rethrows, so a migration failure does not block server startup.
- `ensureProjectFromConfig(projectKey, rootPath)` (`src/db/ensureProject.ts`) — looks up `Project` by `key`; creates it (`name` set equal to `key`) if missing, updates `root_path` if it differs, or does nothing if it already matches. Returns `'created' | 'updated' | 'unchanged'` and logs exactly one `project_created` or `project_updated` info event (no log on `'unchanged'`).
- `ensureProjectDefaults(projectKey)` / `readCurrentBranchFromRoot(projectRoot)` (`src/db/projectDefaults.ts`) — the former delegates straight to `ensureProjectCollections`; the latter parses `.git/HEAD` (`ref: refs/heads/<name>` pattern) and falls back to `'HEAD'` on any read/parse failure (detached HEAD or missing/unreadable file).
- `runSeed()` (`src/db/seed.ts`) — idempotent (gated on `Persona.countDocuments()`); on an empty DB it: creates all `Persona` rows from `personas.json` (recording `seed_baseline_name/description/prompt` and `save_to_seed: true` on each); bulk-inserts `LLMModel` rows from `models.json` via `LLMModel.insertMany`, normalizing/defaulting `categories` via `normalizeModelCategoriesInput`/`defaultModelCategoriesIfEmpty`; bulk-inserts `Project` rows from `projects.json`; calls `ensurePromptsFromSeed()`; then creates each `Agent` from `agents.json`, resolving `project_key` → `project_id`, `persona_names` → `persona_ids`, defaulting all four `tools` flags to `false` if absent, normalizing `model_categories`, and resolving an optional `global_prompt_slug` to a `SystemPrompt._id` (silently `null` if the slug isn't found). Each created `Agent` also gets a full `seed_baseline_*` snapshot. Throws if an agent seed row has no `tool_name`/`focus`, or references an unknown `project_key`.
- `ensurePromptsFromSeed()` (`src/db/seed.ts`) — separately idempotent (gated on `SystemPrompt.countDocuments()`); resolves its seed file via `resolvePromptsSeedPath()` (prefers `prompts.json`, falls back to legacy `global-prompts.json`), returns `'no_file'` if neither exists or the file is empty/non-array, otherwise inserts each row via `SystemPrompt.create()` after deriving `usage_type`/`prompt_type` consistency (`derivePromptTypeFromUsageType` / `deriveUsageTypeFromPromptType`) and defaulting `structure_mode`/`structure_preset`/`structure_mime`. Throws on rows missing `slug`/`name`/`prompt`/`category`, or missing both `usage_type` and a derivable `prompt_type`. Returns `'inserted' | 'skipped' | 'no_file'`.
- `getSeedDir()` / `loadJson()` (`src/db/seed.ts`, private) — resolve `configs/seed` relative to `process.cwd()` and throw a descriptive error (including the resolved path and cwd) if the directory or a required file is missing.
- `readPersonaSeedRows()` / `writePersonaSeedRows()` / `readAgentSeedRows()` / `writeAgentSeedRows()` (`src/stats/configSeedJson.ts`) — read/write helpers for the Config admin UI to view and persist edits to `configs/seed/personas.json` and `configs/seed/agents.json` directly; reads return `[]` on missing file, parse error, or non-array JSON rather than throwing; writes create the seed directory if missing.
- `isDevConfigSeedWrites()` / `assertDevSeedWriteAllowed(reply)` (`src/stats/configAdmin.ts`) — gate seed-file writes to non-production (`NODE_ENV !== 'production'`); the assert helper sends a 403 with an explanatory message and returns `false` when disallowed, `true` otherwise.
- `getServerCwd()` / `getServerPort()` / `setServerContext()` / `applyConfig()` (`src/mcp/context.ts`) — hold the server's working directory and port, seeded from `WORKING_DIRECTORY`/`PORT` env vars at module load and mutable at runtime via the MCP config tool (`applyConfig`), which is how `rootPath` gets threaded into `ensureProjectFromConfig()` calls.
- `getProcessProjectKey()` (`src/projectKey.ts`) — resolves the canonical project key as `MCP_PROJECT_KEY` (trimmed), else `MCP_PROJECT_NAME` (legacy), else the literal `'default'`.

## Models

**Persona** (`src/db/models/Persona.ts`, collection `personas`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| name | string | yes | Indexed (non-unique). |
| description | string | yes | |
| prompt | string | yes | The persona's system-prompt text. |
| save_to_seed | boolean | no (default false) | True for seeded personas; drives whether a restore-baseline exists. |
| seed_baseline_name / _description / _prompt | string | no | Snapshot of the seeded values, used by the restore-default route. |
| createdAt / updatedAt | date | auto | Mongoose `timestamps`. |

**SystemPrompt** (`src/db/models/SystemPrompt.ts`, collection explicitly named `prompts`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| name | string | yes | |
| slug | string | yes, unique | |
| prompt | string | yes | |
| usage_type | string | yes (trimmed) | User-facing role, e.g. `"file processor"`, `"user request"`, `"platform assistant"`; one default expected per usage_type. |
| prompt_type | `'processing' \| 'agent'` | no (deprecated) | Kept for backward compatibility; derived from `usage_type` via a `pre('validate')` hook if omitted or inconsistent. |
| category | `'fast' \| 'blended' \| 'thinking'` | yes | |
| is_default | boolean | no (default false) | |
| save_to_seed | boolean | no (default false) | |
| seed_baseline_prompt | string | no | |
| structure_mode | `'unstructured' \| 'structured'` | default `'unstructured'` | |
| structure_preset | string | default `'agent_pipeline_steps'` | |
| structure_mime | `'application/json' \| 'application/x-yaml-extended'` | default `'application/json'` | |
| createdAt / updatedAt | date | auto | |

Indexes: `{ usage_type: 1, is_default: 1 }`, `{ usage_type: 1, category: 1 }`. The `pre('validate')` hook guarantees `usage_type` and `prompt_type` are cross-derived and consistent, and throws if `usage_type` can't be resolved from either field.

**Agent** (`src/db/models/Agent.ts`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| name | string | yes | |
| description | string | yes | |
| system_prompt | string | yes | |
| tool_name | string | yes | MCP tool id; must be unique per project. |
| model_categories | string[] | no | Empty = agent may use any model; non-empty = model needs a matching tag in `LLMModel.categories`. |
| project_id | ObjectId (ref Project) | yes | |
| persona_ids | ObjectId[] (ref Persona) | no | |
| global_prompt_id | ObjectId (ref SystemPrompt) | no, default null | Optional vault-wide prep prompt run before the agent's own system prompt. |
| tools | `{ file_watch, db_read_write, web_search, run_shell }` (all boolean, default false) | no | Sub-schema, `_id: false`. |
| save_to_seed | boolean | no (default false) | |
| seed_baseline_* | description, system_prompt, tool_name, model_categories, persona_names, global_prompt_slug, tools | no | Restore-default snapshot. |
| model_category, model_ids, seed_baseline_model_names, seed_baseline_model_category | various | no | Explicitly marked `@deprecated` in the interface; retained only so old documents don't break reads. |
| createdAt / updatedAt | date | auto | |

Indexes: `{ project_id: 1 }`, `{ project_id: 1, name: 1 }`, and a unique `{ project_id: 1, tool_name: 1 }` (one MCP tool id per project — matches server-side validation elsewhere).

**Symbol** (`src/db/models/Symbol.ts`) — unrelated to seeding, included here because it was in scope; a lightweight per-file summary record.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| project_id | ObjectId (ref Project) | yes | |
| file | string | yes | |
| summary | string | yes | |
| updated | date | yes | |
| createdAt / updatedAt | date | auto | |

Indexes: unique `{ project_id: 1, file: 1 }`, and `{ project_id: 1, updated: -1 }`.

## Use Cases

### UC1 — Server startup seeds and bootstraps the database

**Goal:** Bring a freshly connected server up to a working state — starter personas/models/project/agents/prompts present, the current project's `Project` document and per-project collections in place — with no manual setup step, regardless of whether the database is empty or already populated.

**Stakeholders:** Platform operators (want a new environment usable immediately after first boot, and no wasted work or duplicate data on every restart); developers running the server locally.

**Actors:** `src/index.ts` (primary MCP server) and `src/stats/server.ts` (stats server), which both drive the same startup sequence; `connectMongoose()`, `runSeed()`, `ensurePromptsFromSeed()`, `ensureProjectFromConfig()`, `ensureProjectCollections()`.

**Preconditions:** `MONGO_URL` is set in the environment; `configs/seed/*.json` exist under the process's `cwd()`.

**Postconditions:** Mongoose is connected; any legacy `Agent.focus` documents have been migrated; the `Persona`, `LLMModel`, `Project`, `Agent`, and `SystemPrompt` collections contain at least the seed baseline data; the current project's `Project` document exists with an up-to-date `root_path`; the project's `_knowledge_base` and `_FileProcessor` collections exist.

**Basic Course of Events (BCE) — first-ever start against an empty database:**
1. `connectMongoose()` connects to `${MONGO_URL}/${config.DB_NAME}` and runs `migrateAgentFocusToToolName()`, which no-ops (no `Agent` documents exist yet).
2. `runSeed()` finds `Persona.countDocuments() === 0` and proceeds: creates all `Persona` rows from `personas.json` (each recording `seed_baseline_name/description/prompt` and `save_to_seed: true`); bulk-inserts `LLMModel` rows from `models.json`; bulk-inserts `Project` rows from `projects.json`; calls `ensurePromptsFromSeed()`; creates each `Agent` from `agents.json`, resolving `project_key` → `project_id` and `persona_names` → `persona_ids`, defaulting the four `tools` flags to `false`, and resolving an optional `global_prompt_slug` to a `SystemPrompt._id`.
3. `ensurePromptsFromSeed()` finds `SystemPrompt.countDocuments() === 0` and inserts each row from `prompts.json` (or the legacy `global-prompts.json` if `prompts.json` is absent), deriving `usage_type`/`prompt_type` consistency and defaulting `structure_mode`/`structure_preset`/`structure_mime`.
4. `ensureProjectFromConfig(projectKey, rootPath)` finds no matching `Project` and creates one (`name` set equal to `key`), logging `project_created`.
5. `ensureProjectCollections(projectKey)` creates the project's `_knowledge_base` and `_FileProcessor` collections and indexes.

**Alternate Flows:**
- A1 — Subsequent start against an already-populated database: at step 2, `runSeed()` sees `Persona.countDocuments() > 0` and returns `'skipped'` without touching any of the five collections it owns; `ensurePromptsFromSeed()` (step 3) is separately gated on `SystemPrompt.countDocuments()` and likewise returns `'skipped'` if prompts already exist. At step 4, `ensureProjectFromConfig()` returns `'unchanged'` (no log) if the stored `root_path` already matches, or `'updated'` if it differs (see UC3).
- A2 — Prompts were cleared independently of personas (e.g. manually deleted from the DB) while personas remain: `runSeed()` still returns `'skipped'` at step 2, but `ensurePromptsFromSeed()` is called again standalone right after `runSeed()` in the startup sequence, sees `SystemPrompt.countDocuments() === 0`, and re-inserts the prompt rows — self-healing that one collection without re-running the rest of the seed.
- A3 — No project key is resolvable at step 4 (`MCP_PROJECT_NAME`/`MCP_PROJECT_KEY` unset and no `projectName` passed): `ensureProjectFromConfig()` and `ensureProjectCollections()` are skipped for this startup; no `Project` document or per-project collections are created until a project key becomes available.

**Exceptions:**
- E1 — The process crashes after step 2 inserts some but not all of `Persona`/`LLMModel`/`Project`/`Agent` (e.g. mid-way through `agents.json`): `runSeed()`'s idempotency check is a single gate on `Persona.countDocuments() > 0` covering all five collections it seeds. On the next startup, since personas now exist, `runSeed()` returns `'skipped'` immediately — the missing `LLMModel`/`Project`/`Agent` data is never retried and the database is left permanently partially-seeded unless someone intervenes manually.
- E2 — An `agents.json` row has no `tool_name`/`focus`, or references a `project_key` not present in `projects.json`: `runSeed()` throws, aborting the rest of seeding for that run (personas/models/project rows already inserted before the failing agent row are not rolled back, contributing to the same partial-seed risk as E1).
- E3 — `MONGO_URL` is unset or empty: `connectMongoose()` throws `'MONGO_URL is required'` at step 1, aborting startup before any seeding or project bootstrap runs.
- E4 — Two agents in `agents.json` resolve to the same `project_id` + `tool_name`: the `Agent` model's compound unique index rejects the second insert at the Mongoose/Mongo level, not with a friendly validation message from `seed.ts`.

### UC2 — Upgrading from an older `Agent` schema (`focus` → `tool_name` migration)

**Goal:** Let a deployment with pre-existing `Agent` documents that still use the legacy `focus` field pick up the current `tool_name` field automatically, with no separate migration script to remember to run.

**Stakeholders:** Platform operators upgrading an existing deployment; anyone maintaining `src/db/models/Agent.ts`, which depends on this migration continuing to run for old data to keep working.

**Actors:** `connectMongoose()` (`src/db/mongoose.ts`); `migrateAgentFocusToToolName()` (`src/db/migrateAgentToolName.ts`).

**Preconditions:** One or more `Agent` documents in the database still have a `focus` (and/or `seed_baseline_focus`) field and lack `tool_name` (and/or `seed_baseline_tool_name`).

**Postconditions:** Those documents have `tool_name` (and `seed_baseline_tool_name`) populated from the old field values; the old `focus`/`seed_baseline_focus` fields are no longer relied upon.

**Basic Course of Events (BCE):**
1. `connectMongoose()` is called (on any server startup, or any other code path that connects Mongoose).
2. Before marking itself connected, it calls `migrateAgentFocusToToolName()`.
3. `migrateAgentFocusToToolName()` runs an aggregation-pipeline `updateMany` against the raw `Agent.collection`, renaming `focus` → `tool_name` wherever `tool_name` doesn't exist but `focus` does.
4. It runs a second `updateMany` doing the same for `seed_baseline_focus` → `seed_baseline_tool_name`.
5. If either update modified documents, it logs `agent_tool_name_migration` (info).

**Alternate Flows:**
- A1 — No documents need migrating (already-current schema, or a fresh database): both `updateMany` calls match zero documents; no log is emitted, and startup proceeds normally.
- A2 — This runs on every single `connectMongoose()` call, not just the first connection ever made to a given database — it is a permanent, unconditional part of the connection path, not a one-off script gated by a "have I migrated yet" flag.

**Exceptions:**
- E1 — `updateMany` throws (e.g. transient Mongo error): the failure is caught, logged as `agent_tool_name_migration_failed` (warn), and not rethrown — `connectMongoose()` proceeds to mark itself connected regardless, so a migration failure does not block server startup, but also means old `focus`-shaped documents can silently continue past `connectMongoose()` unmigrated until a later successful connect retries it.

### UC3 — Moving a project's root directory

**Goal:** Keep a project's stored `root_path` correct after its directory is relocated on disk, without a manual database edit.

**Stakeholders:** Platform operators who move or rename a project's working directory; anything downstream that reads `Project.root_path`.

**Actors:** `ensureProjectFromConfig(projectKey, rootPath)` (`src/db/ensureProject.ts`), invoked during the normal startup sequence (UC1) with whatever `rootPath` is currently resolved (e.g. via `WORKING_DIRECTORY` / MCP config tool's `applyConfig`, per `src/mcp/context.ts`).

**Preconditions:** A `Project` document already exists for the project's `key`, with a `root_path` that no longer matches the directory's current location; the server is started with the new root path resolvable.

**Postconditions:** The `Project` document's `root_path` field is updated to the new path; no other project fields are changed.

**Basic Course of Events (BCE):**
1. On startup, `ensureProjectFromConfig(projectKey, newRootPath)` looks up the `Project` by `key`.
2. It finds an existing document whose `root_path` differs from `newRootPath`.
3. It updates the document's `root_path` to `newRootPath`.
4. It returns `'updated'` and logs a `project_updated` info event.

**Alternate Flows:**
- A1 — The stored `root_path` already matches: `ensureProjectFromConfig()` returns `'unchanged'` and does nothing further (no log emitted) — this is the common case on every startup where the directory hasn't moved.

**Exceptions:**
- None specific to this use case beyond the general "no project key resolvable" case already covered in UC1 A3 — if no project key can be resolved, `ensureProjectFromConfig()` is never called, so a moved directory for a project without a resolvable key will not be picked up.

### UC4 — Operator edits seed personas/agents from the Config admin UI (dev only)

**Goal:** Let an operator change what personas/agents a fresh database will seed, and what "restore to default" falls back to, by editing them through the Config admin UI rather than hand-editing JSON files on disk.

**Stakeholders:** Developers/operators curating the starter persona/agent set; anyone relying on `configs/seed/*.json` as the source of truth for both future seeding and restore-default fallback data.

**Actors:** The Config admin UI (`platform-ui`'s `config.vue` and related panels); the Fastify routes in `src/stats/routes/config.ts`; `assertDevSeedWriteAllowed()` / `isDevConfigSeedWrites()` (`src/stats/configAdmin.ts`); `writePersonaSeedRows()` / `writeAgentSeedRows()` (`src/stats/configSeedJson.ts`).

**Preconditions:** The server is running with `NODE_ENV !== 'production'` (e.g. `npm run dev` or local); the operator has access to the Config admin UI.

**Postconditions:** The corresponding `configs/seed/personas.json` or `configs/seed/agents.json` file on disk is overwritten with the operator's edits; existing DB documents (already-created `Persona`/`Agent` records) are not retroactively changed.

**Basic Course of Events (BCE):**
1. Operator edits a persona or agent's seed definition in the Config admin UI.
2. The UI calls the corresponding route in `src/stats/routes/config.ts`.
3. The route calls `assertDevSeedWriteAllowed()`, which checks `NODE_ENV`; since it is not `'production'`, the write is allowed.
4. The route calls `writePersonaSeedRows()` or `writeAgentSeedRows()`, which overwrites the relevant `configs/seed/*.json` file (creating the seed directory first if it doesn't already exist).
5. Future empty-database seeds (UC1) will read the updated file; future restore-default requests (UC5) that fall back to on-disk seed data will also read the updated file.

**Alternate Flows:** None beyond the production-blocked case, which is captured as an exception since it changes the outcome rather than the path taken.

**Exceptions:**
- E1 — `NODE_ENV === 'production'`: `assertDevSeedWriteAllowed()` returns `false` and sends a 403 with an explanatory message; the seed file is not written, and the operator's edit is rejected outright — seed files can only be edited from non-production environments by design.

### UC5 — Restoring a persona/agent/prompt to its seed default

**Goal:** Let an operator undo edits made to a `Persona`, `Agent`, or `SystemPrompt` document by restoring it to the values it was seeded with.

**Stakeholders:** Operators who have edited a seeded record in the DB and want to revert it; the Config admin UI, which surfaces this as a "restore to default" action.

**Actors:** The `/config/*/restore-default` routes (`src/stats/routes/config.ts`); the document's own `seed_baseline_*` fields; `readPersonaSeedRows()` / `readAgentSeedRows()` (`src/stats/configSeedJson.ts`) as fallback.

**Preconditions:** The target document has `save_to_seed: true` (it was originally seeded) or otherwise has `seed_baseline_*` fields or a matching on-disk seed row to fall back to.

**Postconditions:** The document's editable fields (e.g. `name`/`description`/`prompt`/`tool_name`) are reset to the seed baseline values.

**Basic Course of Events (BCE):**
1. Operator triggers "restore to default" for a persona, agent, or prompt in the Config admin UI.
2. The corresponding `/config/*/restore-default` route looks up the document and reads its own `seed_baseline_*` fields (e.g. `seed_baseline_name`, `seed_baseline_prompt`, `seed_baseline_tool_name`).
3. Since the baseline fields are present on the document, the route writes those values back onto the corresponding editable fields and saves.

**Alternate Flows:**
- A1 — The document's `seed_baseline_*` fields are missing (e.g. an older document created before baseline snapshotting, or a document whose baseline fields were manually cleared): the route falls back to re-reading `configs/seed/personas.json` (via `readPersonaSeedRows()`) or the agents equivalent, matching by the document's current `name`, and uses that row's values instead.

**Exceptions:**
- E1 — Neither the document's own `seed_baseline_*` fields nor a matching row in the on-disk seed file can be found (e.g. the document was never seeded and has no baseline snapshot, or its `name` no longer matches any seed row after being renamed): restore-to-default has no data to restore from for that document; this doc does not specify a distinct error path beyond the fallback in A1 not resolving.

### UC6 — Running seed standalone, without starting the full server

**Goal:** Pre-populate a fresh database with starter personas/models/project/agents/prompts before the server is ever started, e.g. as part of environment setup or CI provisioning.

**Stakeholders:** Operators provisioning a new environment; CI/deployment scripts that want the DB seeded before first server boot.

**Actors:** `npm run seed`, which executes `src/db/seed-run.ts`; `connectMongoose()`, `runSeed()`, `ensurePromptsFromSeed()`, `disconnectMongoose()`.

**Preconditions:** `.env` (or equivalent) provides `MONGO_URL`; `configs/seed/*.json` exist.

**Postconditions:** Same as UC1 steps 1–3 (Mongoose connected then disconnected, seed data present if the DB was empty); no `Project`/per-project-collection bootstrap happens, since `seed-run.ts` does not call `ensureProjectFromConfig()` or `ensureProjectCollections()`.

**Basic Course of Events (BCE):**
1. Operator runs `npm run seed`.
2. `seed-run.ts` loads `.env`, then calls `connectMongoose()`.
3. It calls `runSeed()`, then `ensurePromptsFromSeed()`.
4. It calls `disconnectMongoose()`.
5. The outcome (e.g. `'skipped'` vs. the inserted counts) is logged to stdout.

**Alternate Flows:**
- A1 — Run against an already-seeded database: `runSeed()` and `ensurePromptsFromSeed()` both return `'skipped'`, as in UC1 A1; the script still connects and disconnects cleanly and logs the skip.

**Exceptions:**
- E1 — Same partial-seed risk as UC1 E1: if this script is interrupted mid-seed, the single `Persona.countDocuments() > 0` gate means a subsequent run (whether via `npm run seed` again or via normal server startup) will skip re-seeding the missing collections.
- E2 — `MONGO_URL` missing from `.env`: `connectMongoose()` throws, and the script does not seed anything.

## Tests

- `__tests__/config.test.ts` — asserts `config.DB_NAME === 'mcp_code_vault'`.
- `__tests__/mongoose.test.ts` — with `mongoose.connect`/`disconnect` and `migrateAgentFocusToToolName` mocked, asserts `connectMongoose()` calls `mongoose.connect` with a `mongodb://`-prefixed URL, that a second call does not reconnect (cached), and that `disconnectMongoose()` calls `mongoose.disconnect()`.
- `__tests__/db.test.ts` — with `mongodb.MongoClient` mocked, asserts `connectToDatabase()` caches its `Db` across calls and that it throws `'MONGO_URL is required'` when the env var is deleted.
- `__tests__/migrateAgentToolName.test.ts` — asserts exactly two `updateMany` calls per run, an info log (`agent_tool_name_migration`) when any rows were modified, and a warn log (`agent_tool_name_migration_failed`) — with no rethrow — when `updateMany` rejects.
- `__tests__/ensureProject.test.ts` — with `Project.findOne/create/updateOne` mocked, asserts the three branches: `'created'` (calls `create` with `{ name, key, root_path }`, no `updateOne`), `'updated'` (calls `updateOne` with `{ $set: { root_path } }`, no `create`), and `'unchanged'` (neither called) when `root_path` already matches.
- `__tests__/projectDefaults.test.ts` — asserts `readCurrentBranchFromRoot` parses `ref: refs/heads/<name>` (including trimming whitespace around the name), returns `'HEAD'` for detached/unparseable content and for a throwing `readFileSync`; asserts `ensureProjectDefaults('my-key')` calls the mocked `ensureProjectCollections('my-key')`.
- `__tests__/configSeedJson.test.ts` — asserts `readPersonaSeedRows`/`readAgentSeedRows` return `[]` on missing file, parse error, or non-array JSON, and return the parsed array otherwise; asserts `writePersonaSeedRows`/`writeAgentSeedRows` create the seed directory only when it doesn't already exist, and always call `writeFileSync` with pretty-printed JSON.
- `__tests__/configAdmin.test.ts` — asserts `isDevConfigSeedWrites()` is true for `NODE_ENV` of `development`/`test` and false for `production`; asserts `assertDevSeedWriteAllowed()` returns `true` without touching the reply in non-production, and sends a 403 with an error message containing `"development"` in production.
- No dedicated `configSeedJson`/`seed.ts` test exercises `runSeed()`/`ensurePromptsFromSeed()` end-to-end against real seed JSON in the files reviewed here — those two functions' seed-file-parsing branches (invalid rows, legacy `global-prompts.json` fallback, `global_prompt_slug` resolution) are covered indirectly at best; treat `runSeed()`/`ensurePromptsFromSeed()` as lighter on direct unit coverage than the surrounding bootstrap functions.

## UI/UX

No UI is owned by this subsystem directly, but it is the backing data source for the Config admin pages: `platform-ui`'s Config page (`platform-ui/pages/config.vue`, `ConfigPromptsPanel.vue`, `ConfigModelsPanel.vue`) reads/writes personas, agents, models, and prompts through the Fastify routes in `src/stats/routes/config.ts` (`/config/personas`, `/config/agents`, `/config/prompts`, plus `restore-default` endpoints), which in turn read the same `configs/seed/*.json` files this doc describes via `configSeedJson.ts`. Seed-file writes from that UI are blocked outside development by `assertDevSeedWriteAllowed()`, surfaced to the UI as a 403 with an explanatory error string.

## Dependencies

- Depends on `docs/design/storage.md` for `ensureProjectCollections()`, the per-project `_knowledge_base`/`_FileProcessor` collections, and the `Project` model referenced by `ensureProjectFromConfig()` — this doc assumes that architecture and does not redefine it.
- The `Agent`/`Persona`/`SystemPrompt` models depend on the `Project` and `LLMModel` models (via `project_id`, `persona_ids`, `model_categories`/`model_ids`) for referential fields, though none of those relations are enforced by Mongo itself (no foreign-key constraints — only application-level lookups in `seed.ts` and the config routes).

## Diagrams

No diagram is currently maintained for this subsystem; the startup-sequence list under Architecture and the seed-data-flow block are the closest representation and should be kept in sync with `src/index.ts` / `src/stats/server.ts` if the boot order changes.

## References

- `mcp-code-vault/src/config.ts`, `src/db/mongoose.ts`, `src/db.ts`, `src/db/ensureProject.ts`, `src/db/projectDefaults.ts`, `src/db/migrateAgentToolName.ts`, `src/db/seed.ts`, `src/db/seed-run.ts`.
- `mcp-code-vault/src/db/models/Agent.ts`, `Persona.ts`, `SystemPrompt.ts`, `Symbol.ts`.
- `mcp-code-vault/configs/seed/{agents,models,personas,projects,prompts}.json`, `configs/personas/security-analyst.json` (unused reference config, see Architecture).
- `mcp-code-vault/src/stats/configSeedJson.ts`, `src/stats/configAdmin.ts`, `src/stats/routes/config.ts`.
- `mcp-code-vault/__tests__/config.test.ts`, `configAdmin.test.ts`, `configSeedJson.test.ts`, `ensureProject.test.ts`, `projectDefaults.test.ts`, `mongoose.test.ts`, `migrateAgentToolName.test.ts`, `db.test.ts`.
- `docs/design/storage.md` — per-project collection architecture this subsystem provisions via `ensureProjectCollections()`.
