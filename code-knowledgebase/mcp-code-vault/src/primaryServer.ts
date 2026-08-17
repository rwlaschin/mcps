/**
 * Primary TCP server on port 9256. Client MCPs connect, send { port, projectKey } (legacy: projectName),
 * receive { statsPort }, and keep the connection open (for disconnect detection).
 */

import * as net from 'net';
import { pushToStream } from './stats/streamChannel';

const PRIMARY_TCP_PORT = Number(process.env.PRIMARY_TCP_PORT) || 9256;

let server: net.Server | null = null;
const clientSockets = new Set<net.Socket>();
const clientInfo = new Map<net.Socket, { port: number; projectKey: string }>();

function onClientClose(socket: net.Socket): void {
  const info = clientInfo.get(socket);
  clientInfo.delete(socket);
  clientSockets.delete(socket);
  if (info) {
    pushToStream(
      'secondary:disconnected',
      JSON.stringify({
        port: info.port,
        projectKey: info.projectKey,
        ts: new Date().toISOString()
      })
    );
  }
}

/** Current secondaries (still connected). Used when sending initial state to a new UI client so we only send who is really there. */
export function getCurrentSecondaries(): { port: number; projectKey: string }[] {
  return Array.from(clientInfo.values());
}

export function startPrimaryServer(httpPort: number): void {
  if (server) return;

  server = net.createServer((socket) => {
    clientSockets.add(socket);
    socket.on('close', () => onClientClose(socket));
    socket.on('error', () => onClientClose(socket));

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      try {
        const payload = JSON.parse(buffer.slice(0, idx)) as { port?: number; projectKey?: string; projectName?: string };
        const clientPort = typeof payload?.port === 'number' ? payload.port : 0;
        const clientProjectKey =
          typeof payload?.projectKey === 'string' && payload.projectKey.trim() !== ''
            ? payload.projectKey.trim()
            : typeof payload?.projectName === 'string'
              ? payload.projectName
              : '';
        clientInfo.set(socket, { port: clientPort, projectKey: clientProjectKey });
        socket.write(JSON.stringify({ statsPort: httpPort }) + '\n');
        pushToStream(
          'secondary:connected',
          JSON.stringify({
            port: clientPort,
            projectKey: clientProjectKey,
            ts: new Date().toISOString()
          })
        );
      } catch {
        socket.destroy();
      }
    };
    socket.on('data', onData);
  });

  server.listen(PRIMARY_TCP_PORT, '127.0.0.1', () => {
    // Server ready; connection kept open for client disconnect detection
  });
}

export async function stopPrimaryServer(): Promise<void> {
  if (!server) return;

  for (const s of clientSockets) {
    try {
      s.destroy();
    } catch {
      // ignore
    }
  }
  clientSockets.clear();
  clientInfo.clear();

  await new Promise<void>((resolve, reject) => {
    server!.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  server = null;
}
