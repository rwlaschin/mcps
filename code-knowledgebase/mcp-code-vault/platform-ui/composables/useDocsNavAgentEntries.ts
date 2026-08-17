export const DOCS_NAV_AGENT_ENTRIES_KEY = 'docs-nav-agent-entries'

export type DocsNavAgentEntry = { id: string; label: string; depth: number }

/**
 * Sidebar + hash validation on /docs: agent sections (`tool-agent-<id>`) are registered from the Docs page after fetching `/config/agents`.
 */
export function useDocsNavAgentEntries() {
  return useState<DocsNavAgentEntry[]>(DOCS_NAV_AGENT_ENTRIES_KEY, () => [])
}
