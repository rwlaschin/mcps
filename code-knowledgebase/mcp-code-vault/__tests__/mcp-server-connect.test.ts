jest.mock('@modelcontextprotocol/sdk/server/stdio', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/stats/metricsClient', () => ({
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

import { createMcpServer } from '../src/mcp/server';

describe('createMcpServer', () => {
  it('returns server after connecting transport', async () => {
    const server = await createMcpServer();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
    expect(typeof server.connect).toBe('function');
    expect(typeof server.close).toBe('function');
  });
});
