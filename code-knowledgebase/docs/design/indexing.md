---
modified: 2026-07-06
dependencies: [storage]
---

This document describes the file-scanning and LLM-indexing pipeline in `mcp-code-vault`: walking a project's files on disk, deciding which files need (re)processing, and running an LLM summarization pass over changed files. Read this before touching `src/scanner.ts`, `src/fileProcessingStartup.ts`, `src/llm/runFileProcessingLlm.ts`, the ignore/hash utilities, or the scan-progress reporting path. It assumes familiarity with `docs/design/storage.md`, which owns the per-project `FileProcessor`/`knowledge_base` collection schemas this pipeline reads and (per the collection helpers) is meant to write.

## Sensitive Areas

- **Checksum-based change detection** (`calculateMD5` in `src/utils/hasher.ts`, consumed by `fileProcessingStartup.ts`): the entire "skip unchanged files" decision rests on comparing a freshly computed MD5 against `state.checksumMap.get(filePath)`, which is loaded once at startup via `getFileProcessorChecksumMap`. If a file changes and changes back to identical content between scans, it will be (correctly) skipped — but if the in-memory `checksumMap` is never refreshed after a batch runs, that map only reflects the DB state as of `runFileProcessingStartupBody`'s call, not files processed later in the same run (see Design Constraints and Use Cases below for the consequence).
- **Ignore-pattern matching** (`src/utils/ignore-mgr.ts`): `shouldIgnore` resolves ignore rules per-directory by walking parent prefixes root-to-leaf and merging `.gitignore`-style files at each level (`parentPrefixChain`, `loadMergedPatterns`), with results memoized in `mergerCache` keyed by `(root, parentDir)`. The cache is only invalidated via the test-only `clearIgnoreMergerCacheForTesting()` — in a long-running process, editing an ignore file after the merger for that directory has been computed will not be picked up until the cache is otherwise cleared (e.g. process restart). Getting the parent-prefix chain or the built-in ignore list (`.git/`, `node_modules/`, `.DS_Store`) wrong would silently over- or under-scan large parts of a repo.
- **The `FileProcessor.processingUntil` lock described in storage.md is never set or read anywhere in this pipeline.** Neither `scanner.ts`, `fileProcessingStartup.ts`, nor `projectDb.ts`'s exported functions touch `processingUntil`. There is currently no in-process concurrency guard preventing two scans of the same project from racing, beyond the `fileProcessingStartupInflight` promise map (see Design Constraints).
- **LLM call failure handling in the processing loop** (`processQueue` in `fileProcessingStartup.ts`): each file's `runFileProcessingLlm` call is wrapped in a `try { ... } catch { return 0; }` inside `pLimit`-bounded concurrency. A failure is silently swallowed — the file is not retried, not marked failed, and not recorded anywhere; it simply does not count toward `processedCount` and no checksum is persisted for it (there is no persistence step at all — see Design Constraints). This means a transient LLM error looks identical, from the metrics stream, to a file that was skipped because it was unchanged.
- **`runFileProcessingLlm`'s model-fallback chain** (`src/llm/runFileProcessingLlm.ts`): resolves system prompt and model chain from Mongo (`Project`, `SystemPrompt`, cached vault LLM models), falls back to `GEMINI_API_KEY` only if zero usable model slots exist after credential resolution (`batchResolveModelAuth`). Any change to `resolveFileProcessingForProject`'s driver logic (`prompt` vs `agent`) risks silently changing which system prompt is used for every file in the vault.

## Design Constraints

- **Concurrency is capped, not zero.** `fileProcessingStartup.ts` processes each batch with `pLimit(concurrency)` (default `DEFAULT_CONCURRENCY = 3`), and batches are drained serially from `state.queue` (`DEFAULT_BATCH_SIZE = 30`), with a `pauseMs` delay (default 100ms) between batches. All four knobs (`batchSize`, `pauseMs`, `concurrency`, `debounceMs`) are configurable per project via `Project.file_processing_*` fields, defaulting via `DEFAULT_BATCH_SIZE`/`DEFAULT_PAUSE_MS`/`DEFAULT_CONCURRENCY`/`DEFAULT_DEBOUNCE_MS`.
- **One watcher + processing loop per project, enforced by an in-flight promise map.** `runFileProcessingStartup` short-circuits if `watcherByProject` already has an entry for the project key, and otherwise de-dupes concurrent startup calls via `fileProcessingStartupInflight` (a `Map<projectKey, Promise<void>>`), so calling it twice for the same key while the first call is still initializing does not spin up two watchers.
- **File-change events are debounced, not processed immediately.** `scheduleProcess` clears any pending timer and reschedules `processQueue` after `debounceMs` (default 5000ms), and `enqueue` is idempotent per path via the `state.queued` set — so rapid repeated `change` events for the same file collapse into a single queue entry (confirmed by the "dedupes rapid changes" test in `fileProcessingStartup.test.ts`).
- **Ignore rules must be sourced the same way for both the initial walk and the live watcher.** `scanner.ts`'s `walkDir` and `fileProcessingStartup.ts`'s `chokidar.watch(...)` both go through `shouldIgnore`/`createChokidarIgnored` from `ignore-mgr.ts` — there is no separate ignore implementation for "initial scan" vs "watch."
- **`scannerRequirements.ts` gates whether the (legacy) scanner is allowed to run at all**: `checkScannerRequirements` fail-fasts if `PORT` is missing/invalid (only when not in `stdioMode`), if `MONGO_URL` is unset, or if the project (looked up by `key`) has no non-empty `root_path`. This is a precondition check, not itself part of the scan/process flow.
- **The scanner does not open files itself.** Per the top-of-file comment in `scanner.ts` ("File walker... No file I/O or DB calls in loops"), `walkDir`/`scanProject`/`streamProjectChunks` only produce paths and hand each path to a processor (`ScanProcessor` or `StreamChunkProcessor`); file reads happen inside the processor (`defaultScanProcessor.ts` via `analyzeFile`, `defaultStreamProcessor.ts` via `fs.readFileSync`).
- **Known-but-unfinished: no write-back to `FileProcessor` or `knowledge_base`.** `fileProcessingStartup.ts` explicitly states in a comment: "For now this does not write FileProcessor/knowledge_base; it only reports scan metrics." The pipeline reads `getFileProcessorChecksumMap` to decide what to skip, but nothing in `fileProcessingStartup.ts`, `runFileProcessingLlm.ts`, or `projectDb.ts` writes an updated checksum/`processedAt` back after a successful LLM run. This is a designed-but-unfinished stub, not a bug introduced by this doc's author — every re-scan of the same process lifetime will keep re-processing files whose checksum map was loaded once at startup and never updated for files completed later in the same run.
- **`scanProject` in `scanner.ts` writes to a `symbols` collection, not to the `{projectKey}_knowledge_base`/`{projectKey}_FileProcessor` collections documented in storage.md.** This is a second, older/parallel path (also gated by an in-module `globalThis.__mcp_watchers` chokidar watcher, separate from `fileProcessingStartup.ts`'s `watcherByProject`) that upserts `{ project_key, file, summary, updated }` documents into a flat `symbols` collection via `bulkWrite`. It reuses the same ignore manager and the same default LLM-backed processor (`createDefaultScanProcessor` → `analyzeFile` → `runFileProcessingLlm`), but is a structurally separate persistence target from the one storage.md documents.

## Feature Overview

This subsystem answers three questions for a given project: what files exist, which of them need to be (re)analyzed, and how to run that analysis. There are two parallel entry points that both walk the filesystem and both ultimately call the same LLM summarization step, but persist results differently:

1. **`scanProject`** (`scanner.ts`): a one-shot, on-demand scan. Walks the project root respecting ignore rules, runs a processor (by default `analyzeFile`, which reads the file and calls the file-processing LLM) over every non-ignored file, and bulk-upserts `{file, summary}` results into a `symbols` collection. It also lazily starts a `chokidar` watcher (one per project, tracked in `globalThis.__mcp_watchers`) that re-runs the processor and re-upserts on future file changes.
2. **`runFileProcessingStartup`** (`fileProcessingStartup.ts`): the MCP client's startup-time indexing loop. Lists all files under the project root, loads the project's known checksums from the `FileProcessor` collection, enqueues every file, and — after debouncing — processes the queue in bounded-concurrency batches: for each file, compute its MD5, compare to the last-known checksum, skip if unchanged, otherwise call `runFileProcessingLlm` to summarize it. It also starts its own `chokidar` watcher (tracked separately in `watcherByProject`) that enqueues newly added/changed files with priority. Throughout, it emits `scan` metrics (`start`/`update`/`complete`) and per-batch "read" metrics via `postMetric`, which are what actually drive the live progress feed described in UI/UX below. As noted in Design Constraints, this path does not currently persist new checksums back to `FileProcessor`.

Underneath both entry points, `runFileProcessingLlm` (`src/llm/runFileProcessingLlm.ts`) is the shared LLM step: it reads the file (truncating at `MAX_FILE_CHARS = 120_000` chars), resolves a system prompt and model chain from Mongo (`SystemPrompt`, cached vault LLM models, optionally an "agent" bundle), invokes the model chain with fallback, and emits a `model_call` metric either way.

## Architecture

```
scannerRequirements.ts        (preconditions: PORT/MONGO_URL/project.root_path)
        |
        v
scanner.ts  ---------------------------------------------------------------+
  walkDir() -> uses ignore-mgr.shouldIgnore()                              |
  scanProject() --------------------+--> defaultScanProcessor.ts           |
      |                             |       -> analyzer.ts::analyzeFile    |
      |                             |             -> runFileProcessingLlm  |
      |                             +--> bulkWrite into `symbols` (Mongo)  |
      |                             +--> chokidar watch (globalThis cache) |
  streamProjectChunks() ----------------> defaultStreamProcessor.ts        |
      (no DB writes; yields FileChunk)   (fs.readFileSync + line chunking) |
                                                                            |
fileProcessingStartup.ts  <-------------------------------------------------+ (separate call path)
  runFileProcessingStartup()
    -> scannerRequirements.getProjectRoot()
    -> scanner.listFilesUnderRoot() -> ignore-mgr.shouldIgnore()
    -> projectDb.getFileProcessorChecksumMap()  [storage.md FileProcessor collection]
    -> ignore-mgr.createChokidarIgnored() -> chokidar.watch()
    -> enqueue() / scheduleProcess() (debounce) -> processQueue()
         -> hasher.calculateMD5() vs checksumMap
         -> runFileProcessingLlm.ts  -> Project/SystemPrompt/model chain (Mongo) or GEMINI_API_KEY
         -> postMetric() (scan + model_call + read metrics)
                 |
                 v
         stats/routes/metrics.ts -> scanProgressCache.ingestScanMetricMetadata()
                 -> emitScanProgressFromPayload() -> Socket.IO `scan:progress`
```

`fileProcessingStartup.ts` is the bootstrap/entry point invoked when the MCP client starts up for a project: it is what actually initializes the checksum map, the file queue, and the live watcher for that project's process lifetime; `scanner.ts`'s `scanProject`/`streamProjectChunks` are separately callable (e.g. by MCP tools) and are not invoked from `fileProcessingStartup.ts` — the two do not share in-memory state (`watcherByProject` vs `globalThis.__mcp_watchers`), only the ignore manager and `runFileProcessingLlm`.

## Functions

- `getProjectRoot(projectKey)` (`scanner.ts`, private) / `getProjectRoot(projectKey)` (`scannerRequirements.ts`, exported) — two distinct implementations with the same name in different modules: the `scanner.ts` one queries the `registry` collection directly for `root_path`; the `scannerRequirements.ts` one queries the Mongoose `Project` model for `root_path`. `fileProcessingStartup.ts` uses the `scannerRequirements.ts` version.
- `checkScannerRequirements(projectKey)` (`scannerRequirements.ts`) — throws if `PORT`/`MONGO_URL` env vars are invalid (PORT check skipped in `stdioMode`) or if the project/`root_path` cannot be resolved; otherwise resolves.
- `listFilesUnderRoot(root)` (`scanner.ts`) — synchronous walk of `root` returning all non-ignored file paths (directories excluded), using the same `shouldIgnore` rules as scanning.
- `streamProjectChunks(projectKey, { processor })` (`scanner.ts`) — async generator; resolves project root, walks it, and for each path delegates to the given `StreamChunkProcessor`, yielding whatever `FileChunk`s it produces. Performs no file I/O and no DB writes itself.
- `scanProject(projectKey, { processor? })` (`scanner.ts`) — async; resolves project root, walks it, runs `processor` (default `createDefaultScanProcessor(projectKey)`) over every path, collects non-null `ScanResult`s, and performs one `bulkWrite` upsert into the `symbols` collection. Also lazily starts a per-project chokidar watcher (cached on `globalThis.__mcp_watchers`) that repeats the same per-file processing on `change` events. Returns `{ filesScanned, filesUpdated, symbolsFound }`, where `symbolsFound` is a naive regex count of `class |function |interface ` occurrences across all summaries.
- `createDefaultScanProcessor(projectKey)` (`processors/defaultScanProcessor.ts`) — returns a `ScanProcessor` that calls `analyzeFile(projectKey, filePath)` and wraps it in `{file, summary}`, or returns `null` on any thrown error (including read or LLM failures).
- `createDefaultStreamProcessor({ chunkLines? })` (`processors/defaultStreamProcessor.ts`) — returns a `StreamChunkProcessor` that reads a file synchronously and yields line-range `FileChunk`s of `chunkLines` lines (default 100); returns nothing (no chunks) if the read fails.
- `analyzeFile(projectKey, filePath)` (`analyzer.ts`) — resolves the project root then calls `runFileProcessingLlm` with `caller: MODEL_CALL_CALLER_SCAN_ANALYZE`, returning the summary text.
- `shouldIgnore(absPath, projectRoot, isDirectory?)` / `createChokidarIgnored(projectRoot)` / `logFileWatchIgnoreSummary(projectRoot)` / `clearIgnoreMergerCacheForTesting()` (`utils/ignore-mgr.ts`) — ignore-rule resolution described in Sensitive Areas; `createChokidarIgnored` wraps `shouldIgnore` for chokidar's `ignored` callback shape (handles missing `stats` via `lstatSync`), and logs a bounded number of sample decisions.
- `calculateMD5(filePath)` (`utils/hasher.ts`) — synchronous file read + MD5 hex digest, used as the sole change-detection signal.
- `runFileProcessingStartup(projectKey)` / `stopFileProcessingWatcher(projectKey)` / `resetFileProcessingStartupForTesting()` (`fileProcessingStartup.ts`) — public lifecycle functions: start (idempotent, de-duped via in-flight map), stop (closes the watcher, clears debounce timer, removes state), and a test-only full reset.
- `runFileProcessingLlm({ projectKey, filePath, rootDir, caller })` (`llm/runFileProcessingLlm.ts`) — reads and truncates the file, resolves system prompt + model chain (`resolveFileProcessingForProject`, `resolveFileProcessorSystemPrompt`, `buildFileProcessingSystemFromBundle`), invokes the model chain with fallback (`invokeWithModelFallback`) or falls back to `GEMINI_API_KEY` via `getGeminiLLM`, and posts a `model_call` metric (`postModelCallMetric`) on both success and failure. Returns a `RunFileProcessingLlmResult` (`summary`, `usage`, `source: 'db_chain' | 'env_gemini'`, plus model/attempt metadata).
- `buildScanProgressPayloadFromScanMetadata(metadata)` / `ingestScanMetricMetadata(metadata)` / `emitScanProgressFromPayload(payload)` / `reportScanProgress(payload)` / `getScanProgress(projectKey)` / `emitScanProgress(socket)` / `resetScanProgressCacheForTesting()` (`stats/scanProgressCache.ts`) — see Models and UI/UX for the shape and lifecycle of the in-memory cache these maintain.
- `knowledgeBaseCollectionName` / `fileProcessorCollectionName` / `ensureProjectCollections` / `hasAnyPaths` / `getFileProcessorProcessedAtMap` / `getFileProcessorChecksumMap` (`db/projectDb.ts`) — see storage.md for the full contract; within this pipeline, only `getFileProcessorChecksumMap` is actually called (from `fileProcessingStartup.ts`) to build the initial skip-decision map.

## Models

The persisted `FileProcessor`/`knowledge_base` document shapes are owned by `docs/design/storage.md` — see that document for field-level detail. This pipeline currently only reads from `FileProcessor` (via `getFileProcessorChecksumMap`) and does not write to either collection (see Design Constraints).

The one model specific to this subsystem and not covered in storage.md is the in-memory scan-progress cache in `stats/scanProgressCache.ts`:

- **`ScanProgressPayload`** — `{ filesProcessed: number; filesUpdated: number; totalFiles?: number; isActiveScan?: boolean; files?: Array<{ relativePath: string; state: 'new' | 'stale' | 'fresh' }>; projectKey?: string }`.
- **Storage**: a single process-local `Map<string, ScanProgressPayload>` (`cache`), keyed by `projectKey` (falling back to the literal string `'default'` when no key is given). It is global to the process, not persisted to Mongo, and holds one entry per project that has ever reported scan metadata since the process started.
- **Lifecycle**: populated by `ingestScanMetricMetadata`, which is called from `stats/routes/metrics.ts` whenever a `scan`-operation metric is POSTed; derived fields (`filesProcessed`, `totalFiles`, `isActiveScan`) are recomputed from each incoming metric's metadata, while the `files` list is only replaced when the incoming metadata carries a non-empty `processingRelative` array — otherwise the previous `files` value is carried forward (confirmed by the "keeps prior files when update has no processingRelative" test). `isActiveScan` is `true` whenever `action` is a non-empty string other than `'complete'`.
- **Reset conditions**: only ever cleared by the test-only `resetScanProgressCacheForTesting()`; there is no TTL or automatic eviction, so a project's last-known scan payload persists in memory indefinitely (until process restart) even after the scan completes.

## Use Cases

### UC1 — First scan of a brand-new project

**Goal:** Index every file in a project that has never been scanned before, with no prior checksum history to compare against.

**Stakeholders:** The MCP client operator starting up indexing for a new project; downstream tools/agents that will eventually query indexed content.

**Actors:** `runFileProcessingStartup(projectKey)`; `getFileProcessorChecksumMap` (`db/projectDb.ts`); `runFileProcessingLlm`.

**Preconditions:** `checkScannerRequirements` has passed (valid `PORT`/`MONGO_URL`, project has a `root_path`); no `FileProcessor` documents exist yet for this project key.

**Postconditions:** Every non-ignored file under the project root has been passed to `runFileProcessingLlm` (subject to concurrency/batching); `scan` metrics of `start`→`update`(s)→`complete` have been posted, driving `scanProgressCache`. No checksums are persisted back to `FileProcessor` regardless of outcome (see Design Constraints).

**Basic Course of Events (BCE):**
1. `runFileProcessingStartup(projectKey)` is called; it resolves the project root via `scannerRequirements.getProjectRoot`.
2. `listFilesUnderRoot(root)` walks the filesystem using `shouldIgnore`, returning `allPaths`.
3. `getFileProcessorChecksumMap(projectKey)` returns an empty map (no prior `FileProcessor` docs).
4. Every path in `allPaths` is `enqueue`d; a `scan` metric with `action: 'start'` and `total = allPaths.length` is posted.
5. After the debounce delay, `scheduleProcess` invokes `processQueue`, which drains the queue in batches (`DEFAULT_BATCH_SIZE`, `pLimit(DEFAULT_CONCURRENCY)`).
6. For each file, `calculateMD5` is computed; since `checksumMap` is empty, no match is found, so `runFileProcessingLlm` is called for every file.
7. Each successful call increments `processedCount` and posts a `model_call` metric with `status: ok`; batch and `read` metrics are posted per batch.
8. When the queue empties, a `scan` metric with `action: 'complete'` is posted.

**Alternate Flows:** None — a brand-new project has no checksum history by definition, so there is no branching skip-decision on first scan.

**Exceptions:**
- E1 — `checkScannerRequirements` fails (missing `PORT`/`MONGO_URL`, or project/`root_path` not found): the startup call throws before any file is listed or queued.

### UC2 — Incremental re-scan and process restart (checksum write-back gap)

**Goal:** On a subsequent scan (or a fresh process restart), avoid re-processing files whose content hasn't changed since they were last processed.

**Stakeholders:** Platform operators (want cheap, fast re-scans); anyone relying on LLM cost/time not scaling with total project size on every restart.

**Actors:** `runFileProcessingStartup(projectKey)`; `getFileProcessorChecksumMap`; `calculateMD5`.

**Preconditions:** The project has previously had `FileProcessor` documents populated by some writer (per Design Constraints, this pipeline itself never writes them — any existing documents would have to come from another, unread part of the system).

**Postconditions:** Files whose computed MD5 matches the last-loaded `checksumMap` entry are skipped (`processedCount` not incremented for them); all other files are sent to `runFileProcessingLlm`. As stated in Design Constraints and Sensitive Areas, **no successful LLM run in this pipeline ever writes an updated checksum back to `FileProcessor`** — `fileProcessingStartup.ts` contains the explicit comment "For now this does not write FileProcessor/knowledge_base; it only reports scan metrics." Consequently, on a fresh process restart, `getFileProcessorChecksumMap` reflects only whatever existed in Mongo before this run started; every file this pipeline itself processed in a prior run has no recorded checksum and will be treated as changed and reprocessed again on the next restart.

**Basic Course of Events (BCE):**
1. Process (re)starts; `runFileProcessingStartup(projectKey)` is called.
2. `getFileProcessorChecksumMap(projectKey)` queries the `FileProcessor` collection and builds an in-memory `path -> checksum` map from whatever documents currently exist.
3. `listFilesUnderRoot` re-walks the project root; all paths are enqueued.
4. `processQueue` computes `calculateMD5(file)` for each file and compares it to `checksumMap.get(filePath)`.
5. On a match, the file is skipped (counts 0 toward `processedCount`); on a mismatch or absence, `runFileProcessingLlm` is called.
6. No step in this flow writes a new/updated checksum back to `FileProcessor` for files that were just (re)processed.

**Alternate Flows:**
- A1 — Some external, unread-by-this-pipeline writer has populated/updated `FileProcessor` checksums for some files (e.g. by a mechanism outside `fileProcessingStartup.ts`/`runFileProcessingLlm.ts`/`projectDb.ts`'s exported functions): those specific files would be correctly skipped on this restart. This doc does not know of any such writer existing in the current codebase; it is called out only because the checksum-map read path does not care where the data came from.

**Exceptions:**
- E1 — **Known, unfinished gap:** because this pipeline never persists checksums after processing, every restart of the same process re-processes every file this pipeline has ever handled, unless some other part of the system happens to write `FileProcessor` documents. This is not a bug introduced by this doc — it is a designed-but-unimplemented write-back stub (see Design Constraints and the Diagram's closing note).
- E2 — No concurrency guard beyond the in-process `fileProcessingStartupInflight` promise map: `FileProcessor.processingUntil` (documented in storage.md as the intended cross-process lock) is never set or read anywhere in this pipeline, so two separate processes scanning the same project concurrently are not prevented from racing at the storage layer.

### UC3 — Re-scan after ignore-pattern changes (ignore-cache staleness)

**Goal:** Have `shouldIgnore` decisions reflect the current contents of `.gitignore`-style files on disk.

**Stakeholders:** Developers who edit ignore files expecting the next scan to honor them immediately; platform operators who don't want large ignored directories (e.g. `node_modules`) accidentally re-scanned or vice versa.

**Actors:** `shouldIgnore` / `getMerger` / `loadMergedPatterns` (`utils/ignore-mgr.ts`), used by both `listFilesUnderRoot` and the chokidar watcher's `ignored` callback.

**Preconditions:** The process has already computed and cached a merged `ignore()` instance for a given `(root, parentDir)` pair in `mergerCache` (i.e. at least one prior ignore decision has been made for that directory in this process's lifetime).

**Postconditions:** Editing a `.gitignore`/ignore file under a directory whose merger is already cached does not change `shouldIgnore`'s answer for paths under that directory for the remainder of the process's life — the memoized `ignore()` instance is reused as-is.

**Basic Course of Events (BCE):**
1. A developer edits an ignore file under some directory in the project.
2. A scan or watcher event triggers `shouldIgnore` for a path under that directory.
3. `getMerger` finds an existing cache entry for `(root, parentDir)` in `mergerCache` and returns it without re-reading the ignore file from disk.
4. The stale (pre-edit) ignore rules are applied to the decision.

**Alternate Flows:**
- A1 — The directory's merger has never been cached (first-ever decision for that `(root, parentDir)` pair): `loadMergedPatterns` reads the current, up-to-date ignore files from disk and caches the result, so the edit is picked up correctly in this one case.
- A2 — The process restarts: `mergerCache` is an in-memory, process-local structure, so a restart naturally clears it and the next scan reads current ignore files fresh.

**Exceptions:**
- E1 — There is no file-watch invalidation of the ignore cache itself; the only way to force re-evaluation within a running process is the test-only `clearIgnoreMergerCacheForTesting()`, which is not wired into any runtime code path (confirmed by it existing purely as a test seam).

### UC4 — LLM call fails mid-file

**Goal:** Keep the batch/queue processing loop moving forward even when an individual file's LLM summarization call fails, without corrupting metrics or the queue.

**Stakeholders:** Platform operators monitoring scan health via metrics; whoever eventually wants a complete, accurate index (currently unable to tell "skipped because unchanged" apart from "failed" via scan-progress counters alone).

**Actors:** `processQueue` (`fileProcessingStartup.ts`); `runFileProcessingLlm`; `postModelCallMetric`.

**Preconditions:** A file has been dequeued into the current batch and its checksum did not match `checksumMap` (i.e. it was not skipped).

**Postconditions:** The batch's `processedCount` is not incremented for this file; the file is not retried within the same run and is not marked failed or recorded anywhere persistent; a `model_call` metric with `status: 'error'` has been posted, so the failure is visible in metrics even though scan-progress counters treat it identically to a skip.

**Basic Course of Events (BCE):**
1. `processQueue` dequeues a batch of files (already `splice`d out of `state.queue`).
2. For a given file, `calculateMD5` does not match `checksumMap`, so `runFileProcessingLlm(...)` is invoked inside a `try` block, itself inside a `pLimit`-bounded concurrency wrapper.
3. `runFileProcessingLlm` throws (e.g. model chain exhausted, no usable credentials) — but not before it posts a `model_call` metric with `status: 'error'`.
4. The per-file `catch` block returns `0` instead of `1`, so this file contributes nothing to `processedCount`.
5. Processing continues with the remaining files in the batch and subsequent batches; batch/`read`/`scan` metrics are posted as usual.

**Alternate Flows:** None — the loop has exactly one failure-handling path (swallow and count 0); there is no retry-with-backoff or dead-letter branch implemented.

**Exceptions:**
- E1 — Because the failed file was already removed from `state.queue` before the LLM call, it will not be attempted again until the next full scan (e.g. next process restart or a subsequent file-change event for that same path) — there is no automatic re-queue on failure within the same run.

### UC5 — Server restarts mid-scan (in-memory state lost)

**Goal:** Resume useful indexing behavior after an unplanned or planned process restart interrupts an in-progress scan.

**Stakeholders:** Platform operators who restart/redeploy the MCP client; clients of the `scan:progress` Socket.IO feed expecting continuity.

**Actors:** `runFileProcessingStartup`; `watcherByProject`; `scanProgressCache`'s in-memory `cache` Map.

**Preconditions:** A scan was in progress (queue partially drained, watcher active) when the process was terminated or restarted.

**Postconditions:** All process-local state from before the restart is gone — `watcherByProject`'s watcher entry, `state.queue`/`state.queued`, any pending debounce timer, and `scanProgressCache`'s cached payload for that project are all unrecoverable (none of them are persisted to disk or Mongo). On restart, `runFileProcessingStartup` rebuilds everything from scratch: it re-lists all files and re-queries `getFileProcessorChecksumMap`, subject to the same write-back gap described in UC2 — files this pipeline itself processed just before the crash have no recorded checksum and will be reprocessed.

**Basic Course of Events (BCE):**
1. The process is terminated (crash, redeploy, manual restart) while `processQueue` is mid-batch or `state.queue` still has entries.
2. All in-memory structures for that project (`watcherByProject` entry, `queue`/`queued`, `scanProgressCache`'s cache entry) are discarded with the process.
3. On the next process start, `runFileProcessingStartup(projectKey)` is invoked again (by whatever bootstraps MCP client startup).
4. `listFilesUnderRoot` and `getFileProcessorChecksumMap` are called fresh, exactly as in UC1/UC2 — there is no attempt to detect or resume a prior in-flight scan.
5. A brand-new `scan` metric sequence (`start`→...→`complete`) begins; any client watching `scan:progress` for this project sees a fresh cycle with no reference to the interrupted one.

**Alternate Flows:** None — there is no persisted checkpoint of an in-progress scan to resume from; every restart is equivalent to a fresh start, modulo whatever `FileProcessor` checksums happen to already exist in Mongo.

**Exceptions:**
- E1 — A client connecting to Socket.IO between the crash and the next `runFileProcessingStartup` call receives whatever `scanProgressCache` last held before the crash — but since that cache is itself process-local, a full process restart wipes it too, so a client reconnecting after restart sees no progress data for that project until the new scan posts its first metric.

### UC6 — Rapid successive file edits in watch mode (debounce/dedupe)

**Goal:** Avoid redundant `calculateMD5`/LLM work when a single file receives multiple filesystem `change` events in quick succession (e.g. an editor's autosave, or a build tool rewriting a file multiple times).

**Stakeholders:** Platform operators (want to avoid wasted LLM calls/cost); developers actively editing files who don't want to see duplicate processing runs.

**Actors:** The chokidar watcher started by `runFileProcessingStartup`; `enqueue`; `scheduleProcess`; `processQueue`.

**Preconditions:** The watcher for this project is active (`watcherByProject` has an entry); a file under the watched root receives two or more `change` events within less than `debounceMs` (default 5000ms) of each other.

**Postconditions:** Exactly one `calculateMD5`/processing pass occurs for that file, not one per event — confirmed by the "dedupes rapid changes" test in `fileProcessingStartup.test.ts`.

**Basic Course of Events (BCE):**
1. A `change` event fires for a watched file; the watcher's handler calls `enqueue(path, { priority: true })`, which unshifts the path to the front of `state.queue` and adds it to the `state.queued` set (idempotent — no-op if already present).
2. `scheduleProcess` is called, which clears any pending debounce timer and starts a new one for `debounceMs`.
3. A second `change` event for the same path fires before the timer elapses; `enqueue` is a no-op for the path (already in `state.queued`), and `scheduleProcess` again resets the timer.
4. Once `debounceMs` elapses with no further events, `processQueue` runs and processes the single queued entry for that path exactly once.

**Alternate Flows:**
- A1 — Events for the same path arrive spaced further apart than `debounceMs`: each one independently triggers its own debounce window and its own processing pass (no dedup across separate windows, only within one).

**Exceptions:** None — the debounce/dedupe path has direct test coverage and no known failure mode distinct from the general LLM-failure handling in UC4.

## Tests

- `__tests__/scanner.test.ts` — covers `scanProject` (project-not-found error, single-file walk + `bulkWrite` shape, nested directory walking, ignore-manager integration for `node_modules`) and `streamProjectChunks` (project-not-found, chunking via the default stream processor, respecting a custom `chunkLines`, and skipping files that fail to read). Does not exercise the lazily-started `chokidar` watcher's `change` handler inside `scanProject` (the `mockWatch` is asserted to have been set up but its `on('change', ...)` callback is never invoked in the test).
- `__tests__/scanner-listFiles.test.ts` — exercises `listFilesUnderRoot` against a real temp-directory filesystem (not mocked), confirming nested-file discovery.
- `__tests__/scannerRequirements.test.ts` — exhaustively covers `checkScannerRequirements`'s branches: missing/invalid/negative `PORT`, missing/empty `MONGO_URL`, missing project, project without `root_path`, empty-string `root_path`, and the success path; also confirms the Mongoose query is by `{ key: projectKey }`.
- `__tests__/ignore-mgr.test.ts` — covers default (no ignore files) behavior, built-in `.git`/`node_modules` ignoring, root `.gitignore` application, merging multiple `.*ignore` files in the same directory, nested per-directory `.gitignore` application, treating paths outside the project root as ignored, and `createChokidarIgnored`'s directory classification both with and without `stats` provided (the `lstatSync` fallback path).
- `__tests__/hasher.test.ts` — confirms `calculateMD5` returns a 32-character lowercase hex string and is deterministic for identical content. Does not test its behavior on unreadable files (no try/catch in `calculateMD5` itself, so a read error would throw uncaught — this is consistent with `fileProcessingStartup.ts`'s `processQueue` catching around the whole per-file operation, but there's no direct test of that specific throw path).
- `__tests__/fileProcessingStartup.test.ts` — covers the full startup flow: initial batch processing with per-file checksum-based skip decisions (one of three seeded files has a matching checksum and is skipped), the `start`/`update`/`complete` metric sequence, `read`-operation metric aggregation, and watcher-driven dedup of rapid repeated `change` events (including that `total` increments correctly for a newly-seen file). Does not cover: the `add` watcher event beyond registration, `stopFileProcessingWatcher`'s interaction with an in-progress `processQueue` run, or the effect of concurrent `runFileProcessingStartup` calls racing on `fileProcessingStartupInflight` (no test directly asserts de-dup of two overlapping startup calls).
- `__tests__/runFileProcessingLlm.test.ts` — covers the `db_chain` path (vault model chain success, metric shape with UI token keys), the `agent` driver path (`file_processing_driver: 'agent'` resolving via `loadAgentExecutionBundleById` and tagging the metric `agent:<tool_name>`), the `env_gemini` fallback when no vault models are usable, and the error path when neither vault models nor `GEMINI_API_KEY` are available (asserts both the thrown error message and the `error`-status `model_call` metric). Does not test `MAX_FILE_CHARS` truncation behavior directly, nor the `agent:MISSING` driver tag branch (agent driver selected but bundle load returns falsy).
- `__tests__/scanProgressCache.test.ts` — covers `getScanProgress` (empty cache, blank/whitespace key, per-project isolation), `reportScanProgress` (write/overwrite/omitted-key-defaults-to-`'default'`), `ingestScanMetricMetadata` (mapping `processingRelative` to `stale`-state files, carrying forward `files` when absent, and `isActiveScan` becoming `false` on `'complete'`), and `emitScanProgress` (one `scan:progress` emit per cached project). Does not directly test `emitScanProgressFromPayload`'s wiring to `pushToStream` (that's exercised indirectly via `stats/routes/metrics.ts`, which is outside this subsystem's test files).
- `__tests__/defaultStreamProcessor.test.ts` — covers chunking a readable file with a custom `chunkLines` and returning no chunks when the file read throws.

## UI/UX

There is no traditional UI within this indexing pipeline itself, but it does drive a real, implemented live-progress surface consumed by an external UI: `postScanMetric` calls in `fileProcessingStartup.ts` (and equivalently any other caller of `POST /metrics` with `operation: 'scan'`) flow into `stats/routes/metrics.ts`, which calls `scanProgressCache.ingestScanMetricMetadata` and then `emitScanProgressFromPayload`, broadcasting a `scan:progress` Socket.IO event (see `pushToStream` and `src/index.ts`'s `emitScanProgress`/`scan:replay` handlers). A client connecting to the Socket.IO server receives the latest cached payload per project immediately on connect (`emitScanProgress(socket)` in `index.ts`), and can request a replay for a specific project via a `scan:replay` message. This gives a dashboard-style client a live feed of `{ filesProcessed, filesUpdated, totalFiles, isActiveScan, files }` per project, but the rendering of that feed lives outside this subsystem (in whatever frontend/dashboard consumes the Socket.IO events); no such frontend code exists inside the files covered by this doc.

## Dependencies

Internal modules this pipeline imports directly: `src/utils/ignore-mgr.ts`, `src/utils/hasher.ts`, `src/scannerRequirements.ts`, `src/processors/defaultScanProcessor.ts` and `defaultStreamProcessor.ts`, `src/analyzer.ts`, `src/llm/runFileProcessingLlm.ts` (and its own internal dependencies: `src/llm/vaultLlmModelsCache.ts`, `resolveModelAuth.ts`, `createChatModelForSavedModel.ts`, `invokeWithModelFallback.ts`, `invokeWithContinuation.ts`, `postModelCallMetric.ts`, `src/agent/loadAgentExecutionBundle.ts`), `src/db/projectDb.ts` (for `getFileProcessorChecksumMap`, tying this pipeline to the `FileProcessor` collection defined in storage.md), `src/db/models/Project.ts` and `src/db/models/SystemPrompt.ts` (Mongoose models), `src/stats/metricsClient.ts` (`postMetric`), `src/stats/fileReadHourBuckets.ts` (`METRIC_OPERATION_READ`), and `src/stats/scanProgressCache.ts`/`src/stats/streamChannel.ts` for progress broadcasting.

External npm packages: `chokidar` (file watching for both `scanner.ts`'s lazy watcher and `fileProcessingStartup.ts`'s startup watcher), `p-limit` (bounded concurrency in `processQueue`), `ignore` (gitignore-semantics pattern matching in `ignore-mgr.ts`), `mongoose` (via the `Project`/`SystemPrompt` models and `projectDb.ts`'s use of `mongoose.connection.db`), `@langchain/core` (`SystemMessage`/`HumanMessage` in `runFileProcessingLlm.ts`), and Node built-ins `fs`, `path`, `crypto`.

## Diagrams

```
                         SCAN / INDEX PIPELINE (fileProcessingStartup path)

  runFileProcessingStartup(projectKey)
        |
        v
  getProjectRoot(projectKey)  --(Mongo: Project.root_path)-->  rootDir
        |
        v
  listFilesUnderRoot(rootDir)  --(uses shouldIgnore: .gitignore + built-ins)-->  allPaths[]
        |
        v
  getFileProcessorChecksumMap(projectKey)  --(Mongo: FileProcessor)-->  checksumMap{path -> checksum}
        |
        v
  enqueue(allPaths)  ---->  queue[] + queued Set
        |
        v
  scheduleProcess()  --(debounce, default 5000ms)-->  processQueue()
        |
        v
  for each batch (default 30 files, concurrency 3 via p-limit):
        |
        +--> postScanMetric(action: 'update', processing: batch)
        |
        +--> for each file in batch:
        |         calculateMD5(file) --compare--> checksumMap[file]
        |               |
        |         match?  --yes-->  skip (count 0)
        |               |
        |               no
        |               v
        |         runFileProcessingLlm(file)  --(Mongo: SystemPrompt + model chain, or GEMINI_API_KEY)-->  summary
        |               |
        |               +--(success)--> count 1, postModelCallMetric(status: ok)
        |               +--(throw)---->  count 0, postModelCallMetric(status: error)  [NOT retried, NOT persisted]
        |
        +--> postMetric(operation: 'read', entries: [{count}])
        +--> postScanMetric(action: 'update', processedCount so far)
        |
        v
  queue empty --> postScanMetric(action: 'complete')
        |
        v
  stats/routes/metrics.ts: ingestScanMetricMetadata() -> scanProgressCache
        |
        v
  emitScanProgressFromPayload() -> Socket.IO 'scan:progress' -> connected UI clients

  NOTE: no step above writes back to the FileProcessor collection's checksum/processedAt fields —
  see "Design Constraints" for the unfinished write-back stub.
```

## References

- `mcp-code-vault/src/scanner.ts` — `walkDir`, `listFilesUnderRoot`, `streamProjectChunks`, `scanProject` (lines 32-155).
- `mcp-code-vault/src/scannerRequirements.ts` — `getProjectRoot`, `checkScannerRequirements` (lines 14-40).
- `mcp-code-vault/src/processors/defaultScanProcessor.ts` — `createDefaultScanProcessor`.
- `mcp-code-vault/src/processors/defaultStreamProcessor.ts` — `createDefaultStreamProcessor`, `chunkContent`.
- `mcp-code-vault/src/utils/ignore-mgr.ts` — `shouldIgnore`, `createChokidarIgnored`, `loadMergedPatterns`, `getMerger` (lines 1-181).
- `mcp-code-vault/src/utils/hasher.ts` — `calculateMD5`.
- `mcp-code-vault/src/fileProcessingStartup.ts` — `runFileProcessingStartup`, `runFileProcessingStartupBody`, `processQueue`, `enqueue`, `scheduleProcess`, `stopFileProcessingWatcher` (lines 96-286).
- `mcp-code-vault/src/llm/runFileProcessingLlm.ts` — `runFileProcessingLlm`, `resolveFileProcessingForProject`, `resolveFileProcessorSystemPrompt` (lines 36-302).
- `mcp-code-vault/src/stats/scanProgressCache.ts` — `ScanProgressPayload`, `ingestScanMetricMetadata`, `buildScanProgressPayloadFromScanMetadata`, `emitScanProgress`.
- `mcp-code-vault/src/db/projectDb.ts` — `getFileProcessorChecksumMap` and related collection helpers (see storage.md for full schema ownership).
- `mcp-code-vault/src/analyzer.ts` — `analyzeFile`.
- `mcp-code-vault/src/index.ts` — Socket.IO wiring for `scan:progress`/`scan:replay` (lines ~149-165).
- `mcp-code-vault/src/stats/routes/metrics.ts` — `POST /metrics` ingesting `scan` operation metadata into `scanProgressCache`.
- Tests read: `mcp-code-vault/__tests__/scanner.test.ts`, `scanner-listFiles.test.ts`, `scannerRequirements.test.ts`, `ignore-mgr.test.ts`, `hasher.test.ts`, `fileProcessingStartup.test.ts`, `runFileProcessingLlm.test.ts`, `scanProgressCache.test.ts`, `defaultStreamProcessor.test.ts`.
- `docs/design/storage.md` — owning document for the `{projectKey}_knowledge_base` and `{projectKey}_FileProcessor` Mongo collections this pipeline reads from (and is designed, but not yet implemented, to write to).
