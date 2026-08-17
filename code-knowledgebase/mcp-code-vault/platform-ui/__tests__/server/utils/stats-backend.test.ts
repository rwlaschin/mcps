import { describe, it, expect, afterEach } from 'vitest'
import { getStatsBackendOrigin } from '../../../server/utils/stats-backend'

describe('getStatsBackendOrigin', () => {
  const keys = [
    'NUXT_STATS_BACKEND',
    'CODE_VAULT_STATS_URL',
    'STATS_PORT',
    'NUXT_PUBLIC_STATS_PORT',
    'STATS_BACKEND_HOST'
  ] as const
  const snapshot: Partial<Record<(typeof keys)[number], string | undefined>> = {}

  afterEach(() => {
    for (const k of keys) {
      const v = snapshot[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    for (const k of keys) delete snapshot[k]
  })

  it('uses NUXT_STATS_BACKEND when set (trailing slash trimmed)', () => {
    for (const k of keys) snapshot[k] = process.env[k]
    delete process.env.CODE_VAULT_STATS_URL
    process.env.NUXT_STATS_BACKEND = 'http://example:9/'
    expect(getStatsBackendOrigin()).toBe('http://example:9')
  })

  it('falls back to STATS_PORT on 127.0.0.1', () => {
    for (const k of keys) snapshot[k] = process.env[k]
    delete process.env.NUXT_STATS_BACKEND
    delete process.env.CODE_VAULT_STATS_URL
    delete process.env.NUXT_PUBLIC_STATS_PORT
    delete process.env.STATS_BACKEND_HOST
    process.env.STATS_PORT = '3100'
    expect(getStatsBackendOrigin()).toBe('http://127.0.0.1:3100')
  })
})
