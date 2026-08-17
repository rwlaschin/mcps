import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { withMetrics } from '../stats/metricsClient';
import { createLoggingStdioTransport } from './transportLogger';
import { getServerCwd, getServerPort, applyConfig, getSettingsContent } from './context';

let activeMcpServer: McpServer | null = null;

export function getMcpServerInstance(): McpServer | null {
  return activeMcpServer;
}

function getInstructions(): string {
  const cwd = getServerCwd();
  const port = getServerPort();
  return `mcp-code-vault: code knowledge base. CWD=${cwd}, PORT=${port}.

Tools:
- \`ping\`: verify connection (returns "pong").
- \`settings\`: return current settings (workingDirectory, cwd, port). Read-only.
- \`config\`: set settings (workingDirectory, cwd, port). Pass workingDirectory and/or port to update.
- Plus one MCP tool per agent for your project (see Config → Agents → Tool name). Each tool returns that agent's resolved execution bundle (JSON). Listed after Mongo connects.

Doc: See the Docs page in the Platform UI (e.g. http://localhost:2999/docs) for setup, MCP in Cursor, and configuration.
Use \`tools/list\` to list tools.`;
}

export function createMcpServerApp(): McpServer {
  const server = new McpServer(
    {
      name: 'mcp-code-vault',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: getInstructions()
    }
  );

  const pingHandler = withMetrics('ping', 'query', async (_args: unknown, _extra: unknown) => ({
    content: [{ type: 'text' as const, text: 'pong' }]
  }));

  server.registerTool(
    'ping',
    {
      description: 'Ping the MCP server. Returns pong.',
      inputSchema: {}
    },
    pingHandler as (args: unknown, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>
  );

  const settingsHandler = withMetrics('settings', 'query', async () => {
    const text = getSettingsContent();
    return { content: [{ type: 'text' as const, text }] };
  });

  server.registerTool(
    'settings',
    {
      description: 'Return current server settings (workingDirectory, cwd, port). Read-only.',
      inputSchema: {}
    },
    settingsHandler as (args: unknown, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>
  );

  const configHandler = withMetrics('config', 'query', async (args: unknown) => {
    const input = (args && typeof args === 'object' ? args : {}) as {
      cwd?: string;
      workingDirectory?: string;
      port?: string;
    };
    const { set } = applyConfig(input);
    const text =
      set.length > 0
        ? `Set: ${set.join(', ')}`
        : 'No settings provided. Pass workingDirectory (or cwd) and/or port to set.';
    return { content: [{ type: 'text' as const, text }] };
  });

  server.registerTool(
    'config',
    {
      description: 'Set server settings: workingDirectory (or cwd), port. Pass workingDirectory and/or port to update.',
      inputSchema: {}
    },
    configHandler as (args: unknown, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>
  );

  return server;
}

export async function createMcpServer(): Promise<McpServer> {
  const server = createMcpServerApp();
  activeMcpServer = server;
  const transport = createLoggingStdioTransport();
  await server.connect(transport);
  return server;
}
