import type { FastifyInstance } from 'fastify';
import { Metric, type IMetric } from '../../db/models/Metric';
import { writeProcessLog } from '../../stdioMode';
import { pushToStream } from '../streamChannel';
import { normalizeMetricPayload, ensureMetadataProjectKeyForRead } from '../normalizeMetric';
import { ingestScanMetricMetadata, emitScanProgressFromPayload } from '../scanProgressCache';
import {
  FILE_READ_WINDOW_DAYS,
  incrementFileReadBucketsAndSummarize,
  isReadMetricOperation,
  parseFileReadBatchEntries,
  summarizeFileReadWindow
} from '../fileReadHourBuckets';

const metricBodySchema = {
  type: 'object',
  required: ['instance_id', 'operation', 'kind', 'started_at', 'ended_at', 'duration_ms', 'status'],
  properties: {
    instance_id: { type: 'string' },
    operation: { type: 'string' },
    kind: { type: 'string', enum: ['query', 'event'] },
    started_at: { type: 'string', format: 'date-time' },
    ended_at: { type: 'string', format: 'date-time' },
    duration_ms: { type: 'number' },
    status: { type: 'string', enum: ['ok', 'error'] },
    error_code: { type: 'string' },
    metadata: { type: 'object' },
    role: { type: 'string', enum: ['primary', 'client'] }
  }
};

export async function metricRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
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
  }>('/metrics', {
    schema: { body: metricBodySchema }
  }, async (request, reply) => {
    const { role, ...body } = request.body as typeof request.body & { role?: 'primary' | 'client' };
    const normalized = normalizeMetricPayload(body);

    let metadataForStore: Record<string, unknown> = { ...normalized.metadata };
    if (isReadMetricOperation(normalized.operation)) {
      const entries = parseFileReadBatchEntries(normalized.metadata);
      const totals = await incrementFileReadBucketsAndSummarize(entries, FILE_READ_WINDOW_DAYS);
      metadataForStore = {
        ...metadataForStore,
        totals,
        windowDays: FILE_READ_WINDOW_DAYS
      };
    }

    let doc: IMetric;
    try {
      const created = await Metric.create({
        ...normalized,
        metadata: metadataForStore,
        started_at: new Date(normalized.started_at),
        ended_at: new Date(normalized.ended_at)
      });
      doc = Array.isArray(created) ? created[0] : created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProcessLog(`[MCP] POST /metrics Mongo save failed: ${msg}\n`);
      return reply.status(500).send({ ok: false, error: 'Failed to save metric to database' });
    }
    if (normalized.operation === 'scan') {
      const scanProgress = ingestScanMetricMetadata(normalized.metadata);
      emitScanProgressFromPayload(scanProgress);
    }
    const payload = {
      _id: doc._id?.toString?.() ?? (doc as { id?: string }).id,
      instance_id: doc.instance_id,
      operation: doc.operation,
      kind: doc.kind,
      started_at: doc.started_at.toISOString(),
      ended_at: doc.ended_at.toISOString(),
      duration_ms: doc.duration_ms,
      status: doc.status,
      error_code: doc.error_code,
      metadata: doc.metadata ?? {},
      ...(role ? { role } : {})
    };
    pushToStream('metric', JSON.stringify(payload));
    return reply.send({ ok: true });
  });

  fastify.get<{
    Querystring: { instance_id?: string; operation?: string; since?: string; limit?: string };
  }>('/metrics', async (request, reply) => {
    const query = request.query;
    const filter: Record<string, unknown> = {};
    if (query.instance_id) filter.instance_id = query.instance_id;
    if (query.operation) filter.operation = query.operation;
    if (query.since) filter.started_at = { $gte: new Date(query.since) };
    const limit = Math.min(Math.max(parseInt(query.limit ?? '500', 10), 1), 1000);
    const docs = await Metric.find(filter).sort({ started_at: -1 }).limit(limit).lean();
    const metrics = docs.map((d) => {
      const meta = (d as { metadata?: Record<string, unknown> }).metadata;
      return {
        _id: (d as { _id?: unknown })._id?.toString?.() ?? (d as { id?: string }).id,
        instance_id: (d as { instance_id: string }).instance_id,
        operation: (d as { operation: string }).operation,
        kind: (d as { kind?: string }).kind ?? 'event',
        started_at: (d as { started_at: Date }).started_at?.toISOString?.() ?? new Date((d as { started_at: string }).started_at).toISOString(),
        ended_at: (d as { ended_at: Date }).ended_at?.toISOString?.() ?? new Date((d as { ended_at: string }).ended_at).toISOString(),
        duration_ms: (d as { duration_ms: number }).duration_ms,
        status: (d as { status: string }).status,
        error_code: (d as { error_code?: string }).error_code,
        metadata: ensureMetadataProjectKeyForRead(meta && typeof meta === 'object' ? meta : {})
      };
    });
    return reply.send({ metrics });
  });

  fastify.get<{ Querystring: { days?: string } }>('/metrics/file-reads/window', async (request, reply) => {
    const daysRaw = parseInt(String(request.query.days ?? String(FILE_READ_WINDOW_DAYS)), 10);
    const days = Number.isFinite(daysRaw) ? Math.min(31, Math.max(1, daysRaw)) : FILE_READ_WINDOW_DAYS;
    const totals = await summarizeFileReadWindow(days);
    return reply.send({ days, totals });
  });
}
