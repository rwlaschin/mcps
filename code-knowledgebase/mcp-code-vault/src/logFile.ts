import * as fs from 'fs';
import * as path from 'path';

const LOG_FILENAME = 'mcp-code-vault.log';

/** Logs directory: always <package-dir>/logs (based on __dirname), so logs are created in the same place regardless of process.cwd(). */
export function getLogDir(): string {
  return path.join(__dirname, '..', 'logs');
}

let logPath: string | null = null;

/** Resolved path for the main log file. */
export function getLogPath(): string {
  if (logPath === null) {
    logPath = path.join(getLogDir(), LOG_FILENAME);
  }
  return logPath;
}

/** Ensure the logs directory exists. */
export function ensureLogDir(): void {
  try {
    fs.mkdirSync(getLogDir(), { recursive: true });
  } catch {
    // ignore
  }
}

let appendStream: fs.WriteStream | null = null;

function getAppendStream(): fs.WriteStream {
  if (appendStream === null) {
    ensureLogDir();
    appendStream = fs.createWriteStream(getLogPath(), { flags: 'a' });
  }
  return appendStream;
}

/** Append a line to the log file with an ISO timestamp. In test mode does not write to disk. */
export function appendLine(message: string): void {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const stream = getAppendStream();
    const line = message.endsWith('\n') ? message : message + '\n';
    const stamped = `${new Date().toISOString()} ${line}`;
    stream.write(stamped);
  } catch {
    // ignore
  }
}

/** Close the log file stream so shutdown can exit cleanly. */
export function closeLogFile(): void {
  if (appendStream !== null) {
    try {
      appendStream.end();
    } catch {
      // ignore
    }
    appendStream = null;
  }
}
