import module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const dir = process.env.NODE_COMPILE_CACHE || path.join(os.tmpdir(), 'codegraph-compile-cache')
process.env.NODE_COMPILE_CACHE = dir
module.enableCompileCache?.(dir)
