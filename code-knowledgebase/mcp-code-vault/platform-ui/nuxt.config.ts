import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Vitest/Vite can load this file with a non-file import.meta.url (e.g. virtual or http); use cwd in that case
function getRootDir(): string {
  try {
    const u = import.meta.url
    if (typeof u === 'string' && u.startsWith('file:')) {
      return fileURLToPath(new URL('.', u))
    }
  } catch (_) {}
  return process.cwd()
}
const rootDir = getRootDir()

export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss', '@nuxt/icon'],
  // Disable DevTools so the component-inspector overlay is not injected (it passes style to a fragment-root component and triggers Vue warn)
  devtools: { enabled: false },
  build: { transpile: ['socket.io-client'] },
  vite: {
    resolve: {
      alias: {
        // socket.io-client pulls in "debug"; browser build has no ESM default export
        debug: join(rootDir, 'debug-stub.js'),
        'debug/src/browser.js': join(rootDir, 'debug-stub.js')
      }
    },
    optimizeDeps: {
      include: ['socket.io-client']
    }
  },
  css: ['~/app.css'],
  app: {
    pageTransition: { name: 'page', mode: 'out-in' }
  },
  devServer: {
    // UI must not use 3000 — that's the MCP/stats server. NUXT_PORT (or 2999) wins over inherited PORT.
    port: Number(process.env.NUXT_PORT || process.env.NITRO_PORT) || 2999,
    // Listen on all interfaces, IPv4 and IPv6 (:: is dual-stack). Set NUXT_HOST to override (e.g. 127.0.0.1).
    host: typeof process.env.NUXT_HOST === 'string' && process.env.NUXT_HOST ? process.env.NUXT_HOST : '::'
  },
  routeRules: {
    '/': { prerender: false },
    '/config': { prerender: false },
    '/docs': { prerender: false },
    '/scan': { prerender: false }
  },
  experimental: {
    payloadExtraction: false
  },
  nitro: {
    compatibilityDate: '2026-02-15',
    compressPublicAssets: { gzip: true, brotli: true }
  },
  // Documented for ops; server/utils/stats-backend.ts also reads these env vars directly.
  runtimeConfig: {
    statsBackend: process.env.NUXT_STATS_BACKEND || process.env.CODE_VAULT_STATS_URL || ''
  }
})
