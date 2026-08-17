/**
 * Tests for per-project DB structure.
 * - ensureProjectCollections(projectKey) creates/ensures the two collections (_knowledge_base, _FileProcessor) and indexes.
 * - hasAnyPaths(projectKey) returns false when no knowledge_base docs exist.
 */

const mockCreateIndex = jest.fn().mockResolvedValue('indexName');
const mockCountDocuments = jest.fn().mockResolvedValue(0);

const mockCollection = () => {
  const toArray = jest.fn().mockResolvedValue([]);
  return {
    createIndex: mockCreateIndex,
    createIndexes: jest.fn().mockResolvedValue(undefined),
    countDocuments: jest.fn().mockImplementation(() => ({
      then: (fn: (n: number) => unknown) => Promise.resolve(mockCountDocuments()).then(fn)
    })),
    find: jest.fn(() => ({ toArray }))
  };
};

const mockDb = {
  collection: jest.fn((name: string) => {
    const col = mockCollection();
    (col.countDocuments as jest.Mock).mockResolvedValue(0);
    return col;
  })
};

const mockConnection = {
  db: mockDb
};

jest.mock('../src/db/mongoose', () => ({
  connectMongoose: jest.fn().mockResolvedValue({ connection: mockConnection })
}));

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connection: mockConnection
  };
});

import {
  ensureProjectCollections,
  hasAnyPaths,
  knowledgeBaseCollectionName,
  fileProcessorCollectionName,
  getFileProcessorProcessedAtMap,
  getFileProcessorChecksumMap
} from '../src/db/projectDb';

describe('projectDb — ensure project collections and hasAnyPaths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCountDocuments.mockResolvedValue(0);
    mockDb.collection.mockImplementation((name: string) => {
      const col = mockCollection();
      (col.countDocuments as jest.Mock).mockResolvedValue(0);
      return col;
    });
  });

  describe('collection names', () => {
    it('returns correct suffix names for projectKey', () => {
      expect(knowledgeBaseCollectionName('my-proj')).toBe('my-proj_knowledge_base');
      expect(fileProcessorCollectionName('my-proj')).toBe('my-proj_FileProcessor');
    });
  });

  describe('ensureProjectCollections', () => {
    it('creates or ensures the two per-project collections for the given projectKey', async () => {
      await ensureProjectCollections('test-project');

      expect(mockDb.collection).toHaveBeenCalledWith('test-project_knowledge_base');
      expect(mockDb.collection).toHaveBeenCalledWith('test-project_FileProcessor');
      expect(mockDb.collection).toHaveBeenCalledTimes(2);
    });

    it('creates indexes on FileProcessor collection (path unique, checksum, processedAt, path text)', async () => {
      await ensureProjectCollections('fp-proj');
      const fpResultIndex = mockDb.collection.mock.calls.findIndex((c) => c[0] === 'fp-proj_FileProcessor');
      expect(fpResultIndex).toBeGreaterThanOrEqual(0);
      const fpCol = mockDb.collection.mock.results[fpResultIndex]?.value;
      expect(fpCol?.createIndex).toHaveBeenCalledWith({ path: 1 }, { unique: true });
      expect(fpCol?.createIndex).toHaveBeenCalledWith({ checksum: 1 });
      expect(fpCol?.createIndex).toHaveBeenCalledWith({ processedAt: 1 });
      expect(fpCol?.createIndex).toHaveBeenCalledWith({ path: 'text' });
    });
  });

  describe('hasAnyPaths', () => {
    it('returns false when project has no knowledge_base docs', async () => {
      const result = await hasAnyPaths('empty-project');
      expect(result).toBe(false);
      expect(mockDb.collection).toHaveBeenCalledWith('empty-project_knowledge_base');
    });

    it('returns true when project has at least one knowledge_base doc', async () => {
      mockDb.collection.mockImplementation((name: string) => {
        const col = mockCollection();
        (col.countDocuments as jest.Mock).mockResolvedValue(name.endsWith('_knowledge_base') ? 1 : 0);
        return col;
      });
      const result = await hasAnyPaths('has-docs');
      expect(result).toBe(true);
    });
  });

  describe('integration: ensure then hasAnyPaths', () => {
    it('after ensureProjectCollections for NEW project, hasAnyPaths is false', async () => {
      await ensureProjectCollections('new-project');
      const hasPaths = await hasAnyPaths('new-project');
      expect(hasPaths).toBe(false);
    });
  });

  describe('getFileProcessorProcessedAtMap', () => {
    it('maps path to Date, coerces string timestamps, skips incomplete rows', async () => {
      mockDb.collection.mockImplementation((name: string) => {
        const col = mockCollection();
        if (name === 'map-proj_FileProcessor') {
          const toArray = jest.fn().mockResolvedValue([
            { path: '/a.ts', processedAt: new Date('2020-06-01T00:00:00.000Z') },
            { path: '/b.ts', processedAt: '2021-01-01T00:00:00.000Z' },
            { path: null, processedAt: new Date() },
            { path: '/skip.ts', processedAt: null }
          ]);
          (col.find as jest.Mock).mockReturnValue({ toArray });
        }
        return col;
      });
      const map = await getFileProcessorProcessedAtMap('map-proj');
      expect(map.size).toBe(2);
      expect(map.get('/a.ts')).toEqual(new Date('2020-06-01T00:00:00.000Z'));
      expect(map.get('/b.ts')).toBeInstanceOf(Date);
    });
  });

  describe('getFileProcessorChecksumMap', () => {
    it('maps path to checksum and skips empty or missing fields', async () => {
      mockDb.collection.mockImplementation((name: string) => {
        const col = mockCollection();
        if (name === 'ck-proj_FileProcessor') {
          const toArray = jest.fn().mockResolvedValue([
            { path: '/ok.ts', checksum: 'deadbeef' },
            { path: '/empty.ts', checksum: '' },
            { path: null, checksum: 'x' },
            { path: '/only-path.ts', checksum: null }
          ]);
          (col.find as jest.Mock).mockReturnValue({ toArray });
        }
        return col;
      });
      const map = await getFileProcessorChecksumMap('ck-proj');
      expect(map.size).toBe(1);
      expect(map.get('/ok.ts')).toBe('deadbeef');
    });
  });
});
