import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('architectural boundary: importing the public query client does not load the server engine, TypeScript, or ts-morph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-client-import-'))
  const loaderPath = path.join(root, 'record-loader.mjs')
  fs.writeFileSync(loaderPath, `
export async function load(url, context, nextLoad) {
  if (url.includes('/tool-engine.mjs') || url.includes('/typescript') || url.includes('/ts-morph')) process.stderr.write(url + '\\n')
  return nextLoad(url, context)
}
`)

  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, '--input-type=module', '--eval', "await import('./query-client.mjs'); process.stdout.write('client-imported')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  })
  fs.rmSync(root, { recursive: true, force: true })

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, forbiddenLoads: result.stderr.split('\n').filter((line) => line.includes('/tool-engine.mjs') || line.includes('/typescript') || line.includes('/ts-morph')) },
    { status: 0, stdout: 'client-imported', forbiddenLoads: [] },
  )
})
