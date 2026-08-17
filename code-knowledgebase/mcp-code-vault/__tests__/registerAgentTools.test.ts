jest.mock('../src/db/models/Project', () => ({
  Project: {
    findOne: jest.fn()
  }
}));

jest.mock('../src/db/models/Agent', () => ({
  Agent: {
    find: jest.fn()
  }
}));

jest.mock('../src/agent/loadAgentExecutionBundle', () => ({
  loadAgentExecutionBundleById: jest.fn().mockResolvedValue({
    agent: { name: 'A', tool_name: 'my_tool', description: '', system_prompt: '', model_categories: [], tools: {} },
    globalPrompt: null,
    personas: []
  })
}));

jest.mock('../src/stats/metricsClient', () => ({
  withMetrics: jest.fn((_op: string, _k: string, h: (...args: unknown[]) => unknown) => h)
}));

jest.mock('../src/logger', () => ({ logger: { warn: jest.fn() } }));

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProjectAgentMcpTools, __resetAgentMcpToolsRegistrationForTest } from '../src/mcp/registerAgentTools';
import { Project } from '../src/db/models/Project';
import { Agent } from '../src/db/models/Agent';

describe('registerProjectAgentMcpTools', () => {
  const registerTool = jest.fn();
  const server = { registerTool } as unknown as McpServer;
  const origProject = process.env.MCP_PROJECT_NAME;

  beforeEach(() => {
    __resetAgentMcpToolsRegistrationForTest();
    process.env.MCP_PROJECT_NAME = 'proj-a';
    registerTool.mockClear();
    jest.mocked(Project.findOne).mockReturnValue({
      lean: () => Promise.resolve({ _id: '507f1f77bcf86cd799439011' })
    } as never);
    jest.mocked(Agent.find).mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve([
            {
              _id: '507f1f77bcf86cd799439012',
              name: 'Agent One',
              tool_name: 'my_tool',
              description: 'Does things',
              tools: {
                file_watch: false,
                db_read_write: false,
                web_search: false,
                run_shell: false
              }
            }
          ])
      })
    } as never);
  });

  afterEach(() => {
    process.env.MCP_PROJECT_NAME = origProject;
  });

  it('registers MCP tool for each valid agent', async () => {
    await registerProjectAgentMcpTools(server);
    expect(registerTool).toHaveBeenCalledWith(
      'my_tool',
      expect.objectContaining({
        description: 'Does things',
        inputSchema: {}
      }),
      expect.any(Function)
    );
  });

  it('skips when MCP_PROJECT_NAME unset', async () => {
    delete process.env.MCP_PROJECT_NAME;
    await registerProjectAgentMcpTools(server);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('is idempotent for the process', async () => {
    await registerProjectAgentMcpTools(server);
    await registerProjectAgentMcpTools(server);
    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});
