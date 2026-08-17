/**
 * HTTP origin of the mcp-code-vault Fastify stats server (Mongo-backed REST + scan routes).
 * Browser calls `/api/stats/...` on the Nuxt origin; Nitro proxies here so we never hit the UI port by mistake.
 */
export function getStatsBackendOrigin(): string {
  const explicit =
    process.env.NUXT_STATS_BACKEND?.trim() || process.env.CODE_VAULT_STATS_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const port =
    String(process.env.STATS_PORT || process.env.NUXT_PUBLIC_STATS_PORT || '3000').trim() || '3000'
  const host = process.env.STATS_BACKEND_HOST?.trim() || '127.0.0.1'
  return `http://${host}:${port}`
}
