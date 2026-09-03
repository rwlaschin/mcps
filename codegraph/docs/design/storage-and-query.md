---
modified: 2026-08-31
dependencies:
  - parsing-and-resolution.md
  - mcp-and-cli.md
  - visualizer.md
---

# Storage and Query

This subsystem is CodeGraph's persistence and read path: the on-disk generation store (`store.mjs`), the memory-mapped binary query view (`mmap-query-cache.mjs` plus the macOS-only N-API `mmap` bridge in `native/`), the query engine that reads that view (`daemon-query-engine.mjs`), and the Unix-socket daemon and client that serve queries to other processes (`query-daemon.mjs`, `query-client.mjs`, `query-target.mjs`).

**Who needs to read this:** anyone changing what a symbol or edge record carries, anyone adding a query type or a field to the daemon wire messages, and anyone debugging a stale/absent query result or a daemon that will not start.

**When to consult it:** before touching the binary layout or the socket protocol (both are unversioned or hard-coded in ways detailed under Sensitive Areas), and when tracing where a query result came from — the mapped page or the fallback engine.

Parsing/resolution produces the graph this subsystem stores ([parsing-and-resolution.md](parsing-and-resolution.md)); the MCP server and CLI are its main callers ([mcp-and-cli.md](mcp-and-cli.md)); the visualizer reads through the same daemon client ([visualizer.md](visualizer.md)).

## Sensitive Areas

- **The binary page layout is fixed-width and its header offsets are hard-coded in the reader.** `SYMBOL_BYTES = 40` and `EDGE_BYTES = 16` (`mmap-query-cache.mjs:11-12`) are compile-time constants written into the page header (`:62-63`) and used as multipliers by both writer (`:72`, `:80`) and reader (`:119`, `:129`). The reader also reads header fields by literal offset with no symbolic constant: generation string offset at 56 and coverage at 60 (`:105-106`, and again in `MmapQueryCache.acquire` at `:239`), edges base at 28 (`:129`), symbol count at 20 and edge count at 32 (`:144`, `:109`), and the name/file/incoming index offsets at 40/44/48 (`:138-141`, `:157-159`). Any change to the header field order silently mis-reads rather than failing loudly.
- **The header is CRC-protected, so layout changes must be coherent.** `#writeHeader` stores `crc32` of bytes `0..252` at `HEADER_CHECKSUM_OFFSET = 252` (`:16`, `:277`), and `#readHeader` rejects the whole file if magic, `VERSION`, capacity, root fingerprint, the CRC, `HEADER_BYTES`/`SCRATCH_BYTES` echo, or the page-offset expectations do not match (`:264-269`). A partial layout edit does not corrupt data — it makes the cache appear absent, and every query silently degrades to the fallback engine.
- **The daemon wire protocol has no version field, no handshake, and no capability negotiation.** A request is a bare `{op, id, query, maxQueue}` object (`query-daemon.mjs:299`) and validation accepts only that shape (`:143-149`). A newer client talking to an older running daemon has no way to detect the mismatch; the daemon answers with `{error: 'invalid request', done: true}` at best, or misinterprets an unknown field as absent at worst. The daemon is also long-lived and detached (`:34-37`), so a stale binary can keep serving after the source is upgraded.
- **The query vocabulary is closed.** `#queryMapped` handles exactly `symbols`, `refs`, `deps`, `graph` and otherwise throws `unknown query type: ${request.type}` (`daemon-query-engine.mjs:108-112`). New query types are not additive at the read layer — they need a branch here (or they fall through to the exception, which reaches the client as `{id, error, done}`).
- **The socket path is derived, not registered.** `daemonSocketPath` hashes the resolved root (`query-daemon.mjs:16-20`); two clients that disagree about the root's canonical form (symlink, different casing) get different sockets and each spawns its own daemon. `QueryDaemon.start()` probes an existing socket file and deletes it if nothing answers (`:104-112`) — a live daemon whose socket file was removed out from under it is unreachable and undetectable.
- **The publish path writes through a scratch region and can leave a lease-blocked page.** `publish` copies the payload in `SCRATCH_BYTES` chunks via the scratch area before landing it at the target page (`:217-220`) and refuses to write a page that has outstanding leases (`:213`), returning `false`. A reader that never calls `release()` permanently pins one of the two pages.
- **The native bridge is macOS-only and optional.** `binding.gyp` sets `"type": "none"` for `OS!='mac'`, and `native/mmap-adapter.mjs:7` swallows the `require` failure so `nativeMmapAdapter` is `null`. Every `mmap` benefit disappears silently on any other platform or any failed build; correctness is preserved only because the fallback path exists.
- **`package.json` declares `"main": "query-client.mjs"` with no `"exports"` map, and there is no workspace manifest at the monorepo root** (`/Users/mac/Documents/Projects/mcps/` contains no `package.json`). Every other module in this subsystem is reachable only by deep relative path, and nothing at the repo root hoists or links the package.

## Design Constraints

- **A new `kind` value is free; a new per-record field is not.** `kind` is written as an interned string offset (`mmap-query-cache.mjs:74`, read at `:122`), so any new symbol kind costs nothing but string bytes. Adding any NEW PER-RECORD FIELD requires widening `SYMBOL_BYTES` or `EDGE_BYTES`, bumping `VERSION` (`:6`), and changing the CRC'd header layout that carries the record widths and the chained section offsets — the symbol record is fully packed at 40 bytes (fields at 0,4,8,12,16,20,24,28,32 with `exported` last, `:73-77`) and the edge record is fully packed at 16 bytes (from, to, line, call at 0,4,8,12 — `:81-82`) with **no spare field** in either.
- **Version gating is exact-match, not range.** Both `#readHeader` (`:264`) and `acquire` (`:237`) compare against `VERSION` with `!==`; there is no forward or backward compatibility window. `VERSION` is currently `2`.
- **Capacity is fixed at open time.** `MmapQueryCache` defaults to `capacityBytes = 1024 * 1024 * 1024` (`:192`), clamps to a 1024-byte minimum, stores the capacity in the header, and rejects a header whose capacity field disagrees (`:264`). Page A starts at `floor(capacity/2) + 2048` and page B occupies the space between the scratch region and page A (`:252-255`); a payload larger than its target page's capacity is refused (`:215`).
- **A page is only served if generation AND coverage match exactly.** `acquire({generation, coverage})` compares both interned strings and skips the page otherwise (`:239`). The one relaxation is in the engine: a `symbols` request that misses on `calls` coverage retries with `complete` (`daemon-query-engine.mjs:50`).
- **Transport is local-only.** A Unix domain socket under `os.tmpdir()` (`query-daemon.mjs:19`) — no TCP, no port, no bind address, no authentication beyond filesystem permissions on the socket.
- **Messages are newline-delimited JSON, one message per line, in both directions** (`readline` with `crlfDelay: Infinity`, `:137`, `:227`; every write is `${JSON.stringify(...)}\n`). A row containing a literal newline is impossible because `JSON.stringify` escapes it, but the framing gives no length prefix and no way to resynchronize mid-message.
- **The store's directory contract is `<root>/.codegraph`** with `partitions/`, `generations/`, `sources/`, `overlays/`, and a `CURRENT` pointer file (`store.mjs:11-17`, `:58`). `DaemonQueryEngine` reads `CURRENT` directly rather than through `GraphStore` (`daemon-query-engine.mjs:86`).
- **Every store write is atomic-by-rename** (`store.mjs:75-78`): write `<target>.<pid>.<random>.tmp`, then `rename`. Content-addressed writes are skipped entirely if the target already exists (`:29`, `:38`).
- **Node `>=18`** per `package.json` `engines`; the code uses `import.meta.dirname` (`query-daemon.mjs:34`), private class fields, and `crypto.randomUUID`.

## Feature Overview

Queries against a code graph are read-dominated and latency-sensitive: an MCP tool call or a visualizer frame wants symbol/edge lookups in milliseconds, repeatedly, over a graph that only changes when the indexer republishes. Re-parsing JSON partitions per query, or paying process startup per query, both lose.

Three mechanisms address that, and all three are present:

1. **A content-addressed, generation-stamped store** (`store.mjs`). Partitions and sources are keyed by SHA-256 of their bytes, so re-indexing an unchanged file is a no-op `existsSync` check. A generation is a published manifest with an id of `<base36 time>-<12 hex of manifest digest>-<12 hex random>` (`:55`), and `CURRENT` names the newest one. Nothing is ever mutated in place; readers see either the old file or the new one.
2. **A memory-mapped binary query view** (`mmap-query-cache.mjs` + `native/mmap_bridge.c`). The graph is encoded once into a fixed-width, string-interned page with five precomputed sorted indexes, written into one of two pages inside a single mapped file. A reader decodes only the records a query touches — `symbol()` and `edge()` are per-index accessors (`:117`, `:127`), and `graph` (`:180`) is the only path that materializes everything. Publishing is double-buffered with per-page CRC and a serial counter, so a reader either sees a fully-valid page or falls back.
3. **A per-root query daemon** (`query-daemon.mjs`). Clients pay one Unix-socket connect instead of a Node startup plus a graph load. The daemon keeps a `DaemonQueryEngine` alive, which keeps the mapping alive.

The fallback is what makes the fast path safe to be strict. `DaemonQueryEngine.#pinFallback` (`daemon-query-engine.mjs:95-103`) lazily constructs the full `CodeGraphEngine` and answers from it whenever the mapped page is unavailable, stale, wrong-coverage, or the caller asked for `consistency: 'latest'`. Because every failure in the mmap path returns `null`/`false` rather than throwing (`:206`, `:227`, `:248`, and the `try {} catch {}` around `acquire` at `:49-51`), a broken or absent cache costs speed, never correctness.

Validated incremental publication reuses the pinned generation's unchanged partition ids. The main thread independently computes the required reverse dependency closure, accepts a delta only when its partition keys match that closure exactly, verifies every returned partition and source blob against the pinned base, then publishes a complete manifest assembled from the sparse replacements plus unchanged ids. Any stale base, malformed result, failed write, or failed publication invalidates worker hydration so the next attempt rehydrates instead of trusting partial state.

## Architecture

```
indexer/resolver  ──►  GraphStore (store.mjs)
   (see parsing-and-resolution.md)   .codegraph/{partitions,sources,overlays,generations,CURRENT}
                                                │
                                                ▼
                              MmapQueryCache.publish()  ──►  .codegraph/query-view-cache.bin
                                                                (256B header | 4KB scratch | page B | page A)
                                                                        │ acquire()
QueryDaemonClient ──unix socket──►  QueryDaemon  ──►  DaemonQueryEngine ─┤
  (query-client.mjs)   NDJSON       (per-root)         (#queryMapped)    └─► CodeGraphEngine  (fallback)
```

Components:

- **`GraphStore`** — filesystem layer only. No caching, no in-memory state beyond four path strings. Optionally reports timings to an injected profiler on the partition write path (`store.mjs:23-30`).
- **`encodePage` / `MappedQueryView` / `MmapQueryCache`** — writer, reader, and file/page manager. `MmapQueryCache` owns the native handle and mapping, the two-page header, and the per-page lease counters (`this.leases = [0, 0]`, `:194`).
- **`nativeMmapAdapter`** (`native/mmap-adapter.mjs`) — thin wrapper over the compiled binding, or `null`. It creates the parent directory before `open` and otherwise forwards `open/resize/map/flush/unmap/close/pageSize` verbatim.
- **`mmap_bridge.c`** — N-API module `codegraph_mmap`. `open` does `open(O_RDWR|O_CREAT, 0600)` plus `ftruncate` up to capacity if the file is short; `map` does `mmap(PROT_READ|PROT_WRITE, MAP_SHARED)` over the whole file and returns a `Uint8Array` over an external `ArrayBuffer`, stashing the mapping state on the typed array as a non-enumerable-by-convention `__mmapState` external; `flush` page-aligns the requested range down/up and calls `msync(MS_SYNC)`; `unmap` `munmap`s then `napi_detach_arraybuffer`. Finalizers on both the handle and the mapping close/unmap if JS drops them first.
- **`DaemonQueryEngine`** — the routing brain. Decides mapped-vs-fallback, holds leases in a `Set` so `dispose()` can release them, and exposes `pinQuery`, `queryBatch`, and an async-generator `query`.
- **`QueryDaemon`** — `net.createServer` over the derived socket path; tracks live sockets and in-flight requests keyed `<socketUUID>:<requestId>` so a `cancel` op or a socket close aborts exactly the right `AbortController`s (`:135`, `:151`).
- **`QueryDaemonClient` / `connectQueryDaemon` / `streamQuery`** — client side. `streamQuery` (`query-client.mjs`) is the package's `main` export: connect, stream, close.
- **`qualifiedQuery`** (`query-target.mjs`) — the only query-parsing helper: turns `file:name`, a bare filename, or a bare name into `{file, name}` / `{file}` / `{name}`, recognizing `.js/.jsx/.ts/.tsx/.cjs/.mjs/.cts/.mts` via `/\.[cm]?[jt]sx?$/`.

Process topology: one daemon per canonical root, spawned detached and `unref`'d by `defaultStartDaemon` running `tool.mjs daemon --root <root>` (`query-daemon.mjs:33-43`). Concurrent spawn attempts within one process are deduplicated by `startupBySocket`, a socket-path-keyed promise map (`:10`, `:64-76`). Startup waits up to `STARTUP_TIMEOUT_MS = 15000` with backoff from 10ms toward 50ms plus jitter (`:11-14`, `:49-62`); each individual connect attempt times out at `CONNECT_TIMEOUT_MS = 500` (`:25`).

## Functions

**`store.mjs` — `GraphStore`**

- `constructor(root, cacheDir = '.codegraph')` — derives the four subdirectory paths. Touches no disk.
- `initialize()` — `mkdirSync(recursive)` for all four subdirectories. Called defensively at the top of most write/read methods.
- `writePartition(partition, profiler = null)` — stringifies, SHA-256s the serialized bytes for the id, writes `partitions/<id>.json` only if missing, returns the id. Emits `partition-hash` and `partition-write` profiler spans, the latter carrying `cacheWrite: 0|1`.
- `readPartition(id)` — `JSON.parse` of `partitions/<id>.json`.
- `writeSource(source)` / `readSource(id)` — same content-addressed pattern under `sources/`, no `.json` extension.
- `readOverlay(generation)` — returns the parsed overlay, or `null` on `ENOENT`, rethrowing every other error.
- `writeOverlay(generation, overlay)` — throws `overlay generation mismatch` unless `overlay.generation === generation`, then atomically writes `overlays/<generation>.json`.
- `publish(manifest)` — mints the generation id, stamps `createdAt`, atomically writes `generations/<generation>.json`, then atomically overwrites `CURRENT`. Returns the completed manifest.
- `readGeneration(generation)` — with an explicit id, reads that file. With none, reads `CURRENT`; if that is missing or points at a nonexistent file, scans `generations/`, sorts by mtime then name, takes the newest, repairs `CURRENT`, and uses it. Throws `no codegraph generation; run build` when the directory is empty.
- `#atomicWrite(target, contents)` — temp-write plus `rename`.

**`mmap-query-cache.mjs`**

- `encodePage({generation, coverage, view})` — the writer. Interns every string (generation, coverage, file paths, and per-symbol id/file/name/kind/qualifiedPath/signature, plus edge endpoint ids) into a deduplicated NUL-terminated region starting at `STRING_PREFIX_BYTES = 64`; computes the chained section offsets; writes the 64-byte page header; writes the symbol and edge records; builds the five sorted indexes; writes the 16-byte footer (`FOOTER_MAGIC`, id-index offset, symbol count). Returns the finished `Uint8Array`.
- `MappedQueryView.string(offset)` — reads a NUL-terminated UTF-8 string, bounded by the string region's end, with a `fatal: true` decoder.
- `MappedQueryView.symbol(index)` / `.edge(index)` — decode one fixed-width record. Both notify the optional `decodeObserver`. `edge()` resolves its two `u32` symbol indexes back into full symbols just to take their `id`s.
- `MappedQueryView.matchingSymbols(request = {})` — the `symbols` query. With `request.id`, binary-searches the id index and post-filters on name/file. Otherwise intersects the name-index and file-index candidate sets (falling back to all symbol indexes when neither is given) and re-checks every predicate on the decoded symbol. File matching is exact-or-suffix (`symbol.file.endsWith(request.file)`).
- `MappedQueryView.relationships(request, direction)` — resolves the request to symbol indexes via the id index, then numeric-binary-searches the incoming (offset 48) or outgoing (offset 52) edge index for each, returning decoded edges.
- `MappedQueryView.#stringIndex(start, end, key)` / `#numericIndex(start, end, key)` — lower-bound binary search over 16-byte `(key, payload)` entries, then a forward scan collecting every equal key. Duplicate keys are expected and returned as a list.
- `MappedQueryView.#footerOffset()` / `#idIndexOffset()` / `#lookupId(id)` — footer-derived id-index location, degrading to "id index absent" (id index = footer offset, an empty range) when the footer magic is wrong.
- `MappedQueryView.graph` (getter) — materializes `{generation, edgeCoverage, files, symbols, edges}`, i.e. decodes every record.
- `MmapQueryCache.constructor({filePath, root, adapter, capacityBytes, decodeObserver})` — fingerprints the root (first 4 LE bytes of its SHA-256), opens and maps the file, resizes and remaps once if the mapping came back shorter than capacity, and on any failure releases the native resources and leaves `this.mapping === null` (permanently degraded, never throwing).
- `MmapQueryCache.publish({generation, coverage, view}, {signal})` — reads (or synthesizes) the header, picks the non-active page (page 0 on a virgin file), refuses if that page is leased, encodes, refuses if the payload overflows the page, saves the prior header bytes, copies the payload through scratch, `msync`s the page, updates `length`/`checksum`/`serial` and flips `active`, writes and `msync`s the header, and on a header-flush failure restores the prior header. Returns `true` only on a complete success; every other outcome, including any thrown error, is `false`.
- `MmapQueryCache.acquire({generation, coverage})` — tries the active page then the other one; skips a page with zero/overflowing length, a CRC mismatch, wrong page magic, wrong `VERSION`, or a generation/coverage mismatch. On success increments that page's lease, and returns `{value, release}` where `value` exposes a lazy `graph` getter and a non-enumerable `mappedView`. `release` is idempotent.
- `MmapQueryCache.dispose()` — one-shot; unmaps and closes.
- `MmapQueryCache.#pageChecksum(descriptor)` — CRC over the page bytes, extended 2048 bytes backwards for the upper page so the guard gap is covered.
- `MmapQueryCache.#emptyHeader()` / `#readHeader()` / `#writeHeader(header)` — described under Design Constraints and Models.

**`daemon-query-engine.mjs` — `DaemonQueryEngine`**

- `constructor(root, options)` — builds the `MmapQueryCache` over `<root>/.codegraph/query-view-cache.bin` with the native adapter, unless `options.cacheFactory` overrides it. `engineFactory` and `disposeFallback` are injectable.
- `pinQuery(request, options)` — the core. Short-circuits on an aborted signal, throws if disposed, routes `consistency: 'latest'` straight to the fallback, resolves the generation from `request.generation` or `CURRENT`, derives coverage (`complete`-defaulted for `refs`/`graph`, `calls` otherwise), acquires a lease with the `symbols`-on-`complete` retry, runs `#queryMapped`, and releases the lease in `finally`. Returns `{metadata, graph, rows}` with `metadata.freshness = 'validated'`.
- `queryBatch(request, options)` — `pinQuery` then, if rows are not already an array, drains the iterable, returning `[]` if aborted mid-drain.
- `query(request, options)` — async generator over `queryBatch`, stopping on abort.
- `dispose()` — releases all held leases, disposes the cache, and (unless `disposeFallback` is false) awaits and disposes the fallback engine.
- `#currentGeneration()` — reads and trims `CURRENT`, returning `null` on any error.
- `#fallback()` — memoizes the `engineFactory()` promise.
- `#pinFallback(request, options)` — for `graph` + `complete` calls `engine.snapshotComplete`; otherwise prefers the fallback's own `pinQuery`, else wraps its `queryBatch`.
- `#queryMapped(view, request, signal)` — dispatches the four query types, applies `request.limit` clamped into `[0, rows.length]`, and for `refs`/`deps` with `resolved === true` attaches `fromSymbol`/`toSymbol` endpoint projections (`{id, name, file, line, kind}`), dropping rows whose endpoints cannot be resolved. `refs` rows are sorted by line then `from` id.

**`query-daemon.mjs`**

- `daemonSocketPath(root)` — `path.join(os.tmpdir(), 'codegraph-' + sha256(path.resolve(root)).hex.slice(0,24) + '.sock')`.
- `connectSocket(socketPath)` — one connect attempt with a 500ms destroy-on-timeout.
- `defaultStartDaemon(root)` — detached, `stdio: 'ignore'`, `unref`'d spawn of `node tool.mjs daemon --root <root>`; resolves after 20ms or rejects on a spawn error.
- `waitForDaemon` / `startOnce` / `connectAfterStart` — the retry, spawn-deduplication, and connect-then-start-then-connect sequence described under Architecture. All failures surface as `CodeGraph daemon failed to become ready for <root>` with the original error as `cause`.
- `QueryDaemon.start()` — creates the socket's parent directory, probes and unlinks a stale socket file (throwing `an active CodeGraph daemon already owns <path>` if something answers), builds the engine (`options.engineFactory` or a fresh `DaemonQueryEngine`), listens, awaits `'listening'`, and sets `ownsSocket`. On any failure it closes the server and disposes the engine before rethrowing.
- `QueryDaemon.#accept(socket)` — tags the socket with a UUID, registers it, wires close-time abort of its in-flight requests, and parses NDJSON lines. Blank lines are ignored. Unparseable JSON gets `{error: 'invalid JSON', done: true}`. A non-object message, an unsupported `op`, or a non-object `query` on a non-`cancel` op gets `{id, error: 'invalid request', done: true}`. `cancel` aborts the matching controller and replies nothing.
- `QueryDaemon.#run(socket, request)` — registers an `AbortController`, then either awaits `engine.queryBatch` (falling back to draining `engine.query` when the engine has no batch method) and writes one `{id, rows, done, cancelled}`, or streams `{id, row}` per row honoring backpressure via `await once(socket, 'drain')` and terminates with `{id, done, cancelled}`. Any thrown error becomes `{id, error, done: true}`. The active-request entry is always removed in `finally`.
- `QueryDaemon.close()` — idempotent via a memoized `closing` promise; aborts all in-flight requests, closes the server, unlinks the socket if owned, destroys client sockets, and disposes the engine.
- `QueryDaemonClient.connect()` — throws if closed, returns `this` if already connected, otherwise memoizes a single `connectSocket` attempt to the **existing** socket. It does not itself spawn a daemon.
- `QueryDaemonClient._attach(socket)` — installs the NDJSON reader that routes replies to `this.pending` by `id` (accumulating `row`, replacing on `rows`, resolving or rejecting on `done`), and a close handler that fails every pending request bound to that socket.
- `QueryDaemonClient.queryBatch(query, options)` — up to two attempts. Connects via `connectAfterStart` when there is no live socket, sends one `queryBatch`, and on a `connection|EPIPE|ECONN` error with a `startDaemon` available reconnects and retries once. An aborted signal yields `[]`.
- `QueryDaemonClient.#queryBatchOnce(query, options)` — allocates a monotonic `id`, registers the pending record, wires `options.signal` to send `{op: 'cancel', id}`, and writes the request line.
- `QueryDaemonClient.query(query, options)` — async generator over `queryBatch`; the client-side streaming API is batch-backed.
- `QueryDaemonClient.close()` — marks closed, closes the line reader, destroys the socket.
- `connectQueryDaemon(root, options)` — defaults `startDaemon` to `defaultStartDaemon`, tries `client.connect()`, and on failure falls back to `connectAfterStart` (spawn-then-connect) and attaches the result. This wrapper, not `connect()`, is where the spawn fallback lives.
- `streamQuery(root, query, options)` (`query-client.mjs`) — `connectQueryDaemon`, delegate to `client.query`, `close()` in `finally`.
- `qualifiedQuery(raw)` (`query-target.mjs`) — described under Architecture.

**`native/build-optional.mjs`** — the `install` script. On `darwin` only, locates npm's bundled `node-gyp` (`npm_config_node_gyp`, else the well-known `/usr/local/lib/node_modules/...` path) and runs `rebuild`, writing a warning to stderr and exiting successfully if it is missing or fails. Install never fails because of the native bridge.

## Models

**Generation manifest** (`store.mjs:56`) — the caller's manifest object plus `generation: string` and `createdAt: ISO string`, stored as `generations/<generation>.json`. `generation` format: `${Date.now().toString(36)}-${sha256(JSON.stringify(manifest)).hex.slice(0,12)}-${randomBytes(6).hex}`. `CURRENT` is a plain text file holding one generation id.

**Overlay** (`store.mjs:48-53`) — an arbitrary object required to carry `generation` matching its filename, stored as `overlays/<generation>.json`.

**Cache file layout** (capacity `C`, default 1 GiB):

| Region | Offset | Size |
| --- | --- | --- |
| File header | `0` | `HEADER_BYTES = 256` |
| Scratch | `256` | `SCRATCH_BYTES = 4096` |
| Page 1 (page B) | `4352` | `floor(C/2) + 2048 - 4352` |
| Page 0 (page A) | `floor(C/2) + 2048` | `C - (floor(C/2) + 2048)` |

**File header** (all little-endian `u32`, `mmap-query-cache.mjs:274-277`):

| Offset | Field |
| --- | --- |
| 0 | `FILE_MAGIC = 0x43474d4d` |
| 4 | `VERSION` (2) |
| 8 | capacity |
| 12 | root fingerprint — first 4 LE bytes of `sha256(root)` |
| 16 | active page index (0 or 1) |
| 20 | global serial |
| 24 | `HEADER_BYTES` echo |
| 28 | `SCRATCH_BYTES` echo |
| 32 + 16*i | page `i`: offset, length, checksum, serial |
| 252 | `crc32(header[0..252])` |

Page capacity is *not* stored — it is recomputed from `#emptyHeader()` and the stored offset is required to match it exactly (`:269`).

**Page header** (64 bytes, `:60-66`):

| Offset | Field |
| --- | --- |
| 0 | `PAGE_MAGIC = 0x43515047` |
| 4 | `VERSION` |
| 8 | string region base (`PAGE_HEADER_BYTES = 64`) |
| 12 | string region byte length |
| 16 / 20 / 24 | symbols offset / count / record width (40) |
| 28 / 32 / 36 | edges offset / count / record width (16) |
| 40 / 44 | name index offset / file index offset |
| 48 / 52 | incoming edge index offset / outgoing edge index offset |
| 56 / 60 | generation string offset / coverage string offset |

**String region** — starts at page offset 64, with the first `STRING_PREFIX_BYTES = 64` reserved (interning begins at 64), each entry NUL-terminated, fully deduplicated by value.

**Symbol record — exactly 40 bytes** (`:73-77` write, `:120-125` read):

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | `id` (string offset) |
| 4 | u32 | `file` (string offset) |
| 8 | u32 | `name` (string offset) |
| 12 | u32 | `kind` (string offset) |
| 16 | i32 | `line` |
| 20 | u32 | `qualifiedPath` (string offset, `''` when absent) |
| 24 | u32 | `signature` (string offset, `''` when absent) |
| 28 | i32 | `ordinal` (0 when absent) |
| 32 | u32 | `exported` (0/1, decoded as `Boolean`) |
| 36 | — | end of record at 40; bytes 36–39 are not written or read |

**Edge record — exactly 16 bytes, fully occupied** (`:80-82` write, `:130` read):

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | `from` — symbol **index**, `0xffffffff` if unresolvable |
| 4 | u32 | `to` — symbol **index**, `0xffffffff` if unresolvable |
| 8 | i32 | `line` |
| 12 | u32 | `call` (0/1, decoded as `Boolean`) |

Decoded edges expose `from`/`to` as symbol **id strings**, not indexes — `edge()` decodes each endpoint symbol to read its id.

**Index entries — 16 bytes each** (`INDEX_BYTES = 16`), written as a `u32` key at +0 and a `u32` payload at +4; bytes 8–15 are unwritten padding. Five indexes, in file order, with offsets chained by arithmetic from the end of the previous section (`:51-56`):

| Index | Key | Payload | Entry count |
| --- | --- | --- | --- |
| name | `name` string offset | symbol index | `symbols.length` |
| file | `file` string offset | symbol index | `symbols.length` |
| incoming | `to` symbol index | edge index | `edges.length` |
| outgoing | `from` symbol index | edge index | `edges.length` |
| id | `id` string offset | symbol index | `symbols.length` |

Sort order: string-keyed indexes by `key.localeCompare` with the original array index as tiebreak; numeric-keyed indexes by key then index. Total index bytes are therefore `3 * symbols.length * 16 + 2 * edges.length * 16`.

**Page footer — 16 bytes** (`:91`): `FOOTER_MAGIC = 0x58444951` at +0, id-index offset at +4, symbol count at +8; bytes 12–15 unwritten. The footer exists because the page header (fixed at 64 bytes with fields through offset 60) has no room left for the id-index offset; `#idIndexOffset()` treats a wrong magic as "no id index".

**Generation and atomicity model.** Two independent atomicity layers:

- *Store level:* every file is written to a pid-and-random-suffixed temp path and `rename`d over the target, so a reader of `CURRENT` or of a generation file never sees a torn write. Publishing writes the generation file **before** `CURRENT`, so `CURRENT` never names a file that does not exist; the reverse ordering is what `readGeneration`'s repair path (`store.mjs:65-71`) exists to handle for pre-existing damage.
- *Cache level:* a strict double-buffer. `publish` only ever writes the non-active page, guarded by that page's lease count. The page's CRC (`#pageChecksum`, covering the page bytes plus a 2048-byte backwards guard for the upper page) and its `length` are committed in the same header write that flips `active`, and that header write is itself CRC-covered and rolled back to the prior header bytes if its `msync` fails. Readers therefore see either the previous page or the new one, never a mixture — `acquire` verifies CRC, magic, `VERSION`, generation, and coverage before handing out a lease, and tries the inactive page as a second chance.
- *Freshness:* identity, not recency. A page is valid only for the exact `(generation, coverage)` pair it was written with, so an out-of-date page can never be mistaken for a current one. `consistency: 'latest'` bypasses the cache entirely.

**Wire messages** (newline-delimited JSON):

- Request: `{op: 'query' | 'queryBatch' | 'cancel', id, query, maxQueue}`. `id` is a client-monotonic integer. `query` is the `DaemonQueryEngine` request object and must be a non-array object for `query`/`queryBatch`. `maxQueue` is passed through into engine options untouched. **There is no version field, no handshake, and no capability negotiation.**
- Replies: `{id, row}` (one streamed row), `{id, rows, done: true, cancelled}` (batch result), `{id, done: true, cancelled}` (end of stream), `{id, error, done: true}` (failure), and `{error: 'invalid JSON', done: true}` (no `id`, malformed line).

**Query request** (as consumed by `DaemonQueryEngine`): `type` ∈ `symbols | refs | deps | graph`; optional `id`, `name`, `file` selectors; `limit`; `resolved` (boolean); `generation`; `edgeCoverage`; `consistency: 'latest'`.

**`pinQuery` result:** `{metadata: {revision, freshness, coverage, validatedGeneration}, graph, rows}`. On the mapped path `revision` is always `null` and `freshness` always `'validated'`.

**Graph shape** (`MappedQueryView.graph`): `{generation, edgeCoverage, files: string[], symbols: Symbol[], edges: Edge[]}`, where `files` is the deduplicated sorted set of symbol file paths.

## Use Cases

### UC-1 — Answer a symbol query from the memory-mapped view

**Goal.** A caller resolves a symbol lookup against the current generation without loading or parsing the graph.

**Stakeholders.** The agent or developer waiting on the answer; whoever owns query latency.

**Actors.** An MCP tool or CLI invocation acting through `streamQuery`/`QueryDaemonClient`; the `QueryDaemon`; the `DaemonQueryEngine`; the `MmapQueryCache`.

**Preconditions.** `<root>/.codegraph/CURRENT` exists and names a generation. `query-view-cache.bin` holds a page for that generation with matching coverage, whose CRC and `VERSION` validate. The native mmap adapter loaded. A daemon for the canonical root is running, or can be started.

**Basic Course of Events.**
1. The caller calls `streamQuery(root, {type: 'symbols', name})`, which calls `connectQueryDaemon(root)`.
2. `QueryDaemonClient.connect()` connects to `daemonSocketPath(root)`.
3. `client.query` delegates to `queryBatch`, which writes one line: `{op: 'queryBatch', id, query, maxQueue}`.
4. `QueryDaemon.#accept`'s line handler parses the JSON, confirms `op` is supported and `query` is a plain object, and dispatches `#run`.
5. `#run` registers an `AbortController` under `<socketUUID>:<id>` and awaits `engine.queryBatch`.
6. `DaemonQueryEngine.pinQuery` reads `CURRENT`, derives coverage `calls` for a `symbols` request, and calls `cache.acquire({generation, coverage})`.
7. `acquire` validates the active page's length, CRC, page magic, `VERSION`, generation, and coverage; increments its lease; returns `{value, release}`.
8. `#queryMapped` calls `view.matchingSymbols(request)`, which binary-searches the name index (offset 40) and decodes only the matching 40-byte symbol records.
9. The row limit is applied and the rows are returned; `pinQuery` releases the lease in its `finally`.
10. `#run` writes `{id, rows, done: true, cancelled: false}`.
11. The client's line handler calls `pending.setRows` then `pending.finish`, resolving `queryBatch`; `query` yields each row.
12. `streamQuery`'s `finally` closes the client.

**Alternate Flows.**
- *No live daemon.* `client.connect()` rejects; `connectQueryDaemon` catches and calls `connectAfterStart`, which spawns a detached daemon (deduplicated per socket path), polls until it accepts a connection, then connects. The postcondition is unchanged.
- *Coverage miss on a `symbols` query.* `acquire` on `calls` returns `null`; `pinQuery` immediately retries with coverage `complete` (`daemon-query-engine.mjs:50`) and proceeds from step 8.
- *Id-selected query.* With `request.id`, `matchingSymbols` uses the footer-located id index instead of the name/file indexes and post-filters on name/file.
- *Streaming op.* A caller sending `op: 'query'` gets one `{id, row}` line per row plus a terminal `{id, done}`, with backpressure handled by `await once(socket, 'drain')`.

**Exceptions.**
- *`CURRENT` missing or unreadable.* `#currentGeneration()` returns `null`; `pinQuery` routes to `#pinFallback` (see UC-2).
- *Page invalid, absent, or leased-out generation mismatch.* `acquire` returns `null` (or throws and is swallowed by the `try {}` at `:49-51`); `#pinFallback` answers instead.
- *Unknown `type`.* `#queryMapped` throws `unknown query type: <type>`; `#run` catches it and writes `{id, error, done: true}`; the client rejects `queryBatch` with that message.
- *Malformed request line.* Unparseable JSON gets `{error: 'invalid JSON', done: true}`; a wrong-shaped object gets `{id, error: 'invalid request', done: true}`.
- *Connection dies mid-request.* The daemon's socket-close handler aborts the request's controller; the client's close handler fails every pending record bound to that socket with `CodeGraph daemon connection closed`. `queryBatch` retries once when `startDaemon` is available and the message matches `/connection|EPIPE|ECONN/`.
- *Caller aborts.* The client writes `{op: 'cancel', id}`; the daemon aborts the matching controller; `#queryMapped`/`queryBatch` return `[]` at their next signal check.

**Postconditions.** The caller holds the matching rows. No lease is outstanding. The cache file is unmodified.

### UC-2 — Answer a query when the mapped view cannot serve it

**Goal.** A caller gets a correct answer even though the memory-mapped fast path is unavailable, stale, or deliberately bypassed.

**Stakeholders.** Anyone depending on query correctness across an index rebuild, a non-macOS host, or a failed native build.

**Actors.** The `DaemonQueryEngine`; the lazily-constructed `CodeGraphEngine` fallback.

**Preconditions.** A `DaemonQueryEngine` exists and is not disposed. `options.engineFactory` (default: `import('./tool-engine.mjs')`) can produce a working engine.

**Basic Course of Events.**
1. `pinQuery` is entered with a request whose `consistency` is `'latest'`, or whose generation cannot be resolved, or for which `cache.acquire` yields no lease.
2. `pinQuery` calls `#pinFallback(request, options)`.
3. `#fallback()` memoizes `engineFactory()` so the heavyweight engine is built at most once per `DaemonQueryEngine`.
4. For `type: 'graph'` with `edgeCoverage: 'complete'`, `engine.snapshotComplete(request.generation, options)` produces the graph, and the result is shaped as `{metadata: {revision: null, freshness: 'validated', coverage, validatedGeneration}, graph, rows: [graph]}`.
5. Otherwise, if the fallback exposes `pinQuery`, its result is returned verbatim.
6. Otherwise `engine.queryBatch(request, options)` is wrapped as `{metadata: {}, graph: null, rows}`.
7. The rows travel back out through `queryBatch`/`query` and the daemon exactly as in UC-1.

**Alternate Flows.**
- *Native bridge absent.* `nativeMmapAdapter` is `null` (non-macOS, or the optional build failed), so `MmapQueryCache`'s constructor returns early with `mapping === null` and every `acquire` returns `null` — the fallback becomes the only path, permanently, with no error surfaced.
- *Cache file present but from another root or another `VERSION`.* `#readHeader` rejects on the root fingerprint or version check and `acquire` returns `null`; behaviour is identical to no cache at all.
- *Explicit freshness request.* `consistency: 'latest'` reaches `#pinFallback` at step 1 without any cache access.

**Exceptions.**
- *Engine disposed.* `pinQuery` throws `daemon query engine is disposed` before any work.
- *Signal already aborted.* `pinQuery` returns `{metadata: {}, graph: null, rows: []}` without touching the cache or the fallback.
- *`engineFactory` rejects.* The rejection propagates out of `pinQuery` to `#run`, which writes `{id, error, done: true}`. The memoized `this.fallback` retains the rejected promise, so subsequent fallback queries fail the same way until the engine is recreated; `dispose()` guards against it with `.catch(() => null)`.
- *No generation exists at all.* The fallback's own read path raises (`GraphStore.readGeneration` throws `no codegraph generation; run build`), which reaches the client as that error message.

**Postconditions.** The caller holds a correct answer. `this.fallback` is populated, so the mapped path stays available for later requests while the fallback engine remains resident until `dispose()`.

### UC-3 — Publish a new generation and its memory-mapped query page

**Goal.** The indexer makes a freshly built graph queryable without interrupting in-flight readers.

**Stakeholders.** Readers mid-query (must not see a torn or mixed page); the next reader (must get the new generation).

**Actors.** The indexer/resolver ([parsing-and-resolution.md](parsing-and-resolution.md)) as `GraphStore` caller; `GraphStore`; `MmapQueryCache`; the `mmap_bridge` native module.

**Preconditions.** `<root>/.codegraph` is writable. The graph view to encode is in hand. For the cache write, the mapping is live and `capacity >= HEADER_BYTES + SCRATCH_BYTES + 2`.

**Basic Course of Events.**
1. The caller writes each partition via `writePartition`, which content-addresses it and skips the write when `partitions/<id>.json` already exists.
2. The caller calls `store.publish(manifest)`.
3. `publish` mints `<base36 time>-<digest12>-<random12>`, stamps `createdAt`, and atomically writes `generations/<generation>.json`.
4. `publish` atomically overwrites `CURRENT` with the generation id and returns the completed manifest.
5. The caller calls `cache.publish({generation, coverage, view})`.
6. `#readHeader` validates the existing header, or `#emptyHeader()` supplies the virgin two-page geometry.
7. The target page is chosen: page 0 when `serial === 0`, otherwise `1 - active`.
8. If that page's lease count is above zero, `publish` returns `false` and the generation stays queryable only through the fallback.
9. `encodePage` builds the page bytes; if they exceed the target page's capacity, `publish` returns `false`.
10. The prior 256-byte header is copied aside.
11. The payload is copied into the page in `SCRATCH_BYTES` chunks, each chunk staged at the scratch offset and then copied to its final position.
12. `adapter.flush` `msync`s the page range (the bridge widens it to page boundaries).
13. The descriptor's `length`, `checksum` (`#pageChecksum`) and `serial` are set, the global serial is incremented, and `active` is flipped to the target.
14. `#writeHeader` writes the 256-byte header with its trailing CRC, and `adapter.flush` `msync`s it.
15. `publish` returns `true`. The next `acquire` for that `(generation, coverage)` succeeds.

**Alternate Flows.**
- *Virgin file.* `#readHeader` returns `null`, `#emptyHeader()` is used, page 0 is the target, and `serial` becomes 1.
- *Short mapping at open.* The constructor unmaps, `resize`s the file to capacity, and remaps once before any publish happens.
- *Both `refs`/`graph` and call-only coverage wanted.* Separate `publish` calls with different `coverage` strings occupy the two pages; `acquire` matches on coverage, and a `symbols` request accepts either via the `complete` retry.

**Exceptions.**
- *Target page leased.* Step 8 returns `false`; nothing is written. Retrying after the reader releases succeeds.
- *Payload too large for the page.* Step 9 returns `false`; the existing page remains valid and active.
- *Abort signal fires.* Checked before encoding (`:209`), after encoding (`:215`), and after the page flush (`:222`); an abort returns `false` before `active` is flipped, so the old page stays authoritative.
- *Header `msync` fails.* The saved prior header bytes are written back and re-flushed (best-effort), and `false` is returned — the page data may be new but the header still points at the old active page, so readers keep seeing the previous generation.
- *Any thrown error inside `publish`.* Caught and turned into `false` (`:227`); no exception escapes into the indexer.
- *`overlay.generation` mismatch on `writeOverlay`.* Throws `overlay generation mismatch` before writing.

**Postconditions.** `generations/<generation>.json` exists and `CURRENT` names it. On a `true` return, the cache header's active page holds the new generation with a valid CRC and an incremented serial, and the previously active page is intact as the other buffer.

### UC-4 — Bring up a query daemon for a repository root

**Goal.** Exactly one daemon serves queries for a given canonical root, and clients reach it.

**Stakeholders.** Every query caller (latency); the host (one daemon per root, not per query).

**Actors.** `connectQueryDaemon` / `QueryDaemonClient` as the initiator; `defaultStartDaemon`'s detached `node tool.mjs daemon --root <root>` child; `QueryDaemon` inside that child.

**Preconditions.** `os.tmpdir()` is writable. `tool.mjs` is present next to `query-daemon.mjs`. The root resolves to a stable canonical path.

**Basic Course of Events.**
1. The caller calls `connectQueryDaemon(root)`, which defaults `startDaemon` to `defaultStartDaemon`.
2. `QueryDaemonClient` resolves the root and derives the socket path from its SHA-256 prefix.
3. `client.connect()` attempts `connectSocket` against that path and fails because nothing is listening.
4. `connectQueryDaemon` catches and calls `connectAfterStart(root, startDaemon)`.
5. `connectAfterStart` retries a direct connect once, then calls `startOnce`, which registers a promise in `startupBySocket` so concurrent callers in this process share one spawn.
6. `defaultStartDaemon` spawns the detached, `stdio: 'ignore'`, `unref`'d child and resolves after 20ms.
7. In the child, `QueryDaemon.start()` creates the socket directory, finds no live owner (unlinking a stale socket file if present), constructs a `DaemonQueryEngine`, listens, and awaits `'listening'`.
8. `waitForDaemon` polls `connectSocket` with backoff plus jitter until it succeeds, destroys the probe socket, and clears the `startupBySocket` entry.
9. `connectAfterStart` connects for real; `client._attach(socket)` installs the NDJSON reply reader.
10. `connectQueryDaemon` returns the connected client, ready for UC-1.

**Alternate Flows.**
- *Daemon already running.* Step 3 succeeds and steps 4–9 never happen; `connect()` returns the client directly.
- *Externally started daemon.* Because `startDaemon` is injectable and nullable (`query-daemon.mjs:207`) and `connect()` only ever attempts a plain `connectSocket`, a process constructed with `startDaemon: null` connects to a daemon it did not spawn and never attempts to spawn one.
- *Stale socket file.* `QueryDaemon.start()` probes it, gets no answer, `fs.rmSync`es it, and listens on the same path.
- *Concurrent spawns in one process.* Both callers await the same `startupBySocket` promise; only one child is spawned.

**Exceptions.**
- *Another live daemon owns the socket.* `QueryDaemon.start()` throws `an active CodeGraph daemon already owns <path>`; the child exits and the original daemon keeps serving. The client's connect succeeds against that original.
- *Daemon never becomes ready within 15s.* `waitForDaemon` throws `CodeGraph daemon failed to become ready for <root>` with the last connect error as `cause`; `connectQueryDaemon` propagates it.
- *Spawn itself fails.* The child's `'error'` event rejects `defaultStartDaemon`, and `startOnce` wraps non-readiness errors in `readinessError`.
- *Engine construction fails inside `start()`.* The server is closed, the engine disposed, and the error rethrown; no socket is left listening, and `ownsSocket` stays false so the socket file is not unlinked spuriously.
- *Client closed before or during connect.* `connect()` throws `CodeGraph daemon client is closed`, and `_attach` destroys any socket handed to it after close.

**Postconditions.** One daemon listens on `codegraph-<hash24>.sock` in `os.tmpdir()` with `ownsSocket === true`, holding a live `DaemonQueryEngine`. The client has an attached socket and a reply reader. On `QueryDaemon.close()`, in-flight requests are aborted, client sockets destroyed, the socket file unlinked, and the engine disposed.

## Tests

Node's built-in test runner (`npm test` → `node --test`), tests under `codegraph/test/`. The end-to-end benchmark runs separately with `npm run performance`. Directly covering this subsystem:

- `test/mmap-query-cache.test.mjs` — page encode/decode, header and CRC validation, double-buffered publish, leases.
- `test/daemon-query-engine.test.mjs` — mapped-vs-fallback routing, coverage retry, query types, limits, `resolved` projection.
- `test/query-daemon.test.mjs` — socket path derivation, startup/deduplication, the NDJSON protocol, cancel, invalid requests.
- `test/query-client-import.test.mjs` — the `query-client.mjs` entry point imports cleanly.
- `test/boundaries.test.mjs` — cross-module boundary checks.

`GraphStore` (`store.mjs`) has no dedicated test file; it is exercised indirectly through `test/engine.test.mjs` and the daemon/engine tests. The native bridge has no C-level test suite — it is covered only through `mmap-query-cache.test.mjs` when a build is present, and its absence is the fallback path those tests also cover.

## UI/UX

No UI/UX required — this subsystem exposes no interface to a person. Its consumers are the MCP server, the CLI, and the visualizer; the visualizer's presentation is specified in [visualizer.md](visualizer.md).

## Dependencies

- [parsing-and-resolution.md](parsing-and-resolution.md) — produces the partitions, sources, overlays, and graph views this subsystem persists and encodes.
- [mcp-and-cli.md](mcp-and-cli.md) — the primary caller; `tool.mjs daemon` is the process `defaultStartDaemon` spawns, and `tool-engine.mjs`'s `CodeGraphEngine` is the fallback engine.
- [visualizer.md](visualizer.md) — reads graph data through `query-client.mjs`.
- Node.js built-ins only for the JS side (`node:crypto`, `node:zlib`'s `crc32`, `node:fs`, `node:net`, `node:os`, `node:path`, `node:readline`, `node:child_process`, `node:events`). The native bridge uses `node_api.h` plus POSIX `mmap`/`msync`/`ftruncate`. No third-party runtime dependency in any file in this subsystem's scope.

## Diagrams

The component and data-flow diagram is inline under Architecture; the file, header, page, record, and index layouts are tabulated under Models. No further diagram is maintained.

## References

- Node-API (N-API) — `node_api.h`, `napi_create_external_arraybuffer`, `napi_detach_arraybuffer`, used in `native/mmap_bridge.c`.
- POSIX `mmap(2)`, `msync(2)`, `ftruncate(2)`, `sysconf(_SC_PAGESIZE)` — the semantics `mmap_bridge.c` relies on for shared, page-aligned durable writes.
- `node-gyp` and `binding.gyp` conditions — the `OS!='mac'` → `"type": "none"` mechanism that makes the bridge macOS-only.
- Newline-delimited JSON (NDJSON) — the daemon's framing convention.
