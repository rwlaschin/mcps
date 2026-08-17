import {
  reportScanProgress,
  getScanProgress,
  ingestScanMetricMetadata,
  emitScanProgress,
  resetScanProgressCacheForTesting,
  type ScanProgressPayload
} from '../src/stats/scanProgressCache';

describe('scanProgressCache', () => {
  beforeEach(() => {
    resetScanProgressCacheForTesting();
  });

  describe('getScanProgress', () => {
    it('returns null when cache is empty', () => {
      expect(getScanProgress('any')).toBeNull();
    });

    it('returns null for empty or whitespace key', () => {
      expect(getScanProgress('')).toBeNull();
      expect(getScanProgress('   ')).toBeNull();
    });

    it('returns cached payload after reportScanProgress', () => {
      const payload: ScanProgressPayload = {
        filesProcessed: 5,
        filesUpdated: 2,
        projectKey: 'default'
      };
      reportScanProgress(payload);
      expect(getScanProgress('default')).toEqual(payload);
    });

    it('does not fall back to another project key', () => {
      const payload: ScanProgressPayload = {
        filesProcessed: 1,
        filesUpdated: 0,
        projectKey: 'default'
      };
      reportScanProgress(payload);
      expect(getScanProgress('other')).toBeNull();
    });
  });

  describe('reportScanProgress', () => {
    it('updates cache so getScanProgress returns payload', () => {
      const payload: ScanProgressPayload = {
        filesProcessed: 10,
        filesUpdated: 3,
        projectKey: 'p1'
      };
      reportScanProgress(payload);
      expect(getScanProgress('p1')).toEqual(payload);
    });

    it('stores payload under default when projectKey is omitted', () => {
      reportScanProgress({ filesProcessed: 1, filesUpdated: 0 });
      expect(getScanProgress('default')).toEqual({ filesProcessed: 1, filesUpdated: 0 });
    });

    it('last write wins for same projectKey', () => {
      reportScanProgress({ filesProcessed: 1, filesUpdated: 0, projectKey: 'p1' });
      reportScanProgress({ filesProcessed: 2, filesUpdated: 1, projectKey: 'p1' });
      expect(getScanProgress('p1')?.filesProcessed).toBe(2);
    });
  });

  describe('ingestScanMetricMetadata', () => {
    it('maps processingRelative to stale file entries', () => {
      ingestScanMetricMetadata({
        projectKey: 'x',
        action: 'update',
        total: 5,
        processedCount: 2,
        processingRelative: ['src/a.ts', 'src/b.ts']
      });
      const p = getScanProgress('x');
      expect(p?.totalFiles).toBe(5);
      expect(p?.filesProcessed).toBe(2);
      expect(p?.files).toEqual([
        { relativePath: 'src/a.ts', state: 'stale' },
        { relativePath: 'src/b.ts', state: 'stale' }
      ]);
    });

    it('keeps prior files when update has no processingRelative', () => {
      ingestScanMetricMetadata({
        projectKey: 'y',
        action: 'update',
        total: 3,
        processedCount: 1,
        processingRelative: ['a.ts']
      });
      ingestScanMetricMetadata({
        projectKey: 'y',
        action: 'update',
        total: 3,
        processedCount: 2,
        processingRelative: []
      });
      const p = getScanProgress('y');
      expect(p?.filesProcessed).toBe(2);
      expect(p?.files).toEqual([{ relativePath: 'a.ts', state: 'stale' }]);
    });

    it('sets isActiveScan false when action is complete', () => {
      ingestScanMetricMetadata({
        projectKey: 'z',
        action: 'complete',
        total: 1,
        processedCount: 1
      });
      expect(getScanProgress('z')?.isActiveScan).toBe(false);
    });
  });

  describe('emitScanProgress (to Socket.IO client)', () => {
    it('emits scan:progress for each cached project', () => {
      const emitted: Array<[string, string]> = [];
      const mockSocket = { emit: (e: string, p: string) => emitted.push([e, p]) };
      reportScanProgress({ filesProcessed: 1, filesUpdated: 0, projectKey: 'a' });
      reportScanProgress({ filesProcessed: 2, filesUpdated: 1, projectKey: 'b' });
      emitScanProgress(mockSocket);
      expect(emitted.filter(([ev]) => ev === 'scan:progress')).toHaveLength(2);
    });
  });
});
