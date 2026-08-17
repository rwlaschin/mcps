/**
 * Shutdown hooks: run when stdio (MCP transport) closes so we exit cleanly.
 * Disconnect Mongo, close HTTP/Socket.IO, close logs, then process.exit(0).
 * Only run shutdown on transport close when this process is a secondary; when
 * primary we must not exit so the TCP server stays up and secondaries don't see "connection closed".
 */

type ShutdownFn = () => void | Promise<void>;
const hooks: ShutdownFn[] = [];
let running = false;

/** When true, transport onclose will run disconnectFromPrimary + runShutdown. Set true only for secondary. */
let shutdownOnTransportClose = false;

export function setShutdownOnTransportClose(value: boolean): void {
  shutdownOnTransportClose = value;
}

export function getShutdownOnTransportClose(): boolean {
  return shutdownOnTransportClose;
}

export function registerShutdown(fn: ShutdownFn): void {
  hooks.push(fn);
}

export async function runShutdown(): Promise<never> {
  if (running) return process.exit(0) as never;
  running = true;
  for (const fn of hooks) {
    try {
      await Promise.resolve(fn());
    } catch {
      // continue with other hooks
    }
  }
  process.exit(0);
}
