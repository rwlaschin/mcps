/**
 * Wrapper entry so load-time and startup crashes are caught and logged to stderr.
 * npm run dev → tsx src/run.ts → loads index.ts and calls main().
 */
function onFatal(err: unknown): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write('[mcp] FATAL: ' + msg + '\n');
  process.exit(1);
}

try {
  const index = require('./index.ts');
  if (index.main) {
    index.main().catch(onFatal);
  }
} catch (err) {
  onFatal(err);
}
