/**
 * Single place for the canonical metric/query format: operation, kind, metadata (always present).
 * Every metadata object includes `projectKey`: explicit value, else MCP_PROJECT_KEY / MCP_PROJECT_NAME, else 'default'.
 */

import { getProcessProjectKey } from '../projectKey';

export type NormalizedMetricBody = {
  instance_id: string;
  operation: string;
  kind: 'query' | 'event';
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  error_code?: string;
  metadata: Record<string, unknown>;
};

type PartialMetricBody = Omit<NormalizedMetricBody, 'metadata'> & { metadata?: Record<string, unknown> };

/** Resolve projectKey for incoming metrics (POST /metrics, postMetric). Accepts legacy metadata.projectName. */
export function resolveProjectKeyForMetricMetadata(meta: Record<string, unknown>): string {
  const raw = meta.projectKey ?? meta.projectName;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return getProcessProjectKey();
}

/**
 * Legacy DB rows may have projectName only; normalize reads to always expose projectKey (no duplicate name key).
 */
export function ensureMetadataProjectKeyForRead(meta: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const base = meta && typeof meta === 'object' ? { ...meta } : {};
  const raw = base.projectKey ?? base.projectName;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const { projectName: _drop, ...rest } = base as Record<string, unknown>;
    return { ...rest, projectKey: String(raw).trim() };
  }
  const { projectName: _drop2, ...rest2 } = base as Record<string, unknown>;
  return { ...rest2, projectKey: 'default' };
}

/**
 * Normalize a metric payload: metadata always includes projectKey (drops legacy projectName from stored metadata).
 */
export function normalizeMetricPayload(body: PartialMetricBody): NormalizedMetricBody {
  const base = body.metadata && typeof body.metadata === 'object' ? { ...body.metadata } : {};
  const projectKey = resolveProjectKeyForMetricMetadata(base);
  const { projectName: _drop, ...rest } = base as Record<string, unknown>;
  return {
    ...body,
    metadata: { ...rest, projectKey }
  } as NormalizedMetricBody;
}
