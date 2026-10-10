import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Child processes are necessary: cache activation cannot be undone in this process.
function probe(source, environment = {}) {
  const env = { ...process.env }
  delete env.NODE_COMPILE_CACHE
  delete env.NODE_DISABLE_COMPILE_CACHE
  delete env.NODE_OPTIONS
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...env, ...environment }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('equivalence partitioning: an unset cache directory enables the existing default', () => {
  const result = probe(`import module from 'node:module'; import os from 'node:os'; import path from 'node:path'
import { fileURLToPath } from 'node:url';
    await import('./compile-cache.mjs');
    console.log(JSON.stringify({ enabled: Boolean(module.getCompileCacheDir()), defaultDirectory: process.env.NODE_COMPILE_CACHE === path.join(os.tmpdir(), 'codegraph-compile-cache') }));`)
  assert.deepEqual(result, { enabled: true, defaultDirectory: true })
})

test('boundary analysis: an empty override uses the existing default', () => {
  const result = probe(`import module from 'node:module'; import os from 'node:os'; import path from 'node:path'
import { fileURLToPath } from 'node:url';
    await import('./compile-cache.mjs');
    console.log(JSON.stringify({ enabled: Boolean(module.getCompileCacheDir()), defaultDirectory: process.env.NODE_COMPILE_CACHE === path.join(os.tmpdir(), 'codegraph-compile-cache') }));`, { NODE_COMPILE_CACHE: '' })
  assert.deepEqual(result, { enabled: true, defaultDirectory: true })
})

test('error guessing: a Unicode directory with spaces remains the explicit override', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph cache λ '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const result = probe(`import module from 'node:module';
    await import('./compile-cache.mjs');
    console.log(JSON.stringify({ enabled: Boolean(module.getCompileCacheDir()), preserved: module.getCompileCacheDir().startsWith(process.env.NODE_COMPILE_CACHE) }));`, { NODE_COMPILE_CACHE: directory })
  assert.deepEqual(result, { enabled: true, preserved: true })
})

test('combinatorial analysis: disabling caching wins over an explicit directory', () => {
  const result = probe(`import module from 'node:module';
    await import('./compile-cache.mjs');
    console.log(JSON.stringify({ enabled: Boolean(module.getCompileCacheDir()) }));`, { NODE_COMPILE_CACHE: '/unused-codegraph-cache', NODE_DISABLE_COMPILE_CACHE: '1' })
  assert.deepEqual(result, { enabled: false })
})

test('equivalence partitioning: the missing Node 18 API permits startup without enabling caching', () => {
  const result = probe(`import module from 'node:module'; module.enableCompileCache = undefined;
    await import('./compile-cache.mjs');
    console.log(JSON.stringify({ enabled: Boolean(module.getCompileCacheDir()), inheritedDirectory: Boolean(process.env.NODE_COMPILE_CACHE) }));`)
  assert.deepEqual(result, { enabled: false, inheritedDirectory: true })
})

test('domain analysis: cache activation reaches a newly created worker through the inherited environment', () => {
  const result = probe(`import { Worker } from 'node:worker_threads'; import { once } from 'node:events';
    await import('./compile-cache.mjs');
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent("import module from 'node:module'; import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ enabled: Boolean(module.getCompileCacheDir()), inheritedDirectory: Boolean(process.env.NODE_COMPILE_CACHE) })")));
    const exited = once(worker, 'exit'); const [result] = await once(worker, 'message'); await exited; console.log(JSON.stringify(result));`)
  assert.deepEqual(result, { enabled: true, inheritedDirectory: true })
})

test('domain analysis: importing the service directly activates caching without starting MCP', () => {
  const result = probe(`import module from 'node:module'; await import('./mcp-server.mjs');
    console.log(JSON.stringify({ enabled: Boolean(module.getCompileCacheDir()) }));`)
  assert.deepEqual(result, { enabled: true })
})
