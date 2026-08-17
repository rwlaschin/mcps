import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: () => unknown) => fn)

describe('GET /api/servers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns servers list', async () => {
    const { register } = await import('../../../server/utils/discovery-store')
    register('srv-test', 9200)
    const handler = (await import('../../../server/api/servers.get')).default
    const body = handler() as { servers: { projectName: string; port: number }[] }
    expect(body.servers.some((s) => s.projectName === 'srv-test' && s.port === 9200)).toBe(true)
  })
})
