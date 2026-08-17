jest.mock('../src/scannerRequirements', () => ({
  getProjectRoot: jest.fn().mockResolvedValue('/repo')
}));

jest.mock('../src/scanner', () => ({
  listFilesUnderRoot: jest.fn().mockReturnValue(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'])
}));

const mockFindOneExec = jest.fn().mockResolvedValue({
  file_processing_batch_size: 2,
  file_processing_pause_ms: 0,
  file_processing_concurrency: 2,
  file_processing_debounce_ms: 0
});
jest.mock('../src/db/models/Project', () => ({
  Project: {
    findOne: jest.fn(() => ({
      lean: jest.fn(() => ({
        exec: mockFindOneExec
      }))
    }))
  }
}));

jest.mock('../src/db/projectDb', () => ({
  getFileProcessorChecksumMap: jest
    .fn()
    .mockResolvedValue(new Map<string, string>([['/repo/a.ts', 'same-a'], ['/repo/b.ts', 'old-b']]))
}));

const mockPostMetric = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/stats/metricsClient', () => ({
  postMetric: mockPostMetric
}));

const mockCalculateMD5 = jest.fn((filePath: string) => {
  if (filePath === '/repo/a.ts') return 'same-a';
  if (filePath === '/repo/b.ts') return 'new-b';
  if (filePath === '/repo/c.ts') return 'new-c';
  return 'x';
});
jest.mock('../src/utils/hasher', () => ({
  calculateMD5: mockCalculateMD5
}));

const mockRunFileProcessingLlm = jest.fn().mockResolvedValue({
  summary: 'ok',
  usage: {},
  source: 'db_chain' as const
});
jest.mock('../src/llm/runFileProcessingLlm', () => ({
  ...jest.requireActual<typeof import('../src/llm/runFileProcessingLlm')>('../src/llm/runFileProcessingLlm'),
  runFileProcessingLlm: (...args: unknown[]) => mockRunFileProcessingLlm(...args)
}));

type WatchHandlers = Record<string, ((filePath: string) => void) | undefined>;
const watchHandlers: WatchHandlers = {};
type MockWatcher = {
  on: jest.Mock;
  close: jest.Mock;
};
const mockWatcher: MockWatcher = {
  on: jest.fn((event: string, cb: (filePath: string) => void) => {
    watchHandlers[event] = cb;
    return mockWatcher;
  }),
  close: jest.fn().mockResolvedValue(undefined)
};
const mockWatch = jest.fn(() => mockWatcher);
jest.mock('chokidar', () => ({
  __esModule: true,
  default: { watch: mockWatch }
}));

import {
  runFileProcessingStartup,
  resetFileProcessingStartupForTesting,
  stopFileProcessingWatcher,
  SCAN_METRIC_KEY,
  SCAN_ACTION_COMPLETE,
  SCAN_ACTION_START,
  SCAN_ACTION_UPDATE
} from '../src/fileProcessingStartup';
import { METRIC_OPERATION_READ } from '../src/stats/fileReadHourBuckets';

describe('fileProcessingStartup', () => {
  async function flushProcessing(): Promise<void> {
    for (let i = 0; i < 25; i++) {
      jest.advanceTimersByTime(30);
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockRunFileProcessingLlm.mockClear();
    mockPostMetric.mockClear();
    mockCalculateMD5.mockClear();
    mockFindOneExec.mockClear();
    mockWatch.mockClear();
    mockWatcher.on.mockClear();
    mockWatcher.close.mockClear();
    watchHandlers.add = undefined;
    watchHandlers.change = undefined;
    resetFileProcessingStartupForTesting();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await stopFileProcessingWatcher('proj');
  });

  it('reports scan metrics and skips unchanged files by checksum', async () => {
    await runFileProcessingStartup('proj');
    await flushProcessing();

    const metricCalls = mockPostMetric.mock.calls.map((c) => c[0]);
    const scanCalls = metricCalls.filter((c) => c.operation === SCAN_METRIC_KEY);
    expect(scanCalls.length).toBeGreaterThanOrEqual(3);
    expect(scanCalls[0].metadata.action).toBe(SCAN_ACTION_START);
    expect(scanCalls.some((c) => c.metadata.action === SCAN_ACTION_UPDATE)).toBe(true);
    const lastComplete = [...scanCalls].reverse().find((c) => c.metadata.action === SCAN_ACTION_COMPLETE);
    expect(lastComplete).toBeDefined();
    expect(lastComplete!.metadata.processedCount).toBe(2);

    const readBatches = metricCalls.filter((c) => c.operation === METRIC_OPERATION_READ);
    expect(readBatches.length).toBeGreaterThanOrEqual(1);
    const readSum = readBatches.reduce((s, c) => {
      const ent = (c.metadata?.entries as { count?: number }[]) ?? [];
      return s + ent.reduce((t, e) => t + (typeof e.count === 'number' ? e.count : 0), 0);
    }, 0);
    expect(readSum).toBeGreaterThanOrEqual(2);

    expect(mockCalculateMD5).toHaveBeenCalledWith('/repo/a.ts');
    expect(mockCalculateMD5).toHaveBeenCalledWith('/repo/b.ts');
    expect(mockCalculateMD5).toHaveBeenCalledWith('/repo/c.ts');
    expect(mockRunFileProcessingLlm).toHaveBeenCalled();
  });

  it('sets up watcher and dedupes rapid changes', async () => {
    const scanner = require('../src/scanner');
    scanner.listFilesUnderRoot.mockReturnValueOnce([]);

    await runFileProcessingStartup('proj');
    await flushProcessing();
    mockCalculateMD5.mockClear();

    const onChange = watchHandlers.change;
    expect(onChange).toBeDefined();
    onChange?.('/repo/new.ts');
    onChange?.('/repo/new.ts');
    await flushProcessing();

    expect(mockCalculateMD5).toHaveBeenCalledTimes(1);
    expect(mockCalculateMD5).toHaveBeenCalledWith('/repo/new.ts');

    const metricCalls = mockPostMetric.mock.calls.map((c) => c[0]);
    const scanCalls = metricCalls.filter((c) => c.operation === SCAN_METRIC_KEY);
    const lastUpdate = [...scanCalls].reverse().find((c) => c.metadata.action === SCAN_ACTION_UPDATE);
    expect(lastUpdate?.metadata.total).toBe(1);
  });
});

