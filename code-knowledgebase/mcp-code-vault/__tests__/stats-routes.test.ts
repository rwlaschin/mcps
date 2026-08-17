/**
 * Stats stream behavior: no Fastify / fastify-sse-v2 — route wiring uses a minimal fastify-shaped mock.
 */

import { streamRoutes } from '../src/stats/routes/stream';

describe('Stats routes', () => {
  describe('streamRoutes wiring', () => {
    it('registers GET /metrics/stream and passes streamToUI to reply.sse', async () => {
      const mockFastify = {
        get: jest.fn()
      };
      await streamRoutes(mockFastify as never);
      expect(mockFastify.get).toHaveBeenCalledWith('/metrics/stream', expect.any(Function));
      const handler = mockFastify.get.mock.calls[0][1] as (
        req: unknown,
        reply: { sse: jest.Mock }
      ) => Promise<void>;
      const reply = { sse: jest.fn() };
      await handler({}, reply);
      expect(reply.sse).toHaveBeenCalled();
    });
  });

  describe('GET /metrics/stream (streamToUI / pushToStream)', () => {
    it('stream yields connected event first', async () => {
      const { streamToUI } = await import('../src/stats/streamChannel');
      const gen = streamToUI();
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value?.event).toBe('connected');
      expect(first.value?.data).toBeDefined();
      const data = JSON.parse(first.value!.data);
      expect(data.ts).toBeDefined();
      expect(typeof data.ts).toBe('string');
      expect(new Date(data.ts).toISOString()).toBe(data.ts);
      const { getProcessProjectKey } = await import('../src/projectKey');
      expect(data.projectKey).toBe(getProcessProjectKey());
      expect(data.port).toBe(
        process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 0
      );
    });

    it('stream yields heartbeat immediately after connected', async () => {
      const { streamToUI } = await import('../src/stats/streamChannel');
      const gen = streamToUI();
      await gen.next();
      const second = await gen.next();
      expect(second.done).toBe(false);
      expect(second.value?.event).toBe('heartbeat');
      const data = JSON.parse(second.value!.data);
      expect(data.ts).toBeDefined();
      expect(new Date(data.ts).toISOString()).toBe(data.ts);
      const { getProcessProjectKey: gpk2 } = await import('../src/projectKey');
      expect(data.projectKey).toBe(gpk2());
    });

    it('stream yields heartbeat after delay', async () => {
      jest.useFakeTimers();
      const { streamToUI } = await import('../src/stats/streamChannel');
      const gen = streamToUI();
      await gen.next();
      await gen.next();
      const nextPromise = gen.next();
      jest.advanceTimersByTime(5000);
      const third = await nextPromise;
      jest.useRealTimers();
      expect(third.done).toBe(false);
      expect(third.value?.event).toBe('heartbeat');
      const data = JSON.parse(third.value!.data);
      expect(data.ts).toBeDefined();
      expect(new Date(data.ts).toISOString()).toBe(data.ts);
      const { getProcessProjectKey: gpk3 } = await import('../src/projectKey');
      expect(data.projectKey).toBe(gpk3());
    });

    it('pushToStream broadcasts to all connected clients', async () => {
      const { streamToUI, pushToStream } = await import('../src/stats/streamChannel');
      const genA = streamToUI();
      const genB = streamToUI();
      await genA.next(); // connected
      await genB.next(); // connected
      await genA.next(); // heartbeat
      await genB.next(); // heartbeat
      const nextA = genA.next();
      const nextB = genB.next();
      pushToStream('metric', JSON.stringify({ id: '1', operation: 'query' }));
      const [resA, resB] = await Promise.all([nextA, nextB]);
      expect(resA.done).toBe(false);
      expect(resA.value?.event).toBe('metric');
      const metricData = JSON.parse(resA.value!.data);
      expect(metricData.id).toBe('1');
      expect(metricData.operation).toBe('query');
      expect(resB.done).toBe(false);
      expect(resB.value?.event).toBe('metric');
      expect(JSON.parse(resB.value!.data).id).toBe('1');
    });

    it('stream yields scan:progress with filesProcessed and filesUpdated (legacy UI shape)', async () => {
      const { streamToUI, pushToStream } = await import('../src/stats/streamChannel');
      const gen = streamToUI();
      await gen.next(); // connected
      await gen.next(); // heartbeat
      const nextPromise = gen.next();
      pushToStream(
        'scan:progress',
        JSON.stringify({
          filesProcessed: 5,
          filesUpdated: 5,
          totalFiles: 100,
          isActiveScan: true,
          projectKey: 'p1',
          files: [{ relativePath: 'a.ts', state: 'stale' }]
        })
      );
      const res = await nextPromise;
      expect(res.done).toBe(false);
      expect(res.value?.event).toBe('scan:progress');
      const data = JSON.parse(res.value!.data);
      expect(data.filesProcessed).toBe(5);
      expect(data.filesUpdated).toBe(5);
      expect(data.projectKey).toBe('p1');
    });
  });
});
