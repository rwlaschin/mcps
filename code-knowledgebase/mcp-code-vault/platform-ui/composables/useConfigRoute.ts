/**
 * Nuxt may use `/config` or `/config/` depending on trailingSlash / redirects.
 * Hash-based config sections must treat both as the config page.
 */
export function isConfigPath(path: string): boolean {
  const p = path.replace(/\/+$/, '') || '/'
  return p === '/config'
}

/** Known config URL fragments (canonical + legacy aliases). */
export const CONFIG_HASH_ALIASES = new Set([
  'settings',
  'models',
  'prompts-global',
  'prompts-agents',
  'prompts-personas',
  'personas',
  'project-config',
  'prompts'
])

const CANONICAL_CONFIG_SECTION_IDS = new Set([
  'settings',
  'models',
  'prompts-global',
  'prompts-agents',
  'prompts-personas'
])

/**
 * After a full reload, vue-router can briefly expose an empty `route.hash` while
 * `window.location.hash` already contains the fragment. Merge both so sidebar + page agree.
 */
export function configHashFragment(routePath: string, routeHash: string | undefined): string {
  if (!isConfigPath(routePath)) return ''
  let h = (routeHash ?? '').replace(/^#/, '').trim()
  if (!h && typeof window !== 'undefined' && window.location?.hash) {
    const w = window.location.hash.replace(/^#/, '').trim()
    if (w && CONFIG_HASH_ALIASES.has(w)) h = w
  }
  return h
}

export function normalizeConfigSectionHash(fragment: string): string {
  let hash = fragment
  if (hash === 'project-config') hash = 'settings'
  if (hash === 'prompts') hash = 'prompts-global'
  if (hash === 'personas') hash = 'prompts-personas'
  return CANONICAL_CONFIG_SECTION_IDS.has(hash) ? hash : 'settings'
}
