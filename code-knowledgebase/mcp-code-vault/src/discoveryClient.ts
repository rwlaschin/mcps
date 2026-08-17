/**
 * Discovery client: listen on UDP port 9255 for UI broadcast messages.
 * When we receive { registerUrl }, POST to that URL with { port } so the UI can list MCP servers.
 * If the advertised host is this machine's IP, use 127.0.0.1 so we don't depend on the UI listening on 0.0.0.0.
 * Throttle: at most once per REGISTER_THROTTLE_MS per registerUrl (5s; matches UI broadcast cadence).
 */

import * as dgram from 'dgram';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { logger } from './logger';

const log = logger.child({ component: 'discovery' });
const PREFIX = '[mcp] [discovery]';

const DISCOVERY_PORT = 9255;
/** At most one registration per URL per 5s (matches UI broadcast interval; dedupes duplicate UDP delivery). */
const REGISTER_THROTTLE_MS = 5_000;

/** Port for primary to announce how to connect (TCP host + port). Broadcast to 255.255.255.255 and unicast to 127.0.0.1. */
export const PRIMARY_ANNOUNCE_PORT = 9257;
const PRIMARY_ANNOUNCE_INTERVAL_MS = 2000;

let socket: dgram.Socket | null = null;
let announceSocket: dgram.Socket | null = null;
let announceInterval: ReturnType<typeof setInterval> | null = null;
const lastRegisterByUrl = new Map<string, number>();

/** Primary's project name for register body (set by startDiscoveryClient). */
let registerProjectName: string | null = null;
/** When set, next register includes upgrade: true and this projectName (UI replaces secondary chip). Cleared after send. */
let registerUpgradeProjectName: string | null = null;

export function setRegisterUpgrade(projectName: string): void {
  registerUpgradeProjectName = projectName;
}

/** This machine's non-loopback IPv4 addresses (e.g. 10.0.0.122). */
function getLocalAddresses(): Set<string> {
  const set = new Set<string>();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.address) set.add(a.address);
    }
  }
  return set;
}

/** Resolve register URL: if the host is this machine, use localhost so registration works (UI may listen on IPv6 ::1 only). */
function resolveRegisterUrl(registerUrl: string, localAddresses: Set<string>): string {
  const u = new URL(registerUrl);
  const host = u.hostname.toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return registerUrl;
  if (localAddresses.has(u.hostname)) {
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//localhost:${port}${u.pathname}`;
  }
  return registerUrl;
}

/** Attach the message handler (UI broadcast → POST to registerUrl with port) to the given socket. */
function attachMessageHandler(sock: dgram.Socket, port: number): void {
  const localAddresses = getLocalAddresses();
  sock.on('message', (msg) => {
    try {
      const raw = msg.toString('utf8');
      const payload = JSON.parse(raw) as { registerUrl?: string };
      const registerUrl = payload?.registerUrl;
      if (typeof registerUrl !== 'string' || !registerUrl.startsWith('http')) return;
      const now = Date.now();
      const last = lastRegisterByUrl.get(registerUrl) ?? 0;
      if (now - last < REGISTER_THROTTLE_MS) return;
      lastRegisterByUrl.set(registerUrl, now);

      const url = resolveRegisterUrl(registerUrl, localAddresses);
      const projectName = registerUpgradeProjectName ?? registerProjectName ?? `mcp-${port}`;
      const bodyObj: { port: number; projectName: string; upgrade?: boolean } = { port, projectName };
      if (registerUpgradeProjectName) {
        bodyObj.upgrade = true;
        registerUpgradeProjectName = null;
      }
      const body = JSON.stringify(bodyObj);
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const reqPort = u.port || (isHttps ? '443' : '80');
      const options: http.RequestOptions = {
        hostname: u.hostname,
        port: reqPort,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8')
        }
      };
      const req = (isHttps ? https : http).request(options, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          log.info({ msg: `${PREFIX} Registered with UI at ${url}; stats port ${port}` });
        }
      });
      req.on('error', (err) => {
        log.warn({
          msg: `${PREFIX} Register failed: ${(err as Error).message}. Could not reach UI at ${url}. Ensure the UI is running (e.g. npm run dev in platform-ui).`
        });
      });
      req.setTimeout(5000, () => req.destroy());
      req.write(body);
      req.end();
    } catch {
      // ignore parse errors
    }
  });
}

/**
 * Try to bind UDP DISCOVERY_PORT (9255) as the primary. Resolves true if we bound, false if EADDRINUSE.
 * When true, the socket is bound with the same message handler (UI broadcast → POST with port); caller
 * may then call startDiscoveryClient(port) (idempotent) or rely on this binding.
 * Idempotent: if already bound, returns true.
 */
export function tryStartDiscoveryAsPrimary(port: number): Promise<boolean> {
  if (socket) return Promise.resolve(true);

  const localAddresses = getLocalAddresses();
  const s = dgram.createSocket('udp4');
  socket = s;

  return new Promise((resolve, reject) => {
    s.once('listening', () => {
      try {
        s.setBroadcast(true);
      } catch {
        // optional
      }
      log.info({
        msg: `${PREFIX} Listening on UDP ${DISCOVERY_PORT} | stats port ${port} | will register with UI when it broadcasts`
      });
      resolve(true);
    });
    s.once('error', (err: NodeJS.ErrnoException) => {
      socket = null;
      s.close();
      if (err.code === 'EADDRINUSE') {
        log.info({
          msg: `${PREFIX} Port 9255 in use; skipping discovery (another MCP on this host may be listening).`
        });
        resolve(false);
      } else {
        log.error({ err, msg: `${PREFIX} UDP listener error` });
        reject(err);
      }
    });

    attachMessageHandler(s, port);
    s.bind(DISCOVERY_PORT);
  });
}

export function startDiscoveryClient(port: number, projectName?: string): void {
  registerProjectName = projectName ?? null;
  if (socket) return;
  const localAddresses = getLocalAddresses();
  socket = dgram.createSocket('udp4');
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.info({
        msg: `${PREFIX} Port 9255 in use; skipping discovery (another MCP on this host may be listening).`
      });
    } else {
      log.error({ err, msg: `${PREFIX} UDP listener error` });
    }
  });
  attachMessageHandler(socket, port);
  socket.bind(DISCOVERY_PORT, () => {
    try {
      socket?.setBroadcast(true);
    } catch {
      // optional
    }
    log.info({
      msg: `${PREFIX} Listening on UDP ${DISCOVERY_PORT} | stats port ${port} | will register with UI when it broadcasts`
    });
  });
}

export function stopDiscoveryClient(): void {
  if (socket) {
    socket.close();
    socket = null;
  }
  lastRegisterByUrl.clear();
  stopPrimaryAnnouncer();
}

/**
 * Primary only: broadcast how to connect (TCP host + port) on multicast so secondaries can discover.
 * Call when this process is primary (has 9255). Stops on stopDiscoveryClient or stopPrimaryAnnouncer.
 */
export function startPrimaryAnnouncer(primaryTcpHost: string, primaryTcpPort: number): void {
  if (announceInterval != null) return;

  const s = dgram.createSocket('udp4');
  announceSocket = s;
  s.on('error', () => {
    try {
      s.close();
    } catch {
      // ignore
    }
    announceSocket = null;
  });

  const payload = JSON.stringify({ primaryTcpHost, primaryTcpPort }) + '\n';
  const buf = Buffer.from(payload, 'utf8');

  try {
    s.setBroadcast(true);
  } catch {
    // optional
  }

  log.info({
    msg: `${PREFIX} primary: broadcasting connect info ${primaryTcpHost}:${primaryTcpPort} to 255.255.255.255:${PRIMARY_ANNOUNCE_PORT} every ${PRIMARY_ANNOUNCE_INTERVAL_MS}ms`
  });

  announceInterval = setInterval(() => {
    if (announceSocket == null) return;
    try {
      s.send(buf, 0, buf.length, PRIMARY_ANNOUNCE_PORT, '127.0.0.1');
    } catch (err) {
      log.warn({ err, msg: `${PREFIX} primary: loopback announce send error` });
    }
    try {
      s.send(buf, 0, buf.length, PRIMARY_ANNOUNCE_PORT, '255.255.255.255');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENETUNREACH') {
        log.warn({ err, msg: `${PREFIX} primary: broadcast send error` });
      }
    }
  }, PRIMARY_ANNOUNCE_INTERVAL_MS);
}

export function stopPrimaryAnnouncer(): void {
  if (announceInterval != null) {
    clearInterval(announceInterval);
    announceInterval = null;
  }
  if (announceSocket != null) {
    try {
      announceSocket.close();
    } catch {
      // ignore
    }
    announceSocket = null;
  }
}

/**
 * Secondary: listen for primary's multicast announcement. Resolves with { host, tcpPort } or null after timeout.
 */
export function discoverPrimary(timeoutMs: number): Promise<{ host: string; tcpPort: number } | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      log.debug({
        msg: `${PREFIX} discoverPrimary timeout (${timeoutMs}ms), no broadcast received`
      });
      s.close();
      resolve(null);
    }, timeoutMs);

    const onMessage = (msg: Buffer) => {
      try {
        const raw = msg.toString('utf8').split('\n')[0];
        const obj = JSON.parse(raw) as { primaryTcpHost?: string; primaryTcpPort?: number };
        const host = typeof obj?.primaryTcpHost === 'string' ? obj.primaryTcpHost : null;
        const tcpPort = typeof obj?.primaryTcpPort === 'number' ? obj.primaryTcpPort : null;
        if (host != null && tcpPort != null) {
          s.removeListener('message', onMessage);
          log.info({ msg: `${PREFIX} received primary announcement: ${host}:${tcpPort}` });
          clearTimeout(timer);
          s.close();
          resolve({ host, tcpPort });
        }
      } catch {
        // ignore
      }
    };
    s.on('message', onMessage);
    s.on('error', (err: NodeJS.ErrnoException) => {
      log.warn({
        err,
        msg: `${PREFIX} discoverPrimary listen error: ${err?.code ?? err?.message ?? err}`
      });
      clearTimeout(timer);
      s.close();
      resolve(null);
    });

    s.bind(PRIMARY_ANNOUNCE_PORT, () => {
      log.info({
        msg: `${PREFIX} listening for primary announcement on port ${PRIMARY_ANNOUNCE_PORT} (timeout ${timeoutMs}ms)`
      });
    });
  });
}
