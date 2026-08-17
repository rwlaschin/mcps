import * as fs from 'fs';
import * as path from 'path';
import { getLogDir } from '../logFile';

const REQUEST_LOG_FILENAME = 'mcp-requests.log';

function getRequestLogPath(): string {
  return path.join(getLogDir(), REQUEST_LOG_FILENAME);
}

function ensureLogDir(): void {
  try {
    fs.mkdirSync(getLogDir(), { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Log an incoming MCP request (method name). Writes to logs/mcp-requests.log
 * even in stdio mode. Uses appendFileSync so each line is visible immediately when tailing.
 */
export function appendRequestLog(method: string): void {
  try {
    ensureLogDir();
    const line = `${new Date().toISOString()} [MCP] request ${method}\n`;
    fs.appendFileSync(getRequestLogPath(), line);
  } catch {
    // ignore
  }
}
