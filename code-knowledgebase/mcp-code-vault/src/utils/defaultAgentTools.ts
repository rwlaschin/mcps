/**
 * Built-in MCP tools (always on the server). See Platform UI Docs → MCP tools reference.
 */
export const MCP_BUILTIN_TOOL_IDS = ['ping', 'settings', 'config'] as const;

export const MCP_BUILTIN_TOOL_SUMMARIES: Record<(typeof MCP_BUILTIN_TOOL_IDS)[number], string> = {
  ping: 'Verify the connection; returns pong.',
  settings: 'Read-only server settings and paste-ready MCP snippet.',
  config: 'Update working directory and/or port at runtime.'
};

/**
 * Default agent capability flags when `tools` is omitted on create (matches documented tool flags shape).
 */
export const DEFAULT_AGENT_TOOLS_ON_CREATE = {
  file_watch: true,
  db_read_write: true,
  web_search: true,
  run_shell: true
} as const;
