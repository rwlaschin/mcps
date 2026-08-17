---
modified: 2026-07-06
dependencies: [mcp-server]
---

# Discovery & primary/secondary coordination — how multiple `mcp-code-vault` instances find each other

Describes how multiple `mcp-code-vault` processes running on the same machine (typically one per open Cursor/agent-host window) discover each other, elect a single "primary" to own the shared stats HTTP/Socket.IO server and Mongo connection, and how the `platform-ui` dashboard discovers all of them independently over UDP. Also covers graceful shutdown and primary failover. Read this before touching `src/discoveryClient.ts`, `src/primaryClient.ts`, `src/primaryServer.ts`, `src/shutdown.ts`, `src/projectKey.ts`, `platform-ui/server/plugins/discovery.server.ts`, or `platform-ui/server/utils/discovery-store.ts`. It does not cover the MCP stdio protocol surface or the `main()`/`runAsPrimary()`/`secondaryStartup()` control flow that calls into this subsystem — see `mcp-server` for that; this doc is scoped to the discovery/election/coordination primitives themselves.

## Sensitive Areas

- Primary election is a race for one OS-level resource: binding UDP port 9255. `tryStartDiscoveryAsPrimary()` in `src/discoveryClient.ts` resolves `true` only if the bind succeeds and `false` on `EADDRINUSE`; any other bind error rejects the promise. Changing this to swallow other error codes as "not primary" would hide real environment failures (e.g. permission errors) as ordinary contention.
- `runShutdown()` in `src/shutdown.ts` is guarded by a module-level `running` flag so it only executes its hook list once even if called from multiple signal paths (`process.stdin`'s `'end'`, `SIGTERM`, `SIGINT`, transport close) — removing the guard would double-run hooks like `disconnectMongoose()`/`stopPrimaryServer()`, which are not all idempotent-safe against concurrent invocation.
- `shutdownOnTransportClose` (`src/shutdown.ts`) must be `false` for a primary and `true` for a secondary. A primary that shuts down when its own MCP stdio client disconnects would kill the shared TCP 9256 server and stats backend out from under every other secondary attached to it. This flag is set explicitly in `runAsPrimary()`/`secondaryStartup()` (see `mcp-server`), not derived here, but `src/shutdown.ts` is where the flag lives and is trusted.
- `connectToPrimary()` in `src/primaryClient.ts` keeps the TCP socket open after the handshake specifically so `close`/`error` events can be observed later for failover detection (`onPrimaryDisconnect`). Destroying or replacing the socket without re-registering an `onDisconnect` handler silently breaks failover — a secondary would never notice its primary died.
- The disconnect callback in `connectToPrimary()` guards against firing twice (`disconnectFired`) and clears itself after firing (`disconnectCallback = null` in `onPrimaryDisconnect`'s consumer, i.e. `secondaryStartup`) — reintroducing a persistent/re-armed callback risks repeated failover storms if `close` and `error` both fire for the same socket.
- `primaryServer.ts`'s per-socket `clientInfo` map is the only source of truth for `secondary:connected`/`secondary:disconnected` events and for `getCurrentSecondaries()` (used to replay current state to newly-connected UI Socket.IO clients). If a socket is removed from `clientSockets` without also being removed from `clientInfo` (or vice versa), the UI's live secondary list and a fresh client's initial replay will disagree.
- `discovery-store.ts` on the `platform-ui` side is a plain in-memory `Map`, not persisted — a UI dev-server restart drops all registered servers until the next 5s broadcast cycle causes MCP processes to re-register. `STALE_MS` (default 35s, `DISCOVERY_STALE_MS` env) was deliberately set well above both the UI's 5s broadcast interval and the MCP client's 5s register throttle after a prior bug where a single missed UDP datagram pruned a server and broke the Config page (see the comment block at the top of `discovery-store.ts`).
- UDP broadcast delivery is inherently unreliable (`ENETUNREACH` on VPNs/no default route is explicitly swallowed in both `discoveryClient.ts`'s `startPrimaryAnnouncer` and `discovery.server.ts`'s plugin) — code in this subsystem must tolerate silently dropped datagrams by re-sending on an interval rather than assuming one-shot delivery will succeed.

## Design Constraints

- Exactly one primary per machine is enforced structurally, not by negotiation: whoever wins the `EADDRINUSE` race on UDP 9255 is primary. There is no tiebreak, heartbeat-based re-election among peers, or explicit "step down" message; the only way a new primary is chosen is the old one releasing port 9255 (process exit) and some secondary's retry loop winning the next bind attempt.
- The primary TCP handshake protocol (`primaryServer.ts` / `primaryClient.ts`) is newline-delimited JSON on a persistent socket: client sends `{ port, projectKey }` (or legacy `{ port, projectName }`) once, server replies once with `{ statsPort }`, and the socket is then kept open indefinitely purely so either side can detect the other's disconnect. No further application messages are exchanged on this socket.
- Ports are fixed and environment-overridable only for the primary TCP port: `PRIMARY_TCP_PORT` (default 9256) and `PRIMARY_HOST` (default `127.0.0.1`) in both `primaryClient.ts` and `primaryServer.ts`. UDP discovery port 9255 and the primary-announce port 9257 are hardcoded constants (`DISCOVERY_PORT`, `PRIMARY_ANNOUNCE_PORT` in `discoveryClient.ts`) with no env override.
- All coordination traffic (UDP discovery register, UDP primary announce, TCP handshake) binds to loopback or broadcasts on the local subnet only — `startPrimaryServer` binds `127.0.0.1` explicitly; there is no cross-machine primary/secondary coordination in this subsystem (the stats HTTP server itself binds `0.0.0.0` for LAN dashboard access, but that's a separate concern documented in `mcp-server`).
- `startDiscoveryClient`/`tryStartDiscoveryAsPrimary`/`startPrimaryServer`/`startPrimaryAnnouncer` are all idempotent no-ops on a second call within the same process (checked via module-level socket/server/interval references) — callers are not expected to guard against calling them more than once.
- Registration to the UI is throttled client-side to at most once per `registerUrl` per 5 seconds (`REGISTER_THROTTLE_MS`), matching the UI's own 5s broadcast cadence, specifically to dedupe the loopback-plus-broadcast double-send the UI does on every cycle.
- The `platform-ui` discovery store never fetches or pushes state to MCP servers — it is purely reactive to whatever `POST /api/register` calls arrive from the discovery-client throttle loop, plus an explicit `POST /api/servers/deregister` for immediate removal, plus its own `pruneStale()` time-based eviction.

## Feature Overview

Because a developer can have several projects open at once, each running its own `mcp-code-vault` process, only one of those processes should own the shared, per-machine work: the Mongo connection lifecycle bootstrap, the stats HTTP/Socket.IO server that the `platform-ui` dashboard talks to, and the file-processing watcher. `mcp-code-vault` solves this with a lightweight, leaderless election: every process attempts to bind UDP port 9255 at startup; the one that succeeds becomes **primary** and starts the shared services, while every process that loses the bind (`EADDRINUSE`) becomes a **secondary** that discovers the primary via a UDP broadcast and proxies its own metrics to the primary over a persistent TCP connection.

Separately, the `platform-ui` Nuxt dashboard needs to know which MCP server processes exist at all (to route the Config/Docs/Scan UI). It broadcasts its own UDP discovery beacon on the same port 9255 containing a `registerUrl`; any MCP process listening on 9255 (primary or secondary — both keep a UDP listener open) POSTs `{ port, projectName }` back to that URL so the UI can build a live list. This UI-facing discovery is independent of, and layered on top of, the primary/secondary election — a secondary still needs to tell the UI it exists even though it isn't running the stats server itself.

Graceful shutdown (`src/shutdown.ts`) ties both roles together: a registry of shutdown hooks runs once, in registration order, when the process's MCP stdio transport closes or a termination signal arrives — but only immediately-exits for a secondary; a primary must keep running so it doesn't strand other secondaries mid-connection. When a secondary's primary connection drops unexpectedly (primary process died), `onPrimaryDisconnect` triggers a fresh failover attempt that re-runs the same discover-or-become-primary logic used at startup.

## Architecture

**UDP discovery listener (dual purpose).** `discoveryClient.ts` binds one UDP4 socket to port 9255 for two different reasons depending on how it's called: `tryStartDiscoveryAsPrimary(port)` binds it as part of winning the primary election, and `startDiscoveryClient(port, projectName)` binds the same socket/handler as a secondary (`attachMessageHandler`) purely to receive the UI's discovery beacon — both a primary and a secondary need to answer the UI's broadcast, but only one process on the machine can hold port 9255, so in practice whichever process is primary is also the one answering UI broadcasts; a secondary process does not get its own UDP 9255 socket (it lost the bind) but still needs a way to tell the UI it exists — that path is `startDiscoveryClient`, which is only reachable if the port is free, i.e. effectively only the primary calls it with a real socket bind (a secondary's `startDiscoveryClient` call after losing the race also hits `EADDRINUSE`). Both entry points share `attachMessageHandler(socket, port)`: on receiving a UDP datagram, it parses `{ registerUrl }`, resolves the target host to `localhost` if it matches one of this machine's non-loopback IPv4 addresses (`getLocalAddresses()`/`resolveRegisterUrl()`, so registration doesn't depend on the UI listening on a specific interface), throttles by `registerUrl` (`REGISTER_THROTTLE_MS` = 5000ms via `lastRegisterByUrl`), and POSTs `{ port, projectName, upgrade? }` to it via plain `http`/`https`.

**Primary announcement (secondary discovery of primary).** Once a process becomes primary, `startPrimaryAnnouncer(primaryTcpHost, primaryTcpPort)` opens a second, separate UDP socket and every `PRIMARY_ANNOUNCE_INTERVAL_MS` (2000ms) sends `{ primaryTcpHost, primaryTcpPort }\n` to two destinations: loopback (`127.0.0.1:9257`, always works) and broadcast (`255.255.255.255:9257`, best-effort, `ENETUNREACH` swallowed). `discoverPrimary(timeoutMs)` is the secondary-side counterpart: it opens a UDP socket bound to `PRIMARY_ANNOUNCE_PORT` (9257), waits up to `timeoutMs` for one matching message, and resolves `{ host, tcpPort }` or `null` on timeout/error. This is how a secondary learns where to open its TCP connection without a hardcoded host, while still falling back to `PRIMARY_HOST`/`PRIMARY_TCP_PORT` defaults if no broadcast arrives in time.

**Primary TCP handshake and liveness.** `primaryServer.ts`'s `startPrimaryServer(httpPort)` opens a `net.Server` on `PRIMARY_TCP_PORT` (9256, bound to `127.0.0.1` only) and, per connecting socket, buffers incoming bytes until a newline, parses `{ port, projectKey }` (or legacy `projectName`), stores it in `clientInfo`, replies with `{ statsPort: httpPort }\n`, and emits a `secondary:connected` event onto the primary's metrics stream (`pushToStream`, see `mcp-server`/stats subsystem). The socket is deliberately never closed by the server after handshake — `onClientClose()` (triggered by the socket's own `close`/`error`) is what removes the entry from `clientInfo`/`clientSockets` and emits `secondary:disconnected`. `primaryClient.ts`'s `connectToPrimary(myPort, projectKey, discover?)` is the mirror: it connects (to the discovered host/port, or `PRIMARY_HOST`/`PRIMARY_TCP_PORT` defaults), writes the handshake line, parses the reply, and — critically — keeps the socket referenced in module state (`clientSocket`) and attaches `close`/`error` listeners that invoke a single registered `onPrimaryDisconnect` callback exactly once (`disconnectFired` guard), clearing the socket via `clearSocket()` either way.

**Primary election and failover control flow.** (Full startup sequencing lives in `src/index.ts` and is documented in `mcp-server`; this doc covers only the primitives it calls.) At process start, `tryStartDiscoveryAsPrimary(port)` is attempted first; success means "run as primary" (start TCP server + announcer + stats server). Failure means "run as secondary," which loops: `discoverPrimary(2000)` then `connectToPrimary(...)`; on success the secondary registers `onPrimaryDisconnect` to re-run the same discover/connect-or-become-primary sequence (with a 0–50ms random jitter, `FAILOVER_JITTER_MS`) if the primary later disappears — this is the failover path, and it can end with the erstwhile secondary itself becoming the new primary if it wins the port-9255 bind race this time. If neither discovery+connect nor becoming primary succeeds, the secondary retries (with jitter) up to `maxRetries` times before giving up.

**Shutdown hook registry.** `shutdown.ts` holds a simple ordered array of `ShutdownFn` (sync or async, each wrapped in a try/catch so one failing hook doesn't block the rest) and a `running` guard so `runShutdown()` only executes once per process. `setShutdownOnTransportClose(bool)`/`getShutdownOnTransportClose()` is the single piece of state that lets the MCP transport-close handler (in `mcp-server`'s `createLoggingStdioTransport`) decide whether closing this process's stdio should trigger `runShutdown()` at all — `true` for secondaries, `false` for primaries, set explicitly by whichever startup path won.

**Project key resolution.** `projectKey.ts`'s `getProcessProjectKey()` is the single canonical function for naming this process's project in stream/metric payloads and the TCP handshake: `MCP_PROJECT_KEY` env if set, else legacy `MCP_PROJECT_NAME`, else the literal string `'default'`, both trimmed. It exists so a secondary's TCP handshake and its metrics stream both use the same identifier without duplicating the fallback logic.

**UI-side discovery broadcast and store.** `platform-ui/server/plugins/discovery.server.ts` is a Nitro plugin (skipped entirely when `NODE_ENV === 'test'`) that opens its own UDP4 socket, computes a `registerUrl` from `NUXT_HOST`/`NITRO_HOST` env or the first non-internal IPv4 interface (falling back to `127.0.0.1`), and every `BROADCAST_INTERVAL_MS` (5000ms) sends `{ registerUrl }` to both `127.0.0.1:9255` (always works) and `255.255.255.255:9255` (best-effort, `ENETUNREACH` ignored). `platform-ui/server/utils/discovery-store.ts` is the receiving side's state: an in-memory `Map<string, RegisteredServer>` keyed by `${projectName}:${port}`, with `register()` (returns whether the key was new), `deregister()` (immediate removal), and `getServers()` which always calls `pruneStale()` first to drop entries whose `lastSeen` is older than `getStaleMs()` (env `DISCOVERY_STALE_MS`, default 35000ms) before returning the list. The Nitro API routes `platform-ui/server/api/register.post.ts` (validates `{ port, projectName? }`, defaults label to `mcp-${port}`), `platform-ui/server/api/servers.get.ts` (returns `{ servers: getServers() }`), and `platform-ui/server/api/servers/deregister.post.ts` are thin wrappers with no logic beyond input validation around this store.

## Functions

- `tryStartDiscoveryAsPrimary(port): Promise<boolean>` (`src/discoveryClient.ts`) — attempt to bind UDP 9255; `true` means this process won primary election, `false` means `EADDRINUSE` (already a primary on this machine); idempotent, rejects on unexpected bind errors.
- `startDiscoveryClient(port, projectName?)` / `stopDiscoveryClient()` (`src/discoveryClient.ts`) — bind (or release) the UDP 9255 listener that answers the UI's discovery beacon; `stopDiscoveryClient` also calls `stopPrimaryAnnouncer()`.
- `startPrimaryAnnouncer(primaryTcpHost, primaryTcpPort)` / `stopPrimaryAnnouncer()` (`src/discoveryClient.ts`) — primary-only: periodically broadcast `{ primaryTcpHost, primaryTcpPort }` on UDP 9257 so secondaries can find the TCP handshake endpoint.
- `discoverPrimary(timeoutMs): Promise<{ host, tcpPort } | null>` (`src/discoveryClient.ts`) — secondary-only: listen briefly on UDP 9257 for the primary's announcement.
- `setRegisterUpgrade(projectName)` (`src/discoveryClient.ts`) — mark the next UI registration as an "upgrade" (`{ upgrade: true, projectName }`) so the UI replaces a stale secondary chip with a primary one during failover.
- `startPrimaryServer(httpPort)` / `stopPrimaryServer(): Promise<void>` (`src/primaryServer.ts`) — start/stop the TCP 9256 listener that performs the secondary handshake and tracks connected secondaries.
- `getCurrentSecondaries(): { port, projectKey }[]` (`src/primaryServer.ts`) — snapshot of currently-connected secondaries, used to replay state to a freshly-connected UI Socket.IO client.
- `connectToPrimary(myPort, projectKey, discover?): Promise<{ statsPort } | null>` (`src/primaryClient.ts`) — perform the secondary-side TCP handshake; keeps the socket open for disconnect detection; resolves `null` on any connection/handshake failure.
- `onPrimaryDisconnect(callback)` / `disconnectFromPrimary()` (`src/primaryClient.ts`) — register the single failover callback / tear down the client socket and clear that callback.
- `setShutdownOnTransportClose(value)` / `getShutdownOnTransportClose()` (`src/shutdown.ts`) — the primary-vs-secondary flag consulted by the MCP transport wrapper to decide whether transport close should shut the process down.
- `registerShutdown(fn)` / `runShutdown(): Promise<never>` (`src/shutdown.ts`) — append a hook / run all hooks once (best-effort, errors swallowed per hook) then `process.exit(0)`.
- `getProcessProjectKey(): string` (`src/projectKey.ts`) — canonical project identifier for this process (`MCP_PROJECT_KEY` > `MCP_PROJECT_NAME` > `'default'`).
- `register(projectName, port): boolean` / `deregister(projectName, port)` / `pruneStale()` / `getServers(): RegisteredServer[]` (`platform-ui/server/utils/discovery-store.ts`) — the UI's in-memory registry of known MCP servers.
- Nitro plugin default export (`platform-ui/server/plugins/discovery.server.ts`) — starts the UI's periodic UDP discovery beacon on boot; no-ops under `NODE_ENV=test`.

## Models

- `RegisteredServer` (`platform-ui/server/utils/discovery-store.ts`, TypeScript interface, not persisted): `{ projectName: string; port: number; lastSeen: number }`, keyed in the store by `${projectName}:${port}`. Purely in-memory and ephemeral — rebuilt from scratch on every UI dev-server restart via the next round of MCP registrations.
- `IServerInstance` / `ServerInstance` (`src/db/models/ServerInstance.ts`, Mongoose model, collection `serverinstances`): `{ started_at: Date; last_seen: Date; port: number; local_url: string; network_url?: string; log_path: string; pid: number }`, indexed on `started_at` descending. This model is defined and read (`ServerInstance.find().sort({ started_at: -1 })` in `src/stats/routes/servers.ts`'s `GET /servers` route) but nothing in `src/` currently calls `ServerInstance.create`/`insertOne` — no code path in this subsystem (or elsewhere found in `src/`) writes an `IServerInstance` document, so in the current codebase `GET /servers` always returns an empty list. This is a persisted-model shell for a durable server registry that is not wired up yet, distinct from the ephemeral UDP-based discovery described above.
- No other persisted models are part of this subsystem — the primary/secondary handshake payloads (`{ port, projectKey }`, `{ statsPort }`, `{ primaryTcpHost, primaryTcpPort }`, `{ registerUrl }`) are wire-format JSON objects only, never stored.

## Use Cases

### UC1 — Two Cursor windows open on different projects race for primary

**Goal:** Ensure exactly one of several concurrently-starting `mcp-code-vault` processes on the same machine ends up owning the shared stats server/Mongo connection, regardless of which window the developer opened first.

**Stakeholders:** The developer running multiple Cursor/agent-host windows (wants both projects to work without manually designating one as "primary"); the `platform-ui` dashboard (needs exactly one stats backend to talk to per machine).

**Actors:** Process A and Process B (both running `mcp-code-vault`'s startup sequence, `main()` in `src/index.ts` — see `mcp-server`); `tryStartDiscoveryAsPrimary()`, `discoverPrimary()`, `connectToPrimary()` (`src/discoveryClient.ts`/`src/primaryClient.ts`).

**Preconditions:** No other `mcp-code-vault` process on this machine currently holds UDP port 9255.

**Postconditions:** Exactly one process (primary) is running `startPrimaryServer()` (TCP 9256), `startPrimaryAnnouncer()` (UDP 9257), the stats HTTP/Socket.IO server, and owns the Mongo connection bootstrap; every other process (secondary) holds an open TCP connection to the primary and proxies its own metrics through it.

**Basic Course of Events (BCE):**
1. Process A starts first and calls `tryStartDiscoveryAsPrimary(9255)`; the UDP bind succeeds, resolving `true`.
2. Process A runs as primary: `startPrimaryServer()` opens TCP 9256, `startPrimaryAnnouncer()` begins broadcasting `{ primaryTcpHost, primaryTcpPort }` on UDP 9257 every 2000ms, and the stats server/Mongo bootstrap start.
3. Process B starts shortly after and calls `tryStartDiscoveryAsPrimary(9255)`; the bind fails with `EADDRINUSE`, resolving `false`.
4. Process B runs as secondary: it calls `discoverPrimary(2000)`, which listens on UDP 9257 and receives Process A's next announcement within the 2000ms window, resolving `{ host, tcpPort }`.
5. Process B calls `connectToPrimary(myPort, projectKey, { host, tcpPort })`, which opens a TCP socket to Process A, writes `{ port, projectKey }\n`, and receives `{ statsPort }\n` back.
6. Process B keeps the socket open and registers `onPrimaryDisconnect` for later failover detection (see UC2); it proxies its own metrics to the received `statsPort`.

**Alternate Flows:**
- A1 — Process B starts before Process A (reversed order): the same race plays out with roles reversed — whichever process's `tryStartDiscoveryAsPrimary` call executes first wins the bind. The protocol is symmetric; no code path depends on start order.
- A2 — Process B's `discoverPrimary(2000)` times out before an announcement arrives (e.g. it started between two of the primary's 2000ms broadcast ticks): `discoverPrimary` resolves `null`, and the secondary startup loop falls back to `PRIMARY_HOST`/`PRIMARY_TCP_PORT` defaults for `connectToPrimary` instead of a discovered host/port.

**Exceptions:**
- E1 — `tryStartDiscoveryAsPrimary` rejects with an error code other than `EADDRINUSE` (e.g. a permission error binding UDP 9255): per Sensitive Areas, this must not be swallowed as ordinary contention — it propagates as a real startup failure rather than silently falling back to secondary mode.
- E2 — Neither discovery+connect nor becoming primary succeeds after `maxRetries` attempts (each with jitter): the secondary startup loop gives up; this doc does not define what the caller does after giving up (see `mcp-server` for `main()`'s handling of that terminal failure).

### UC2 — Primary process closes and a secondary fails over

**Goal:** When the primary process exits (e.g. its Cursor window is closed), automatically promote a surviving secondary to primary so the remaining processes and the dashboard aren't left without a stats backend.

**Stakeholders:** The developer(s) still running other Cursor windows on this machine (their stats proxying must resume, not stay broken); the `platform-ui` dashboard (needs to keep showing an accurate primary/secondary picture).

**Actors:** Process A (the exiting primary); Process B (a connected secondary); `onPrimaryDisconnect` callback, `secondaryStartup()` (in `src/index.ts`, per `mcp-server`), `setRegisterUpgrade()` (`src/discoveryClient.ts`).

**Preconditions:** Process B is an active secondary with an open TCP connection to Process A and a registered `onPrimaryDisconnect` callback (established per UC1).

**Postconditions:** Process A's TCP 9256 and UDP 9255/9257 resources are released; Process B (or whichever secondary wins the re-election) is now primary, running its own `startPrimaryServer`/`startPrimaryAnnouncer`/stats server, and the UI's chip for that project has been told to upgrade from secondary to primary.

**Basic Course of Events (BCE):**
1. Process A exits, releasing its UDP 9255/9257 sockets and closing its TCP 9256 listener and all connected sockets.
2. Process B's `clientSocket` (in `primaryClient.ts`) observes a `close` event; the disconnect callback fires exactly once (`disconnectFired` guard) and clears itself.
3. `secondaryStartup` re-runs the discover-or-become-primary sequence with a `0`–`50`ms random jitter (`FAILOVER_JITTER_MS`), starting with `tryStartDiscoveryAsPrimary(9255)` since UDP 9255 is now free.
4. Process B wins the now-uncontested bind and becomes the new primary, calling `runAsPrimary` with `{ projectName, upgrade: true }` (`fromFailover: true`).
5. `setRegisterUpgrade(projectName)` marks Process B's next UI registration as an upgrade (`{ upgrade: true, projectName }`), so the UI replaces that project's existing secondary chip with a primary one rather than showing a duplicate entry.

**Alternate Flows:**
- A1 — Multiple secondaries were connected to Process A: all of their sockets see `close` and all race `tryStartDiscoveryAsPrimary` again (each with independent jitter); exactly one wins the bind and becomes primary, the rest fail with `EADDRINUSE` again and re-enter secondary mode, discovering and connecting to the new primary the same way as UC1.

**Exceptions:**
- E1 — No secondary is available to fail over (Process A was the only process running): there is nothing to detect the disconnect, and no failover occurs; the machine simply has no `mcp-code-vault` process running until one is started fresh (which becomes primary via ordinary UC1 startup, not failover).
- E2 — The multi-process failover sequence completing end-to-end (a real secondary observing a real primary's disconnect and successfully becoming the new primary) has no dedicated integration test — see Tests; the closest existing coverage only asserts that the disconnect callback fires, not that re-election and re-announcement complete.

### UC3 — platform-ui dashboard starts while MCP servers are already running

**Goal:** Let the `platform-ui` Nuxt dashboard build a live list of running `mcp-code-vault` processes on startup, without any prior record of who's running, so it can route the Config/Docs/Scan UI correctly.

**Stakeholders:** The developer opening the dashboard (expects it to reflect reality immediately, not show a blank list); the dashboard's Config/Docs/Scan pages (depend on `discovery-store` for routing).

**Actors:** The Nitro plugin (`platform-ui/server/plugins/discovery.server.ts`); whichever `mcp-code-vault` process currently holds UDP 9255 (primary or secondary — both keep a UDP listener open, per Architecture); `attachMessageHandler()` (`src/discoveryClient.ts`); `discovery-store.ts`'s `register()`.

**Preconditions:** One or more `mcp-code-vault` processes are already running and listening on UDP 9255 (whichever process currently holds that port) before the dashboard starts; `NODE_ENV !== 'test'` for the Nitro plugin to be active.

**Postconditions:** `discovery-store`'s in-memory `Map` contains a `RegisteredServer` entry for each running MCP process that has responded, reachable via `GET /api/servers`.

**Basic Course of Events (BCE):**
1. The Nitro plugin starts on dashboard boot and computes a `registerUrl` from `NUXT_HOST`/`NITRO_HOST` env or the first non-internal IPv4 interface (falling back to `127.0.0.1`).
2. Every `BROADCAST_INTERVAL_MS` (5000ms), it sends `{ registerUrl }` via UDP to both `127.0.0.1:9255` and `255.255.255.255:9255`.
3. The MCP process holding UDP 9255 receives the datagram in `attachMessageHandler()`, resolves the target host (`localhost` if it matches one of this machine's non-loopback IPv4 addresses), and — since this `registerUrl` hasn't been POSTed to within the last 5000ms (`REGISTER_THROTTLE_MS`) — POSTs `{ port, projectName, upgrade? }` to it.
4. `platform-ui/server/api/register.post.ts` validates the payload (defaulting the label to `mcp-${port}` if needed) and calls `discovery-store.register(projectName, port)`, which returns whether the key `${projectName}:${port}` was new.
5. A caller (e.g. the Config page) requests `GET /api/servers`; the route calls `getServers()`, which runs `pruneStale()` first, then returns the current list — populated within one broadcast cycle (≤5s) of dashboard startup.

**Alternate Flows:**
- A1 — Multiple MCP processes are running (one primary, several secondaries): only the process currently holding UDP 9255 (per Architecture, effectively the primary) receives the dashboard's broadcast and registers; secondaries do not get their own UDP 9255 socket and so do not independently register via this path.

**Exceptions:**
- E1 — No MCP process is running yet when the dashboard starts: no datagram is answered, `discovery-store` stays empty, and `GET /api/servers` returns an empty list until an MCP process starts and its own registration throttle/broadcast cycle catches the dashboard's next beacon.

### UC4 — A single UDP datagram is dropped

**Goal:** Tolerate ordinary UDP unreliability (dropped broadcast, `ENETUNREACH` on a VPN with no default route, or normal packet loss) without a running MCP server disappearing from the dashboard's list.

**Stakeholders:** The developer relying on the Config/Docs/Scan pages (a false "server not found" would block their work); platform maintainers (this was a real prior bug — see below).

**Actors:** The Nitro plugin's broadcast loop; the MCP process's `attachMessageHandler`; `discovery-store.ts`'s `pruneStale()`.

**Preconditions:** A `RegisteredServer` entry already exists in `discovery-store` for a still-running MCP process (registered per UC3).

**Postconditions:** The entry survives one or a few missed broadcast/register cycles and is only evicted if it genuinely stops responding for longer than the stale window.

**Basic Course of Events (BCE):**
1. One UDP datagram — either the dashboard's `{ registerUrl }` broadcast or the MCP process's `{ port, projectName }` registration POST's underlying network path — is dropped (packet loss, or `ENETUNREACH` on the broadcast address, which both `discoveryClient.ts` and `discovery.server.ts` explicitly swallow rather than treat as fatal).
2. `discovery-store`'s `getServers()` calls `pruneStale()` on the next read, comparing each entry's `lastSeen` against `getStaleMs()` (env `DISCOVERY_STALE_MS`, default 35000ms).
3. Because the stale window (35s) is provisioned with wide margin over the dashboard's 5s broadcast interval, the missed datagram alone doesn't push `lastSeen` past the threshold — the entry survives.
4. The next successful broadcast/register cycle (within another 5s) refreshes `lastSeen`, and the entry is never evicted.

**Alternate Flows:**
- A1 — Several consecutive datagrams are dropped (roughly 7 in a row, given the 5s cycle and 35s stale window): once `lastSeen` genuinely exceeds `DISCOVERY_STALE_MS`, `pruneStale()` evicts the entry on the next `getServers()` call, same as if the process had actually stopped.

**Exceptions:**
- None — this use case exists specifically because of a prior exception (a bug where a single missed datagram pruned a server and broke the Config page, per the comment block at the top of `discovery-store.ts`); the fix was widening the margin between broadcast interval and stale window, described above as the current, working behavior.

### UC5 — A secondary disconnects cleanly

**Goal:** When a secondary process shuts down normally (its Cursor window closed, or SIGTERM/SIGINT), promptly reflect its departure on the primary's live secondary roster — not just eventually, via the dashboard's slower staleness prune.

**Stakeholders:** The developer closing that window (expects the dashboard to stop showing it as connected); the primary process (must keep an accurate `clientInfo` map for `getCurrentSecondaries()`).

**Actors:** The exiting secondary process; `shutdown.ts`'s hook registry; `disconnectFromPrimary()` (`src/primaryClient.ts`); the primary's `onClientClose()` (`src/primaryServer.ts`).

**Preconditions:** The secondary has an open TCP connection to the primary (established per UC1) and `getShutdownOnTransportClose()` is `true` for this process (set at secondary startup).

**Postconditions:** The secondary's TCP socket is closed; the primary's `clientInfo`/`clientSockets` no longer contain an entry for it; a `secondary:disconnected` event has been emitted on the primary's metrics stream.

**Basic Course of Events (BCE):**
1. The secondary's MCP stdio transport closes, or it receives SIGTERM/SIGINT.
2. `runShutdown()` runs its registered hooks once, in registration order — including `disconnectFromPrimary()`, which closes the TCP socket to the primary — before `process.exit(0)`.
3. The primary's socket for that connection sees `close`/`error`, invoking `onClientClose()`.
4. `onClientClose()` removes the socket's entry from `clientInfo` and `clientSockets` and emits `secondary:disconnected` (with that client's `port`/`projectKey`) onto the primary's metrics stream via `pushToStream`.
5. Any UI consuming that Socket.IO stream updates its live secondary list immediately, independent of and faster than `discovery-store`'s 35s staleness prune (which governs a separate, UDP-registration-based "known MCP processes" list, not the primary's live secondary roster).

**Alternate Flows:**
- A1 — The secondary is killed ungracefully (process killed with SIGKILL, hard crash) so its shutdown hooks never run: the TCP socket still closes at the OS level, so the primary's `close`/`error` listener still fires `onClientClose()` and the roster still updates — the clean-shutdown hook path is a faster, deliberate trigger, not the only way this gets detected.

**Exceptions:**
- None — both the deliberate (`disconnectFromPrimary`) and incidental (OS-level socket close) paths converge on the same `onClientClose()` handling, so there is no genuine failure mode distinct from UC2's primary-side disconnect handling.

### UC6 — Legacy secondary sends `projectName` instead of `projectKey`

**Goal:** Let an older secondary build (predating the `projectKey` field) successfully hand-shake with a current primary, without requiring a protocol version bump or forcing a simultaneous upgrade of every process on the machine.

**Stakeholders:** Developers running a mix of old and freshly-updated `mcp-code-vault` builds across different open windows during a rollout.

**Actors:** A legacy secondary sending `{ port, projectName }`; `primaryServer.ts`'s handshake parser.

**Preconditions:** A secondary (any version) is performing the TCP handshake against a current-version primary.

**Postconditions:** The primary's `clientInfo` entry for that connection has a valid `projectKey` string, sourced from whichever field the client actually sent.

**Basic Course of Events (BCE):**
1. The legacy secondary connects to the primary's TCP 9256 listener and writes `{ port, projectName }\n` (no `projectKey` field).
2. The primary's handshake parser checks whether `payload.projectKey` is a non-empty string; it is not (the field is absent), so it falls back to `payload.projectName`.
3. The primary stores `{ port, projectKey: projectName }` in `clientInfo` and replies with `{ statsPort }\n`, exactly as it would for a current client.
4. The primary emits `secondary:connected` with that resolved `projectKey`, so downstream consumers (metrics stream, `getCurrentSecondaries()`) see a normal, valid entry regardless of which field the client used.

**Alternate Flows:**
- A1 — A current-version secondary sends both `projectKey` and legacy `projectName`: the parser prefers `projectKey` when it is present and non-empty, ignoring `projectName`.

**Exceptions:**
- None — the parser's field-fallback fully resolves this case for any combination of the two fields being present, absent, or empty; there is no input shape under which the handshake fails solely due to which field name was used.

### UC7 — Durable server registry query (unresolved gap)

**Goal:** Let a caller retrieve a durable, Mongo-backed list of MCP server instances (start time, PID, log path, URLs) via `GET /servers`, independent of the ephemeral UDP-based discovery described in UC1–UC6.

**Stakeholders:** Anyone who would want server history/audit data surviving past the in-memory discovery store's lifetime (e.g. across a dashboard restart) — no current caller in the codebase actually depends on this.

**Actors:** `GET /servers` route (`src/stats/routes/servers.ts`); `IServerInstance`/`ServerInstance` Mongoose model (`src/db/models/ServerInstance.ts`).

**Preconditions:** None can be meaningfully stated — see Exceptions.

**Postconditions:** None achieved in the current codebase — see Exceptions.

**Basic Course of Events (BCE):**
1. A caller issues `GET /servers`.
2. The route runs `ServerInstance.find().sort({ started_at: -1 })` against the `serverinstances` collection.
3. The route returns whatever documents are found.

**Alternate Flows:** None — there is only the one code path, and it has no branch that behaves differently based on input.

**Exceptions:**
- E1 — This is an unresolved gap, not working functionality: per Models, nothing in `src/` ever calls `ServerInstance.create`/`insertOne` — no write path exists for this model anywhere in the codebase. As a direct consequence, step 2's query always finds zero documents and `GET /servers` always returns an empty list today, regardless of how many MCP server processes are actually running. This is a persisted-model shell for a durable server registry that was never wired up; do not treat this use case as describing working behavior, and do not "fix" it by inventing a write path not already decided elsewhere in this doc.

## Tests

- `mcp-code-vault/__tests__/discoveryClient.test.ts` — unit tests (mocked `dgram`/`http`/`https`) covering: `startDiscoveryClient` binds and is idempotent, correctly POSTs `{ port, projectName }` on a valid `registerUrl` message and ignores malformed/empty ones, logs `EADDRINUSE` as info vs. other errors as error; `tryStartDiscoveryAsPrimary` resolves `true`/`false` correctly and is idempotent and re-bindable after `stopDiscoveryClient`; `startPrimaryAnnouncer`/`stopPrimaryAnnouncer` schedule sends on interval, are idempotent, and handle socket errors; `discoverPrimary` resolves `null` on timeout and on socket error.
- `mcp-code-vault/__tests__/primaryServer.test.ts` — unit tests (mocked `net`) covering `getCurrentSecondaries` empty state, `startPrimaryServer`/`stopPrimaryServer` idempotency and listen/close calls, and the client handshake: writes `statsPort`, emits `secondary:connected`/`secondary:disconnected` via the mocked `pushToStream`, falls back `projectName`→`projectKey` correctly, and destroys the socket on malformed JSON.
- `mcp-code-vault/__tests__/integration/primaryServer.test.ts` — real TCP integration (binds actual port 9256): full handshake round-trip returns `{ statsPort }`, connection stays open/writable after handshake, `stopPrimaryServer` closes both the listener and existing client sockets (subsequent connect attempts are rejected), safe to call when never started.
- `mcp-code-vault/__tests__/primaryClient.test.ts` — unit tests for `onPrimaryDisconnect`/`disconnectFromPrimary` not throwing, including when never connected.
- `mcp-code-vault/__tests__/primaryClient.connect.test.ts` — unit tests (mocked `net.connect`) for `connectToPrimary`: successful handshake resolves `{ statsPort }`; honors a supplied `discover` host/port; resolves `null` for a non-numeric `statsPort`, malformed JSON, pre-handshake socket error, or pre-handshake socket close; invokes the registered `onPrimaryDisconnect` callback exactly once when the peer closes after a successful handshake.
- `mcp-code-vault/__tests__/integration/primaryClient.test.ts` — real TCP integration pairing `primaryClient` against a real `primaryServer`: successful connect/handshake, `onPrimaryDisconnect` fires when the server is stopped, `connectToPrimary` resolves `null` when nothing listens on 9256, and `disconnectFromPrimary` prevents the disconnect callback from firing afterward.
- `mcp-code-vault/__tests__/shutdown.test.ts` — `setShutdownOnTransportClose`/`getShutdownOnTransportClose` round-trip (via `jest.isolateModules` since it's module-level state); `registerShutdown` registers without invoking; `runShutdown` invokes all hooks (sync and async) exactly once, continues past a hook that throws/rejects, and always calls `process.exit(0)`.
- `mcp-code-vault/__tests__/projectKey.test.ts` — `getProcessProjectKey` defaults to `'default'` when unset, trims `MCP_PROJECT_NAME`, prefers and trims `MCP_PROJECT_KEY` over `MCP_PROJECT_NAME`.
- `mcp-code-vault/__tests__/startup.integration.test.ts` — end-to-end process-spawn smoke test: runs `npx tsx src/index.ts` and asserts no `MODULE_NOT_FOUND`/`Cannot find module` output (does not assert specific primary/secondary log lines, since it may exit early without Mongo); separately asserts `platform-ui`'s `npm run dev` finds the `nuxt` binary. This is a coarse "does it boot" check, not a discovery-protocol assertion.
- `mcp-code-vault/platform-ui/__tests__/server/plugins/discovery.server.test.ts` — Vitest, mocked `node:dgram`: confirms the plugin creates a UDP socket and sends the discovery payload when `NODE_ENV !== 'test'`, and that it re-sends on the 5s interval (advances fake timers 6s, expects ≥2 sends).
- `mcp-code-vault/platform-ui/__tests__/server/utils/discovery-store.test.ts` — Vitest: `register` returns `true` for a new key and `false` on repeat; `deregister` removes an entry; `pruneStale` respects a custom `DISCOVERY_STALE_MS`; the default stale window survives a 12s gap (longer than one UI broadcast interval) without evicting a still-live server.
- Not covered by any test found in this subsystem: `ServerInstance` persistence (there is no write path to test, per Models above), and the full multi-process failover sequence end-to-end (`onPrimaryDisconnect` triggering a real re-election and a real secondary becoming primary) — the closest coverage is the integration test asserting the disconnect callback fires, not that failover completes and a new primary is announced.
- `mcp-code-vault/__tests__/manager.test.ts` and `mcp-code-vault/__tests__/verifyLocalConnection.test.ts` were reviewed but are out of scope for this subsystem: `manager.test.ts` covers `ProjectManager.registerProject` in `src/manager.ts`, a standalone legacy project-registry helper (writes to a `registry` collection via a raw Mongo driver) with no reference to discovery, primary/secondary election, or any file in this doc; `verifyLocalConnection.test.ts` covers an LLM local-provider connectivity check (`src/stats/providerDiscovery.ts`) unrelated to instance discovery. `manager.integration.test.ts` does not exist in the repository despite being named in the review scope.

## UI/UX

There is no end-user-facing UI for the election/handshake mechanics themselves (no primary/secondary toggle, no manual "promote to primary" control) — coordination is fully automatic. The only visible surface is indirect: the `platform-ui` dashboard's list of known MCP servers (backed by `GET /api/servers` / `discovery-store.ts`) and its live Socket.IO stream of `secondary:connected`/`secondary:disconnected`/`primary:identified` events (consumed by whatever dashboard view renders connection status — implemented in `mcp-server`/stats subsystem, not here). A user closing a Cursor window sees that project's server disappear from the dashboard's list once its `secondary:disconnected` event fires (near-immediate) or, for the slower UDP-registration-based list, once `pruneStale()` evicts it (up to `DISCOVERY_STALE_MS`, default 35s, after its last registration).

## Dependencies

- Node.js built-ins `dgram` (UDP discovery/announce sockets), `net` (TCP primary handshake), `os` (`networkInterfaces()` for local IPv4 detection), `http`/`https` (registration POST to the UI) — no third-party discovery/clustering library is used.
- `src/logger.ts` (pino-based `logger.child({ component: 'discovery' })`) for all discovery-side logging in `discoveryClient.ts`.
- `src/stats/streamChannel.ts`'s `pushToStream` — used by `primaryServer.ts` to emit `secondary:connected`/`secondary:disconnected` onto the primary's metrics/Socket.IO stream; this subsystem depends on that channel existing but does not define it (see `mcp-server`/stats design docs).
- `mongoose` — only via `src/db/models/ServerInstance.ts`'s schema definition; no active write path in this subsystem currently uses it (see Models).
- On the `platform-ui` side: Nuxt/Nitro's `defineNitroPlugin`/`defineEventHandler` runtime globals, and `node:dgram`/`node:os` built-ins. No external service dependency (no message broker, no shared database) is required for discovery or election to function — everything is local UDP/TCP on one machine.
- This doc's content is a prerequisite for understanding the primary-vs-secondary branches described in the `mcp-server` design doc's Architecture section (`main()`, `runAsPrimary()`, `secondaryStartup()`), which is why `mcp-server` is listed as a frontmatter dependency here — read this doc first if the two are read together, since `mcp-server` treats these functions as given.

## Diagrams

Primary election and secondary handshake sequence, one machine, two processes:

```
Process A (starts first)              Process B (starts second)
--------------------------            --------------------------
tryStartDiscoveryAsPrimary(9255)      tryStartDiscoveryAsPrimary(9255)
  -> bind succeeds -> true              -> EADDRINUSE -> false
runAsPrimary():                       secondaryStartup(): loop
  startPrimaryServer() [TCP 9256]        discoverPrimary(2000ms)  <---- UDP 9257 announce ---+
  startPrimaryAnnouncer() [UDP 9257] ----------------------------------------------------------+
  createStatsServer() [HTTP/IO]          connectToPrimary(port, projectKey, {host,tcpPort})
  startDiscoveryClient() [UDP 9255]        -> TCP connect 9256, write {port, projectKey}\n
                                            <- {statsPort}\n
                                          keep socket open; onPrimaryDisconnect(cb) armed
                                        setStatsBaseUrl(statsPort); metrics now proxy to A

Failure/failover branch (A exits):
  Process A's TCP 9256 + UDP 9255/9257 released
  Process B's client socket -> 'close' -> cb() fires once
  secondaryStartup(fromFailover=true) re-loops with 0-50ms jitter
    tryStartDiscoveryAsPrimary(9255) -> B now wins the bind -> true
    runAsPrimary(port, { projectName, upgrade: true })  // setRegisterUpgrade -> UI swaps chip
```

UI discovery (independent of the above, layered on the same UDP 9255 port):

```
platform-ui (Nitro plugin)                 mcp-code-vault (whichever process holds UDP 9255)
---------------------------                --------------------------------------------------
every 5s: send {registerUrl}        --UDP-->  attachMessageHandler():
  to 127.0.0.1:9255 and                         throttle by registerUrl (5s)
  255.255.255.255:9255 (best effort)            resolve host (local IP -> localhost)
                                                 POST {port, projectName, upgrade?} -> registerUrl
GET/POST /api/register  <----HTTP-------------- discovery-store.register(projectName, port)
GET /api/servers -> pruneStale() -> list of RegisteredServer (35s stale window)
```

## References

- `mcp-code-vault/src/discoveryClient.ts`, `src/primaryClient.ts`, `src/primaryServer.ts`, `src/shutdown.ts`, `src/projectKey.ts`, `src/db/models/ServerInstance.ts`, `src/index.ts` (caller of all of the above — see `mcp-server` for its full flow).
- `mcp-code-vault/platform-ui/server/plugins/discovery.server.ts`, `platform-ui/server/utils/discovery-store.ts`, `platform-ui/server/api/register.post.ts`, `platform-ui/server/api/servers.get.ts`, `platform-ui/server/api/servers/deregister.post.ts`.
- Tests listed in full under Tests above, all under `mcp-code-vault/__tests__/` and `mcp-code-vault/platform-ui/__tests__/server/`.
- `docs/design/mcp-server.md` — the MCP protocol/process-startup design doc that consumes these primitives from `main()`/`runAsPrimary()`/`secondaryStartup()`.
