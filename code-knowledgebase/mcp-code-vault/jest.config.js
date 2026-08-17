const path = require('path');

// We define the absolute paths here so we KNOW they are correct
const root = __dirname;
const coveragePath = path.resolve(root, 'coverage');
const nodeModulesPath = path.resolve(root, 'node_modules');
const distPath = path.resolve(root, 'dist');
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: root,
  roots: [root],
  // Only match __tests__ at repo root (mcp-code-vault), not under platform-ui (Vitest)
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },

  // Use the absolute paths we just created.
  // No <rootDir> tokens, just raw strings from your OS.
  watchPathIgnorePatterns: [
    nodeModulesPath,
    coveragePath,
    distPath
  ],

  modulePathIgnorePatterns: [
    distPath
  ],

  testPathIgnorePatterns: [
    'node_modules',
    'coverage'
  ],

  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!**/node_modules/**',
    '!src/db/models/**',
    '!**/__tests__/**',
    '!src/db/seed.ts', /* script shouldn't be in production path */
    '!src/db/seed-run.ts', /* script shouldn't be in production path */
  ],
  coverageDirectory: 'coverage',
  // Jest 30's default v8 coverage can report paths that don't match collectCoverageFrom;
  // babel provider instruments source paths so coverage is reported correctly.
  coverageProvider: 'babel',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov'],
  // All four keys required; each >= 1 — see repo .cursor/rules/test-coverage-no-zero-files.mdc
  coverageThreshold: {
    global: {
      statements: 50,
      branches: 50,
      functions: 70,
      lines: 50
    },
    // Per-file floor (Jest built-in): every file under collectCoverageFrom must be >0% on each
    // axis, so the text report cannot show 0 in Stmts/Branch/Funcs/Lines for any file while
    // the run still exits 0. `global` alone is aggregate-only.
    './src/**/*.ts': {
      statements: 1,
      branches: 1,
      functions: 1,
      lines: 1
    }
  },
  // Use `npm run test:unit:watch` (watchAll): Jest's default `--watch` only runs tests
  // "related to changed files" while coverage is collected for all of `src/**/*.ts`, so
  // global thresholds will fail. `--watchAll` re-runs the full suite every time.
};