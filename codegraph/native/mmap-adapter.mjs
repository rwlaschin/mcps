import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let binding = null
try { binding = require('../build/Release/codegraph_mmap.node') } catch {}

export const nativeMmapAdapter = binding ? {
  open(filePath, capacity) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    return binding.open(filePath, capacity)
  },
  resize: (handle, capacity) => binding.resize(handle, capacity),
  map: (handle) => binding.map(handle),
  flush: (mapping, offset, length) => binding.flush(mapping, offset, length),
  unmap: (mapping) => binding.unmap(mapping),
  close: (handle) => binding.close(handle),
  pageSize: () => binding.pageSize(),
} : null
