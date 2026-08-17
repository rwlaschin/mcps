import path from 'node:path'
import fs from 'node:fs/promises'

const CONCURRENCY_ERROR = 'read concurrency must be an integer from 1 to 128'

export async function readSources(root, policy, options = {}) {
  const concurrency = options.concurrency === undefined ? 16 : options.concurrency
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error(CONCURRENCY_ERROR)

  const files = policy.scan()
  const values = new Array(files.length)
  const failures = new Array(files.length)
  const readFile = options.readFile ?? fs.readFile
  const measure = options.measure !== false
  const now = measure ? (options.now ?? process.hrtime.bigint) : null
  let next = 0
  let active = 0
  let peakReads = 0
  let stopped = false
  let filesRead = 0
  let bytesRead = 0
  let readNanoseconds = 0n

  const worker = async () => {
    while (!stopped) {
      const index = next++
      if (index >= files.length) return
      if (measure) {
        active += 1
        peakReads = Math.max(peakReads, active)
      }
      const startedAt = measure ? now() : 0n
      try {
        const source = await readFile(path.join(root, files[index]), 'utf8')
        if (measure) readNanoseconds += now() - startedAt
        values[index] = source
        if (measure) {
          filesRead += 1
          bytesRead += Buffer.byteLength(source)
        }
      } catch (error) {
        if (measure) readNanoseconds += now() - startedAt
        failures[index] = error
        stopped = true
      } finally {
        if (measure) active -= 1
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()))
  const failure = failures.find(Boolean)
  if (failure) throw failure

  return {
    sources: new Map(files.map((file, index) => [file, values[index]])),
    stats: { filesRead, bytesRead, readMs: Number(readNanoseconds) / 1e6, readConcurrency: concurrency, peakReads },
  }
}
