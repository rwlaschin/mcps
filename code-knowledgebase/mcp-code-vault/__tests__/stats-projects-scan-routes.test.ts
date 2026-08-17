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

const mockFind = jest.fn();
const mockFindOne = jest.fn();
jest.mock('../src/db/models/Project', () => ({
  Project: {
    find: (...args: unknown[]) => mockFind(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args)
  }
}));
const mockListFilesUnderRoot = jest.fn();
jest.mock('../src/scanner', () => ({
  ...jest.requireActual('../src/scanner'),
  listFilesUnderRoot: (...args: unknown[]) => mockListFilesUnderRoot(...args)
}));

import { createStatsServer } from '../src/stats/server';

function chainMock(leanResult: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(leanResult)
  };
}

describe('Stats projects and scan routes', () => {
  let fastify: Awaited<ReturnType<typeof createStatsServer>> | undefined;

  beforeAll(async () => {
    fastify = await createStatsServer();
  }, 5000);

  afterAll(async () => {
    if (fastify) await fastify.close();
  });

  beforeEach(() => {
    mockFind.mockReturnValue(chainMock([]));
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ key: 'default', root_path: '/repo' }) });
    mockListFilesUnderRoot.mockReturnValue([]);
  });

  describe('GET /projects', () => {
    it('returns list of projects from Project model', async () => {
      mockFind.mockReturnValue(
        chainMock([
          { key: 'default', name: 'Default Project' },
          { key: 'other', name: 'Other' }
        ])
      );

      const res = await fastify!.inject({ method: 'GET', url: '/projects' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects).toEqual([
        { key: 'default', name: 'Default Project' },
        { key: 'other', name: 'Other' }
      ]);
      expect(Array.isArray(body.projects)).toBe(true);
      body.projects.forEach((p: { key: string; name: string }) => {
        expect(p).toHaveProperty('key');
        expect(p).toHaveProperty('name');
        expect(typeof p.key).toBe('string');
        expect(typeof p.name).toBe('string');
      });
    });

    it('returns empty array when no projects', async () => {
      mockFind.mockReturnValue(chainMock([]));

      const res = await fastify!.inject({ method: 'GET', url: '/projects' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects).toEqual([]);
    });
  });

  describe('GET /scan/files', () => {
    it('returns paginated scan file entries using limit+1 strategy', async () => {
      mockFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ key: 'default', root_path: '/repo' })
      });
      mockListFilesUnderRoot.mockReturnValue([
        '/repo/src/c.ts',
        '/repo/src/a.ts',
        '/repo/src/b.ts'
      ]);

      const res = await fastify!.inject({
        method: 'GET',
        url: '/scan/files?projectKey=default&limit=2'
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.entries).toEqual([
        { relativePath: 'src/a.ts', state: 'new' },
        { relativePath: 'src/b.ts', state: 'new' }
      ]);
      expect(body.page.hasMore).toBe(true);
      expect(body.page.nextCursor).toBe('src/b.ts');
    });

    it('supports cursor pagination and returns final page without nextCursor', async () => {
      mockFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ key: 'default', root_path: '/repo' })
      });
      mockListFilesUnderRoot.mockReturnValue([
        '/repo/src/a.ts',
        '/repo/src/b.ts',
        '/repo/src/c.ts'
      ]);

      const res = await fastify!.inject({
        method: 'GET',
        url: '/scan/files?projectKey=default&limit=2&cursor=src/b.ts'
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.entries).toEqual([{ relativePath: 'src/c.ts', state: 'new' }]);
      expect(body.page.hasMore).toBe(false);
      expect(body.page.nextCursor).toBe(null);
    });
  });
});
