import {
  ensureMetadataProjectKeyForRead,
  normalizeMetricPayload,
  resolveProjectKeyForMetricMetadata
} from '../src/stats/normalizeMetric';

describe('normalizeMetric', () => {
  const saved = process.env;

  beforeEach(() => {
    process.env = { ...saved };
    delete process.env.MCP_PROJECT_KEY;
    delete process.env.MCP_PROJECT_NAME;
  });

  afterAll(() => {
    process.env = saved;
  });

  describe('resolveProjectKeyForMetricMetadata', () => {
    it('uses trimmed projectKey', () => {
      expect(resolveProjectKeyForMetricMetadata({ projectKey: '  pk  ' })).toBe('pk');
    });

    it('uses projectName when projectKey absent', () => {
      expect(resolveProjectKeyForMetricMetadata({ projectName: 'legacy' })).toBe('legacy');
    });

    it('prefers projectKey over projectName', () => {
      expect(resolveProjectKeyForMetricMetadata({ projectKey: 'a', projectName: 'b' })).toBe('a');
    });

    it('whitespace-only projectKey falls through to env/default (projectName not consulted)', () => {
      expect(resolveProjectKeyForMetricMetadata({ projectKey: '   ', projectName: 'n' })).toBe('default');
    });

    it('falls back to MCP_PROJECT_KEY', () => {
      process.env.MCP_PROJECT_KEY = 'from-key';
      process.env.MCP_PROJECT_NAME = 'from-name';
      expect(resolveProjectKeyForMetricMetadata({})).toBe('from-key');
    });

    it('falls back to MCP_PROJECT_NAME then default', () => {
      process.env.MCP_PROJECT_NAME = 'nm';
      expect(resolveProjectKeyForMetricMetadata({})).toBe('nm');
      delete process.env.MCP_PROJECT_NAME;
      expect(resolveProjectKeyForMetricMetadata({})).toBe('default');
    });
  });

  describe('ensureMetadataProjectKeyForRead', () => {
    it('keeps projectKey and drops projectName', () => {
      expect(ensureMetadataProjectKeyForRead({ projectKey: 'k', projectName: 'old', x: 1 })).toEqual({
        x: 1,
        projectKey: 'k'
      });
    });

    it('promotes projectName to projectKey', () => {
      expect(ensureMetadataProjectKeyForRead({ projectName: 'n' })).toEqual({ projectKey: 'n' });
    });

    it('uses default for null/undefined meta', () => {
      expect(ensureMetadataProjectKeyForRead(null)).toEqual({ projectKey: 'default' });
      expect(ensureMetadataProjectKeyForRead(undefined)).toEqual({ projectKey: 'default' });
    });

    it('uses default when no name keys', () => {
      expect(ensureMetadataProjectKeyForRead({ other: true })).toEqual({ other: true, projectKey: 'default' });
    });
  });

  describe('normalizeMetricPayload', () => {
    it('always attaches metadata.projectKey and drops projectName from metadata', () => {
      const out = normalizeMetricPayload({
        instance_id: 'i',
        operation: 'op',
        kind: 'query',
        started_at: 'a',
        ended_at: 'b',
        duration_ms: 0,
        status: 'ok',
        metadata: { projectName: 'via-name', extra: 2 }
      });
      expect(out.metadata.projectKey).toBe('via-name');
      expect((out.metadata as { projectName?: string }).projectName).toBeUndefined();
      expect(out.metadata.extra).toBe(2);
    });

    it('works without metadata object', () => {
      const out = normalizeMetricPayload({
        instance_id: 'i',
        operation: 'op',
        kind: 'event',
        started_at: 'a',
        ended_at: 'b',
        duration_ms: 1,
        status: 'ok'
      });
      expect(out.metadata.projectKey).toBe('default');
    });
  });
});
