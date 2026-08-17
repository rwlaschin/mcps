---
modified: 2026-07-06
dependencies: []
---

# Storage — per-project MongoDB collections

Describes how `mcp-code-vault` stores indexed codebase data in MongoDB: the two collections created per project, their schemas, and full-text search setup. Read this before touching `src/db/projectDb.ts`, adding a new per-project collection, or changing how indexed content is written or queried.

## Sensitive Areas

- Collection and index creation (`ensureProjectCollections()` in `src/db/projectDb.ts`) must happen together — creating an index on a collection that doesn't exist yet creates the collection as a side effect. Splitting these into separate steps risks a collection existing without its required indexes.
- The `FileProcessor.processingUntil` lock is a date, not a boolean, specifically so an aborted process can't leave a file stuck "being processed" forever — the lock self-expires when the date passes. Do not replace this with a boolean flag.

## Design Constraints

- Exactly two collections per project (see Architecture) — no ad hoc additional per-project collections. Project-level config (key, `root_path`, etc.) lives in the `registry`/`Project` model, not in either of these collections.
- Collection names are derived from the project key (e.g. `mcp-development_knowledge_base`, `mcp-development_FileProcessor`), so a project key must stay stable once collections exist under it.
- Full-text search fields must be indexed at collection-creation time, not added later as an afterthought.

## Feature Overview

Code changes over time — functions move, get renamed or deleted, branches diverge — so storing one document per file (a single blob per file) makes it hard to keep indexed context accurate as things move or when comparing branches. The original design goal (see `mcp-code-vault/docs/ARCHITECTURE.md`, folded into this doc) was to store fine-grained "atoms" — one file yields multiple atoms — instead of one document per file, so that individual units can be updated or invalidated independently and searched efficiently. Example atom categories floated in that design: variable/exports, function prototypes/methods, imports, dependencies, doc, diagram — these were explicitly examples only, not a prescribed `type` enum.

**Current implementation status:** `ensureProjectCollections()` (`src/db/projectDb.ts`) creates the two collections and their indexes today, but the collection is named `{projectKey}_knowledge_base` and its indexes are on `format` and `level` — not the `meta`/`keywords` full-text fields the original atoms schema sketched. No code path currently writes documents into the knowledge-base collection: `knowledgeBaseCollectionName` is referenced only inside `projectDb.ts` itself (`hasAnyPaths()` reads it, nothing writes it), and `runFileProcessingStartup()` (`src/fileProcessingStartup.ts`) — the MCP-client startup path that would be the natural place to populate it — carries an explicit comment that "this does not write FileProcessor/knowledge_base; it only reports scan metrics." `ensureProjectDefaults()` (`src/db/projectDefaults.ts`) only calls `ensureProjectCollections()`; it does not write documents either.

This is a genuinely open gap, not a documentation oversight: the atom schema (`file`, `branch`, `meta`, `keywords`) below is the original design's target shape, but no write path, no `meta` format convention, and no `format`/`level` index rationale have been decided or committed to in code. Treat the schema in Models below as aspirational/undecided, not current, until a write path exists and this doc is updated to match. Resolving this (deciding the write path and the `meta` format) is unfinished design work, not something inferable from the current code.

## Architecture

Two per-project collections, both set up together in `ensureProjectCollections()`:

1. **`{projectKey}_knowledge_base`** — the indexed knowledge-base entries for the project (working name "atoms" in the original design).
2. **`{projectKey}_FileProcessor`** — tracks which files have been processed, when, and their checksums, for change detection.

Project-level config (key, `root_path`, model/prompt settings, etc.) is stored separately in the `Project` model (`src/db/models/Project.ts`) — never inside either per-project collection.

## Functions

- `knowledgeBaseCollectionName(projectKey)` / `fileProcessorCollectionName(projectKey)` — derive the two collection names from a project key.
- `ensureProjectCollections(projectKey)` — creates both collections (if missing) and their indexes in one step. Currently creates `format`/`level` indexes on the knowledge-base collection and `path` (unique), `checksum`, `processedAt`, and a text index on `path` for the FileProcessor collection.
- `hasAnyPaths(projectKey)` — true if the project's knowledge-base collection has at least one document.
- `getFileProcessorProcessedAtMap(projectKey)` / `getFileProcessorChecksumMap(projectKey)` — build `path -> processedAt` / `path -> checksum` maps from the FileProcessor collection, used to decide which files need reprocessing.

All defined in `src/db/projectDb.ts`.

## Models

**Knowledge-base document (target shape — not yet committed in code; no write path exists, see Feature Overview)**

| Field    | Type                      | Required | Notes |
| -------- | ------------------------- | -------- | ----- |
| file     | string                    | yes      | Path relative to project root (or absolute, by convention). |
| branch   | string                    | no       | Git branch (or equivalent); optional if same across branches or not branch-aware. |
| meta     | string                    | yes      | Full-text searchable. Content/summary of the atom. Exact format (plain text vs. markdown, a signature+description convention, etc.) has not been decided — this is unresolved design work, not an implementation detail to infer from code, since no code writes this field today. |
| keywords | array of string or string | yes      | Full-text searchable. Terms for retrieval (e.g. names, tags). |

No prescribed `type`/`kind` field or enum for atom categories — left open in the original design. Note that the collection actually created by `ensureProjectCollections()` indexes `format`/`level` fields instead, which do not appear in this target schema at all — the current indexes and the target schema have not been reconciled; that reconciliation is itself part of the undecided write path.

**FileProcessor document (current — matches implementation)**

| Field           | Type   | Required | Notes |
| --------------- | ------ | -------- | ----- |
| path            | string | yes      | File path (relative to project root, or absolute by convention); unique index. |
| checksum        | string | yes      | e.g. MD5 hash of file content; used to detect changes without re-reading the file. |
| processedAt     | date   | yes      | When the file was last processed. |
| processingUntil | date   | no       | Processing lock. If set, the file is "being processed" until this time. Cleared on completion (success or failure); if the process aborts, the date simply passes and the lock expires — a date is used instead of a boolean so it can't get stuck. |
| createdAt       | date   | yes      | Set by the system when the document is created. |
| modifiedAt      | date   | yes      | Set by the system when the document is updated. |

## Use Cases

### UC1 — Incremental re-scan skips unchanged files

**Goal:** Avoid re-processing every file in a project on each scan by detecting which files actually changed.

**Stakeholders:** Platform operators (want fast, low-cost re-scans); the Mongo instance (write/read-volume concern).

**Actors:** The scanning/file-processing caller (outside this module — see `src/fileProcessingStartup.ts` and related scan code); `getFileProcessorProcessedAtMap()` / `getFileProcessorChecksumMap()` (`src/db/projectDb.ts`).

**Preconditions:** `ensureProjectCollections(projectKey)` has already run for the project, so its `{projectKey}_FileProcessor` collection and indexes exist; the caller has a current on-disk file listing for the project.

**Postconditions:** The caller has a `path -> processedAt` map and/or a `path -> checksum` map reflecting what was last recorded for each known file, which it uses to decide which files to skip.

**Basic Course of Events (BCE):**
1. Caller invokes `getFileProcessorProcessedAtMap(projectKey)` and/or `getFileProcessorChecksumMap(projectKey)`.
2. Each function queries the `{projectKey}_FileProcessor` collection, projecting only `path`+`processedAt` or `path`+`checksum`.
3. Each function builds an in-memory `Map<string, Date>` or `Map<string, string>` keyed by file path, skipping any document missing the relevant field.
4. Caller compares each on-disk file's current mtime/checksum against the map; files that match are skipped, files that differ or are absent from the map are queued for (re)processing.

**Alternate Flows:**
- A1 — Project has no `FileProcessor` documents yet (first scan): both map-builder functions return empty maps, so every on-disk file is treated as needing processing.

**Exceptions:**
- E1 — `ensureProjectCollections()` was never called for this project key: `getDb()`'s underlying `mongoose.connection.db` call still succeeds (Mongo does not require the collection to pre-exist for a read), but `find()` against a nonexistent collection simply returns no documents — indistinguishable from "no files processed yet," which could mask a setup bug.

### UC2 — Change detection across branches (design target, not implemented)

**Goal:** Let the same file's indexed knowledge-base content diverge per Git branch instead of one shared record going stale when branches disagree.

**Stakeholders:** Codebase maintainers working across multiple long-lived branches; agents querying indexed context (need branch-correct results).

**Actors:** A future write path for the knowledge-base collection (does not exist yet — see Feature Overview).

**Preconditions:** None can be stated as currently satisfied — this use case describes intended behavior of the target atom schema's optional `branch` field, not a flow that runs today.

**Postconditions:** Not applicable today; in the target design, a knowledge-base document's `branch` field would let atoms for the same `file` differ by branch.

**Basic Course of Events (BCE):**
1. (Target design only) A write path indexes a file, tagging the resulting atom document(s) with the current branch (e.g. via `readCurrentBranchFromRoot()` in `src/db/projectDefaults.ts`, which already reads `.git/HEAD` for this purpose).
2. (Target design only) A query for context on that file filters or prefers atoms matching the caller's current branch.

**Alternate Flows:** None — no implemented flow exists to branch from.

**Exceptions:**
- E1 — This entire use case is unimplemented. `readCurrentBranchFromRoot()` exists and works (reads `.git/HEAD`, falls back to `'HEAD'` if detached/unreadable) but nothing in the codebase calls it as part of a knowledge-base write, because no such write exists. Do not treat this section as describing current behavior.

### UC3 — Context retrieval for agents (design target, not implemented)

**Goal:** Let an MCP tool call retrieve relevant context for a query via full-text search over indexed content, instead of loading whole files.

**Stakeholders:** MCP tool callers/agents (want fast, relevant context without full-file reads); end users waiting on tool responses.

**Actors:** A future write path and query path for the knowledge-base collection (neither exists yet).

**Preconditions:** Not satisfiable today — would require documents to exist in `{projectKey}_knowledge_base`, which nothing currently writes (see Feature Overview), and full-text indexes on `meta`/`keywords`, which the current `ensureProjectCollections()` does not create (it creates `format`/`level` indexes instead).

**Postconditions:** Not applicable today.

**Basic Course of Events (BCE):**
1. (Target design only) A write path populates `{projectKey}_knowledge_base` with atom documents (`file`, `branch`, `meta`, `keywords`).
2. (Target design only) An MCP tool call runs a full-text query over `meta`/`keywords` and returns matching atoms instead of whole-file contents.

**Alternate Flows:** None — no implemented flow exists.

**Exceptions:**
- E1 — `hasAnyPaths(projectKey)` (`src/db/projectDb.ts`) already exists and would return `true`/`false` based on document count in the knowledge-base collection, but since nothing writes to it, it returns `false` for every project today — a straightforward way to confirm this gap has not silently been closed.

## Tests

`__tests__/projectDb.test.ts` covers `ensureProjectCollections`, the collection name helpers, `hasAnyPaths`, and the `FileProcessor` map builders.

## UI/UX

No UI/UX required — this is a storage/data-access layer with no direct visual surface. The platform UI's project/scan views consume this data indirectly through the stats API, not through this module directly.

## Dependencies

None — this is a foundational storage layer other subsystems build on, not one that depends on other design docs.

## Diagrams

Not applicable — no diagram currently maintained for this subsystem.

## References

- Original design note: "Architecture: Project Collection (target design)" (folded into this document; superseded as a standalone file).
