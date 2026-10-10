import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = path.join(import.meta.dirname, '..')
const stagedRoots = new Set()

test.afterEach(() => {
  for (const root of stagedRoots) fs.rmSync(root, { recursive: true, force: true })
  stagedRoots.clear()
})

const stagedBuild = ({ addon = false, builder }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-startup-'))
  stagedRoots.add(root)
  fs.mkdirSync(path.join(root, 'native'), { recursive: true })
  fs.copyFileSync(path.join(projectRoot, 'native', 'build-optional.mjs'), path.join(root, 'native', 'build-optional.mjs'))
  if (addon) {
    fs.mkdirSync(path.join(root, 'build', 'Release'), { recursive: true })
    fs.copyFileSync(path.join(projectRoot, 'build', 'Release', 'codegraph_mmap.node'), path.join(root, 'build', 'Release', 'codegraph_mmap.node'))
  }
  const builderPath = path.join(root, 'fake-node-gyp.mjs')
  fs.writeFileSync(builderPath, builder)
  return { root, builderPath, buildUrl: pathToFileURL(path.join(root, 'native', 'build-optional.mjs')).href }
}

test('equivalence partition: a current-runtime native addon is verified without rebuilding it', () => {
  const staged = stagedBuild({ addon: true, builder: "process.exit(91)\n" })

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `const { ensureNativeMmap } = await import(${JSON.stringify(staged.buildUrl)}); await ensureNativeMmap()`], {
    cwd: staged.root,
    env: { ...process.env, npm_config_node_gyp: staged.builderPath },
    encoding: 'utf8',
  })

  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 0, stderr: '' })
})

test('error guessing: a failed native rebuild is fatal instead of enabling the GraphStore fallback', () => {
  const staged = stagedBuild({ addon: false, builder: "process.stderr.write('fake native build failed\\n'); process.exit(23)\n" })

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `const { ensureNativeMmap } = await import(${JSON.stringify(staged.buildUrl)}); await ensureNativeMmap()`], {
    cwd: staged.root,
    env: { ...process.env, npm_config_node_gyp: staged.builderPath },
    encoding: 'utf8',
  })

  assert.deepEqual(
    { failed: result.status !== 0, namedBuildFailure: result.stderr.includes('fake native build failed'), silentFallback: result.stderr.includes('using GraphStore fallback') },
    { failed: true, namedBuildFailure: true, silentFallback: false },
  )
})

test('domain analysis: shared daemon verifies the active-runtime addon before creating the service', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'query-daemon.mjs'), 'utf8')
  const verification = source.indexOf('await ensureNativeMmap()')
  const workerSpawn = source.indexOf('this.engine = createService()')

  assert.deepEqual({ verificationPresent: verification >= 0, workerSpawnPresent: workerSpawn >= 0, verificationFirst: verification >= 0 && verification < workerSpawn }, { verificationPresent: true, workerSpawnPresent: true, verificationFirst: true })
})
