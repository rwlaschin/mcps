import {
  formatMongoUrlForSettings,
  mongoUrlLinesForSettingsContent
} from '../src/utils/redactMongoUrl';

describe('formatMongoUrlForSettings', () => {
  it('returns (not set) for empty input', () => {
    expect(formatMongoUrlForSettings(undefined)).toEqual({
      urlForDisplay: '(not set)',
      hadCredentials: false
    });
    expect(formatMongoUrlForSettings(null)).toEqual({
      urlForDisplay: '(not set)',
      hadCredentials: false
    });
    expect(formatMongoUrlForSettings('')).toEqual({
      urlForDisplay: '(not set)',
      hadCredentials: false
    });
    expect(formatMongoUrlForSettings('   ')).toEqual({
      urlForDisplay: '(not set)',
      hadCredentials: false
    });
  });

  it('flags placeholder-only MONGO_URL (no real host)', () => {
    const a = formatMongoUrlForSettings('mongodb://***');
    expect(a.urlForDisplay).toContain('MONGO_URL is not a full connection string');
    expect(a.hadCredentials).toBe(false);
    const b = formatMongoUrlForSettings('mongodb+srv://***');
    expect(b.urlForDisplay).toContain('MONGO_URL is not a full connection string');
    expect(b.hadCredentials).toBe(false);
  });

  it('leaves URIs without userinfo unchanged', () => {
    expect(formatMongoUrlForSettings('mongodb://localhost:27017')).toEqual({
      urlForDisplay: 'mongodb://localhost:27017',
      hadCredentials: false
    });
    expect(formatMongoUrlForSettings('mongodb://localhost:27017/mcp_code_vault')).toEqual({
      urlForDisplay: 'mongodb://localhost:27017/mcp_code_vault',
      hadCredentials: false
    });
    expect(formatMongoUrlForSettings('mongodb://h1:27017,h2:27017/db?replicaSet=rs')).toEqual({
      urlForDisplay: 'mongodb://h1:27017,h2:27017/db?replicaSet=rs',
      hadCredentials: false
    });
  });

  it('strips user:password@ but keeps host path and query', () => {
    expect(formatMongoUrlForSettings('mongodb://u:p@h1:27017,h2:27017/db?replicaSet=rs')).toEqual({
      urlForDisplay: 'mongodb://h1:27017,h2:27017/db?replicaSet=rs',
      hadCredentials: true
    });
    expect(formatMongoUrlForSettings('mongodb://alice:secret@host:27017/mcp_code_vault')).toEqual({
      urlForDisplay: 'mongodb://host:27017/mcp_code_vault',
      hadCredentials: true
    });
    expect(
      formatMongoUrlForSettings('mongodb+srv://user:p%40ss@cluster.example.net/mydb?retryWrites=true')
    ).toEqual({
      urlForDisplay: 'mongodb+srv://cluster.example.net/mydb?retryWrites=true',
      hadCredentials: true
    });
  });

  it('strips username-only before @', () => {
    expect(formatMongoUrlForSettings('mongodb://alice@host/db')).toEqual({
      urlForDisplay: 'mongodb://host/db',
      hadCredentials: true
    });
  });

  it('returns non-mongodb strings as-is', () => {
    expect(formatMongoUrlForSettings('postgres://x:y@host/db')).toEqual({
      urlForDisplay: 'postgres://x:y@host/db',
      hadCredentials: false
    });
  });

  it('uses legacy path when ConnectionString throws but URI looks like mongodb with userinfo', () => {
    const malformed = 'mongodb://user:pass@localhost:27017/db?opts=%ZZ';
    const out = formatMongoUrlForSettings(malformed);
    expect(out.urlForDisplay).toMatch(/^mongodb:\/\//);
    expect(out.urlForDisplay).not.toContain('@');
    expect(out.urlForDisplay).toContain('localhost:27017');
    expect(out.hadCredentials).toBe(true);
  });
});

describe('mongoUrlLinesForSettingsContent', () => {
  it('includes mongoAuth line when credentials were present', () => {
    const lines = mongoUrlLinesForSettingsContent('mongodb://u:p@host:27017/db');
    expect(lines).toContain('mongoUrl: mongodb://host:27017/db');
    expect(lines).toContain('mongoAuth:');
    expect(lines).toContain('not shown');
  });

  it('omits mongoAuth line when no credentials', () => {
    const lines = mongoUrlLinesForSettingsContent('mongodb://localhost:27017');
    expect(lines).toBe('mongoUrl: mongodb://localhost:27017');
  });
});
