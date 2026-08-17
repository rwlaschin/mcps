import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** @vitejs/plugin-vue resolves against hoisted Vite; Vitest still nests its own Vite — types differ, runtime matches. */
const vuePlugin = vue() as Plugin;

export default defineConfig({
  plugins: [vuePlugin],
  resolve: {
    alias: {
      // So vite-node resolves @iconify/vue to the package (avoids "Cannot find module .../iconify.mjs" in tests)
      '@iconify/vue': path.join(dir, 'node_modules', '@iconify', 'vue'),
    },
  },
  test: {
    // Align with mcp-code-vault Jest (`--testTimeout=1000`): keep each test under 1s.
    testTimeout: 1000,
    hookTimeout: 1000,
    environment: 'happy-dom',
    server: {
      deps: {
        inline: ['@iconify/vue'],
      },
    },
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['__tests__/**/*.spec.ts', '__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      // Only app source (the old `**/.ts` glob matched almost nothing; `**/*.js` pulled noise).
      include: [
        'app.vue',
        'app.config.ts',
        'nuxt.config.ts',
        'app/**/*.{ts,vue}',
        'components/**/*.{ts,vue}',
        'composables/**/*.ts',
        'layouts/**/*.vue',
        'lib/**/*.ts',
        'pages/**/*.vue',
        'plugins/**/*.{ts,vue}',
        'server/**/*.ts'
      ],
      exclude: [
        'node_modules/**',
        '.nuxt/**',
        'dist/**',
        'coverage/**',
        '**/__tests__/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts'
      ],
      thresholds: {
        // Global thresholds: all four keys required; each must be >= 1 (see .cursor/rules/test-coverage-no-zero-files.mdc).
        statements: 70,
        branches: 60,
        lines: 70,
        functions: 55,
        // Per-file floor (Vitest built-in glob thresholds): no instrumented .ts/.vue file may show 0% on any axis
        // while the run still passes — same intent as Jest `coverageThreshold['./src/**/*.ts']` in mcp-code-vault.
        '**/*.ts': { statements: 1, branches: 1, lines: 1, functions: 1 },
        '**/*.vue': { statements: 1, branches: 1, lines: 1, functions: 1 }
      }
    }
  }
});
