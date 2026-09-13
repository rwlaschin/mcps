#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createDisposableMirror } from './codegraph.performance.mjs'
import { CodeGraphEngine } from '../tool-engine.mjs'

if (!process.argv[2]) throw new Error('usage: measure-cold-internals.mjs <repository>')
const sourceRoot = path.resolve(process.argv[2])
const mirror = await createDisposableMirror(sourceRoot)
let peak = process.memoryUsage()
const timer = setInterval(() => {
  const current = process.memoryUsage()
  for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers']) peak[key] = Math.max(peak[key], current[key])
}, 10)
try {
  const engine = new CodeGraphEngine(mirror)
  const start = performance.now(); const result = await engine.build(); const wallMs = performance.now() - start
  clearInterval(timer)
  const manifest = engine.readGeneration(result.generation)
  const ids = new Set(Object.values(manifest.internalPartitions ?? {}))
  const internalBytes = [...ids].reduce((sum, id) => sum + fs.statSync(path.join(mirror, '.codegraph', 'internal-partitions', `${id}.bin`)).size, 0)
  await engine.dispose()
  process.stdout.write(`${JSON.stringify({ wallMs, parsedFiles: result.parsedFiles?.length, generation: result.generation, peak, internalPartitionCount: ids.size, internalBytes })}\n`)
} finally {
  clearInterval(timer)
  fs.rmSync(path.dirname(mirror), { recursive: true, force: true })
}
