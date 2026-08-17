/**
 * Primary client: connect to primary's TCP 9256, handshake to get statsPort,
 * keep connection open for disconnect detection (failover).
 */

import * as net from 'net';

const PRIMARY_TCP_PORT = Number(process.env.PRIMARY_TCP_PORT) || 9256;
const PRIMARY_HOST = process.env.PRIMARY_HOST ?? '127.0.0.1';

let clientSocket: net.Socket | null = null;
let disconnectCallback: (() => void) | null = null;

function clearSocket(): void {
  if (clientSocket) {
    clientSocket.removeAllListeners();
    try {
      clientSocket.destroy();
    } catch {
      // ignore
    }
    clientSocket = null;
  }
}

/**
 * Connect to primary, send { port, projectKey }, receive { statsPort }.
 * If discover is provided (from discoverPrimary()), use that host/port; else use PRIMARY_HOST/PRIMARY_TCP_PORT.
 * Returns { statsPort } and keeps the socket open, or null if connection/handshake failed.
 */
export function connectToPrimary(
  myPort: number,
  projectKey: string,
  discover?: { host: string; tcpPort: number } | null
): Promise<{ statsPort: number } | null> {
  const host = discover?.host ?? PRIMARY_HOST;
  const tcpPort = discover?.tcpPort ?? PRIMARY_TCP_PORT;
  process.stderr.write(`[primaryClient] connecting to ${host}:${tcpPort}\n`);

  return new Promise((resolve) => {
    const socket = net.connect(
      { port: tcpPort, host },
      () => {
        socket.write(JSON.stringify({ port: myPort, projectKey }) + '\n');
      }
    );

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      try {
        const obj = JSON.parse(buffer.slice(0, idx)) as { statsPort?: number };
        const statsPort = obj?.statsPort;
        if (typeof statsPort !== 'number') {
          socket.destroy();
          resolve(null);
          return;
        }
        clientSocket = socket;
        let disconnectFired = false;
        const onDisconnect = () => {
          clearSocket();
          if (disconnectFired) return;
          disconnectFired = true;
          const cb = disconnectCallback;
          disconnectCallback = null;
          cb?.();
        };
        socket.on('close', onDisconnect);
        socket.on('error', onDisconnect);
        resolve({ statsPort });
      } catch {
        socket.destroy();
        resolve(null);
      }
    };
    socket.on('data', onData);

    let resolved = false;
    const done = (): void => {
      if (resolved) return;
      resolved = true;
      resolve(null);
    };

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const msg = err?.code ?? (err instanceof Error ? err.message : String(err));
      process.stderr.write(`[primaryClient] connect to ${host}:${tcpPort} failed: ${msg}\n`);
      done();
    });
    socket.on('close', () => {
      if (!clientSocket && !resolved) {
        process.stderr.write(`[primaryClient] connection closed before handshake (${host}:${tcpPort})\n`);
      }
      done();
    });
  });
}

/**
 * Register a callback to be invoked when the connection to primary closes or errors.
 */
export function onPrimaryDisconnect(callback: () => void): void {
  disconnectCallback = callback;
}

/**
 * Close the connection to primary and clear the disconnect callback.
 */
export function disconnectFromPrimary(): void {
  disconnectCallback = null;
  clearSocket();
}
