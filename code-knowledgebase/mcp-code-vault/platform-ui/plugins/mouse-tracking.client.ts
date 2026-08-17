/**
 * Global mouse-tracking plugin for Neon-Glass specular layers.
 * Updates CSS variables --mouse-x and --mouse-y on document root (0–1 normalized)
 * so glass components can react to cursor position (e.g. specular highlight).
 */
export default defineNuxtPlugin(() => {
  const root = document.documentElement

  function updateMouse(e: MouseEvent) {
    const x = e.clientX / window.innerWidth
    const y = e.clientY / window.innerHeight
    root.style.setProperty('--mouse-x', String(x))
    root.style.setProperty('--mouse-y', String(y))
  }

  window.addEventListener('mousemove', updateMouse, { passive: true })

  // Optional: reset to center when leaving viewport so specular doesn't stick to edge
  window.addEventListener('mouseout', () => {
    root.style.setProperty('--mouse-x', '0.5')
    root.style.setProperty('--mouse-y', '0.5')
  }, { passive: true })
})
