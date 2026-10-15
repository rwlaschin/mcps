#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { once } from 'node:events'
import './compile-cache.mjs'

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const requestedRoot = path.resolve(rootAt >= 0 ? args[rootAt + 1] : process.env.CODEGRAPH_ROOT ?? process.cwd())
// One spelling of the tree across every entry point; a symlinked root would otherwise be indexed
// under one path and queried under another.
const root = fs.existsSync(requestedRoot) ? fs.realpathSync(requestedRoot) : requestedRoot
const profileAt = args.indexOf('--profile')
if (profileAt >= 0 && (!args[profileAt + 1] || args[profileAt + 1].startsWith('--'))) {
  process.stderr.write('codegraph: --profile requires a file path\n')
  process.exit(1)
}
const profile = profileAt >= 0 ? path.resolve(args[profileAt + 1]) : undefined
const command = args[0]

const writeCliIndex = async (engine, generation) => {
  const [graph] = await engine.queryBatch({ type: 'graph', generation, limit: 1 })
  if (!graph || !Array.isArray(graph.files) || !Array.isArray(graph.symbols) || !Array.isArray(graph.edges)) throw new Error('build returned an invalid graph')
  const files = graph.files
  const fileIndexes = new Map(files.map((file, index) => [file, index]))
  const symbolIndexes = new Map(graph.symbols.map((symbol, index) => [symbol.id, index]))
  const n = graph.symbols.length
  const forward = Array.from({ length: n }, () => [])
  const reverse = Array.from({ length: n }, () => [])
  for (const edge of graph.edges) {
    const from = symbolIndexes.get(edge.from), to = symbolIndexes.get(edge.to)
    if (from === undefined || to === undefined) throw new Error('build returned an invalid graph edge')
    const value = { target: to, line: edge.line, call: edge.call ? 1 : 0 }
    forward[from].push(value); reverse[to].push({ ...value, target: from })
  }
  const csr = (rows) => {
    const offsets = new Int32Array(n + 1); let length = 0
    for (let index = 0; index < n; index += 1) { length += rows[index].length; offsets[index + 1] = length }
    const target = new Int32Array(length), line = new Int32Array(length), call = new Int32Array(length)
    let at = 0
    for (const row of rows) for (const edge of row) { target[at] = edge.target; line[at] = edge.line; call[at] = edge.call; at += 1 }
    return { offsets, target, line, call }
  }
  const fwd = csr(forward), rev = csr(reverse), m = fwd.target.length
  const words = new Int32Array(2 + (n + 1) + m + m + m + (n + 1) + m + m + m)
  let at = 0
  words[at++] = n; words[at++] = m
  for (const part of [fwd.offsets, fwd.target, fwd.line, fwd.call, rev.offsets, rev.target, rev.line, rev.call]) { words.set(part, at); at += part.length }
  const maxMtimeMs = files.reduce((max, file) => Math.max(max, fs.statSync(path.join(root, file)).mtimeMs), 0)
  const meta = {
    files,
    symbols: graph.symbols.map((symbol) => ({ name: symbol.name, file: fileIndexes.get(symbol.file), line: symbol.line, kind: symbol.kind, exp: symbol.exported })),
    maxMtimeMs,
  }
  const output = path.join(root, '.codegraph')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'graph.bin'), Buffer.from(words.buffer))
  fs.writeFileSync(path.join(output, 'meta.json'), JSON.stringify(meta))
}

let engine = null
if (command !== 'daemon') {
  const { connectQueryDaemon } = await import('./query-daemon.mjs')
  const client = await connectQueryDaemon(root)
  engine = {
    build: () => client.request('build', { root, profile }),
    incremental: events => client.request('incremental', { root, profile, events }),
    reconcile: () => client.request('reconcile', { root, profile }),
    query: (query, options) => client.query(query, options),
    queryBatch: (query, options) => client.queryBatch(query, options),
    dispose: () => client.close(),
  }
}
let writeTail = Promise.resolve()
const write = (record) => {
  writeTail = writeTail.then(async () => { if (!process.stdout.write(JSON.stringify(record) + '\n')) await once(process.stdout, 'drain') })
  return writeTail
}

if (command === 'build') {
  const result = await engine.build()
  await writeCliIndex(engine, result.generation)
  await write(result)
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
  daemon.onClose = error => process.exit(error ? 1 : 0)
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
  await engine.dispose()
} else {
  process.stderr.write('usage: tool.mjs build|incremental <events>|reconcile|query <request>|serve|daemon [--root path]\n'); process.exitCode = 1
}
