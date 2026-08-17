import { deregister } from '../../utils/discovery-store'

export default defineEventHandler(async (event) => {
  if (event.method !== 'POST') return
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body.port !== 'number') {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Expected { port: number, projectName?: string }' })
  }
  const port = Number(body.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Invalid port' })
  }
  const projectName = typeof body.projectName === 'string' && body.projectName.trim()
    ? String(body.projectName).trim()
    : `mcp-${port}`
  deregister(projectName, port)
  return { ok: true }
})
