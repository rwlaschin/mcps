import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('Nuxt client/server plugins', () => {
  beforeEach(() => {
    vi.stubGlobal('defineNuxtPlugin', (fn: (app: { vueApp: { use: (...a: unknown[]) => void; component: (...a: unknown[]) => void } }) => void) => fn)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('apexcharts.client registers vue3-apexcharts', async () => {
    const use = vi.fn()
    const mod = await import('../../plugins/apexcharts.client')
    mod.default({ vueApp: { use, component: vi.fn() } } as never)
    expect(use).toHaveBeenCalled()
  })

  it('0.apexcharts.server registers stub components', async () => {
    const component = vi.fn()
    const mod = await import('../../plugins/0.apexcharts.server')
    mod.default({ vueApp: { use: vi.fn(), component } } as never)
    expect(component).toHaveBeenCalledWith('apexchart', expect.any(Object))
    expect(component).toHaveBeenCalledWith('ApexCharts', expect.any(Object))
  })

  it('apexcharts.server is a no-op plugin', async () => {
    const mod = await import('../../plugins/apexcharts.server')
    expect(() => mod.default({ vueApp: { use: vi.fn(), component: vi.fn() } } as never)).not.toThrow()
  })

  it('motion.client installs MotionPlugin', async () => {
    const use = vi.fn()
    const mod = await import('../../plugins/motion.client')
    mod.default({ vueApp: { use, component: vi.fn() } } as never)
    expect(use).toHaveBeenCalled()
  })

  it('mouse-tracking.client registers listeners and runs handlers (covers inner functions)', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 100, configurable: true })
    const root = document.documentElement
    const mod = await import('../../plugins/mouse-tracking.client')
    const run = mod.default as () => void
    run()
    expect(add).toHaveBeenCalledWith('mousemove', expect.any(Function), { passive: true })
    expect(add).toHaveBeenCalledWith('mouseout', expect.any(Function), { passive: true })

    const moveHandler = add.mock.calls.find((c) => c[0] === 'mousemove')?.[1] as (e: MouseEvent) => void
    const outHandler = add.mock.calls.find((c) => c[0] === 'mouseout')?.[1] as () => void
    moveHandler({ clientX: 40, clientY: 25 } as MouseEvent)
    expect(root.style.getPropertyValue('--mouse-x')).toBe('0.2')
    expect(root.style.getPropertyValue('--mouse-y')).toBe('0.25')
    outHandler()
    expect(root.style.getPropertyValue('--mouse-x')).toBe('0.5')
    expect(root.style.getPropertyValue('--mouse-y')).toBe('0.5')
    add.mockRestore()
  })
})
