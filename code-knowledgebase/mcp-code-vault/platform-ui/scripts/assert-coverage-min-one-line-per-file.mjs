#!/usr/bin/env node
/**
 * Fails if any instrumented file has measurable coverage on an axis but zero hits (0%).
 * Reads Vitest json-summary (requires reporter "json-summary" in vitest.config).
 * Complements Vitest `coverage.thresholds` globs; keeps CI honest if config is edited.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const summaryPath = path.join(dir, '..', 'coverage', 'coverage-summary.json')

const AXES = /** @type {const} */ (['lines', 'statements', 'branches', 'functions'])

if (!fs.existsSync(summaryPath)) {
  console.error(`Missing ${summaryPath}. Run vitest with --coverage first.`)
  process.exit(1)
}

const raw = fs.readFileSync(summaryPath, 'utf8')
const summary = JSON.parse(raw)

const failures = []
for (const [file, metrics] of Object.entries(summary)) {
  if (file === 'total' || !metrics) continue
  for (const axis of AXES) {
    const m = metrics[axis]
    if (!m || typeof m.total !== 'number' || typeof m.covered !== 'number') continue
    if (m.total > 0 && m.covered < 1) {
      failures.push({ file, axis, total: m.total, covered: m.covered })
    }
  }
}

if (failures.length) {
  console.error(
    'Coverage: each instrumented file must have covered >= 1 on every axis where total > 0 (no 0% rows):\n'
  )
  for (const row of failures) {
    console.error(`  ${row.file} (${row.axis} ${row.covered}/${row.total})`)
  }
  process.exit(1)
}

console.log(
  'Coverage: all instrumented files have at least one hit on lines, statements, branches, and functions (where totals > 0).'
)
