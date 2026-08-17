/**
 * MCP stdio test harness: spawns the real server process and talks to it over stdin/stdout
 * using the SDK's StdioClientTransport and Client. Same path Cursor uses.
 * Requires MONGO_URL. Skip if unset. Run: npm run test:integration
 */

const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio');
const pathMod = require('path') as typeof import('path');

const MONGO_URL = process.env.MONGO_URL;
const PORT = process.env.MCP_TEST_PORT ?? '37654';
const SERVER_ENTRY = pathMod.resolve(__dirname, '../../src/index.ts');

const hasMongo = Boolean(MONGO_URL && String(MONGO_URL).trim());

describe('MCP stdio (integration)', () => {
  it(
    'spawns server via stdio and gets ping tool result',
    async () => {
      if (!hasMongo) {
        console.warn('MCP stdio test skipped: set MONGO_URL to run');
        return;
      }

      const mongoUrl = String(MONGO_URL).trim();
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', SERVER_ENTRY],
        env: {
          ...process.env,
          PORT,
          MONGO_URL: mongoUrl
        },
        stderr: 'pipe'
      });

      const client = new Client(
        { name: 'mcp-stdio-test', version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(transport, { timeout: 20_000 });

      const tools = await client.listTools();
      expect(tools.tools).toBeDefined();
      const pingTool = tools.tools?.find((t: { name: string }) => t.name === 'ping');
      expect(pingTool).toBeDefined();
      const configTool = tools.tools?.find((t: { name: string }) => t.name === 'config');
      expect(configTool).toBeDefined();

      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(result).toBeDefined();
      const content = result.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
      const textPart = content.find((c: { type: string }) => c.type === 'text');
      expect(textPart).toBeDefined();
      expect(textPart.text).toBe('pong');

      const configResult = await client.callTool({ name: 'config', arguments: {} });
      expect(configResult.content).toBeDefined();
      const configText = configResult.content?.find((c: { type: string }) => c.type === 'text')?.text ?? '';
      expect(configText).toContain('cwd:');
      expect(configText).toContain('port:');
      expect(configText).toContain('MCP config snippet:');

      await transport.close();
    },
    30_000
  );
});

export {};
