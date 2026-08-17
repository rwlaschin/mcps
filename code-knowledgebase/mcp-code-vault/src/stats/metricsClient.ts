/**
 * Metrics client: POST to stats server (POST /metrics).
 * Queues metrics until the stats server is ready, then flushes.
 * Routine metric posts are silent; only failures are written to the process log.
 */

import { writeProcessLog } from '../stdioMode';
import { normalizeMetricPayload } from './normalizeMetric';

const INSTANCE_ID = process.env.INSTANCE_ID ?? 'mcp-code-vault';

export type MetricPayload = {
  instance_id: string;
  operation: string;
  kind: 'query' | 'event';
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  error_code?: string;
  metadata?: Record<string, unknown>;
};

let statsBaseUrlOverride: string | null = null;
/** Role for metrics: primary sends to its own server; client sends to primary's server. */
let metricsRole: 'primary' | 'client' | null = null;

function getStatsBase(): string {
  if (statsBaseUrlOverride) return statsBaseUrlOverride;
  const port = process.env.STATS_PORT ?? process.env.PORT ?? '3000';
  return `http://127.0.0.1:${port}`;
}

/**
 * Override the stats server base URL (e.g. primary's URL when running as client).
 * Used when we are a client and got statsPort from primary.
 */
export function setStatsBaseUrl(url: string): void {
  statsBaseUrlOverride = url.replace(/\/$/, '');
}

/**
 * Mark the stats server as ready and switch to send + flush queue.
 * Pass 'server' when this process is the primary (stats server); pass 'client' when we are a client sending to primary.
 */
export function markServerReady(role: 'client' | 'server'): void {
  metricsRole = role === 'server' ? 'primary' : 'client';
  metricSender.markServerReady();
}

/**
 * Sends metrics to the stats server. Queues until server is ready, then post becomes send and queue is flushed.
 * Your design: post() only pushes; when ready, this.post = this.send and flush queue.
 */
class MetricSender {
  messageQueue: MetricPayload[] = [];

  /** After server is ready: post becomes send, then flush queue. */
  markServerReady(): void {
    this.post = this.send;
    this.messageQueue.forEach(this.post);
    this.messageQueue = [];
  }

  /** Queue only. After markServerReady(), this is reassigned to send. */
  post = (payload: MetricPayload): Promise<void> => {
    this.messageQueue.push(payload);
    return Promise.resolve();
  };

  /** Actually POST one metric to the stats server. Awaited so process does not exit before send. */
  send = async (payload: MetricPayload): Promise<void> => {
    const base = getStatsBase();
    const body = metricsRole ? { ...payload, role: metricsRole } : payload;
    try {
      const res = await fetch(`${base}/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        writeProcessLog(`[MCP] POST /metrics failed ${res.status} operation=${payload.operation}: ${text.slice(0, 200)}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProcessLog(`[MCP] POST /metrics error operation=${payload.operation}: ${msg}\n`);
    }
  };
}

const metricSender = new MetricSender();

/** Reset queue and sender state (for tests only). */
export function resetMetricSenderForTesting(): void {
  statsBaseUrlOverride = null;
  metricsRole = null;
  metricSender.messageQueue = [];
  metricSender.post = (payload: MetricPayload): Promise<void> => {
    metricSender.messageQueue.push(payload);
    return Promise.resolve();
  };
}

export async function postMetric(payload: MetricPayload): Promise<void> {
  const normalized = normalizeMetricPayload(payload);
  await metricSender.post(normalized);
}

/**
 * Wraps an async handler with metrics: records start/end, duration_ms, status,
 * POSTs to stats server with operation and kind (query = user-initiated, event = other).
 */
export function withMetrics<TArgs extends unknown[], TResult>(
  operation: string,
  kind: 'query' | 'event',
  handler: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const started_at = new Date().toISOString();
    let status: 'ok' | 'error' = 'ok';
    let error_code: string | undefined;
    try {
      const result = await handler(...args);
      return result;
    } catch (err) {
      status = 'error';
      error_code = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const ended_at = new Date().toISOString();
      const started = new Date(started_at).getTime();
      const ended = new Date(ended_at).getTime();
      const duration_ms = Math.max(0, ended - started);
      await postMetric({
        instance_id: INSTANCE_ID,
        operation,
        kind,
        started_at,
        ended_at,
        duration_ms,
        status,
        error_code,
        metadata: {}
      });
    }
  };
}
