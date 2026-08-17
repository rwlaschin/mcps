import { describe, it, expect, vi, beforeEach } from 'vitest'

const readBody = vi.fn()
vi.stubGlobal('defineEventHandler', (fn: (event: Record<string, unknown>) => unknown) => fn)
vi.stubGlobal('readBody', readBody)
vi.stubGlobal('createError', (opts: { statusCode: number; message?: string }) => {
  const e = new Error(opts.message ?? 'err')
  ;(e as { statusCode?: number }).statusCode = opts.statusCode
  return e
})

describe('POST /api/register', () => {
  beforeEach(() => {
    vi.resetModules()
    readBody.mockReset()
  })

  it('returns undefined when method is not POST', async () => {
    const handler = (await import('../../../server/api/register.post')).default
    await expect(handler({ method: 'GET' })).resolves.toBeUndefined()
  })

  it('400 when body missing port', async () => {
    readBody.mockResolvedValue({})
    const handler = (await import('../../../server/api/register.post')).default
    await expect(handler({ method: 'POST' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400 when port out of range', async () => {
    readBody.mockResolvedValue({ port: 70000 })
    const handler = (await import('../../../server/api/register.post')).default
    await expect(handler({ method: 'POST' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('registers with trimmed projectName', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    readBody.mockResolvedValue({ port: 9100, projectName: '  myproj  ' })
    const handler = (await import('../../../server/api/register.post')).default
    await expect(handler({ method: 'POST' })).resolves.toEqual({ ok: true })
    const { getServers } = await import('../../../server/utils/discovery-store')
    expect(getServers().some((s) => s.projectName === 'myproj' && s.port === 9100)).toBe(true)
  })
})
