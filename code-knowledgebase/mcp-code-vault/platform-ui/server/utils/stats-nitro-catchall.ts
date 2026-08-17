import type { H3Event } from 'h3'
import {
  appendHeader,
  defineEventHandler,
  getMethod,
  getRequestHeader,
  getRequestURL,
  readRawBody,
  setResponseStatus
} from 'h3'
import { executeStatsProxyRequest, statsProxyPathFromParams } from './stats-http-proxy'

/** Nitro `/api/stats/**` → Fastify stats server (exported for tests). */
export async function handleStatsNitroCatchall(event: H3Event): Promise<string | Uint8Array | null> {
  const pathStr = statsProxyPathFromParams(event.context.params as Record<string, unknown> | undefined)
  const incoming = getRequestURL(event)
  const method = getMethod(event)
  const ct = getRequestHeader(event, 'content-type')
  const auth = getRequestHeader(event, 'authorization')

  let rawBody: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(event, false).catch(() => undefined)
    if (raw !== undefined && raw.length > 0) rawBody = raw
  }

  const result = await executeStatsProxyRequest({
    pathStr,
    search: incoming.search || '',
    method,
    contentType: ct,
    authorization: auth,
    rawBody
  })

  if (result.kind === 'error') {
    setResponseStatus(event, result.status)
    return result.message
  }

  setResponseStatus(event, result.status)
  for (const [key, value] of result.headers) {
    appendHeader(event, key, value)
  }
  if (result.body === null) return null
  return new Uint8Array(result.body)
}

export default defineEventHandler(handleStatsNitroCatchall)
