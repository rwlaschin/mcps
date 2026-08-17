import Fastify from 'fastify';
import { serverRoutes } from '../src/stats/routes/servers';
import { MOCK_STATS_PORT, MOCK_STATS_URL } from './testConstants';

const mockFind = jest.fn();

jest.mock('../src/db/models/ServerInstance', () => ({
  ServerInstance: {
    find: () => ({
      sort: () => ({
        limit: () => ({
          lean: () => mockFind()
        })
      })
    })
  }
}));

describe('GET /servers', () => {
  let fastify: Awaited<ReturnType<typeof createApp>>;

  async function createApp() {
    const app = Fastify();
    await app.register(serverRoutes);
    return app;
  }

  beforeAll(async () => {
    fastify = await createApp();
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    mockFind.mockReset();
  });

  it('returns servers array from ServerInstance', async () => {
    const now = new Date();
    mockFind.mockResolvedValue([
      {
        _id: '507f1f77bcf86cd799439011',
        started_at: now,
        last_seen: now,
        port: MOCK_STATS_PORT,
        local_url: MOCK_STATS_URL,
        log_path: '/tmp/log',
        pid: 12345
      }
    ]);
    const res = await fastify.inject({ method: 'GET', url: '/servers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].port).toBe(MOCK_STATS_PORT);
    expect(body.servers[0].local_url).toBe(MOCK_STATS_URL);
  });

  it('applies limit query param (clamped 1–100)', async () => {
    mockFind.mockResolvedValue([]);
    await fastify.inject({ method: 'GET', url: '/servers?limit=5' });
    expect(mockFind).toHaveBeenCalled();
    const res = await fastify.inject({ method: 'GET', url: '/servers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.servers).toEqual([]);
  });
});
