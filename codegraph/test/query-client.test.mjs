import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('architecture contract: query client forwards internal summaries and scoped internals through the daemon protocol', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'query-client.mjs'), 'utf8')
  assert.deepEqual({ summaries: /internal-summaries/.test(source), internals: /internals/.test(source), generation: /generation/.test(source) }, { summaries: true, internals: true, generation: true })
})

test('architecture contract: query client cancellation drains the internal response before releasing the socket', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'query-client.mjs'), 'utf8')
  assert.deepEqual({ cancel: /cancel/.test(source), drain: /done/.test(source) }, { cancel: true, drain: true })
})
