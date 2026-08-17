jest.mock('../src/db/mongoose', () => ({
  connectMongoose: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/db/seed', () => ({
  runSeed: jest.fn().mockResolvedValue('skipped' as const),
  ensurePromptsFromSeed: jest.fn().mockResolvedValue('skipped' as const)
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

jest.mock('../src/fileProcessingStartup', () => ({
  runFileProcessingStartup: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), child: jest.fn(() => ({ info: jest.fn() })) }
}));

const mockPushToStream = jest.fn();
jest.mock('../src/stats/streamChannel', () => ({
  pushToStream: (...args: unknown[]) => mockPushToStream(...args)
}));

import { createStatsServer } from '../src/stats/server';
import { postMetric } from '../src/stats/metricsClient';

describe('createStatsServer', () => {
  let fastify: Awaited<ReturnType<typeof createStatsServer>>;
  const origProjectName = process.env.MCP_PROJECT_NAME;

  beforeAll(async () => {
    process.env.MCP_PROJECT_NAME = 'test-project';
    mockPushToStream.mockClear();
    jest.mocked(postMetric).mockClear();
    fastify = await createStatsServer();
  });

  afterAll(async () => {
    process.env.MCP_PROJECT_NAME = origProjectName;
    await fastify.close();
  });

  it('emits db:connected, seed:checked, then project', () => {
    const calls = mockPushToStream.mock.calls as [string, string][];
    const events = calls.map((c) => c[0]);
    expect(events).toContain('db:connected');
    expect(events).toContain('seed:checked');
    expect(events).toContain('project');
    expect(mockPushToStream).toHaveBeenCalledWith('db:connected', expect.any(String));
    expect(mockPushToStream).toHaveBeenCalledWith('seed:checked', expect.any(String));
    expect(mockPushToStream).toHaveBeenCalledWith('project', expect.any(String));
    const seedPayload = JSON.parse(
      (mockPushToStream.mock.calls.find((c) => c[0] === 'seed:checked') ?? [])[1] ?? '{}'
    );
    expect(seedPayload).toMatchObject({
      action: expect.stringMatching(/^ran|skipped$/),
      promptsSeed: expect.stringMatching(/^inserted|skipped|no_file$/)
    });
    expect(typeof seedPayload.ts).toBe('string');
    const projectPayload = JSON.parse(
      (mockPushToStream.mock.calls.find((c) => c[0] === 'project') ?? [])[1] ?? '{}'
    );
    expect(projectPayload).toMatchObject({
      projectKey: expect.any(String),
      rootPath: expect.any(String),
      action: 'unchanged'
    });
    expect(typeof projectPayload.ts).toBe('string');
  });

  it('posts init metric with connections_ensured metadata', () => {
    expect(postMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'init',
        kind: 'event',
        status: 'ok',
        metadata: expect.objectContaining({
          content: 'connections_ensured',
          project: 'test-project',
          ts: expect.any(String)
        })
      })
    );
  });

  it('registers GET /config', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { config?: string };
    expect(body).toHaveProperty('config');
    expect(typeof body.config).toBe('string');
    expect((body.config as string).length).toBeGreaterThan(0);
    expect(body.config).toContain('Code-vault');
  });

  it('registers GET /docs', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ docs: 'empty' });
  });

  it('registers GET /metrics/stream route', async () => {
    const routes = fastify.printRoutes();
    expect(routes).toMatch(/stream/);
  });
});
