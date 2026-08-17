/**
 * True = assume MCP (stdio): do not write to stdout/stderr; use noop logger.
 * Default is true. Only when we're clearly in a TTY (isTTY === true) do we allow file logging and non-noop logger.
 * Set MCP_STDIO=0 to force non-MCP when running in a terminal but with piped stdio.
 */
export const stdioMode =
  process.env.MCP_STDIO !== '0' && process.stdout.isTTY !== true;

export type ProcessLogSink = (message: string) => void;
const processLogSinks: ProcessLogSink[] = [];

/** Set the primary sink for writeProcessLog (e.g. file). Replaces any previously set primary. Call from index once logFile is loaded. */
export function setProcessLogSink(sink: ProcessLogSink): void {
  processLogSinks.length = 0;
  processLogSinks.push(sink);
}

/** Add an extra output for writeProcessLog (e.g. stderr). All sinks receive every message. */
export function addProcessLogSink(sink: ProcessLogSink): void {
  processLogSinks.push(sink);
}

/** Write to all registered process-log sinks (file, stderr, etc.). */
export function writeProcessLog(message: string): void {
  for (const s of processLogSinks) s(message);
}
