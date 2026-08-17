import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Workspace root: two levels up from platform-ui (parent of mcp-code-vault). Resolved from this file’s location. */
function getProjectRoot(): string {
  const currentFile = fileURLToPath(import.meta.url)
  const serverApiDir = path.dirname(currentFile) // .../platform-ui/server/api
  const platformUiRoot = path.resolve(serverApiDir, '..', '..') // .../platform-ui
  const mcpCodeVaultRoot = path.resolve(platformUiRoot, '..') // .../mcp-code-vault
  return path.resolve(mcpCodeVaultRoot, '..') // workspace root (e.g. code-knowledgebase)
}

function statsPortForDocs(): string {
  const p = process.env.STATS_PORT || process.env.NUXT_PUBLIC_STATS_PORT || '3000'
  return String(p).trim() || '3000'
}

export default defineEventHandler(() => {
  const cwd = process.env.DOCS_PROJECT_ROOT || getProjectRoot()
  const port = statsPortForDocs()
  return { cwd, port }
})
