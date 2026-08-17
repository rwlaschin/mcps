/** MCP SEP-986-style tool identifiers (1–128 chars, [A-Za-z0-9._-]). */
const MCP_TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidMcpToolNameId(s: string): boolean {
  const t = s.trim();
  return t.length >= 1 && t.length <= 128 && MCP_TOOL_NAME_RE.test(t);
}
