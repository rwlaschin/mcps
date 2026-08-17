/**
 * Exercises metricsClient paths not covered when the module is fully mocked in server tests.
 */
import {
  markServerReady,
  postMetric,
  resetMetricSenderForTesting,
  setStatsBaseUrl,
  withMetrics
} from '../src/stats/metricsClient';

describe('metricsClient (integration-style)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetMetricSenderForTesting();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => ''
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetMetricSenderForTesting();
  });

  it('setStatsBaseUrl strips trailing slash', async () => {
    setStatsBaseUrl('http://127.0.0.1:4000/');
    markServerReady('server');
    await postMetric({
      instance_id: 't',
      operation: 'op',
      kind: 'event',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 1,
      status: 'ok'
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/metrics',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.role).toBe('primary');
  });

  it('markServerReady(client) tags metrics as secondary role', async () => {
    setStatsBaseUrl('http://127.0.0.1:5001');
    markServerReady('client');
    await postMetric({
      instance_id: 't',
      operation: 'op',
      kind: 'query',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 2,
      status: 'ok'
    });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.role).toBe('client');
  });

  it('send logs non-ok response without throwing', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'busy'
    });
    markServerReady('server');
    await expect(
      postMetric({
        instance_id: 't',
        operation: 'op',
        kind: 'event',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 1,
        status: 'ok'
      })
    ).resolves.toBeUndefined();
  });

  it('send swallows fetch network errors', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('econnrefused'));
    markServerReady('server');
    await expect(
      postMetric({
        instance_id: 't',
        operation: 'op',
        kind: 'event',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: 1,
        status: 'ok'
      })
    ).resolves.toBeUndefined();
  });

  it('withMetrics records error status and rethrows', async () => {
    markServerReady('server');
    const wrapped = withMetrics('boom', 'query', async () => {
      throw new Error('fail-op');
    });
    await expect(wrapped()).rejects.toThrow('fail-op');
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.status).toBe('error');
    expect(body.error_code).toBe('fail-op');
  });

  it('withMetrics returns handler result on success', async () => {
    markServerReady('server');
    const wrapped = withMetrics('okop', 'event', async () => 42);
    await expect(wrapped()).resolves.toBe(42);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.status).toBe('ok');
    expect(body.error_code).toBeUndefined();
  });
});
