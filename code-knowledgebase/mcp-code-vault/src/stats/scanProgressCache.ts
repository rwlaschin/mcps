/**
 * In-memory cache for scan progress.
 * Live UI: Socket.IO **scan:progress** (broadcast + replay on connect + `scan:replay`).
 * POST /metrics with operation `scan` ingests metadata here and broadcasts **scan:progress** + **metric**.
 */

import { pushToStream } from './streamChannel';

export interface ScanProgressPayload {
  filesProcessed: number;
  filesUpdated: number;
  totalFiles?: number;
  isActiveScan?: boolean;
  files?: Array<{ relativePath: string; state: 'new' | 'stale' | 'fresh' }>;
  projectKey?: string;
}

const cache = new Map<string, ScanProgressPayload>();

/**
 * Build the UI-facing scan payload from scan metric metadata (same fields whether from DB or live).
 */
export function buildScanProgressPayloadFromScanMetadata(
  metadata: Record<string, unknown>
): ScanProgressPayload {
  const projectKey =
    typeof metadata.projectKey === 'string' && metadata.projectKey.trim() !== ''
      ? metadata.projectKey.trim()
      : 'default';
  const total = typeof metadata.total === 'number' ? metadata.total : 0;
  const processedCount = typeof metadata.processedCount === 'number' ? metadata.processedCount : 0;
  const action = typeof metadata.action === 'string' ? metadata.action : '';

  const processingRel = Array.isArray(metadata.processingRelative)
    ? metadata.processingRelative.filter((x): x is string => typeof x === 'string')
    : [];

  const prev = cache.get(projectKey);
  const files =
    processingRel.length > 0
      ? processingRel.map((relativePath) => ({ relativePath, state: 'stale' as const }))
      : prev?.files;

  const isActiveScan = action !== '' && action !== 'complete';

  return {
    projectKey,
    filesProcessed: processedCount,
    filesUpdated: processedCount,
    totalFiles: total,
    isActiveScan,
    ...(files !== undefined ? { files } : {})
  };
}

/**
 * Merge scan metadata from POST /metrics into the progress cache (primary process, after Mongo save).
 * Returns the payload pushed on **scan:progress** for callers that need it.
 */
export function ingestScanMetricMetadata(metadata: Record<string, unknown>): ScanProgressPayload {
  const payload = buildScanProgressPayloadFromScanMetadata(metadata);
  cache.set(payload.projectKey ?? 'default', payload);
  return payload;
}

/** Emit legacy Socket.IO event name with metric-derived compatible shape. */
export function emitScanProgressFromPayload(payload: ScanProgressPayload): void {
  pushToStream('scan:progress', JSON.stringify(payload));
}

/** Update cache only (tests / legacy callers). */
export function reportScanProgress(payload: ScanProgressPayload): void {
  const key = payload.projectKey ?? 'default';
  cache.set(key, payload);
}

/** Latest cached payload for a project key (`scan:replay`); no cross-project fallback. */
export function getScanProgress(projectKey: string): ScanProgressPayload | null {
  const k = projectKey.trim();
  if (!k) return null;
  return cache.get(k) ?? null;
}

/** On Socket.IO connect: send each project’s latest cached scan state to this client only. */
export function emitScanProgress(socket: {
  emit: (event: string, payload: string) => void;
}): void {
  for (const payload of cache.values()) {
    socket.emit('scan:progress', JSON.stringify(payload));
  }
}

/** @internal Jest */
export function resetScanProgressCacheForTesting(): void {
  cache.clear();
}
