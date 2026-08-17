/**
 * metricsClient: postMetric, withMetrics.
 * Tests define expected behaviour (TDD-style); fetch is mocked.
 */
const originalFetch = globalThis.fetch;

describe('metricsClient', () => {
  let fetchCalls: { url: string; init: RequestInit }[] = [];

  beforeAll(() => {
    globalThis.fetch = jest.fn((url: string, init?: RequestInit) => {
      fetchCalls.push({ url: url as string, init: init || {} });
      return Promise.resolve({ ok: true } as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    fetchCalls = [];
    delete process.env.STATS_PORT;
    delete process.env.PORT;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  describe('postMetric', () => {
    it('does nothing when PORT and STATS_PORT are unset', () => {
      const { postMetric } = require('../src/stats/metricsClient');
      postMetric({
        instance_id: 'id',
        operation: 'op',
        kind: 'event',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 1,
        status: 'ok'
      });
      expect(fetchCalls.length).toBe(0);
    });
    it('POSTs to http://127.0.0.1:PORT/metrics when PORT is set', async () => {
      process.env.PORT = '3999';
      await jest.isolateModulesAsync(async () => {
        const { postMetric, markServerReady } = require('../src/stats/metricsClient');
        await postMetric({
          instance_id: 'id',
          operation: 'op',
          kind: 'event',
          started_at: '2020-01-01T00:00:00.000Z',
          ended_at: '2020-01-01T00:00:00.001Z',
          duration_ms: 1,
          status: 'ok'
        });
        markServerReady('server');
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0].url).toBe('http://127.0.0.1:3999/metrics');
        expect(fetchCalls[0].init.method).toBe('POST');
        expect(JSON.parse(fetchCalls[0].init.body as string)).toMatchObject({
          instance_id: 'id',
          operation: 'op',
          status: 'ok',
          duration_ms: 1,
          metadata: { projectKey: 'default' }
        });
      });
    });
  });

  describe('setStatsBaseUrl and markServerReady(client)', () => {
    it('after setStatsBaseUrl and markServerReady(client), postMetric sends POST to that URL', () => {
      jest.isolateModules(() => {
        const {
          setStatsBaseUrl,
          markServerReady,
          postMetric,
          resetMetricSenderForTesting
        } = require('../src/stats/metricsClient');
        resetMetricSenderForTesting();
        setStatsBaseUrl('http://127.0.0.1:9999');
        postMetric({
          instance_id: 'id',
          operation: 'op',
          kind: 'event',
          started_at: '2020-01-01T00:00:00.000Z',
          ended_at: '2020-01-01T00:00:00.001Z',
          duration_ms: 1,
          status: 'ok'
        });
        markServerReady('client');
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0].url).toBe('http://127.0.0.1:9999/metrics');
        expect(fetchCalls[0].init.method).toBe('POST');
      });
    });
    it('queued metrics before markServerReady(client) are flushed', () => {
      jest.isolateModules(() => {
        const {
          setStatsBaseUrl,
          markServerReady,
          postMetric,
          resetMetricSenderForTesting
        } = require('../src/stats/metricsClient');
        resetMetricSenderForTesting();
        setStatsBaseUrl('http://127.0.0.1:8888');
        postMetric({
          instance_id: 'a',
          operation: 'o1',
          kind: 'event',
          started_at: '2020-01-01T00:00:00.000Z',
          ended_at: '2020-01-01T00:00:00.001Z',
          duration_ms: 1,
          status: 'ok'
        });
        postMetric({
          instance_id: 'b',
          operation: 'o2',
          kind: 'query',
          started_at: '2020-01-01T00:00:00.000Z',
          ended_at: '2020-01-01T00:00:00.002Z',
          duration_ms: 2,
          status: 'ok'
        });
        markServerReady('client');
        expect(fetchCalls.length).toBe(2);
        expect(fetchCalls[0].url).toBe('http://127.0.0.1:8888/metrics');
        expect(fetchCalls[1].url).toBe('http://127.0.0.1:8888/metrics');
      });
    });
  });

  describe('withMetrics', () => {
    it('returns handler result and POSTs metric with status ok', async () => {
      process.env.PORT = '4000';
      const { withMetrics, markServerReady, resetMetricSenderForTesting } = require('../src/stats/metricsClient');
      resetMetricSenderForTesting();
      const handler = jest.fn().mockResolvedValue(42);
      const wrapped = withMetrics('testOp', 'query', handler);
      const result = await wrapped();
      markServerReady('server');
      expect(result).toBe(42);
      expect(handler).toHaveBeenCalled();
      expect(fetchCalls.length).toBe(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.operation).toBe('testOp');
      expect(body.status).toBe('ok');
      expect(body.metadata).toEqual({ projectKey: 'default' });
    });
    it('rethrows and POSTs metric with status error when handler throws', async () => {
      process.env.PORT = '4001';
      const { withMetrics, markServerReady, resetMetricSenderForTesting } = require('../src/stats/metricsClient');
      resetMetricSenderForTesting();
      const err = new Error('fail');
      const handler = jest.fn().mockRejectedValue(err);
      const wrapped = withMetrics('errOp', 'event', handler);
      await expect(wrapped()).rejects.toThrow('fail');
      markServerReady('server');
      expect(fetchCalls.length).toBe(1);
      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.operation).toBe('errOp');
      expect(body.status).toBe('error');
      expect(body.error_code).toBe('fail');
      expect(body.metadata).toEqual({ projectKey: 'default' });
    });
  });
});
