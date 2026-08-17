jest.mock('../src/db/mongoose', () => ({
  connectMongoose: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/db/seed', () => ({
  runSeed: jest.fn().mockResolvedValue(undefined),
  ensurePromptsFromSeed: jest.fn().mockResolvedValue('skipped')
}));
jest.mock('../src/db/ensureProject', () => ({
  ensureProjectFromConfig: jest.fn().mockResolvedValue('unchanged' as const)
}));

jest.mock('../src/db/projectDb', () => ({
  ...jest.requireActual('../src/db/projectDb'),
  ensureProjectCollections: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/stats/metricsClient', () => ({
  ...jest.requireActual('../src/stats/metricsClient'),
  postMetric: jest.fn().mockResolvedValue(undefined)
}));

const mockCreate = jest.fn();
const mockFind = jest.fn();
jest.mock('../src/db/models/Metric', () => ({
  Metric: {
    get create() {
      return mockCreate;
    },
    get find() {
      return mockFind;
    }
  }
}));

const mockPushToStream = jest.fn();
jest.mock('../src/stats/streamChannel', () => ({
  pushToStream: (...args: unknown[]) => mockPushToStream(...args)
}));

const mockIncrementFileReads = jest.fn();
const mockSummarizeFileReadWindow = jest.fn();
jest.mock('../src/stats/fileReadHourBuckets', () => ({
  ...jest.requireActual('../src/stats/fileReadHourBuckets'),
  incrementFileReadBucketsAndSummarize: (...a: unknown[]) => mockIncrementFileReads(...a),
  summarizeFileReadWindow: (...a: unknown[]) => mockSummarizeFileReadWindow(...a)
}));

import { createStatsServer } from '../src/stats/server';

function chainMock(leanResult: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(leanResult)
  };
}

describe('Stats metrics routes', () => {
  let fastify: Awaited<ReturnType<typeof createStatsServer>> | undefined;

  beforeAll(async () => {
    fastify = await createStatsServer();
  }, 5000);

  afterAll(async () => {
    if (fastify) await fastify.close();
  });

  beforeEach(() => {
    mockCreate.mockReset();
    mockFind.mockReturnValue(chainMock([]));
    mockPushToStream.mockClear();
    mockIncrementFileReads.mockReset();
    mockIncrementFileReads.mockResolvedValue([]);
    mockSummarizeFileReadWindow.mockReset();
    mockSummarizeFileReadWindow.mockResolvedValue([]);
  });

  describe('POST /metrics', () => {
    it('validates body and returns 400 on invalid', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/metrics',
        payload: { instance_id: 'x' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates metric and pushes to stream', async () => {
      const doc = {
        _id: { toString: () => 'abc123' },
        instance_id: 'i1',
        operation: 'query',
        kind: 'query',
        started_at: new Date('2025-01-01T00:00:00.000Z'),
        ended_at: new Date('2025-01-01T00:00:01.000Z'),
        duration_ms: 100,
        status: 'ok' as const,
        error_code: undefined,
        metadata: { projectKey: 'default' }
      };
      mockCreate.mockResolvedValue(doc);

      const res = await fastify!.inject({
        method: 'POST',
        url: '/metrics',
        payload: {
          instance_id: 'i1',
          operation: 'query',
          kind: 'query',
          started_at: '2025-01-01T00:00:00.000Z',
          ended_at: '2025-01-01T00:00:01.000Z',
          duration_ms: 100,
          status: 'ok'
        }
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
      expect(mockCreate).toHaveBeenCalled();
      expect(mockCreate.mock.calls[0][0]).toMatchObject({
        metadata: { projectKey: 'default' }
      });
      expect(mockPushToStream).toHaveBeenCalledWith('metric', expect.any(String));
      const pushedPayload = JSON.parse(mockPushToStream.mock.calls[0][1]);
      expect(pushedPayload.operation).toBe('query');
      expect(pushedPayload.kind).toBe('query');
      expect(pushedPayload.instance_id).toBe('i1');
      expect(pushedPayload.metadata).toEqual({ projectKey: 'default' });
      expect(new Date(pushedPayload.started_at).toISOString()).toBe(pushedPayload.started_at);
      expect(new Date(pushedPayload.ended_at).toISOString()).toBe(pushedPayload.ended_at);
    });

    it('ingests scan metrics into scan progress cache', async () => {
      const { getScanProgress } = require('../src/stats/scanProgressCache');
      const doc = {
        _id: { toString: () => 'id-scan' },
        instance_id: 'i1',
        operation: 'scan',
        kind: 'event',
        started_at: new Date('2025-01-01T00:00:00.000Z'),
        ended_at: new Date('2025-01-01T00:00:00.000Z'),
        duration_ms: 0,
        status: 'ok' as const,
        error_code: undefined,
        metadata: {
          projectKey: 'scan-ingest-test',
          action: 'update',
          total: 10,
          processedCount: 3,
          processingRelative: ['x.ts', 'y.ts']
        }
      };
      mockCreate.mockResolvedValue(doc);

      const res = await fastify!.inject({
        method: 'POST',
        url: '/metrics',
        payload: {
          instance_id: 'i1',
          operation: 'scan',
          kind: 'event',
          started_at: '2025-01-01T00:00:00.000Z',
          ended_at: '2025-01-01T00:00:00.000Z',
          duration_ms: 0,
          status: 'ok',
          metadata: {
            projectKey: 'scan-ingest-test',
            action: 'update',
            total: 10,
            processedCount: 3,
            processingRelative: ['x.ts', 'y.ts']
          }
        }
      });

      expect(res.statusCode).toBe(200);
      const p = getScanProgress('scan-ingest-test');
      expect(p).not.toBeNull();
      expect(p?.filesProcessed).toBe(3);
      expect(p?.totalFiles).toBe(10);
      expect(p?.files).toEqual([
        { relativePath: 'x.ts', state: 'stale' },
        { relativePath: 'y.ts', state: 'stale' }
      ]);
      expect(p?.isActiveScan).toBe(true);
      expect(mockPushToStream).toHaveBeenCalledWith('scan:progress', expect.any(String));
      const scanCall = mockPushToStream.mock.calls.find((c) => c[0] === 'scan:progress');
      expect(scanCall).toBeDefined();
      const scanPayload = JSON.parse(String(scanCall![1]));
      expect(scanPayload.filesProcessed).toBe(3);
      expect(scanPayload.projectKey).toBe('scan-ingest-test');
      const metricCall = mockPushToStream.mock.calls.filter((c) => c[0] === 'metric');
      expect(metricCall.length).toBe(1);
    });

    it('read operation merges window totals and emits metric', async () => {
      mockIncrementFileReads.mockResolvedValueOnce([{ project: 'acme', total: 11 }]);
      mockCreate.mockImplementationOnce((p: Record<string, unknown>) => {
        const started = p.started_at instanceof Date ? p.started_at : new Date(String(p.started_at));
        const ended = p.ended_at instanceof Date ? p.ended_at : new Date(String(p.ended_at));
        return Promise.resolve({
          ...p,
          _id: { toString: () => 'fr1' },
          started_at: started,
          ended_at: ended
        });
      });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/metrics',
        payload: {
          instance_id: 'i1',
          operation: 'read',
          kind: 'event',
          started_at: '2025-01-01T00:00:00.000Z',
          ended_at: '2025-01-01T00:00:00.000Z',
          duration_ms: 0,
          status: 'ok',
          metadata: { entries: [{ projectKey: 'acme', count: 2 }] }
        }
      });
      expect(res.statusCode).toBe(200);
      expect(mockIncrementFileReads).toHaveBeenCalled();
      const metricCall = mockPushToStream.mock.calls.find((c) => c[0] === 'metric');
      expect(metricCall).toBeDefined();
      const mp = JSON.parse(String(metricCall![1]));
      expect(mp.metadata.totals).toEqual([{ project: 'acme', total: 11 }]);
      expect(mp.metadata.windowDays).toBe(7);
    });

    it('legacy file_reads_batch operation still merges window totals', async () => {
      mockIncrementFileReads.mockResolvedValueOnce([{ project: 'legacy', total: 1 }]);
      mockCreate.mockImplementationOnce((p: Record<string, unknown>) => {
        const started = p.started_at instanceof Date ? p.started_at : new Date(String(p.started_at));
        const ended = p.ended_at instanceof Date ? p.ended_at : new Date(String(p.ended_at));
        return Promise.resolve({
          ...p,
          _id: { toString: () => 'fr2' },
          started_at: started,
          ended_at: ended
        });
      });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/metrics',
        payload: {
          instance_id: 'i1',
          operation: 'file_reads_batch',
          kind: 'event',
          started_at: '2025-01-01T00:00:00.000Z',
          ended_at: '2025-01-01T00:00:00.000Z',
          duration_ms: 0,
          status: 'ok',
          metadata: { entries: [{ projectKey: 'legacy', count: 1 }] }
        }
      });
      expect(res.statusCode).toBe(200);
      expect(mockIncrementFileReads).toHaveBeenCalled();
    });
  });

  describe('GET /metrics/file-reads/window', () => {
    it('returns summarized totals', async () => {
      mockSummarizeFileReadWindow.mockResolvedValueOnce([{ project: 'z', total: 3 }]);
      const res = await fastify!.inject({
        method: 'GET',
        url: '/metrics/file-reads/window?days=7'
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ days: 7, totals: [{ project: 'z', total: 3 }] });
    });
  });

  describe('GET /metrics', () => {
    it('returns metrics array and applies query params', async () => {
      mockFind.mockReturnValue(
        chainMock([
          {
            _id: { toString: () => 'id1' },
            instance_id: 'i1',
            operation: 'query',
            kind: 'query',
            started_at: new Date('2025-01-01T00:00:00.000Z'),
            ended_at: new Date('2025-01-01T00:00:01.000Z'),
            duration_ms: 50,
            status: 'ok',
            error_code: undefined,
            metadata: undefined
          }
        ])
      );

      const res = await fastify!.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.metrics).toHaveLength(1);
      expect(body.metrics[0].operation).toBe('query');
      expect(body.metrics[0].metadata).toEqual({ projectKey: 'default' });

      await fastify!.inject({
        method: 'GET',
        url: '/metrics?instance_id=my-instance&operation=scan&since=2025-01-01T00:00:00.000Z&limit=10'
      });
      expect(mockFind).toHaveBeenLastCalledWith(
        expect.objectContaining({
          instance_id: 'my-instance',
          operation: 'scan',
          started_at: { $gte: new Date('2025-01-01T00:00:00.000Z') }
        })
      );
    });
  });
});
