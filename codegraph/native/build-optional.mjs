import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

if (process.platform === 'darwin') {
  const bundledNodeGyp = '/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'
  const nodeGyp = process.env.npm_config_node_gyp ?? (fs.existsSync(bundledNodeGyp) ? bundledNodeGyp : null)
  const result = nodeGyp
    ? spawnSync(process.execPath, [nodeGyp, 'rebuild'], { stdio: 'inherit', shell: false })
    : { error: new Error('npm bundled node-gyp was not found') }
  if (result.error) process.stderr.write(`codegraph: optional mmap bridge unavailable (${result.error.message})\n`)
  else if (result.status !== 0) process.stderr.write('codegraph: optional mmap bridge build failed; using GraphStore fallback\n')
}
