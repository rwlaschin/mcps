import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env from package root so it works when cwd is not the project (e.g. Cursor MCP).
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
dotenv.config({ quiet: true }); // still allow cwd/.env to override

const FAILOVER_JITTER_MS = 50;

import * as os from 'os';
import { Server as SocketIOServer } from 'socket.io';
import { createStatsServer } from './stats/server';
import { createMcpServer, getMcpServerInstance } from './mcp/server';
import { registerProjectAgentMcpTools } from './mcp/registerAgentTools';
import { getServerCwd, setServerContext } from './mcp/context';
import { logger } from './logger';
import { setSocketIO, pushToStream, setStreamRole, buildStreamHeartbeatPayload } from './stats/streamChannel';
import { emitScanProgress, getScanProgress } from './stats/scanProgressCache';
import { markServerReady, setStatsBaseUrl } from './stats/metricsClient';
import { writeProcessLog, setProcessLogSink, addProcessLogSink, stdioMode } from './stdioMode';
import { appendLine as appendProcessLogToFile, closeLogFile, getLogDir, getLogPath } from './logFile';
import { registerShutdown, runShutdown, setShutdownOnTransportClose } from './shutdown';
import { connectMongoose, disconnectMongoose } from './db/mongoose';
import { runSeed, ensurePromptsFromSeed } from './db/seed';
import { ensureProjectFromConfig } from './db/ensureProject';
import { ensureProjectCollections } from './db/projectDb';
import { runFileProcessingStartup, stopFileProcessingWatcher } from './fileProcessingStartup';
import {
  startDiscoveryClient,
  stopDiscoveryClient,
  tryStartDiscoveryAsPrimary,
  startPrimaryAnnouncer,
  discoverPrimary,
  setRegisterUpgrade
} from './discoveryClient';
import { startPrimaryServer, stopPrimaryServer, getCurrentSecondaries } from './primaryServer';
import { connectToPrimary, disconnectFromPrimary, onPrimaryDisconnect } from './primaryClient';
import { getProcessProjectKey } from './projectKey';

let processInstanceId: string | undefined = undefined;

/** Reset process instance id so main() can run again (for unit tests only). */
export function __resetProcessInstanceIdForTest(): void {
  processInstanceId = undefined;
}

export function localNetworkHost(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function logToStderr(message: string): void {
  const line = message != null ? String(message) : '';
  process.stderr.write(line + '\n');
}

/** Options when starting as primary (e.g. from failover: upgrade so UI replaces secondary chip). */
interface RunAsPrimaryOpts {
  projectName?: string;
  upgrade?: boolean;
}

/**
 * Full primary startup: stats server, Mongo, Socket.IO, discovery UDP 9255, primary TCP 9256.
 * Used at initial startup when we bound 9255 and for failover when a client upgrades to primary.
 * Start TCP 9256 and announcer first so secondaries can connect while the rest of primary comes up.
 * When opts.upgrade is true, register with the UI includes upgrade: true so the UI can replace the secondary chip.
 */
async function runAsPrimary(port: number, opts?: RunAsPrimaryOpts): Promise<void> {
  setShutdownOnTransportClose(false);
  if (opts?.upgrade && opts?.projectName) setRegisterUpgrade(opts.projectName);
  const projectName = opts?.projectName ?? process.env.MCP_PROJECT_NAME ?? `mcp-${port}`;
  const cwd = process.cwd();

  registerShutdown(() => {
    pushToStream('primary:disconnected', JSON.stringify(buildStreamHeartbeatPayload(port)));
  });
  startPrimaryServer(Number(port));
  registerShutdown(stopPrimaryServer);
  const primaryTcpPort = Number(process.env.PRIMARY_TCP_PORT) || 9256;
  startPrimaryAnnouncer('127.0.0.1', primaryTcpPort);

  let statsApp: Awaited<ReturnType<typeof createStatsServer>> | null = null;
  try {
    statsApp = await createStatsServer();
    await statsApp.listen({ port: Number(port), host: '0.0.0.0' });
    await markServerReady('server');
    registerShutdown(async () => {
      await statsApp!.close();
    });
    registerShutdown(async () => {
      await disconnectMongoose();
    });
    registerShutdown(closeLogFile);
  } catch (statsErr) {
    const errMsg = statsErr instanceof Error ? statsErr.message : String(statsErr);
    const errStack = statsErr instanceof Error ? statsErr.stack : undefined;
    logToStderr('[mcp] Stats server failed: ' + errMsg);
    if (errStack) logToStderr(errStack);
    if (stdioMode) {
      writeProcessLog(`[MCP] Stats server failed (MCP-only): ${errMsg} cwd=${cwd}\n`);
      registerShutdown(closeLogFile);
      return;
    }
    throw statsErr;
  }

  const STREAM_HEARTBEAT_MS = 5000;
  const io = new SocketIOServer(statsApp!.server, {
    cors: {
      origin: true, // allow any origin (open CORS)
      methods: ['GET', 'POST']
    }
  });
  setSocketIO(io);
  setStreamRole('primary');
  const fileProcessingKey = process.env.MCP_PROJECT_NAME?.trim();
  if (fileProcessingKey) {
    void runFileProcessingStartup(fileProcessingKey).catch((err: unknown) => {
      logger.warn({ event: 'file_processing_startup_failed', projectKey: fileProcessingKey, err });
    });
    registerShutdown(async () => {
      await stopFileProcessingWatcher(fileProcessingKey);
    });
  }
  // Ensure Socket.IO connections are closed when the process shuts down.
  // Otherwise Socket.IO may keep client connections alive briefly and the per-socket heartbeat intervals
  // can continue emitting, making the UI look "still connected" after Ctrl-C.
  registerShutdown(() => {
    try {
      io.close();
    } catch {
      // ignore
    }
  });
  io.on('connection', (socket) => {
    const addr = socket.handshake.address ?? (socket.conn as { remoteAddress?: string }).remoteAddress ?? 'unknown';
    writeProcessLog(`[MCP] Socket.IO client connected from ${addr}\n`);
    const streamHello = buildStreamHeartbeatPayload(port);
    // Emit objects (not pre-JSON.stringify'd): some Socket.IO clients mishandle string payloads and you only see `{ ts }`.
    socket.emit('connected', streamHello);
    socket.emit('heartbeat', streamHello);
    socket.emit('primary:identified', streamHello);
    emitScanProgress(socket);
    for (const { port: p, projectKey: pk } of getCurrentSecondaries()) {
      socket.emit(
        'secondary:connected',
        JSON.stringify({ port: p, projectKey: pk, ts: new Date().toISOString() })
      );
    }
    const iv = setInterval(() => {
      socket.emit('heartbeat', buildStreamHeartbeatPayload(port));
    }, STREAM_HEARTBEAT_MS);
    socket.on('disconnect', () => clearInterval(iv));

    socket.on('scan:replay', (raw: unknown) => {
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (!key) return;
      const payload = getScanProgress(key);
      if (payload) socket.emit('scan:progress', JSON.stringify(payload));
    });
  });

  startDiscoveryClient(Number(port), projectName);
  registerShutdown(stopDiscoveryClient);

  pushToStream('primary:identified', JSON.stringify(buildStreamHeartbeatPayload(port)));

  const networkHost = localNetworkHost();
  logToStderr(
    `[mcp] Primary: stats http://0.0.0.0:${port} (metrics, Socket.IO), discovery UDP 9255, primary TCP 9256`
  );
  writeProcessLog(
    `[MCP] Stats server listening on port ${port} (POST /metrics, GET /metrics, Socket.IO stream)\n`
  );
  writeProcessLog(`[MCP] Discovery: listening on UDP 9255; will register with UI when broadcast received\n`);
  logger.info({
    msg: 'Backend ports',
    http: port,
    discoveryUdp: 9255,
    local: `http://localhost:${port}`,
    network: networkHost != null ? `http://${networkHost}:${port}` : undefined
  });
  logger.info({
    msg: 'Stats routes',
    routes: ['/config', '/docs', '/metrics', '/metrics/stream (SSE)', '/projects', '/scan/files', 'Socket.IO']
  });
  logger.info({ msg: 'MCP: add this app as an MCP server in Cursor to connect on stdio' });
  logger.info({ msg: 'Discovery: listening on UDP 9255; will register with UI when it broadcasts' });
}

export async function main(): Promise<void> {
  if (processInstanceId !== undefined) {
    process.stderr.write(`[mcp] Already initialized (instance ${processInstanceId}), skipping duplicate.\n`);
    return;
  }
  const g = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : ({} as { crypto?: { randomUUID?: () => string } });
  processInstanceId =
    g?.crypto?.randomUUID != null
      ? g.crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  process.stderr.write(`[mcp] Instance ID: ${processInstanceId}\n`);

  logToStderr('[mcp] Starting...');

  // When run by MCP host (e.g. Cursor), require env so the server has a valid config. npm run dev (TTY) does not require these.
  if (stdioMode) {
    const missing: string[] = [];
    if (process.env.MONGO_URL === undefined || String(process.env.MONGO_URL).trim() === '')
      missing.push('MONGO_URL');
    if (process.env.MCP_PROJECT_NAME === undefined || String(process.env.MCP_PROJECT_NAME).trim() === '')
      missing.push('MCP_PROJECT_NAME');
    if (process.env.WORKING_DIRECTORY === undefined || String(process.env.WORKING_DIRECTORY).trim() === '')
      missing.push('WORKING_DIRECTORY');
    if (process.env.PORT === undefined || String(process.env.PORT).trim() === '') missing.push('PORT');
    if (missing.length > 0) {
      process.stderr.write(
        `[mcp] Aborting: required env missing when run by MCP host: ${missing.join(', ')}.\n`
      );
      process.stderr.write(
        'Add these in Cursor: Settings → MCP → your code-vault server → env. Set MONGO_URL via .env in mcp-code-vault root or via command-line (e.g. cross-env MONGO_URL=... npx ...). Example env for mcp.json:\n\n'
      );
      const example = JSON.stringify(
        {
          mcpServers: {
            'code-vault': {
              command: 'npx',
              args: ['tsx', '/absolute/path/to/mcp-code-vault/src/index.ts'],
              env: {
                PORT: '3100',
                MCP_PROJECT_NAME: 'my-project',
                WORKING_DIRECTORY: '/path/to/your/codebase'
              }
            }
          }
        },
        null,
        2
      );
      process.stderr.write(example + '\n');
      process.exit(1);
    }
  }

  setProcessLogSink(appendProcessLogToFile);
  // So [MCP] and other process-log lines go to file and stderr (Cursor may show MCP stderr)
  addProcessLogSink((msg: string) => {
    if (msg != null && msg !== '') process.stderr.write(String(msg));
  });

  const logDir = getLogDir();
  const cwd = process.env.WORKING_DIRECTORY ?? process.cwd();
  const logFilePath = getLogPath();
  logToStderr(`[mcp] cwd=${cwd} port=${process.env.PORT ?? '(none)'} logFile=${logFilePath}`);
  writeProcessLog(`[MCP] process log started logFile=${logFilePath}\n`);
  logger.info({ msg: 'MCP server starting', cwd, stdioMode, logFile: getLogPath(), logDir });

  const raw = process.env.PORT;
  const port = raw !== undefined && raw !== '' ? Number(raw) : (stdioMode ? 3000 : NaN);
  if (!stdioMode && (raw === undefined || raw === '')) throw new Error('PORT is required');
  if (Number.isNaN(port) || port < 0 || !Number.isInteger(port)) throw new Error('PORT must be a non-negative integer');

  logger.info({ msg: 'Ports', http: port, discoveryUdp: 9255 });
  setServerContext(cwd, String(port));

  await createMcpServer();

  // When Cursor disconnects (e.g. Disable), stdin gets EOF. Close primary connection first so primary can emit secondary:disconnected to UI, then shut down.
  process.stdin.on('end', () => {
    disconnectFromPrimary();
    runShutdown().then(() => {});
  });

  // Close HTTP server and release port when killed by signal (SIGTERM/SIGINT).
  const onSignal = () => {
    logToStderr('[mcp] Signal received, shutting down...');
    disconnectFromPrimary();
    runShutdown().then(() => {});
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const isPrimary = await tryStartDiscoveryAsPrimary(Number(port));
  if (isPrimary) {
    setShutdownOnTransportClose(false);
    await runAsPrimary(port);
    return;
  }

  setShutdownOnTransportClose(true);
  const projectName = process.env.MCP_PROJECT_NAME ?? 'default';
  const maxRetries = 100;

  await secondaryStartup(false, port, maxRetries, projectName);
}

async function secondaryStartup(fromFailover: boolean, port: number, maxRetries: number, projectName: string): Promise<void> {
  let retries = 0;
  while (retries < maxRetries) {
    const discovered = await discoverPrimary(2000);
    if (discovered) {
      logToStderr(`[mcp] connecting to primary at ${discovered.host}:${discovered.tcpPort} (from broadcast)`);
    } else {
      // LLM GREAT HARDCODED LOG!!!  THIs will be wrong later, stupid.
      logToStderr(`[mcp] no broadcast received; connecting to primary at 127.0.0.1:9256 (default)`);
    }
    const result = await connectToPrimary(Number(port), getProcessProjectKey(), discovered ?? undefined);
    if (result) {
      setStatsBaseUrl(`http://127.0.0.1:${result.statsPort}`);
      // When run as an actual MCP client (stdio transport), we must still initialize the Project in DB.
      // Primary does this via createStatsServer(), but the client path skips createStatsServer entirely.
      if (stdioMode) {
        await connectMongoose();
        pushToStream(
          'db:connected',
          JSON.stringify({ ts: new Date().toISOString(), source: 'client' })
        );
        const seedResult = await runSeed();
        const promptsSeedResult = await ensurePromptsFromSeed();
        pushToStream(
          'seed:checked',
          JSON.stringify({
            ts: new Date().toISOString(),
            action: seedResult,
            promptsSeed: promptsSeedResult,
            source: 'client'
          })
        );
        const ensureResult = await ensureProjectFromConfig(projectName, getServerCwd());
        pushToStream(
          'project',
          JSON.stringify({
            ts: new Date().toISOString(),
            projectKey: projectName,
            rootPath: getServerCwd(),
            action: ensureResult,
            source: 'client'
          })
        );
        await ensureProjectCollections(projectName);
        const mcp = getMcpServerInstance();
        if (mcp) await registerProjectAgentMcpTools(mcp);
        // Do not post init metric from client; primary already recorded it. Prevents duplicate init events.
        registerShutdown(async () => {
          await disconnectMongoose();
        });
      }
      await markServerReady('client');
      if (stdioMode) {
        try {
          await runFileProcessingStartup(projectName);
          registerShutdown(async () => {
            await stopFileProcessingWatcher(projectName);
          });
        } catch {
          // log and continue so startup does not fail
        }
      }
      registerShutdown(disconnectFromPrimary);
      onPrimaryDisconnect(() => {
        logToStderr('[mcp] Primary disconnected; redoing startup after 0–50ms.');
        disconnectFromPrimary();
        setTimeout(() => secondaryStartup(true, port, maxRetries, projectName), Math.floor(Math.random() * 51));
      });
      logToStderr(`[mcp] Client; metrics → primary at ${result.statsPort}`);
      return;
    }
    const becamePrimary = await tryStartDiscoveryAsPrimary(Number(port));
    if (becamePrimary) {
      await runAsPrimary(port, fromFailover ? { projectName, upgrade: true } : undefined);
      return;
    }
    retries += 1;
    const jitter = Math.floor(Math.random() * (FAILOVER_JITTER_MS + 1));
    await new Promise((r) => setTimeout(r, jitter));
  }
  logToStderr('[mcp] Could not connect to primary or become primary; giving up after retries.');
}

// When run via tsx, require.main can be the tsx loader, so also treat this file as entry when argv[1] is index.
const isEntry =
  (typeof require !== 'undefined' && require.main === module) ||
  (process.argv[1] != null &&
    (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js')));

if (isEntry) {
  const onFatal = (err: unknown): void => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write('[mcp] FATAL: ' + msg + '\n');
    logger.fatal(err);
    process.exit(1);
  };
  try {
    main().catch(onFatal);
  } catch (err) {
    onFatal(err);
  }
}
