/**
 * Canonical project key for stream payloads and metrics (matches DB project key).
 * MCP_PROJECT_KEY overrides; else MCP_PROJECT_NAME (legacy); else 'default'.
 */
export function getProcessProjectKey(): string {
  return process.env.MCP_PROJECT_KEY?.trim() || process.env.MCP_PROJECT_NAME?.trim() || 'default';
}
