export const PRIMARY_BASE_URL_STATE_KEY = 'primaryBaseUrl'

/**
 * Global (app-wide) state for the primary backend base URL that the UI should use for HTTP requests.
 * This is set when the socket connects (discovery/stream-driven primary).
 */
export function usePrimaryBaseUrl() {
  // Nuxt 3 built-in global state helper (no extra deps).
  return useState<string>(PRIMARY_BASE_URL_STATE_KEY, () => '')
}

