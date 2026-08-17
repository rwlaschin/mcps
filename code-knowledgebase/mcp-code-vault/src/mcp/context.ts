import { mongoUrlLinesForSettingsContent } from '../utils/redactMongoUrl';

/**
 * MCP server context: working directory (project root) and port. Set at startup from env (WORKING_DIRECTORY, PORT); config tool can update them.
 */
let serverCwd: string = process.env.WORKING_DIRECTORY ?? process.cwd();
let serverPort: string = process.env.PORT ?? '3000';

export function getServerCwd(): string {
  return serverCwd;
}

export function getServerPort(): string {
  return serverPort;
}

export function setServerContext(cwd: string, port: string): void {
  serverCwd = cwd;
  serverPort = port;
}

export type ConfigInput = { cwd?: string; workingDirectory?: string; port?: string };

/** Apply settings from the config tool. Returns what was set. */
export function applyConfig(input: ConfigInput): { set: string[] } {
  const set: string[] = [];
  const newCwd = input.workingDirectory ?? input.cwd;
  if (newCwd !== undefined && newCwd !== '') {
    serverCwd = newCwd;
    set.push(`workingDirectory=${serverCwd}`);
  }
  if (input.port !== undefined && input.port !== '') {
    serverPort = input.port;
    set.push(`port=${serverPort}`);
  }
  return { set };
}

/** Return current settings and MCP snippet (read-only) for the settings tool. Matches Config page: config table + MCP snippet. */
export function getSettingsContent(): string {
  const projectName =
    process.env.MCP_PROJECT_NAME !== undefined && process.env.MCP_PROJECT_NAME !== ''
      ? process.env.MCP_PROJECT_NAME
      : '(not set)';
  const mongoBlock = mongoUrlLinesForSettingsContent(process.env.MONGO_URL);
  const pwd = process.env.PWD !== undefined && process.env.PWD !== '' ? process.env.PWD : '(not set)';
  const snippet = JSON.stringify(
    {
      mcpServers: {
        'mcp-code-vault': {
          command: 'node',
          args: ['dist/index.js'],
          cwd: serverCwd,
          env: {
            PORT: serverPort,
            MCP_PROJECT_NAME: process.env.MCP_PROJECT_NAME ?? '',
            WORKING_DIRECTORY: serverCwd
          }
        }
      }
    },
    null,
    2
  );
  return `Code-vault config\nprojectName: ${projectName}\n${mongoBlock}\nworkingDirectory: ${serverCwd}\ncwd: ${serverCwd}\npwd: ${pwd}\nport: ${serverPort}\n\nMCP snippet (for Cursor)\n${snippet}`;
}
