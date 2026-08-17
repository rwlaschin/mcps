/**
 * Integration test: backend stats server accepts Socket.IO client and emits
 * 'connected' then 'heartbeat' (A → B → C = connected). Requires MONGO_URL and
 * a running MongoDB. Run: npm run test:integration
 */

const pathMod = require('path') as typeof import('path');
const { spawn } = require('child_process');
const http = require('http');

const MONGO_URL = process.env.MONGO_URL;
const SOCKET_TEST_PORT = process.env.SOCKET_TEST_PORT ?? '39391';
const SERVER_ENTRY = pathMod.resolve(__dirname, '../../src/index.ts');
const CWD = pathMod.resolve(__dirname, '../..');

const hasMongo = Boolean(MONGO_URL && String(MONGO_URL).trim());

/** Returns true if MongoDB is reachable within 3s (so we can skip the test if not). */
async function mongoReachable(): Promise<boolean> {
  if (!hasMongo) return false;
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(String(MONGO_URL).trim() + '/mcp_code_vault', {
      serverSelectionTimeoutMS: 3000
    });
    await mongoose.disconnect();
    return true;
  } catch {
    return false;
  }
}

function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${port}/config`, (res: import('http').IncomingMessage) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start >= timeoutMs) return reject(new Error(`HTTP ${res.statusCode}`));
        setTimeout(tryOnce, 200);
      });
      req.on('error', () => {
        if (Date.now() - start >= timeoutMs) reject(new Error('Server did not become ready'));
        else setTimeout(tryOnce, 200);
      });
      req.setTimeout(2000, () => { req.destroy(); });
    };
    tryOnce();
  });
}

describe('Socket backend (integration)', () => {
  it(
    'spawns backend and receives connected + heartbeat over Socket.IO',
    async () => {
      if (!hasMongo) {
        console.warn('Socket backend test skipped: set MONGO_URL to run');
        return;
      }
      if (!(await mongoReachable())) {
        console.warn('Socket backend test skipped: MongoDB not reachable at MONGO_URL');
        return;
      }

      const port = Number(SOCKET_TEST_PORT);
      const mongoUrl = String(MONGO_URL).trim();

      const child = spawn('npx', ['tsx', SERVER_ENTRY], {
        cwd: CWD,
        env: { ...process.env, PORT: String(port), MONGO_URL: mongoUrl },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const exitPromise = new Promise<number>((resolve) => {
        child.on('exit', (code: number) => resolve(code ?? -1));
      });

      try {
        await waitForServer(port, 25_000);
      } catch (e) {
        child.kill('SIGTERM');
        await exitPromise;
        const msg = e instanceof Error ? e.message : String(e);
        const out = [stdout, stderr].filter(Boolean).join('\n').slice(-3000);
        throw new Error(`${msg}${out ? `\nChild output:\n${out}` : ''}`);
      }

      const { io } = await import('socket.io-client');
      const socket = io(`http://localhost:${port}`, { autoConnect: true });

      const connected = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for connected')), 5000);
        socket.once('connected', () => {
          clearTimeout(t);
          resolve();
        });
      });
      const heartbeat = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for heartbeat')), 6000);
        socket.once('heartbeat', () => {
          clearTimeout(t);
          resolve();
        });
      });

      await connected;
      await heartbeat;

      socket.disconnect();
      socket.close();
      child.kill('SIGTERM');
      await exitPromise;
    },
    35_000
  );
});

export {};
