---
modified: 2026-10-13
dependencies:
  - parsing-and-resolution.md
  - mcp-and-cli.md
  - visualizer.md
---

# Storage and Query

This subsystem is CodeGraph's persistence and read path: the on-disk generation store (`store.mjs`), the memory-mapped binary query view (`mmap-query-cache.mjs` plus the macOS-only N-API `mmap` bridge in `native/`), the query engine that reads that view (`daemon-query-engine.mjs`), and the Unix-socket daemon and client that serve queries to other processes (`query-daemon.mjs`, `query-client.mjs`, `query-target.mjs`).

**Who needs to read this:** anyone changing what a symbol or edge record carries, anyone adding a query type or a field to the daemon wire messages, and anyone debugging a stale/absent query result or a daemon that will not start.

**When to consult it:** before touching the versioned binary layout or the socket protocol, and when tracing where a query result came from — an immutable mapped root or the fallback engine.

Parsing/resolution produces the graph this subsystem stores ([parsing-and-resolution.md](parsing-and-resolution.md)); the MCP server and CLI are its main callers ([mcp-and-cli.md](mcp-and-cli.md)); the visualizer reads through the same daemon client ([visualizer.md](visualizer.md)).

## Sensitive Areas

- **Version-4 roots reference immutable records.** Payload storage is separate from byte-prefix lookup directory/chunk records within the same sparse mmap. `RecordWriter` copies only affected committed lookup pages; its own unpublished pages can change until commit. `ImmutableQueryView` captures one root, so committed offsets are never reused. Five indexes share symbol/edge payloads; unresolved occurrences have a sixth index.
- **Integrity covers the header and each traversed record.** The 256-byte header has a CRC at offset 252. Record headers carry payload length, type, and CRC; `RecordReader.record` checks current mapped bytes on every read. Root descriptors and allocator bounds are checked before acquisition. Publication computes CRCs only for appended records, not the whole graph.
- **The daemon wire protocol has no version field, no handshake, and no capability negotiation.** A request is a bare `{op, id, query, maxQueue}` object (`query-daemon.mjs:299`) and validation accepts only that shape (`:143-149`). A newer client talking to an older running daemon has no way to detect the mismatch; the daemon answers with `{error: 'invalid request', done: true}` at best, or misinterprets an unknown field as absent at worst. The daemon is also long-lived and detached (`:34-37`), so a stale binary can keep serving after the source is upgraded.
- **The query vocabulary is closed.** `#queryMapped` handles exactly `symbols`, `refs`, `deps`, `graph` and otherwise throws `unknown query type: ${request.type}` (`daemon-query-engine.mjs:108-112`). New query types are not additive at the read layer — they need a branch here (or they fall through to the exception, which reaches the client as `{id, error, done}`).
- **The socket path is derived, not registered.** `daemonSocketPath` hashes the resolved root (`query-daemon.mjs:16-20`); two clients that disagree about the root's canonical form (symlink, different casing) get different sockets and each spawns its own daemon. `QueryDaemon.start()` probes an existing socket file and deletes it if nothing answers (`:104-112`) — a live daemon whose socket file was removed out from under it is unreachable and undetectable.
- **Capacity is consumed by immutable appends.** A delta never detaches old roots, rewrites retained rows, or compacts storage. Cold prefix partitioning leaves abandoned staging chunks allocated but unreachable; they consume tail space and are not reclaimed. Capacity exhaustion returns `false`; committed roots and pinned views remain readable. Disposal detaches still-live views before unmapping, which can copy a large retained allocation outside the edit path.
- **The native bridge is macOS-only and optional.** `binding.gyp` sets `"type": "none"` for `OS!='mac'`, and `native/mmap-adapter.mjs:7` swallows the `require` failure so `nativeMmapAdapter` is `null`. Every `mmap` benefit disappears silently on any other platform or any failed build; correctness is preserved only because the fallback path exists.
- **`package.json` declares `"main": "query-client.mjs"` with no `"exports"` map, and there is no workspace manifest at the monorepo root** (`/Users/mac/Documents/Projects/mcps/` contains no `package.json`). Every other module in this subsystem is reachable only by deep relative path, and nothing at the repo root hoists or links the package.

## Design Constraints

- **Record layouts and schema changes require coherent migration.** The schema integer remains 4. Authenticated root tag 7 selects partitioned lookup; genuine older version-4 root/node tags 6/5 retain their AVL reader. Valid version-3 pages and AVL version-4 roots migrate from cached bytes without source parsing or a cache-miss rebuild.
- **Legacy compatibility is explicit.** `LegacyQueryView` decodes version 3 independently of `CACHE_SCHEMA_VERSION = 4`. Opening the cache attempts migration of both valid retained roots, preserving generation, coverage and occurrence order. AVL migration reuses existing keys/payload offsets. Version 2 retains its prior rejection behavior. Insufficient space leaves genuine legacy reads available; publication returns `false` while unmigrated roots remain, instead of migrating during an edit.
- **Capacity is fixed at open time.** The default is 1 GiB and the header capacity must match. A short mapping is resized and remapped once at open. Version-4 appends use committed writable intervals and a cursor; migration permanently excludes both legacy payloads and the upper page's 2048-byte checksum guard. There is no automatic compaction or resizing on an edit.
- **A root is served only for an exact generation and coverage match.** `acquire({generation, coverage})` tries the active descriptor then the other. A symbol request missing calls coverage retries complete coverage in `DaemonQueryEngine`.
- **Transport is local-only.** A Unix domain socket under `os.tmpdir()` (`query-daemon.mjs:19`) — no TCP, no port, no bind address, no authentication beyond filesystem permissions on the socket.
- **Messages are newline-delimited JSON, one message per line, in both directions** (`readline` with `crlfDelay: Infinity`, `:137`, `:227`; every write is `${JSON.stringify(...)}\n`). A row containing a literal newline is impossible because `JSON.stringify` escapes it, but the framing gives no length prefix and no way to resynchronize mid-message.
- **The store's directory contract is `<root>/.codegraph`** with `partitions/`, `generations/`, `sources/`, `overlays/`, and a `CURRENT` pointer file (`store.mjs:11-17`, `:58`). `DaemonQueryEngine` reads `CURRENT` directly rather than through `GraphStore` (`daemon-query-engine.mjs:86`).
- **Every store write is atomic-by-rename** (`store.mjs:75-78`): write `<target>.<pid>.<random>.tmp`, then `rename`. Content-addressed writes are skipped entirely if the target already exists (`:29`, `:38`).
- **Node `>=18`** per `package.json` `engines`; the code uses `import.meta.dirname` (`query-daemon.mjs:34`), private class fields, and `crypto.randomUUID`.

## Feature Overview

Queries against a code graph are read-dominated and latency-sensitive: an MCP tool call or a visualizer frame wants symbol/edge lookups in milliseconds, repeatedly, over a graph that only changes when the indexer republishes. Re-parsing JSON partitions per query, or paying process startup per query, both lose.

Three mechanisms address that, and all three are present:

1. **A content-addressed, generation-stamped store** (`store.mjs`). Partitions and sources are keyed by SHA-256 of their bytes, so re-indexing an unchanged file is a no-op `existsSync` check. A generation is a published manifest with an id of `<base36 time>-<12 hex of manifest digest>-<12 hex random>` (`:55`), and `CURRENT` names the newest one. Nothing is ever mutated in place; readers see either the old file or the new one.
2. **A memory-mapped binary query view** (`mmap-query-cache.mjs` + `native/mmap_bridge.c`). The native file reserves sparse backing at fixed logical capacity. Separate lookup records partition composite key bytes through 256-way directories with common-prefix hints and unsorted chunks of at most 64 key/payload-offset pairs. Cold construction directly fills six unpublished chunk chains, then partitions overflowing chains by common-prefix and byte-scatter passes; it performs no incremental lookup insertion or sorting. A one-file delta visits changed symbols and affected edge/status groups, reuses identical payloads, and copies affected chunks and prefix paths. Lookup depth follows encoded key length rather than graph size. Calls/complete publications share the same work. Queries decode and order requested results; graph materialization is explicit read work.
3. **A per-root query daemon** (`query-daemon.mjs`). Clients pay one Unix-socket connect instead of a Node startup plus a graph load. The daemon keeps a `DaemonQueryEngine` alive, which keeps the mapping alive.

`DaemonQueryEngine.#pinFallback` lazily constructs the full `CodeGraphEngine` when acquisition is unavailable, stale, wrong-coverage, or bypassed by `consistency: 'latest'`. Acquisition failures return `null`; publication failures return `false`. Corruption encountered while reading a mapped row throws instead of returning unchecked data, and the daemon reports that query error.

Validated incremental publication reuses the pinned generation's unchanged partition ids. A single-file delta is accepted only when it contains exactly the changed/add partition or unlink tombstone. The coordinator verifies it against the pinned base, patches exact edges and dangling-reference status from retained complete partitions, then publishes a complete manifest from the one replacement plus unchanged ids. It never computes a reverse dependency closure or reads dependent source. Stale bases, malformed results, and failed partition writes are rejected before manifest publication. The mapped-cache publication follows the manifest; a cache failure retains the existing fallback query route.

Validated generations publish content-addressed binary internal partitions beside their symbol partitions. The same atomic manifest publication binds control flow and complexity data to the matching symbol generation.

TypeScript-only, Go-only, and mixed repositories use the same partition and query layouts. `LanguageSemanticWorker` combines language-owned receipts into one atomic generation with no inferred cross-language edges. `PublicationFacts` retains keyed unresolved rows and edge patches and applies only touched publication groups on a one-file edit; unchanged partition ids and pinned mmap reads remain valid.

## Architecture

```
indexer/resolver  ──►  GraphStore (store.mjs)
   (see parsing-and-resolution.md)   .codegraph/{partitions,sources,overlays,generations,CURRENT}
                                                │
                                                ▼
                              MmapQueryCache.publish()  ──►  .codegraph/query-view-cache.bin
                                                                (256B header | reserved 4KB scratch | immutable records)
                                                                        │ acquire()
QueryDaemonClient ──unix socket──►  QueryDaemon  ──►  DaemonQueryEngine ─┤
  (query-client.mjs)   NDJSON       (per-root)         (#queryMapped)    └─► CodeGraphEngine  (fallback)
```

Components:

- **`GraphStore`** — filesystem layer only. No caching, no in-memory state beyond four path strings. Optionally reports timings to an injected profiler on the partition write path (`store.mjs:23-30`).
- **`RecordReader` / `RecordWriter` / `ImmutableQueryView` / `MmapQueryCache`** — checked record access, partitioned lookup updates, generation-pinned query methods, and mapping/transaction ownership. `LegacyQueryView` is the retained version-3 decoder; `RecordReader.node` retains authentic AVL version-4 reads. The cache tracks views weakly for disposal detachment.
- **`nativeMmapAdapter`** (`native/mmap-adapter.mjs`) — thin wrapper over the compiled binding, or `null`. It creates the parent directory before `open` and otherwise forwards `open/resize/map/flush/unmap/close/pageSize` verbatim.
- **`mmap_bridge.c`** — N-API module `codegraph_mmap`. `open` does `open(O_RDWR|O_CREAT, 0600)` plus `ftruncate` up to capacity if the file is short; `map` does `mmap(PROT_READ|PROT_WRITE, MAP_SHARED)` over the whole file and returns a `Uint8Array` over an external `ArrayBuffer`, stashing the mapping state on the typed array as a non-enumerable-by-convention `__mmapState` external; `flush` page-aligns the requested range down/up and calls `msync(MS_SYNC)`; `unmap` `munmap`s then `napi_detach_arraybuffer`. Finalizers on both the handle and the mapping close/unmap if JS drops them first.
- **`DaemonQueryEngine`** — the routing brain. Decides mapped-vs-fallback, holds leases in a `Set` so `dispose()` can release them, and exposes `pinQuery`, `queryBatch`, and an async-generator `query`.
- **`QueryDaemon`** — `net.createServer` over the derived socket path; tracks live sockets and in-flight requests keyed `<socketUUID>:<requestId>` so a `cancel` op or a socket close aborts exactly the right `AbortController`s (`:135`, `:151`).
- **`QueryDaemonClient` / `connectQueryDaemon` / `streamQuery`** — client side. `streamQuery` (`query-client.mjs`) is the package's `main` export: connect, stream, close.
- **`qualifiedQuery`** (`query-target.mjs`) — turns `file:name`, a recognized filename, or a bare name into `{file, name}`, `{file}`, or `{name}` using registered analyzer extensions, including `.go`.

Process topology: one daemon per canonical root, spawned detached and `unref`'d by `defaultStartDaemon` running `tool.mjs daemon --root <root>` (`query-daemon.mjs:33-43`). Concurrent spawn attempts within one process are deduplicated by `startupBySocket`, a socket-path-keyed promise map (`:10`, `:64-76`). Startup waits up to `STARTUP_TIMEOUT_MS = 15000` with backoff from 10ms toward 50ms plus jitter (`:11-14`, `:49-62`); each individual connect attempt times out at `CONNECT_TIMEOUT_MS = 500` (`:25`).

## Functions

**`store.mjs` — `GraphStore`**

- `constructor(root, cacheDir = '.codegraph')` — derives the four subdirectory paths. Touches no disk.
- `initialize()` — `mkdirSync(recursive)` for all four subdirectories. Called defensively at the top of most write/read methods.
- `writePartition(partition, profiler = null)` — stringifies, SHA-256s the serialized bytes for the id, writes `partitions/<id>.json` only if missing, returns the id. Emits `partition-hash` and `partition-write` profiler spans, the latter carrying `cacheWrite: 0|1`.
- `writeInternalPartition(bytes)` / `readInternalPartition(id)` — persist and read binary internal partitions by content hash.
- `readPartition(id)` — `JSON.parse` of `partitions/<id>.json`.
- `writeSource(source)` / `readSource(id)` — same content-addressed pattern under `sources/`, no `.json` extension.
- `readOverlay(generation)` — returns the parsed overlay, or `null` on `ENOENT`, rethrowing every other error.
- `writeOverlay(generation, overlay)` — throws `overlay generation mismatch` unless `overlay.generation === generation`, then atomically writes `overlays/<generation>.json`.
- `publish(manifest)` — mints the generation id, stamps `createdAt`, atomically writes `generations/<generation>.json`, then atomically overwrites `CURRENT`. Returns the completed manifest.
- `readGeneration(generation)` — with an explicit id, reads that file. With none, reads `CURRENT`; if that is missing or points at a nonexistent file, scans `generations/`, sorts by mtime then name, takes the newest, repairs `CURRENT`, and uses it. Throws `no codegraph generation; run build` when the directory is empty.
- `#atomicWrite(target, contents)` — temp-write plus `rename`.

**`mmap-query-cache.mjs`**

- `RecordReader.record(offset, type)` — validates aligned offsets, payload bounds, record type, and current payload CRC. `lookup` checks fixed chunk/directory layouts, counts, and hints. `range` follows prefix hints and chunk entries without decoding strings; legacy AVL traversal remains bounded for genuine old roots. `root` dispatches authenticated root tags 6/7.
- `RecordWriter.append` / `writeRoot` — append aligned records within committed writable intervals. `update` changes one unsorted chunk and its byte-prefix path; `split` partitions a full chunk plus one new key at their first differing byte. `writable` copies a committed page once per transaction; unpublished pages are reused in place. `finalize` clears every new chunk's temporary link, including abandoned staging chunks, then computes lookup CRCs once before flushing. Only the writer bypasses pending CRCs on its own unpublished lookup pages; public readers always validate.
- `RecordWriter.stageCold` / `finishCold` / `#ownedKey` — directly write key/value pairs into six chunk chains with fixed head/tail/count slots and tail DataViews. A single chunk remains its own final leaf. Larger chains use one common-prefix pass and one scatter pass, then recursively finish child chains using fixed 256-entry scratch. Private owned-key reads validate type and bounds without rechecking newly encoded key CRCs. This path performs no `update`, `lookup`, or public `key` calls; genuine AVL startup conversion retains its separate incremental index conversion path.
- `coldState(writer, graph, legacy)` — encodes the caller's graph and original occurrence/sequence metadata. Migration retains encoded duplicate-ID endpoint identities.
- `patchSymbols`, `patchEdges`, `patchUnresolved` — patch keyed changed-file symbols and exact affected groups. Identical rows reuse their existing payloads and roots. Raw/missing counts are updated from changed groups.
- `ImmutableQueryView.matchingSymbols(request)` — looks up exact ID/name/file ranges, preserves current result order, and applies requested predicates. Suffix-only file matching retains the existing scan fallback.
- `ImmutableQueryView.relationships(request, direction)` — resolves selected symbols to their first ID occurrence and reads only the corresponding endpoint range. Cold duplicate-ID edges retain the legacy last-occurrence encoding rule.
- `ImmutableQueryView.graph` — materializes symbols, edges, and optional unresolved rows. Files derive from symbol paths. Cold/migrated graphs retain caller order; changed roots use canonical symbol/group order. Ordering is requested-row read work, never publication work.
- `ImmutableQueryView.detach()` — copies its retained mapping prefix once and releases its lease. Used for disposal, not one-file publication or immutable-view eviction.
- `MmapQueryCache.constructor` — opens the fixed mapping, handles a short mapping once, and attempts lossless version-3 or AVL version-4 migration before edits. Missing adapter/open failures leave the existing unavailable-cache behavior.
- `MmapQueryCache.publish({generation, coverage, view}, {signal})` — accepts a full graph for cold publication or a retained immutable parent plus changed file/partition/groups for a delta. Validates the parent, appends only changed records and root metadata, flushes those ranges, and commits the fixed header last. Shared `publicationState` avoids duplicate calls/complete encoding. Errors, aborts, or capacity exhaustion return `false`.
- `MmapQueryCache.cloneGeneration` — appends a new generation root sharing existing immutable indexes; no full-page copy.
- `MmapQueryCache.acquire({generation, coverage})` — validates root metadata, matches exact identity, and returns `{value, release}` with a lazy graph and non-enumerable `mappedView`. Release is idempotent and does not invalidate the immutable view.
- `MmapQueryCache.#migrate` / `#migrateAvl` — migrate both retained roots during open. Version-3 migration encodes cached rows in protected writable intervals; version-4 migration traverses each authentic AVL index once and reuses key/payload offsets beyond the maximum committed cursor. Both publish tagged partition roots with the header last; failed conversion preserves legacy reads and blocks new publication without a source rebuild.
- `MmapQueryCache.dispose()` — detaches live weakly tracked views, then unmaps/closes once. Old views remain readable after disposal.

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

**Version-4 cache file layout** (fixed capacity, default 1 GiB):

| Region | Offset | Purpose |
| --- | --- | --- |
| File header | 0, 256 bytes | Identity, serial, two committed root descriptors, header CRC |
| Reserved scratch | 256, 4096 bytes | Retained header contract; excluded from appends |
| Record regions | Aligned offsets from 4352 | Separate key/payload storage and lookup chunks/directories, plus immutable generation roots |

Migrated files retain their original version-3 payload regions and the upper checksum guard as permanently excluded intervals. Root allocation state stores writable interval bounds, the active interval, and committed cursor across restart. Exhausted intervals are empty; they are not writable gaps.

**File header** (little-endian `u32`):

| Offset | Field |
| --- | --- |
| 0 / 4 | `FILE_MAGIC = 0x43474d4d` / schema version 4 |
| 8 / 12 | Fixed capacity / root fingerprint |
| 16 / 20 | Active root descriptor (0 or 1) / global serial |
| 24 / 28 | Header size 256 / reserved scratch size 4096 |
| 32 + 16*i | Root descriptor `i`: offset, record length, payload CRC, serial |
| 252 | `crc32(header[0..252])` |

**Record header — 16 bytes:** `type`, payload byte length, payload CRC32, reserved zero. Record allocations are 8-byte aligned. Type codes are key=1, symbol=2, edge=3, unresolved=4, legacy AVL node=5, legacy AVL root=6, partition root=7, directory=8, lookup chunk=9. Numeric payload fields are little-endian; strings carry a length followed by UTF-8 bytes.

| Payload | Stored data |
| --- | --- |
| Key | Composite byte key: escaped, zero-terminated UTF-8 components and big-endian numeric components |
| Symbol | Sequence, occurrence, line, ordinal, exported; ID, file, name, kind, qualified path, signature |
| Edge | Sequence, from/to symbol occurrences, group occurrence, line, call; from/to IDs |
| Unresolved | Sequence, kind, group occurrence, line; from/to IDs and reason |
| Legacy AVL node | Key/value offsets, left/right offsets, height, subtree count (24 bytes); retained reader only |
| Directory | Branch depth, hint-key offset, total live subtree entry count, reserved zero, then 256 child offsets (1040-byte payload) |
| Lookup chunk | Count, reserved zero, 64 unsorted key/value offset pairs; unused pairs zero (520-byte payload). The reserved word temporarily links writer-owned cold staging chunks and is zeroed before CRC/commit. |
| Root | Six index roots, next symbol occurrence, unresolved presence, ordering mode, allocation state, raw count/original boundary; generation and coverage; tag 6 or 7 identifies representation |

Five partitioned indexes select ID, name, file, incoming endpoint, and outgoing endpoint. Incoming/outgoing entries share one edge payload. Unresolved occurrences use a primary `(kind, from, to, line, occurrence)` index. Directory hints skip common key bytes; selecting a child strictly increases traversal depth. The 65th chunk entry splits only that local set; deletions leave neighboring records unchanged and empty children become zero. There is no automatic merging or compaction. Cold/migrated unresolved kind 2 preserves original sequence; the first delta captures the original raw boundary. Later deltas change current raw counts without reclassifying untouched cold missing rows.

**Generation and atomicity model.**

- *Store level:* atomic temp-file rename publishes the manifest before `CURRENT`. This persisted manifest work is separate from bounded cache publication.
- *Cache level:* changed payloads, lookup chunks and prefix paths append without modifying committed records. Transaction-owned lookup pages remain mutable until temporary cold links clear and their CRCs finalize. This includes unreachable staging chunks left by cold partitioning; committed chunk reserved words remain zero. Appended ranges flush before root descriptors and the CRC-protected fixed header commit. Header flush failure restores prior header bytes; failed tail records remain unreachable and are ignored on reopen.
- *Pinned reads:* a view captures immutable roots. Later appends, descriptor replacement, engine eviction, and lease release do not change its rows. Before unmapping, disposal detaches still-live views. No automatic compaction reclaims committed records.
- *Freshness:* exact `(generation, coverage)` identity. The header retains two discoverable roots; older acquired roots remain valid through their retained view. `consistency: 'latest'` retains its existing fallback routing.
- *Migration:* open-time conversion preserves both valid version-3 pages or genuine AVL version-4 roots without rebuilding from source. Protected legacy bytes and immutable offsets remain intact if conversion cannot fit or fails before header commit; their readers remain available, and later edits do not trigger a full migration.

**Wire messages** (newline-delimited JSON):

- Request: `{op: 'query' | 'queryBatch' | 'cancel', id, query, maxQueue}`. `id` is a client-monotonic integer. `query` is the `DaemonQueryEngine` request object and must be a non-array object for `query`/`queryBatch`. `maxQueue` is passed through into engine options untouched. **There is no version field, no handshake, and no capability negotiation.**
- Replies: `{id, row}` (one streamed row), `{id, rows, done: true, cancelled}` (batch result), `{id, done: true, cancelled}` (end of stream), `{id, error, done: true}` (failure), and `{error: 'invalid JSON', done: true}` (no `id`, malformed line).

**Query request** (as consumed by `DaemonQueryEngine`): `type` ∈ `symbols | refs | deps | graph`; optional `id`, `name`, `file` selectors; `limit`; `resolved` (boolean); `generation`; `edgeCoverage`; `consistency: 'latest'`.

**`pinQuery` result:** `{metadata: {revision, freshness, coverage, validatedGeneration}, graph, rows}`. On the mapped path `revision` is always `null` and `freshness` always `'validated'`.

**Graph shape** (`ImmutableQueryView.graph`): `{generation, edgeCoverage, files: string[], symbols: Symbol[], edges: Edge[], unresolvedEdges?: UnresolvedEdge[]}`, where `files` is the deduplicated sorted set of symbol file paths.

**Generation internals:** `internalPartitions` maps each source file to the binary internal-partition id published with that generation.

## Use Cases

### 1. Answer a symbol query from the memory-mapped view

**Goal:** A caller resolves a symbol lookup against the current generation without loading or parsing the graph.

**Stakeholders:** The agent or developer waiting on the answer; whoever owns query latency.

**Actors:** An MCP tool or CLI invocation acting through `streamQuery`/`QueryDaemonClient`; the `QueryDaemon`; the `DaemonQueryEngine`; the `MmapQueryCache`.

**Preconditions:** `<root>/.codegraph/CURRENT` exists and names a generation. `query-view-cache.bin` holds a root for that generation with matching coverage, whose metadata and record CRCs validate. The native mmap adapter loaded. A daemon for the canonical root is running, or can be started.

**Postconditions:** The caller holds the matching rows. No lease is outstanding. The cache file is unmodified.

**Basic Course of Events:**
1. The caller calls `streamQuery(root, {type: 'symbols', name})`, which calls `connectQueryDaemon(root)`.
2. `QueryDaemonClient.connect()` connects to `daemonSocketPath(root)`.
3. `client.query` delegates to `queryBatch`, which writes one line: `{op: 'queryBatch', id, query, maxQueue}`.
4. `QueryDaemon.#accept`'s line handler parses the JSON, confirms `op` is supported and `query` is a plain object, and dispatches `#run`.
5. `#run` registers an `AbortController` under `<socketUUID>:<id>` and awaits `engine.queryBatch`.
6. `DaemonQueryEngine.pinQuery` reads `CURRENT`, derives coverage `calls` for a `symbols` request, and calls `cache.acquire({generation, coverage})`.
7. `acquire` validates the active root descriptor, payload CRC, schema, allocator bounds, generation, and coverage; increments its lease; returns `{value, release}`.
8. `#queryMapped` calls `view.matchingSymbols(request)`, which follows the name index's byte-prefix hints, filters matching chunk entries, validates each traversed record, and decodes requested symbol rows.
9. The row limit is applied and the rows are returned; `pinQuery` releases the lease in its `finally`.
10. `#run` writes `{id, rows, done: true, cancelled: false}`.
11. The client's line handler calls `pending.setRows` then `pending.finish`, resolving `queryBatch`; `query` yields each row.
12. `streamQuery`'s `finally` closes the client.

**Alternate Flows:**
- *No live daemon.* `client.connect()` rejects; `connectQueryDaemon` catches and calls `connectAfterStart`, which spawns a detached daemon (deduplicated per socket path), polls until it accepts a connection, then connects. The postcondition is unchanged.
- *Coverage miss on a `symbols` query.* `acquire` on `calls` returns `null`; `pinQuery` immediately retries with coverage `complete` (`daemon-query-engine.mjs:50`) and proceeds from step 8.
- *Id-selected query.* With `request.id`, `matchingSymbols` uses the ID lookup prefix instead of the name/file prefixes and post-filters on name/file.
- *Streaming op.* A caller sending `op: 'query'` gets one `{id, row}` line per row plus a terminal `{id, done}`, with backpressure handled by `await once(socket, 'drain')`.

**Exceptions:**
- *`CURRENT` missing or unreadable.* `#currentGeneration()` returns `null`; `pinQuery` routes to `#pinFallback` (see UC-2).
- *Root invalid, absent, or generation mismatch.* `acquire` returns `null` (or throws and is swallowed by the `try {}` at `:49-51`); `#pinFallback` answers instead.
- *Corrupt record during a mapped lookup.* Record validation throws; the lease releases in `finally` and the daemon reports the query error.
- *Unknown `type`.* `#queryMapped` throws `unknown query type: <type>`; `#run` catches it and writes `{id, error, done: true}`; the client rejects `queryBatch` with that message.
- *Malformed request line.* Unparseable JSON gets `{error: 'invalid JSON', done: true}`; a wrong-shaped object gets `{id, error: 'invalid request', done: true}`.
- *Connection dies mid-request.* The daemon's socket-close handler aborts the request's controller; the client's close handler fails every pending record bound to that socket with `CodeGraph daemon connection closed`. `queryBatch` retries once when `startDaemon` is available and the message matches `/connection|EPIPE|ECONN/`.
- *Caller aborts.* The client writes `{op: 'cancel', id}`; the daemon aborts the matching controller; `#queryMapped`/`queryBatch` return `[]` at their next signal check.

### 2. Answer a query when the mapped view cannot serve it

**Goal:** A caller gets a correct answer even though the memory-mapped fast path is unavailable, stale, or deliberately bypassed.

**Stakeholders:** Anyone depending on query correctness across an index rebuild, a non-macOS host, or a failed native build.

**Actors:** The `DaemonQueryEngine`; the lazily-constructed `CodeGraphEngine` fallback.

**Preconditions:** A `DaemonQueryEngine` exists and is not disposed. `options.engineFactory` (default: `import('./tool-engine.mjs')`) can produce a working engine.

**Postconditions:** The caller holds a correct answer. `this.fallback` is populated, so the mapped path stays available for later requests while the fallback engine remains resident until `dispose()`.

**Basic Course of Events:**
1. `pinQuery` is entered with a request whose `consistency` is `'latest'`, or whose generation cannot be resolved, or for which `cache.acquire` yields no lease.
2. `pinQuery` calls `#pinFallback(request, options)`.
3. `#fallback()` memoizes `engineFactory()` so the heavyweight engine is built at most once per `DaemonQueryEngine`.
4. For `type: 'graph'` with `edgeCoverage: 'complete'`, `engine.snapshotComplete(request.generation, options)` produces the graph, and the result is shaped as `{metadata: {revision: null, freshness: 'validated', coverage, validatedGeneration}, graph, rows: [graph]}`.
5. Otherwise, if the fallback exposes `pinQuery`, its result is returned verbatim.
6. Otherwise `engine.queryBatch(request, options)` is wrapped as `{metadata: {}, graph: null, rows}`.
7. The rows travel back out through `queryBatch`/`query` and the daemon exactly as in UC-1.

**Alternate Flows:**
- *Native bridge absent.* `nativeMmapAdapter` is `null` (non-macOS, or the optional build failed), so `MmapQueryCache`'s constructor returns early with `mapping === null` and every `acquire` returns `null` — the fallback becomes the only path, permanently, with no error surfaced.
- *Cache file present but from another root or another `VERSION`.* `#readHeader` rejects on the root fingerprint or version check and `acquire` returns `null`; behaviour is identical to no cache at all.
- *Explicit freshness request.* `consistency: 'latest'` reaches `#pinFallback` at step 1 without any cache access.

**Exceptions:**
- *Engine disposed.* `pinQuery` throws `daemon query engine is disposed` before any work.
- *Signal already aborted.* `pinQuery` returns `{metadata: {}, graph: null, rows: []}` without touching the cache or the fallback.
- *`engineFactory` rejects.* The rejection propagates out of `pinQuery` to `#run`, which writes `{id, error, done: true}`. The memoized `this.fallback` retains the rejected promise, so subsequent fallback queries fail the same way until the engine is recreated; `dispose()` guards against it with `.catch(() => null)`.
- *No generation exists at all.* The fallback's own read path raises (`GraphStore.readGeneration` throws `no codegraph generation; run build`), which reaches the client as that error message.

### 3. Publish a new generation and its immutable query root

**Goal:** Make a validated change queryable while existing readers retain their generation.

**Stakeholders:** Readers holding old roots; callers awaiting the new validated graph.

**Actors:** The indexer/resolver, `GraphStore`, `MmapQueryCache`, and the native mapping adapter.

**Preconditions:** The store is writable and the mapping is live. Cold publication has a graph; a delta has the validated parent root, changed partition/tombstone, and exact affected groups.

**Postconditions:** The manifest exists and `CURRENT` names it. On cache success, the header names the new immutable generation/coverage root and earlier acquired roots remain readable.

**Basic Course of Events:**
1. The caller persists changed content-addressed partitions and publishes the generation manifest through `GraphStore`.
2. The caller passes that generation and its cold graph or bounded delta inputs to `cache.publish`.
3. The cache validates the header, committed allocator, and delta parent generation.
4. Cold publication fills six unsorted chunk chains directly, then partitions overflowing chains into prefix directories without incremental insertion; delta publication reuses unchanged records and appends changed payloads and copied lookup pages.
5. The cache appends a root carrying generation, coverage, and committed allocation metadata.
6. The adapter flushes appended ranges, then the cache updates and flushes the fixed header.
7. Acquisition for the new generation/coverage succeeds. Existing pins continue reading unchanged records.

**Alternate Flows:**
- *Calls and complete coverage.* Two root publications share the encoded graph or delta index work through one publication view.
- *Unchanged graph under a new generation.* `cloneGeneration` appends only root metadata.
- *Valid version-3 cache.* Startup migrates both pages before committing the version-4 header. A filled legacy lower interval is skipped without overwriting its payload or checksum guard.
- *Genuine AVL version-4 cache.* Startup migrates both retained roots to tagged partition roots, reusing key/payload offsets; the numerical version remains 4.
- *Short mapping.* Opening resizes and remaps once before publication.

**Exceptions:**
- *Capacity exhausted, aborted publication, or record flush failure.* Publication returns `false`; prior committed roots remain queryable and tail writes are unreachable.
- *Header flush failure.* Prior header bytes are restored and best-effort flushed; publication returns `false`.
- *Stale parent or invalid committed metadata.* Publication returns `false` rather than replacing retained records.
- *Insufficient migration space or migration failure.* Protected version-3 payloads or genuine AVL version-4 roots remain readable; publication returns `false` without attempting a repository-sized conversion during an edit.

### 4. Bring up a query daemon for a repository root

**Goal:** Exactly one daemon serves queries for a given canonical root, and clients reach it.

**Stakeholders:** Every query caller (latency); the host (one daemon per root, not per query).

**Actors:** `connectQueryDaemon` / `QueryDaemonClient` as the initiator; `defaultStartDaemon`'s detached `node tool.mjs daemon --root <root>` child; `QueryDaemon` inside that child.

**Preconditions:** `os.tmpdir()` is writable. `tool.mjs` is present next to `query-daemon.mjs`. The root resolves to a stable canonical path.

**Postconditions:** One daemon listens on `codegraph-<hash24>.sock` in `os.tmpdir()` with `ownsSocket === true`, holding a live `DaemonQueryEngine`. The client has an attached socket and a reply reader. On `QueryDaemon.close()`, in-flight requests are aborted, client sockets destroyed, the socket file unlinked, and the engine disposed.

**Basic Course of Events:**
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

**Alternate Flows:**
- *Daemon already running.* Step 3 succeeds and steps 4–9 never happen; `connect()` returns the client directly.
- *Externally started daemon.* Because `startDaemon` is injectable and nullable (`query-daemon.mjs:207`) and `connect()` only ever attempts a plain `connectSocket`, a process constructed with `startDaemon: null` connects to a daemon it did not spawn and never attempts to spawn one.
- *Stale socket file.* `QueryDaemon.start()` probes it, gets no answer, `fs.rmSync`es it, and listens on the same path.
- *Concurrent spawns in one process.* Both callers await the same `startupBySocket` promise; only one child is spawned.

**Exceptions:**
- *Another live daemon owns the socket.* `QueryDaemon.start()` throws `an active CodeGraph daemon already owns <path>`; the child exits and the original daemon keeps serving. The client's connect succeeds against that original.
- *Daemon never becomes ready within 15s.* `waitForDaemon` throws `CodeGraph daemon failed to become ready for <root>` with the last connect error as `cause`; `connectQueryDaemon` propagates it.
- *Spawn itself fails.* The child's `'error'` event rejects `defaultStartDaemon`, and `startOnce` wraps non-readiness errors in `readinessError`.
- *Engine construction fails inside `start()`.* The server is closed, the engine disposed, and the error rethrown; no socket is left listening, and `ownsSocket` stays false so the socket file is not unlinked spuriously.
- *Client closed before or during connect.* `connect()` throws `CodeGraph daemon client is closed`, and `_attach` destroys any socket handed to it after close.

## Tests

Node's built-in test runner (`npm test` → `node --test`), tests under `codegraph/test/`. The end-to-end benchmark runs separately with `npm run performance`. Directly covering this subsystem:

- `test/mmap-query-cache.test.mjs` — authenticated version-3 and genuine AVL version-4 fixtures; partitioned publication and bounded writes; chunk splits/hints; exact ordering/duplicates/unresolved transitions; live pins; record/header integrity; flush rollback; fixed capacity; lossless startup migration, protected intervals, and native reopen.
- `test/daemon-query-engine.test.mjs` — mapped-vs-fallback routing, coverage retry, query types, limits, `resolved` projection.
- `test/query-daemon.test.mjs` — socket path derivation, startup/deduplication, the NDJSON protocol, cancel, invalid requests.
- `test/query-client-import.test.mjs` — the `query-client.mjs` entry point imports cleanly.
- `test/boundaries.test.mjs` — cross-module boundary checks.

`GraphStore` (`store.mjs`) has no dedicated test file; it is exercised indirectly through `test/engine.test.mjs` and the daemon/engine tests. The native bridge has no C-level test suite — it is covered only through `mmap-query-cache.test.mjs` when a build is present, and its absence is the fallback path those tests also cover.

The [direct cold-build report](../../profiles/direct-cold-build-2026-10-10/REPORT.md) records matched real 877-file cold/warm profiles, exact output and bounded-work receipts, and staging-space costs. Its independent `reproduce/direct-build-proof.mjs` checks zero cold incremental/public-key calls, 129/257-entry chains, single-chunk offset reuse, and zero reserved links on all appended chunks. The [earlier publication report](../../profiles/publication-2026-10-10/REPORT.md) retains the prior AVL measurements. Both separate initial indexing, first-query cache construction and warmed edits; lifecycle heap sampling does not measure warm allocation volume.

## UI/UX

No UI/UX required — this subsystem exposes no interface to a person. Its consumers are the MCP server, the CLI, and the visualizer; the visualizer's presentation is specified in [visualizer.md](visualizer.md).

## Dependencies

- [parsing-and-resolution.md](parsing-and-resolution.md) — produces the partitions, sources, overlays, and graph views this subsystem persists and encodes.
- [mcp-and-cli.md](mcp-and-cli.md) — the primary caller; `tool.mjs daemon` is the process `defaultStartDaemon` spawns, and `tool-engine.mjs`'s `CodeGraphEngine` is the fallback engine.
- [visualizer.md](visualizer.md) — reads graph data through `query-client.mjs`.
- Node.js built-ins only for the JS side (`node:crypto`, `node:zlib`'s `crc32`, `node:fs`, `node:net`, `node:os`, `node:path`, `node:readline`, `node:child_process`, `node:events`). The native bridge uses `node_api.h` plus POSIX `mmap`/`msync`/`ftruncate`. No third-party runtime dependency in any file in this subsystem's scope.

## Diagrams

The component and data-flow diagram is inline under Architecture; the file, header, record, and root layouts are tabulated under Models. No further diagram is maintained.

## References

- Node-API (N-API) — `node_api.h`, `napi_create_external_arraybuffer`, `napi_detach_arraybuffer`, used in `native/mmap_bridge.c`.
- POSIX `mmap(2)`, `msync(2)`, `ftruncate(2)`, `sysconf(_SC_PAGESIZE)` — the semantics `mmap_bridge.c` relies on for shared, page-aligned durable writes.
- `node-gyp` and `binding.gyp` conditions — the `OS!='mac'` → `"type": "none"` mechanism that makes the bridge macOS-only.
- Newline-delimited JSON (NDJSON) — the daemon's framing convention.
