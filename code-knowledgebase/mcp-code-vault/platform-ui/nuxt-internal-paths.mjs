/**
 * Node resolves `#internal/nuxt/paths` against the app package.json when Nitro loads
 * `.nuxt/dist/server/server.mjs` in dev. Nuxt expects this import map; without it, SSR
 * throws ERR_PACKAGE_IMPORT_NOT_DEFINED (see nuxt dev getServerEntry → dynamic import).
 */
export function baseURL() {
  const fromEnv = process.env.NUXT_APP_BASE_URL
  if (typeof fromEnv === 'string' && fromEnv.length) return fromEnv
  return '/'
}
