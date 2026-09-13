#!/usr/bin/env node
// Entry shim. It owns the client's stdio connection and nothing else; mcp-server.mjs runs in a
// worker so a code reload can terminate that thread and free its whole module graph. Re-importing
// with a fresh URL cannot do that — ESM never releases a loaded specifier, so every reload would
// leak the previous graph (measured over 12 reloads of ts-morph: query-string +115 MB and still
// climbing, terminated worker flat at +2 MB).
//
// Enabling the compile cache here is the other reason this file exists: ESM evaluates static
// imports before any body code, so the server cannot turn it on for itself. NODE_COMPILE_CACHE is
// set as well, so the worker and its own parser threads inherit it.
import module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { ensureNativeMmap } from './native/build-optional.mjs'

const dir = process.env.NODE_COMPILE_CACHE || path.join(os.tmpdir(), 'codegraph-compile-cache')
process.env.NODE_COMPILE_CACHE = dir
module.enableCompileCache?.(dir)

// Control frame asking the body to drain. An object, not a sentinel string: forwarded input is
// always a string, so the two can never be confused. Not imported from the body — importing would
// load the very module graph the reload exists to throw away.
const RELEASE = { release: true }

const body = new URL('./mcp-server.mjs', import.meta.url)
let server = null
let serverReady = Promise.resolve()
let held = ''

const spawn = () => {
  server = new Worker(body)
  const worker = server
  serverReady = new Promise((resolve) => {
    const ready = (message) => { if (message?.ready) { worker.off('message', ready); resolve() } }
    worker.on('message', ready)
    worker.once('exit', resolve)
  })
  // Replies come back as messages and this process writes them, so nothing is in flight on the
  // worker's own stdout when it is terminated.
  server.on('message', (message) => { if (message?.out) process.stdout.write(message.out) })
  server.on('error', (error) => process.stderr.write(`codegraph-mcp: ${error.message}\n`))
  if (held) { server.postMessage(held); held = '' }
  return server
}

// Drain the body's in-flight requests, then terminate it — the reply is what makes terminating
// safe, and terminating is what actually frees the module graph.
const stop = async () => {
  const worker = server
  if (!worker) return
  server = null
  await Promise.race([serverReady, new Promise((resolve) => setTimeout(resolve, 5_000).unref())])
  await Promise.race([
    new Promise((resolve) => {
      const onMessage = (message) => { if (message?.released) { worker.off('message', onMessage); resolve() } }
      worker.on('message', onMessage)
      worker.once('exit', resolve)
      worker.postMessage(RELEASE)
    }),
    new Promise((resolve) => setTimeout(resolve, 1_000).unref()),
  ])
  await worker.terminate()
}

await ensureNativeMmap()
spawn()

// Input arriving mid-reload is held rather than dropped, so a request is never lost to a restart.
process.stdin.on('data', (chunk) => { server ? server.postMessage(String(chunk)) : (held += chunk) })
// Worker stdout is forwarded to this process asynchronously, so exiting the moment the worker dies
// truncates the reply it just wrote. Flush first, then exit.
const finish = async () => {
  await stop()
  process.stdout.write('', () => process.exit(0))
}

process.stdin.on('end', finish)

// SIGHUP reloads the code. The client never sees a disconnect: this process holds the pipe, and the
// replacement worker reads the current source from disk.
let reloading = null
process.on('SIGHUP', () => {
  if (reloading) return
  reloading = stop()
    .then(() => { spawn(); process.stderr.write('codegraph-mcp: reloaded\n') })
    .catch((error) => process.stderr.write(`codegraph-mcp reload: ${error.message}\n`))
    .finally(() => { reloading = null })
})

// SIGINT refreshes state only: the worker keeps running, having dropped its cached engines.
process.on('SIGINT', () => { server?.postMessage(RELEASE) })

process.on('SIGTERM', finish)
