import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { MOCK_STATS_PORT } from '../../../testConstants'

vi.stubGlobal('defineEventHandler', (fn: (event: any) => any) => fn)

describe('GET /api/docs-context', () => {
  const mockEvent = {}

  it('returns cwd and port', async () => {
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    expect(result).toEqual({
      cwd: expect.any(String),
      port: expect.any(String)
    })
  }, 10_000)

  it('returns absolute project root for cwd (never placeholder)', async () => {
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    expect(result.cwd).not.toContain('/path/to')
    expect(result.cwd).not.toBe('')
    expect(path.isAbsolute(result.cwd)).toBe(true)
  })

  it('returns port default when STATS_PORT unset', async () => {
    const orig = process.env.STATS_PORT
    delete process.env.STATS_PORT
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    expect(result.port).toBe(String(MOCK_STATS_PORT))
    if (orig !== undefined) process.env.STATS_PORT = orig
  })

  it('returns STATS_PORT when set', async () => {
    const orig = process.env.STATS_PORT
    process.env.STATS_PORT = '4000'
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    expect(result.port).toBe('4000')
    if (orig !== undefined) process.env.STATS_PORT = orig
    else delete process.env.STATS_PORT
  })

  it('returns NUXT_PUBLIC_STATS_PORT when STATS_PORT unset', async () => {
    const origStats = process.env.STATS_PORT
    const origNuxt = process.env.NUXT_PUBLIC_STATS_PORT
    delete process.env.STATS_PORT
    process.env.NUXT_PUBLIC_STATS_PORT = '3100'
    vi.resetModules()
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    expect(result.port).toBe('3100')
    if (origStats !== undefined) process.env.STATS_PORT = origStats
    else delete process.env.STATS_PORT
    if (origNuxt !== undefined) process.env.NUXT_PUBLIC_STATS_PORT = origNuxt
    else delete process.env.NUXT_PUBLIC_STATS_PORT
  })

  it('returns DOCS_PROJECT_ROOT for cwd when set', async () => {
    const orig = process.env.DOCS_PROJECT_ROOT
    process.env.DOCS_PROJECT_ROOT = '/custom/root'
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    expect(result.cwd).toBe('/custom/root')
    if (orig !== undefined) process.env.DOCS_PROJECT_ROOT = orig
    else delete process.env.DOCS_PROJECT_ROOT
  })

  it('matches snapshot (structure; cwd normalized to placeholder)', async () => {
    const origPort = process.env.STATS_PORT
    const origRoot = process.env.DOCS_PROJECT_ROOT
    delete process.env.STATS_PORT
    delete process.env.DOCS_PROJECT_ROOT
    const handler = (await import('../../../server/api/docs-context.get')).default
    const result = await handler(mockEvent)
    if (origPort !== undefined) process.env.STATS_PORT = origPort
    if (origRoot !== undefined) process.env.DOCS_PROJECT_ROOT = origRoot
    const forSnapshot = {
      cwd: result.cwd ? '<project-root>' : result.cwd,
      port: result.port
    }
    expect(forSnapshot.port).toBe(String(MOCK_STATS_PORT))
    expect(forSnapshot.cwd).toBe('<project-root>')
  })
})
