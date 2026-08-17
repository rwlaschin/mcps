/**
 * Stream to all connected UI clients. Socket.IO (primary) + optional SSE.
 * MCP POSTs to /metrics → Mongo → pushToStream → io.emit / subscribers.
 */

import type { Server as SocketIOServer } from 'socket.io';
import { getProcessProjectKey } from '../projectKey';
import { writeProcessLog } from '../stdioMode';

type StreamMessage = { event: string; data: string };
type Subscriber = (msg: StreamMessage | null) => void;
const subscribers = new Set<Subscriber>();
let io: SocketIOServer | null = null;
let streamRole: 'primary' | 'client' | null = null;

export function setSocketIO(socketServer: SocketIOServer): void {
  io = socketServer;
}

/** Set when this process is the primary (has Socket.IO and stats server). Used so query/metric events can include source. */
export function setStreamRole(role: 'primary' | 'client'): void {
  streamRole = role;
}

export function getStreamRole(): 'primary' | 'client' | null {
  return streamRole;
}

/** Push a metric (or any event) to the stream. Every connected client receives it. */
export function pushToStream(event: string, data: string): void {
  const msg: StreamMessage = { event, data };
  if (io) io.emit(event, data);
  const subs = Array.from(subscribers);
  subscribers.clear();
  subs.forEach((resolve) => resolve(msg));
}

function waitNext(timeoutMs: number): Promise<StreamMessage | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      subscribers.delete(deliver);
      resolve(null);
    }, timeoutMs);
    const deliver: Subscriber = (msg: StreamMessage | null) => {
      clearTimeout(t);
      subscribers.delete(deliver);
      resolve(msg);
    };
    subscribers.add(deliver);
  });
}

const HEARTBEAT_MS = 5000;

/** Live stream liveness payload (Socket.IO + SSE). Always includes projectKey (e.g. `'default'` when env unset). */
export function buildStreamHeartbeatPayload(
  statsPort: number,
  ts: string = new Date().toISOString()
): { ts: string; port: number; projectKey: string } {
  const p = Number(statsPort);
  return {
    ts,
    port: Number.isFinite(p) ? p : 0,
    projectKey: getProcessProjectKey()
  };
}

function sseStreamJson(ts: string): string {
  const raw = process.env.PORT;
  const portGuess = raw !== undefined && raw !== '' ? Number(raw) : 0;
  return JSON.stringify(buildStreamHeartbeatPayload(portGuess, ts));
}

/** Async generator for SSE (tests / legacy): connected, immediate heartbeat, then metric or heartbeat. */
export async function* streamToUI(): AsyncGenerator<StreamMessage> {
  const ts0 = new Date().toISOString();
  yield { event: 'connected', data: sseStreamJson(ts0) };
  yield { event: 'heartbeat', data: sseStreamJson(new Date().toISOString()) };
  while (true) {
    const msg = await waitNext(HEARTBEAT_MS);
    if (msg) {
      yield msg;
    } else {
      yield {
        event: 'heartbeat',
        data: sseStreamJson(new Date().toISOString())
      };
    }
  }
}
