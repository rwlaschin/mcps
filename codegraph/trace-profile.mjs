import fs from 'node:fs/promises'
import path from 'node:path'

const toMicroseconds = (nanoseconds) => Number(nanoseconds / 1000n)

export function createTraceProfiler(destination, deps = {}) {
  if (destination === undefined) return null

  const now = deps.now ?? process.hrtime.bigint
  const memoryUsage = deps.memoryUsage ?? process.memoryUsage
  const writeFile = deps.writeFile ?? fs.writeFile
  const mkdir = deps.mkdir ?? fs.mkdir
  const rename = deps.rename ?? fs.rename
  const unlink = deps.unlink ?? fs.unlink
  const outputPath = path.resolve(destination)
  const events = []

  return {
    begin(name, args, options = {}) {
      const startedAt = now()
      const event = { name, cat: 'codegraph', ph: 'X', ts: toMicroseconds(startedAt), dur: 0, pid: process.pid, tid: 0 }
      if (args !== undefined) event.args = args
      let memoryBefore
      if (options.memory) {
        memoryBefore = memoryUsage()
        event.args ??= {}
        for (const field of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) event.args[`${field}Before`] = Math.trunc(memoryBefore[field] ?? 0)
      }
      events.push(event)
      return { event, startedAt, memoryBefore }
    },
    end(token) {
      token.event.dur = Math.max(0, toMicroseconds(now() - token.startedAt))
      if (token.memoryBefore) {
        const memoryAfter = memoryUsage()
        token.event.args ??= {}
        for (const field of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
          const after = Math.trunc(memoryAfter[field] ?? 0)
          token.event.args[`${field}After`] = after
          token.event.args[`${field}Delta`] = after - Math.trunc(token.memoryBefore[field] ?? 0)
        }
      }
    },
    async write() {
      const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`)
      try {
        await mkdir(path.dirname(outputPath), { recursive: true })
        await writeFile(temporaryPath, JSON.stringify({ traceEvents: events }), { encoding: 'utf8', mode: 0o600 })
        await rename(temporaryPath, outputPath)
      } catch (error) {
        try { await unlink(temporaryPath) } catch {}
        throw error
      }
    },
  }
}
