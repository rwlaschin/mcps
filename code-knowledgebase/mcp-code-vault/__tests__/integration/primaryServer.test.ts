/**
 * Integration tests for primaryServer: TCP server on 9256 for client MCP handshake.
 * Requires port 9256 to be free. Run: npm run test:integration
 */

import * as net from 'net';
import { startPrimaryServer, stopPrimaryServer } from '@/primaryServer';

const PRIMARY_TCP_PORT = 9256;

describe('primaryServer (integration)', () => {
  afterEach(async () => {
    await stopPrimaryServer();
  });

  it('starts TCP server on 9256 and responds to handshake', async () => {
    startPrimaryServer(3999);

    const result = await new Promise<{ statsPort: number }>((resolve, reject) => {
      const client = net.connect({ port: PRIMARY_TCP_PORT, host: '127.0.0.1' }, () => {
        client.write(JSON.stringify({ port: 3100, projectName: 'my-proj' }) + '\n');
      });
      let buffer = '';
      client.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          try {
            const obj = JSON.parse(buffer.trim()) as { statsPort: number };
            resolve(obj);
          } catch (e) {
            reject(e);
          }
          client.destroy();
        }
      });
      client.on('error', reject);
    });

    expect(result).toEqual({ statsPort: 3999 });
  });

  it('keeps connection open after handshake', async () => {
    startPrimaryServer(3000);

    const result = await new Promise<{ gotResponse: boolean; stillOpen: boolean }>((resolve, reject) => {
      const client = net.connect({ port: PRIMARY_TCP_PORT, host: '127.0.0.1' }, () => {
        client.write(JSON.stringify({ port: 3100, projectName: 'p' }) + '\n');
      });
      let gotResponse = false;
      client.on('data', () => {
        gotResponse = true;
        setImmediate(() => {
          const stillOpen = client.writable && !client.destroyed;
          client.destroy();
          resolve({ gotResponse, stillOpen });
        });
      });
      client.on('error', reject);
    });

    expect(result.gotResponse).toBe(true);
    expect(result.stillOpen).toBe(true);
  });

  it('stopPrimaryServer closes server and client sockets', async () => {
    startPrimaryServer(3000);

    const client = net.connect({ port: PRIMARY_TCP_PORT, host: '127.0.0.1' }, () => {
      client.write(JSON.stringify({ port: 3100, projectName: 'p' }) + '\n');
    });

    const gotResponse = await new Promise<boolean>((resolve) => {
      client.on('data', () => resolve(true));
      client.on('close', () => resolve(false));
    });
    expect(gotResponse).toBe(true);

    await stopPrimaryServer();

    await expect(
      new Promise<void>((resolve, reject) => {
        const c = net.connect({ port: PRIMARY_TCP_PORT, host: '127.0.0.1' });
        c.on('connect', () => resolve());
        c.on('error', (err) => reject(err));
      })
    ).rejects.toThrow();
  });

  it('is safe to call stopPrimaryServer when never started', async () => {
    await expect(stopPrimaryServer()).resolves.toBeUndefined();
  });
});
