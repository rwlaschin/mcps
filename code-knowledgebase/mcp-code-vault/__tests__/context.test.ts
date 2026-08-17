const {
  setServerContext,
  getServerCwd,
  getServerPort,
  applyConfig,
  getSettingsContent
} = require('../src/mcp/context');

describe('MCP context', () => {
  beforeEach(() => {
    setServerContext(process.cwd(), '3000');
  });

  it('getServerCwd and getServerPort return values set by setServerContext', () => {
    expect(getServerCwd()).toBe(process.cwd());
    expect(getServerPort()).toBe('3000');
  });

  it('setServerContext updates getServerCwd and getServerPort', () => {
    setServerContext('/some/cwd', '4000');
    expect(getServerCwd()).toBe('/some/cwd');
    expect(getServerPort()).toBe('4000');
  });

  it('applyConfig sets working directory when cwd or workingDirectory provided', () => {
    setServerContext('/initial', '3000');
    const { set: set1 } = applyConfig({ cwd: '/new/cwd' });
    expect(set1).toContain('workingDirectory=/new/cwd');
    expect(getServerCwd()).toBe('/new/cwd');
    setServerContext('/initial', '3000');
    const { set: set2 } = applyConfig({ workingDirectory: '/other/wd' });
    expect(set2).toContain('workingDirectory=/other/wd');
    expect(getServerCwd()).toBe('/other/wd');
    expect(getServerPort()).toBe('3000');
  });

  it('applyConfig sets port when provided', () => {
    setServerContext('/app', '3000');
    const { set } = applyConfig({ port: '5000' });
    expect(set).toContain('port=5000');
    expect(getServerCwd()).toBe('/app');
    expect(getServerPort()).toBe('5000');
  });

  it('applyConfig sets both workingDirectory and port', () => {
    const { set } = applyConfig({ workingDirectory: '/proj', port: '4000' });
    expect(set).toEqual(['workingDirectory=/proj', 'port=4000']);
    expect(getServerCwd()).toBe('/proj');
    expect(getServerPort()).toBe('4000');
  });

  it('applyConfig ignores empty string and undefined', () => {
    setServerContext('/ok', '3001');
    expect(applyConfig({}).set).toEqual([]);
    expect(applyConfig({ cwd: '' }).set).toEqual([]);
    expect(applyConfig({ workingDirectory: '' }).set).toEqual([]);
    expect(applyConfig({ port: '' }).set).toEqual([]);
    expect(getServerCwd()).toBe('/ok');
    expect(getServerPort()).toBe('3001');
  });

  it('getSettingsContent returns Code-vault config and MCP snippet', () => {
    setServerContext('/my/project', '4100');
    const content = getSettingsContent();
    expect(content).toContain('Code-vault config');
    expect(content).toContain('projectName:');
    expect(content).toContain('mongoUrl:');
    expect(content).toContain('workingDirectory: /my/project');
    expect(content).toContain('cwd: /my/project');
    expect(content).toContain('pwd:');
    expect(content).toContain('port: 4100');
    expect(content).toContain('MCP snippet (for Cursor)');
    expect(content).toContain('"mcp-code-vault"');
    expect(content).toContain('"cwd": "/my/project"');
    expect(content).toContain('"PORT": "4100"');
    expect(content).toContain('"WORKING_DIRECTORY": "/my/project"');
  });

  it('getSettingsContent shows (not set) for projectName when MCP_PROJECT_NAME unset', () => {
    const orig = process.env.MCP_PROJECT_NAME;
    delete process.env.MCP_PROJECT_NAME;
    setServerContext('/x', '3000');
    const content = getSettingsContent();
    expect(content).toContain('projectName: (not set)');
    expect(content).not.toContain('my-project');
    if (orig !== undefined) process.env.MCP_PROJECT_NAME = orig;
  });
});
