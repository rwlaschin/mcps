import { register } from '../utils/discovery-store'

export default defineEventHandler(async (event) => {
  if (event.method !== 'POST') return
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body.port !== 'number') {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Expected { port: number }' })
  }
  const port = Number(body.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Invalid port' })
  }
  const label = typeof body.projectName === 'string' && body.projectName.trim()
    ? String(body.projectName).trim()
    : `mcp-${port}`
  const isNew = register(label, port)
  if (isNew) {
    console.info(`[discovery] MCP server registered: ${label} @ port ${port}`)
  }
  return { ok: true }
})
