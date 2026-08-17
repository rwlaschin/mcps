import { getProcessProjectKey } from '../src/projectKey';

describe('getProcessProjectKey', () => {
  const saved = process.env;

  beforeEach(() => {
    process.env = { ...saved };
    delete process.env.MCP_PROJECT_KEY;
    delete process.env.MCP_PROJECT_NAME;
  });

  afterAll(() => {
    process.env = saved;
  });

  it('returns default when env unset', () => {
    expect(getProcessProjectKey()).toBe('default');
  });

  it('trims MCP_PROJECT_NAME', () => {
    process.env.MCP_PROJECT_NAME = '  myproj  ';
    expect(getProcessProjectKey()).toBe('myproj');
  });

  it('prefers MCP_PROJECT_KEY over MCP_PROJECT_NAME', () => {
    process.env.MCP_PROJECT_KEY = 'key1';
    process.env.MCP_PROJECT_NAME = 'name1';
    expect(getProcessProjectKey()).toBe('key1');
  });

  it('trims MCP_PROJECT_KEY', () => {
    process.env.MCP_PROJECT_KEY = '  k  ';
    expect(getProcessProjectKey()).toBe('k');
  });
});
