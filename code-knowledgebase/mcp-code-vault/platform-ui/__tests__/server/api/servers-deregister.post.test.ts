import { describe, it, expect, vi, beforeEach } from 'vitest'

const readBody = vi.fn()
vi.stubGlobal('defineEventHandler', (fn: (event: Record<string, unknown>) => unknown) => fn)
vi.stubGlobal('readBody', readBody)
vi.stubGlobal('createError', (opts: { statusCode: number; message?: string }) => {
  const e = new Error(opts.message ?? 'err')
  ;(e as { statusCode?: number }).statusCode = opts.statusCode
  return e
})

describe('POST /api/servers/deregister', () => {
  beforeEach(() => {
    vi.resetModules()
    readBody.mockReset()
  })

  it('returns undefined when method is not POST', async () => {
    const handler = (await import('../../../server/api/servers/deregister.post')).default
    await expect(handler({ method: 'GET' })).resolves.toBeUndefined()
  })

  it('400 when port invalid', async () => {
    readBody.mockResolvedValue({ port: 0 })
    const handler = (await import('../../../server/api/servers/deregister.post')).default
    await expect(handler({ method: 'POST' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('deregisters server', async () => {
    const { register, getServers } = await import('../../../server/utils/discovery-store')
    register('to-remove', 9300)
    readBody.mockResolvedValue({ port: 9300, projectName: 'to-remove' })
    const handler = (await import('../../../server/api/servers/deregister.post')).default
    await expect(handler({ method: 'POST' })).resolves.toEqual({ ok: true })
    expect(getServers().some((s) => s.projectName === 'to-remove')).toBe(false)
  })
})
