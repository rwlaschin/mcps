import type { RouterConfig } from '@nuxt/schema'

export default <RouterConfig>{
  scrollBehavior(to) {
    if (to.hash && typeof document !== 'undefined') {
      const hash = to.hash
      const el = document.querySelector(hash)
      if (el) return { el: hash, top: 0 }
      // One frame defer so SSR/hydration can paint the target
      return new Promise<{ el: string; top: number } | { left: number; top: number }>((resolve) => {
        requestAnimationFrame(() => {
          resolve(document.querySelector(hash) ? { el: hash, top: 0 } : { left: 0, top: 0 })
        })
      })
    }
    return { left: 0, top: 0 }
  }
}
