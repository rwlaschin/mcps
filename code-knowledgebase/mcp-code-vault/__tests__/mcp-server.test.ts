jest.mock('../src/stats/metricsClient', () => ({
  // Real signature: withMetrics(operation, kind, handler) — third arg is the handler.
  withMetrics: jest.fn(
    (_operation: string, _kind: string, handler: (...args: unknown[]) => unknown) => handler
  )
}));

jest.mock('../src/mcp/context', () => {
  const { MOCK_STATS_PORT } = require('./testConstants');
  return {
    getServerCwd: jest.fn(() => '/test-cwd'),
    getServerPort: jest.fn(() => String(MOCK_STATS_PORT)),
    applyConfig: jest.fn(() => ({ set: [] })),
    getSettingsContent: jest.fn(() => `Code-vault config\ncwd: /test-cwd\nport: ${MOCK_STATS_PORT}\n\nMCP snippet (for Cursor)\n{}`)
  };
});

import { createMcpServerApp } from '../src/mcp/server';
import { withMetrics } from '../src/stats/metricsClient';
import { applyConfig, getSettingsContent } from '../src/mcp/context';

type ToolHandler = (...args: unknown[]) => Promise<{ content: { type: string; text: string }[] }>;

function handlersFromLastApp() {
  const calls = jest.mocked(withMetrics).mock.calls as [string, string, ToolHandler][];
  const byOp = (op: string) => {
    const row = [...calls].reverse().find((c) => c[0] === op);
    expect(row?.[2]).toBeDefined();
    return row![2];
  };
  return { ping: byOp('ping'), settings: byOp('settings'), config: byOp('config') };
}

describe('MCP server', () => {
  beforeEach(() => {
    jest.mocked(withMetrics).mockClear();
    jest.mocked(applyConfig).mockReturnValue({ set: [] });
  });

  it('createMcpServerApp returns a server instance', () => {
    const server = createMcpServerApp();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  it('server has connect and close methods', () => {
    const server = createMcpServerApp();
    expect(typeof server.connect).toBe('function');
    expect(typeof server.close).toBe('function');
  });

  it('server is not connected before connect()', () => {
    const server = createMcpServerApp();
    expect(server.isConnected()).toBe(false);
  });

  it('ping tool handler returns pong', async () => {
    createMcpServerApp();
    const { ping } = handlersFromLastApp();
    const out = await ping({}, {});
    expect(out.content[0].text).toBe('pong');
  });

  it('settings tool handler returns getSettingsContent text', async () => {
    createMcpServerApp();
    const { settings } = handlersFromLastApp();
    const out = await settings();
    expect(jest.mocked(getSettingsContent)).toHaveBeenCalled();
    expect(out.content[0].text).toContain('Code-vault');
  });

  it('config tool handler uses empty object when args is not an object', async () => {
    createMcpServerApp();
    const { config } = handlersFromLastApp();
    await config(null);
    expect(jest.mocked(applyConfig)).toHaveBeenCalledWith({});
  });

  it('config tool handler reports when nothing was set', async () => {
    jest.mocked(applyConfig).mockReturnValue({ set: [] });
    createMcpServerApp();
    const { config } = handlersFromLastApp();
    const out = await config({ workingDirectory: '/tmp' });
    expect(out.content[0].text).toContain('No settings provided');
  });

  it('config tool handler reports applied keys when applyConfig sets values', async () => {
    jest.mocked(applyConfig).mockReturnValue({ set: ['port=4000'] });
    createMcpServerApp();
    const { config } = handlersFromLastApp();
    const out = await config({ port: '4000' });
    expect(out.content[0].text).toContain('Set:');
    expect(out.content[0].text).toContain('port=4000');
  });
});
