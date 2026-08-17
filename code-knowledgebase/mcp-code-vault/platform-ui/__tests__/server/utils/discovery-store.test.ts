import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('discovery-store', () => {
  const origStale = process.env.DISCOVERY_STALE_MS

  beforeEach(() => {
    vi.resetModules()
    delete process.env.DISCOVERY_STALE_MS
  })

  afterEach(() => {
    if (origStale !== undefined) process.env.DISCOVERY_STALE_MS = origStale
    else delete process.env.DISCOVERY_STALE_MS
  })

  it('register returns true for new key and false on repeat', async () => {
    const { register, getServers } = await import('../../../server/utils/discovery-store')
    expect(register('p1', 9000)).toBe(true)
    expect(register('p1', 9000)).toBe(false)
    const list = getServers()
    expect(list.some((s) => s.projectName === 'p1' && s.port === 9000)).toBe(true)
  })

  it('deregister removes an entry', async () => {
    const { register, deregister, getServers } = await import('../../../server/utils/discovery-store')
    register('p2', 9001)
    deregister('p2', 9001)
    const list = getServers()
    expect(list.some((s) => s.projectName === 'p2')).toBe(false)
  })

  it('pruneStale respects DISCOVERY_STALE_MS', async () => {
    vi.useFakeTimers()
    process.env.DISCOVERY_STALE_MS = '100'
    const { register, getServers } = await import('../../../server/utils/discovery-store')
    register('old', 9002)
    vi.setSystemTime(Date.now() + 200)
    const list = getServers()
    expect(list.some((s) => s.projectName === 'old')).toBe(false)
    vi.useRealTimers()
  })

  it('default stale window survives gaps longer than one UI broadcast interval', async () => {
    vi.useFakeTimers()
    delete process.env.DISCOVERY_STALE_MS
    vi.resetModules()
    const { register, getServers } = await import('../../../server/utils/discovery-store')
    register('survivor', 9010)
    vi.setSystemTime(Date.now() + 12_000)
    const list = getServers()
    expect(list.some((s) => s.projectName === 'survivor' && s.port === 9010)).toBe(true)
    vi.useRealTimers()
  })
})
