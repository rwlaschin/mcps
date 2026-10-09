---
modified: 2026-10-08
dependencies:
  - ../../design/mcp-and-cli.md
  - ../../design/storage-and-query.md
  - ../../design/parsing-and-resolution.md
supersedes: null
---

# Machine-wide service

## Problem

Independent MCP clients and repository runtimes multiply checker workers, parser workers, mappings and watchers. The current per-process parser budget does not cap those resources across applications or repositories.

## Solution

Route existing MCP, CLI and visualizer entry points through one authenticated local service. Serialize heavy repository operations with round-robin root scheduling, retain one heavy runtime, share canonical-root watchers, and evict idle caches under memory pressure.

## APPROVED REQUIREMENTS

1. Make existing MCP stdio processes thin proxies to one machine-wide service across clients and repositories; preserve existing MCP configuration, tool arguments, responses, default roots and cancellation.
2. Enforce one total worker budget across all repositories: CPU minus one by default, minimum one, or the configured count. Count the checker and structural workers together; queue heavy operations fairly and deduplicate identical index work without cancelling surviving waiters.
3. Retain at most one heavy repository runtime and apply one 1 GiB RSS retention high-water policy across the service. Evict unpinned idle query mappings first and then the idle heavy runtime; preserve active leases and disk data. Report active-work memory and measured RSS separately; do not claim a hard operating-system RAM ceiling.
4. Own one watcher per canonical repository and all publication in the service. Retain changed-path events independently of heavy runtime eviction; route CLI mutations and visualizer subscriptions through the same owner.
5. Use a local socket with atomic singleton startup before heavy imports. Release each disconnected client's requests and subscriptions independently; close failed initialization resources and cancel active runtime work before shutdown drain.
6. Reuse the existing daemon, runtime, worker classes and standard library. Preserve dependency versions, cache versions, stored formats, complete outputs, bounded changed-file work and unrelated changes.
7. Independently verify ten clients across six repositories, singleton races, total worker/watch counts, cancellation isolation, cache eviction/reload, failure cleanup and real CPU/heap/trace profiles. Report measured results without extrapolating an unproved performance gain.

## Scope

- `query-daemon.mjs`: extend existing NDJSON transport with authenticated attachment, per-connection MCP requests, root-aware queries and mutations, subscriptions, cancellation and singleton ownership. Bind one fixed loopback endpoint before importing heavy modules; write a random token in an owner-only local directory after successful binding. Reject insecure token paths and foreign endpoint occupancy. Keep request IDs connection-local and preserve existing query row/batch completion records.
- `mcp-server.mjs`: expose existing tool handlers to the service; maintain canonical-root descriptors, watcher subscriptions, dirty event queues, query engines and mappings. Use FIFO within roots and round-robin between roots. Fully close the previous heavy runtime before activating another. Prevent memoized query fallbacks from retaining disposed engines: route fallback calls through the scheduler rather than returning a particular evictable engine. Keep default root and request cancellation in each client context. Apply RSS retention cleanup before admission and after operations and leases finish. Track connection/subscription/waiter interest per root; close its watcher and release its descriptor when final interest and required queued publication work end.
- `mcp.mjs`: replace the server Worker and native initialization with a stdio transport proxy. Preserve fragmented UTF-8 input and output flushing. SIGINT queues cache refresh for the connection's roots after active work finishes. SIGHUP requests coordinated source reload: notify connected clients to hold new input, drain accepted work and replies, close the old service, and reconnect proxies to a newly launched process loading current source; preserve each proxy's stdio connection. Never label reconnecting to the same process as source reload.
- `tool.mjs`: host the singleton for `daemon`; route build, incremental, reconcile, query and serve through it. Preserve JSON records, explicit profile destinations and command exit behavior.
- `mcp-runtime.mjs`: allow the service to inject the globally configured engine and shared watcher ownership while retaining debounce, path acceptance and cleanup behavior.
- `semantic-checker-worker.mjs`: accept an explicit structural count of total budget minus one. For a total budget of one, build structural facts inside the checker using the existing graph builder. Preserve one-edit/one-job behavior and unique profile names.
- `query-client.mjs` and `visualizer.mjs`: expose service subscriptions and replace the visualizer's independent recursive watcher while preserving SSE indexing/ready events and graph invalidation.
- `scripts/codegraph.performance.mjs`: profile the service separately from proxies, collect its worker artifacts and flush them through explicit service shutdown. Client disconnect must not stop a service still used by another client.
- `test/query-daemon.test.mjs`, `test/mcp-runtime.test.mjs`, and `test/machine-service.test.mjs`: independent QA owns relevant extensions and new service integration coverage. Preserve valid existing tests.
- No source renames, new dependencies, storage migrations or version changes. Do not add another parser-pool implementation or cross-root worker protocol.

## Target Design Docs

After verification, update `docs/design/mcp-and-cli.md` Architecture, Functions, Models, Use Cases and Tests for shared service ownership and thin proxies. Update `docs/design/storage-and-query.md` for transport, leases and retention policy. Update `docs/design/parsing-and-resolution.md` for the total worker budget and root activation lifecycle.

## Use Cases

### 1. Share indexing across applications and repositories

**Goal:** Serve simultaneous clients without multiplying heavy resource budgets.

**Stakeholders:** Developer running multiple applications and repositories.

**Actors:** MCP clients, CLI and machine service.

**Preconditions:** Existing entry points can access the repository and local service token.

**Postconditions:** Clients receive existing outputs from one publication owner within the total worker limit.

**Basic Course of Events (BCE):**
1. `mcp.mjs` connects through `query-daemon.mjs` and authenticates its connection and default root.
2. The service binds its loopback endpoint before importing heavy handlers; competing starters exit without workers.
3. `mcp-server.mjs` canonicalizes each explicit or connection-default root and enqueues heavy work by root.
4. The service closes the previous heavy runtime before activating the next root and returns the existing tool result to the requesting connection.
5. Shared repository watchers enqueue accepted changed paths; round-robin scheduling publishes their work through the same runtime owner.

**Alternate Flows:** Cached mapped queries run concurrently under protected leases. CLI commands use root-aware daemon operations. A visualizer subscribes to the shared watcher. Root aliases reuse the canonical owner. A memory-pressure eviction reloads the persisted generation on the next activation.

**Exceptions:** Invalid roots or requests retain existing error behavior. Authentication failure rejects the connection. Foreign endpoint occupancy fails readiness. Worker or initialization failure closes partial ownership and returns an error without changing a valid published generation.

### 2. Disconnect one client while others continue

**Goal:** Release disconnected-client resources without losing shared work.

**Stakeholders:** Clients sharing repository state and the developer's machine.

**Actors:** MCP proxy, daemon connection and service.

**Preconditions:** Multiple authenticated connections hold requests or subscriptions.

**Postconditions:** Only disconnected-client reads, waiters and subscriptions are released; surviving clients receive correct results.

**Basic Course of Events (BCE):**
1. The connection-local request map in `query-daemon.mjs` registers request IDs independently of other sockets.
2. A proxy disconnects or sends its existing cancellation notification.
3. The service aborts that connection's reads and removes its waiters and subscriptions.
4. Shared index work continues for surviving waiters or watcher events.
5. Service shutdown stops admission/watchers, disposes active runtime work, drains remaining requests, closes mappings and removes owned transport credentials.

**Alternate Flows:** Identical IDs on different connections remain independent. Repeated close is idempotent. A reconnect authenticates again and reloads persisted state after service restart.

**Exceptions:** Duplicate outstanding IDs within one connection are rejected. A peer disappearing under output backpressure settles its requests. Failed startup does not remove a newer successful owner's token or endpoint.

## Testing Requirements

Independent QA selects and writes API integration tests before source implementation, following existing `node:test` and `node:assert/strict` conventions. Extend daemon/runtime coverage and add `test/machine-service.test.mjs` for real proxy/service flows rather than source-string assertions.

Prove ten simultaneous starters elect exactly one owner before heavy construction; ten proxies create no checker/parser workers. Observe total worker limits at budgets one, two and three across six roots. Verify FIFO within a root and round-robin across roots, identical index deduplication with one surviving waiter, canonical aliases, and exactly one watcher per root. Check overlapping numeric/string IDs across connections, fragmented UTF-8 frames, malformed/authentication requests, missing/default/explicit roots and duplicate outstanding IDs.

Exercise cancellation and disconnect while another client remains, failure before/after bind and runtime initialization, worker exit, peer closure during backpressure, repeated close and restart. Assert actual worker, watcher, socket and file-handle ownership drains to the warmed baseline. Verify pressure eviction never disposes active leases, returns exact results after reload and preserves persisted cache bytes and versions. Compare complete tool/query outputs and generation metadata; preserve one-file bounded-work receipts.

Verify actual visualizer indexing/ready SSE events and graph invalidation, subscription-only disconnect, and CLI default/explicit-root mutation/query output and exit behavior through the same publication owner. Reject missing/wrong tokens, insecure credential paths and foreign endpoint occupancy; prove startup losers cannot remove the winning owner's credentials. Queue watcher changes while their heavy runtime is evicted, and prove inactive-root fallback cannot create a second heavy owner. Inject RSS below/equal/above the threshold; verify mapping-before-runtime eviction, deferred cleanup after lease release, and honest RSS reporting after all idle owners close. Exercise final-waiter cancellation, watcher-owned work, differing index options, failed publication preserving the old complete generation, and authenticated reconnect/reload.

Verify final-interest disconnect closes the root watcher after queued publication ends. Alternate roots and request an engine-backed query to catch disposed fallback reuse. Issue SIGHUP with multiple live proxies and accepted work; prove outstanding replies drain, new input survives, stdio stays connected, and the new service process loads changed source. Sample actual RSS with active/idle labels; do not claim a separate active-allocation measurement.

Collect existing Node built-in per-file line/branch/function coverage with `node --test --experimental-test-coverage` for the focused test files; report the metrics it provides and flag coverage below the test-guard threshold without adding coverage dependencies. Mutate the worker ceiling, connection namespace, surviving-waiter cancellation and pinned-owner eviction conditions temporarily; require the corresponding focused checks to fail, restore the exact source, and rerun them successfully.

Run focused checks during each atomic group, syntax checks and `git diff --check`, code-guard after source edits, and test-guard after test edits. Run the full suite once at the end and report unrelated pre-existing failures separately. Use real repositories for before/after startup, cold index and warm update measurements with host process access; retain CPU, heap, trace and resource receipts under `profiles/machine-wide-service-2026-10-08`. Use deterministic resource assertions, never timing thresholds.

## Parallel / Dependent Breakdown

1. QA writes focused contract tests before implementation.
2. Implement transport, shared MCP handling, CLI routing, runtime scheduling and checker configuration as one dependent atomic group; independently verify singleton ownership, output parity and total worker cap.
3. Implement subscription server/client and visualizer routing after transport; independently verify watcher deduplication and SSE events.
4. Adapt profiling lifecycle after service ownership is working; independently run real multi-client/multi-root resource and performance receipts.
5. Update design documents only after verified implementation and complete final validation.

## Success Criteria

- Ten actual stdio proxies and six repository roots share one service; proxies create zero analysis workers.
- Observed checker plus structural workers never exceed the total configured budget, including budget one.
- Heavy operations follow per-root FIFO and cross-root round-robin; surviving waiters complete after another disconnects.
- Each canonical root owns at most one watcher and one publication stream, including CLI and visualizer clients.
- RSS retention pressure releases unpinned idle owners and reports real RSS without a hard-RAM claim; active leases remain valid.
- Exact MCP/query outputs, persisted bytes, versions and bounded single-file behavior are preserved.
- Failure, disconnect, shutdown and restart receipts show no leaked owned workers, sockets, watchers or file handles.
- Real service CPU/heap/trace files and measured startup/index/update results are available in the repository profile directory.
