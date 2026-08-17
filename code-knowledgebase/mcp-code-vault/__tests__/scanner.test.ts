const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn().mockResolvedValue(undefined);
const mockBulkWrite = jest.fn().mockResolvedValue({ ok: 1 });

jest.mock('../src/db', () => ({
  connectToDatabase: jest.fn().mockResolvedValue({
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'registry') return { findOne: mockFindOne };
      if (name === 'symbols') return { updateOne: mockUpdateOne, bulkWrite: mockBulkWrite };
      return {};
    })
  })
}));

jest.mock('../src/utils/ignore-mgr', () => ({
  shouldIgnore: jest.fn((filePath: string) => filePath.includes('node_modules')),
  createChokidarIgnored: jest.fn(() => (p: string) => p.includes('node_modules'))
}));

jest.mock('../src/analyzer', () => ({
  analyzeFile: jest.fn().mockResolvedValue('class Foo {} function bar() {}')
}));

const mockReaddirSync = jest.fn();
const mockStatSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync
}));

jest.mock('path', () => ({
  join: (...args: string[]) => args.join('/')
}));

const mockWatch = jest.fn().mockReturnValue({ on: jest.fn() });
jest.mock('chokidar', () => ({
  __esModule: true,
  default: { watch: mockWatch }
}));

import { scanProject, streamProjectChunks } from '../src/scanner';
import { createDefaultStreamProcessor } from '../src/processors/defaultStreamProcessor';

describe('scanProject', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
    mockUpdateOne.mockClear();
    mockBulkWrite.mockClear();
    mockReaddirSync.mockReset();
    mockStatSync.mockReset();
  });

  it('throws when project not found', async () => {
    mockFindOne.mockResolvedValue(null);
    await expect(scanProject('unknown')).rejects.toThrow('Project not found');
  });

  it('returns counts when project exists and walk finds one file', async () => {
    mockFindOne.mockResolvedValue({ project_key: 'K', root_path: '/root' });
    mockReaddirSync.mockReturnValue(['a.ts']);
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    const result = await scanProject('K');

    expect(result).toEqual({
      filesScanned: 1,
      filesUpdated: 1,
      symbolsFound: 2
    });
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockBulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { project_key: 'K', file: '/root/a.ts' },
          update: { $set: expect.objectContaining({ summary: 'class Foo {} function bar() {}' }) },
          upsert: true
        })
      })
    ]);
  });

  it('skips directories and nested files', async () => {
    mockFindOne.mockResolvedValue({ project_key: 'K', root_path: '/root' });
    mockReaddirSync
      .mockReturnValueOnce(['dir', 'file.ts'])
      .mockReturnValueOnce(['nested.ts']);
    mockStatSync
      .mockReturnValueOnce({ isDirectory: () => true })
      .mockReturnValueOnce({ isDirectory: () => false })
      .mockReturnValueOnce({ isDirectory: () => false });

    const result = await scanProject('K');

    expect(result.filesScanned).toBe(2);
    expect(result.filesUpdated).toBe(2);
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
  });

  it('uses ignore manager (node_modules not walked)', async () => {
    mockFindOne.mockResolvedValue({ project_key: 'K', root_path: '/root' });
    mockReaddirSync.mockReturnValue(['node_modules', 'a.ts']);
    mockStatSync
      .mockReturnValueOnce({ isDirectory: () => true })
      .mockReturnValueOnce({ isDirectory: () => false });
    // shouldIgnore is mocked to return true for paths including 'node_modules', so we never recurse into it
    const result = await scanProject('K');
    expect(result.filesScanned).toBe(1);
    expect(result.filesUpdated).toBe(1);
  });
});

describe('streamProjectChunks', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
    mockReaddirSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
  });

  it('throws when project not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const gen = streamProjectChunks('unknown', { processor: createDefaultStreamProcessor() });
    await expect(gen.next()).rejects.toThrow('Project not found');
  });

  it('yields chunks for a single file via default processor', async () => {
    mockFindOne.mockResolvedValue({ project_key: 'K', root_path: '/root' });
    mockReaddirSync.mockReturnValue(['a.ts']);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n');
    mockReadFileSync.mockReturnValue(lines);

    const chunks: Array<{ file: string; startLine: number; endLine: number; content: string }> = [];
    for await (const chunk of streamProjectChunks('K', { processor: createDefaultStreamProcessor() })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ file: '/root/a.ts', startLine: 1, endLine: 100, content: lines.split('\n').slice(0, 100).join('\n') });
    expect(chunks[1]).toEqual({ file: '/root/a.ts', startLine: 101, endLine: 150, content: lines.split('\n').slice(100, 150).join('\n') });
  });

  it('respects chunkLines option on processor', async () => {
    mockFindOne.mockResolvedValue({ project_key: 'K', root_path: '/root' });
    mockReaddirSync.mockReturnValue(['a.ts']);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    mockReadFileSync.mockReturnValue(lines);

    const chunks: Array<{ file: string; startLine: number; endLine: number }> = [];
    for await (const chunk of streamProjectChunks('K', { processor: createDefaultStreamProcessor({ chunkLines: 10 }) })) {
      chunks.push({ file: chunk.file, startLine: chunk.startLine, endLine: chunk.endLine });
    }

    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toEqual({ file: '/root/a.ts', startLine: 1, endLine: 10 });
    expect(chunks[4]).toEqual({ file: '/root/a.ts', startLine: 41, endLine: 50 });
  });

  it('skips files that fail to read (processor filters)', async () => {
    mockFindOne.mockResolvedValue({ project_key: 'K', root_path: '/root' });
    mockReaddirSync.mockReturnValue(['a.ts', 'b.ts']);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('a.ts')) throw new Error('EACCES');
      return 'content of b';
    });

    const chunks: Array<{ file: string; content: string }> = [];
    for await (const chunk of streamProjectChunks('K', { processor: createDefaultStreamProcessor() })) {
      chunks.push({ file: chunk.file, content: chunk.content });
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].file).toContain('b.ts');
    expect(chunks[0].content).toBe('content of b');
  });
});
