#!/usr/bin/env node
import path from 'node:path'
import readline from 'node:readline'
import { once } from 'node:events'

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const root = path.resolve(rootAt >= 0 ? args[rootAt + 1] : process.env.CODEGRAPH_ROOT ?? process.cwd())
const profileAt = args.indexOf('--profile')
if (profileAt >= 0 && (!args[profileAt + 1] || args[profileAt + 1].startsWith('--'))) {
  process.stderr.write('codegraph: --profile requires a file path\n')
  process.exit(1)
}
const profile = profileAt >= 0 ? path.resolve(args[profileAt + 1]) : undefined
const command = args[0]
let engine = null
if (command !== 'daemon') {
  const { CodeGraphEngine } = await import('./tool-engine.mjs')
  engine = new CodeGraphEngine(root, { profile })
}
let writeTail = Promise.resolve()
const write = (record) => {
  writeTail = writeTail.then(async () => { if (!process.stdout.write(JSON.stringify(record) + '\n')) await once(process.stdout, 'drain') })
  return writeTail
}

if (command === 'build') {
  await write(await engine.build())
  await engine.dispose()
  process.exit(0)
} else if (command === 'incremental') {
  const events = JSON.parse(args[1] ?? '[]')
  await write(await engine.incremental(events))
  await engine.dispose()
  process.exit(0)
} else if (command === 'reconcile') {
  await write(await engine.reconcile())
  await engine.dispose()
  process.exit(0)
} else if (command === 'query') {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  for await (const row of engine.query(JSON.parse(args[1] ?? '{}'), { signal: controller.signal })) await write(row)
  await engine.dispose()
  process.exit(0)
} else if (command === 'daemon') {
  const { QueryDaemon } = await import('./query-daemon.mjs')
  const daemon = new QueryDaemon(root)
  const close = async () => { await daemon.close(); process.exit() }
  process.once('SIGINT', close); process.once('SIGTERM', close)
  await daemon.start()
  await new Promise(() => {})
} else if (command === 'serve') {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const active = new Map(); const MAX_CONCURRENT = 8
  const run = async (request, controller) => {
    try {
      if (request.op === 'queryBatch') {
        const rows = await engine.queryBatch(request.query, { signal: controller.signal, maxQueue: request.maxQueue })
        await write({ id: request.id, rows, done: true, cancelled: controller.signal.aborted })
        return
      }
      for await (const row of engine.query(request.query, { signal: controller.signal, maxQueue: request.maxQueue })) await write({ id: request.id, row })
      await write({ id: request.id, done: true, cancelled: controller.signal.aborted })
    } catch (error) { await write({ id: request.id, error: error.message, done: true }) }
    finally { active.delete(request.id) }
  }
  for await (const line of rl) {
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.op === 'cancel') { active.get(request.id)?.abort(); continue }
    if (active.size >= MAX_CONCURRENT) { await write({ id: request.id, error: `too many concurrent requests (max ${MAX_CONCURRENT})`, done: true }); continue }
    const controller = new AbortController(); active.set(request.id, controller); void run(request, controller)
  }
  for (const controller of active.values()) controller.abort()
  await Promise.allSettled([...active.keys()].map(async (id) => { while (active.has(id)) await new Promise((resolve) => setImmediate(resolve)) }))
} else {
  process.stderr.write('usage: tool.mjs build|incremental <events>|reconcile|query <request>|serve|daemon [--root path]\n'); process.exitCode = 1
}
