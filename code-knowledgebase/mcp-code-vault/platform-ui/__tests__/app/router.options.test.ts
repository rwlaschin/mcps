import { describe, it, expect, vi, afterEach } from 'vitest'

describe('app/router.options scrollBehavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('returns top-left when route has no hash', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    const mod = await import('../../app/router.options')
    const scrollBehavior = (mod.default as { scrollBehavior: (to: { hash?: string }) => unknown }).scrollBehavior
    expect(scrollBehavior({ hash: '' } as { hash: string })).toEqual({ left: 0, top: 0 })
  })

  it('scrolls to hash element when present', async () => {
    document.body.innerHTML = '<div id="target"></div>'
    const mod = await import('../../app/router.options')
    const scrollBehavior = (mod.default as { scrollBehavior: (to: { hash?: string }) => unknown }).scrollBehavior
    expect(scrollBehavior({ hash: '#target' })).toEqual({ el: '#target', top: 0 })
  })

  it('defers with rAF when hash element appears later', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      document.body.innerHTML = '<div id="late"></div>'
      cb(0)
      return 0
    })
    const mod = await import('../../app/router.options')
    const scrollBehavior = (mod.default as { scrollBehavior: (to: { hash?: string }) => unknown }).scrollBehavior
    const p = scrollBehavior({ hash: '#late' })
    await expect(p).resolves.toEqual({ el: '#late', top: 0 })
  })

  it('falls back to top-left when hash never resolves', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    document.body.innerHTML = ''
    const mod = await import('../../app/router.options')
    const scrollBehavior = (mod.default as { scrollBehavior: (to: { hash?: string }) => unknown }).scrollBehavior
    const p = scrollBehavior({ hash: '#missing' })
    await expect(p).resolves.toEqual({ left: 0, top: 0 })
  })
})
