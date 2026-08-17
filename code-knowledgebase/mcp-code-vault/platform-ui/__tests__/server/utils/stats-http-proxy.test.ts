import { describe, it, expect, vi } from 'vitest'
import {
  executeStatsProxyRequest,
  statsProxyPathFromParams
} from '../../../server/utils/stats-http-proxy'

describe('statsProxyPathFromParams', () => {
  it('joins array slug segments', () => {
    expect(statsProxyPathFromParams({ slug: ['config', 'personas'] })).toBe('config/personas')
  })

  it('returns string slug as-is', () => {
    expect(statsProxyPathFromParams({ slug: 'projects' })).toBe('projects')
  })

  it('returns empty when missing', () => {
    expect(statsProxyPathFromParams(undefined)).toBe('')
  })
})

describe('executeStatsProxyRequest', () => {
  it('returns 404 when path is empty', async () => {
    const r = await executeStatsProxyRequest({
      pathStr: '',
      search: '',
      method: 'GET',
      contentType: undefined,
      authorization: undefined,
      rawBody: undefined,
      origin: 'http://127.0.0.1:1'
    })
    expect(r).toEqual({ kind: 'error', status: 404, message: 'Not found' })
  })

  it('GET forwards query and strips hop-by-hop response headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
        'x-foo': 'bar'
      }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"ok":true}').buffer)
    })
    const r = await executeStatsProxyRequest({
      pathStr: 'config/personas',
      search: '?x=1',
      method: 'GET',
      contentType: undefined,
      authorization: undefined,
      rawBody: undefined,
      fetchImpl,
      origin: 'http://127.0.0.1:9'
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9/config/personas?x=1',
      expect.objectContaining({ method: 'GET' })
    )
    expect(r.kind).toBe('response')
    if (r.kind !== 'response') return
    expect(r.status).toBe(200)
    const names = r.headers.map(([k]) => k.toLowerCase())
    expect(names).toContain('content-type')
    expect(names).toContain('x-foo')
    expect(names).not.toContain('transfer-encoding')
    expect(new TextDecoder().decode(new Uint8Array(r.body!))).toBe('{"ok":true}')
  })

  it('POST forwards content-type, authorization, and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    })
    const bodyBuf = Buffer.from('{}')
    await executeStatsProxyRequest({
      pathStr: 'config/models',
      search: '',
      method: 'POST',
      contentType: 'application/json',
      authorization: 'Bearer x',
      rawBody: bodyBuf,
      fetchImpl,
      origin: 'http://h:1'
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://h:1/config/models',
      expect.objectContaining({
        method: 'POST',
        body: bodyBuf
      })
    )
    const call = fetchImpl.mock.calls[0]![1] as { headers: Headers }
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.headers.get('authorization')).toBe('Bearer x')
  })

  it('returns null body for 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 204,
      headers: new Headers(),
      arrayBuffer: () => Promise.reject(new Error('should not read'))
    })
    const r = await executeStatsProxyRequest({
      pathStr: 'x',
      search: '',
      method: 'DELETE',
      contentType: undefined,
      authorization: undefined,
      rawBody: undefined,
      fetchImpl,
      origin: 'http://127.0.0.1:1'
    })
    expect(r.kind).toBe('response')
    if (r.kind !== 'response') return
    expect(r.body).toBe(null)
  })
})
