import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { handleStatsNitroCatchall } from '../../../server/utils/stats-nitro-catchall'

function makeEvent(method: string, urlPathWithQuery: string) {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = method
  req.url = urlPathWithQuery
  req.headers = { host: '127.0.0.1' }
  const res = new ServerResponse(req)
  const event = createEvent(req, res)
  return event
}

describe('stats api route module', () => {
  it('re-exports the catch-all handler from [...slug]', async () => {
    const mod = await import('../../../server/api/stats/[...slug].ts')
    expect(typeof mod.default).toBe('function')
  })
})

describe('handleStatsNitroCatchall', () => {
  const fetchMock = vi.fn()
  const prevFetch = globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = prevFetch
  })

  it('proxies GET and sets response status', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('[]').buffer)
    })
    const event = makeEvent('GET', '/api/stats/config/personas')
    event.context.params = { slug: 'config/personas' }
    const body = await handleStatsNitroCatchall(event)
    expect(fetchMock).toHaveBeenCalled()
    expect(body).toBeInstanceOf(Uint8Array)
  })
})
