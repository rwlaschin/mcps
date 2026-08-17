import { getStatsBackendOrigin } from './stats-backend'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-encoding'
])

export type StatsProxyParams = {
  pathStr: string
  search: string
  method: string
  contentType: string | undefined
  authorization: string | undefined
  rawBody: Buffer | undefined
  /** Injected for tests */
  fetchImpl?: typeof fetch
  origin?: string
}

export type StatsProxyResult =
  | { kind: 'error'; status: number; message: string }
  | {
      kind: 'response'
      status: number
      headers: Array<[string, string]>
      body: ArrayBuffer | null
    }

function joinSlug(slug: string | string[] | undefined): string {
  if (slug == null) return ''
  return Array.isArray(slug) ? slug.join('/') : slug
}

/**
 * Build upstream URL and perform the request (used by `/api/stats/*` Nitro route).
 */
export async function executeStatsProxyRequest(params: StatsProxyParams): Promise<StatsProxyResult> {
  const pathStr = params.pathStr
  if (!pathStr) {
    return { kind: 'error', status: 404, message: 'Not found' }
  }

  const origin = (params.origin ?? getStatsBackendOrigin()).replace(/\/$/, '')
  const target = `${origin}/${pathStr}${params.search || ''}`
  const headers = new Headers()
  if (params.contentType) headers.set('content-type', params.contentType)
  if (params.authorization) headers.set('authorization', params.authorization)

  const fetchFn = params.fetchImpl ?? globalThis.fetch
  const res = await fetchFn(target, {
    method: params.method,
    headers,
    body:
      params.method !== 'GET' && params.method !== 'HEAD' && params.rawBody?.length
        ? new Uint8Array(params.rawBody)
        : undefined
  })

  const outHeaders: Array<[string, string]> = []
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP.has(k)) return
    outHeaders.push([key, value])
  })

  if (res.status === 204 || res.status === 304) {
    return { kind: 'response', status: res.status, headers: outHeaders, body: null }
  }
  const body = new Uint8Array(await res.arrayBuffer())
  return {
    kind: 'response',
    status: res.status,
    headers: outHeaders,
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
}

export function statsProxyPathFromParams(params: Record<string, unknown> | undefined): string {
  const slug = params?.slug as string | string[] | undefined
  return joinSlug(slug)
}
