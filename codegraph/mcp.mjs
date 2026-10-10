#!/usr/bin/env node
import path from 'node:path'
import readline from 'node:readline'
import './compile-cache.mjs'
const { connectQueryDaemon } = await import('./query-daemon.mjs')

const root = process.env.CODEGRAPH_ROOT ? path.resolve(process.env.CODEGRAPH_ROOT) : null
let client = null, reconnecting = null, paused = false, ended = false, finishing = false, reloadReady = null, resumeReload = null
const held = [], active = new Map(), inFlight = new Set()
function connect() {
  if (client?.socket && !client.socket.destroyed) return Promise.resolve(client)
  return reconnecting ??= connectQueryDaemon(root ?? process.cwd(), { onControl: control => {
    if (control === 'reload') { paused = true; client = null; reloadReady = new Promise(resolve => { resumeReload = resolve }) }
  } }).then(connected => {
    client = connected
    connected.socket.once('close', () => {
      if (!paused || ended) return
      void connect().then(() => { paused = false; for (const request of held.splice(0)) feed(request); resumeReload?.(); reloadReady = null })
    })
    return connected
  }).finally(() => { reconnecting = null })
}
function feed(request) {
  if (request.method === 'notifications/cancelled') {
    const id = request.params?.requestId
    active.get(id)?.abort()
    let retained = 0, cancelled = false
    for (let index = 0; index < held.length; index += 1) {
      if (id !== undefined && held[index].id === id) cancelled = true
      else held[retained++] = held[index]
    }
    held.length = retained
    if (cancelled) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: request cancelled' }], isError: true } })}\n`)
    return
  }
  if (request.id !== undefined) {
    let duplicate = active.has(request.id)
    for (let index = 0; !duplicate && index < held.length; index += 1) duplicate = held[index].id === request.id
    if (duplicate) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'duplicate outstanding request id' } })}\n`)
      return
    }
  }
  if (paused) { held.push(request); return }
  const controller = new AbortController()
  if (request.id !== undefined) active.set(request.id, controller)
  const work = connect().then(connected => connected.mcp(request, { signal: controller.signal, root })).then(reply => {
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`)
  }).catch(error => {
    if (paused && !controller.signal.aborted && /reload|connection closed/.test(error.message)) held.push(request)
    else if (controller.signal.aborted && request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'error: request cancelled' }], isError: true } })}\n`)
    else if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } })}\n`)
    else process.stderr.write(`codegraph-mcp: ${error.message}\n`)
  }).finally(() => {
    if (active.get(request.id) === controller) active.delete(request.id)
    inFlight.delete(work)
  })
  inFlight.add(work)
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  if (!line.trim()) return
  try { feed(JSON.parse(line)) } catch { process.stderr.write('codegraph-mcp: bad JSON-RPC line\n') }
})
async function finish() {
  if (finishing) return
  finishing = true
  if (paused) await reloadReady
  while (inFlight.size || held.length) {
    await Promise.allSettled([...inFlight])
    if (paused) await reloadReady
  }
  ended = true
  await client?.close()
  process.stdout.write('', () => process.exit(0))
}
lines.on('close', finish)
process.on('SIGTERM', () => { for (const controller of active.values()) controller.abort(); void finish() })
process.on('SIGINT', () => void connect().then(connected => connected.request('refresh')))
process.on('SIGHUP', () => void connect().then(connected => connected.request('reload')))
