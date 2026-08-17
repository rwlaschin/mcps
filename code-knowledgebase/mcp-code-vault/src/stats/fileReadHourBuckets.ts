/**
 * Persist file-read counts per project per local clock hour; rolling window sums match the stats UI (default 7 local calendar days).
 */

import { FileReadHourBucket } from '../db/models/FileReadHourBucket';

/** Metric.operation verb, same style as `scan`. */
export const METRIC_OPERATION_READ = 'read';

const LEGACY_METRIC_OPERATION_READ = 'file_reads_batch';

/** POST /metrics body `operation` — `read` or legacy `file_reads_batch` rolls up into hour buckets. */
export function isReadMetricOperation(operation: string): boolean {
  return operation === METRIC_OPERATION_READ || operation === LEGACY_METRIC_OPERATION_READ;
}

/** Default window: same span as platform-ui `last7Days` chart (7 inclusive local calendar days). */
export const FILE_READ_WINDOW_DAYS = 7;

/** Local wall-clock hour label: yyyy/MM/dd HH (zero-padded month, day, hour). */
export function formatLocalHourKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}/${m}/${day} ${h}`;
}

function formatLocalDayHourKey(d: Date, hour: number): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(hour).padStart(2, '0');
  return `${y}/${m}/${day} ${h}`;
}

/**
 * Inclusive local calendar day range [start 00:00 .. end 23:00] as hourKey strings (lexicographic compare works).
 */
export function localCalendarHourKeyRange(numDays: number): { minKey: string; maxKey: string } {
  const now = new Date();
  const endCal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startCal = new Date(endCal);
  startCal.setDate(startCal.getDate() - (numDays - 1));
  return {
    minKey: formatLocalDayHourKey(startCal, 0),
    maxKey: formatLocalDayHourKey(endCal, 23)
  };
}

export function parseFileReadBatchEntries(meta: Record<string, unknown>): { projectKey: string; count: number }[] {
  const raw = meta.entries;
  if (!Array.isArray(raw)) return [];
  const out: { projectKey: string; count: number }[] = [];
  for (const row of raw) {
    if (row == null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pk = typeof r.projectKey === 'string' ? r.projectKey.trim() : '';
    const c = typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0 ? Math.floor(r.count) : 0;
    if (pk !== '' && c > 0) out.push({ projectKey: pk, count: c });
  }
  return out;
}

/**
 * $inc per (projectKey, local hour); returns [{ project, total }] for the rolling local calendar window.
 */
export async function incrementFileReadBucketsAndSummarize(
  entries: { projectKey: string; count: number }[],
  windowDays: number,
  at: Date = new Date()
): Promise<{ project: string; total: number }[]> {
  const hourKey = formatLocalHourKey(at);
  for (const e of entries) {
    await FileReadHourBucket.updateOne(
      { projectKey: e.projectKey, hourKey },
      { $inc: { count: e.count } },
      { upsert: true }
    );
  }
  return summarizeFileReadWindow(windowDays);
}

export async function summarizeFileReadWindow(
  windowDays: number
): Promise<{ project: string; total: number }[]> {
  const { minKey, maxKey } = localCalendarHourKeyRange(windowDays);
  const agg = await FileReadHourBucket.aggregate<{ _id: string; total: number }>([
    { $match: { hourKey: { $gte: minKey, $lte: maxKey } } },
    { $group: { _id: '$projectKey', total: { $sum: '$count' } } },
    { $sort: { _id: 1 } }
  ]);
  return agg.map((x) => ({ project: x._id, total: x.total }));
}
