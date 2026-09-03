import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.join(import.meta.dirname, '..')
const addon = path.join(root, 'build', 'Release', 'codegraph_mmap.node')
const require = createRequire(import.meta.url)

export const ensureNativeMmap = () => {
  if (process.platform !== 'darwin') return
  try { require(addon); return }
  catch {}

  const bundledNodeGyp = '/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'
  const nodeGyp = process.env.npm_config_node_gyp ?? (fs.existsSync(bundledNodeGyp) ? bundledNodeGyp : null)
  const result = nodeGyp
    ? spawnSync(process.execPath, [nodeGyp, 'rebuild'], { cwd: root, stdio: 'inherit', shell: false })
    : { error: new Error('npm bundled node-gyp was not found') }
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`native mmap bridge build failed with status ${result.status}`)
  try { require(addon) }
  catch (error) { throw new Error(`native mmap bridge failed to load after rebuild: ${error.message}`, { cause: error }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.platform === 'darwin') {
  try { ensureNativeMmap() }
  catch (error) { process.stderr.write(`codegraph: optional mmap bridge unavailable (${error.message})\n`) }
}
