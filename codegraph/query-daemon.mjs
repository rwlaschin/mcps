import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const startupBySocket = new Map()
const CONNECT_TIMEOUT_MS = 500
const STARTUP_TIMEOUT_MS = 15000
const STARTUP_POLL_MIN_MS = 10
const STARTUP_POLL_MAX_MS = 50

export function daemonSocketPath(root) {
  const canonical = path.resolve(root)
  const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24)
  return path.join(os.tmpdir(), `codegraph-${digest}.sock`)
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const timer = setTimeout(() => socket.destroy(new Error(`timed out connecting to ${socketPath}`)), CONNECT_TIMEOUT_MS)
    const cleanup = () => { clearTimeout(timer); socket.off('error', fail) }
    const fail = (error) => { cleanup(); reject(error) }
    socket.once('error', fail)
    socket.once('connect', () => { cleanup(); resolve(socket) })
  })
}

async function defaultStartDaemon(root) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'tool.mjs'), 'daemon', '--root', root], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    setTimeout(resolve, 20)
  })
}

function readinessError(root, cause) {
  return new Error(`CodeGraph daemon failed to become ready for ${root}`, { cause })
}

async function waitForDaemon(root, socketPath) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastError
  let attempt = 0
  while (Date.now() < deadline) {
    try { return await connectSocket(socketPath) }
    catch (error) { lastError = error }
    const backoff = Math.min(STARTUP_POLL_MAX_MS, STARTUP_POLL_MIN_MS + attempt * 2)
    const jitter = Math.floor(Math.random() * STARTUP_POLL_MIN_MS)
    await new Promise((resolve) => setTimeout(resolve, backoff + jitter))
    attempt += 1
  }
  throw readinessError(root, lastError)
}

async function startOnce(root, socketPath, startDaemon) {
  let startup = startupBySocket.get(socketPath)
  if (!startup) {
    startup = Promise.resolve()
      .then(startDaemon)
      .then(() => waitForDaemon(root, socketPath))
      .then((probe) => { probe.destroy() })
      .catch((error) => { throw /failed to become ready/.test(error.message) ? error : readinessError(root, error) })
      .finally(() => startupBySocket.delete(socketPath))
    startupBySocket.set(socketPath, startup)
  }
  return startup
}

async function connectAfterStart(root, startDaemon) {
  const socketPath = daemonSocketPath(root)
  try { return await connectSocket(socketPath) }
  catch (firstError) {
    await startOnce(root, socketPath, startDaemon)
    try { return await connectSocket(socketPath) }
    catch (secondError) { throw readinessError(root, secondError ?? firstError) }
  }
}

export class QueryDaemon {
  constructor(root, options = {}) {
    this.root = path.resolve(root)
    this.socketPath = daemonSocketPath(this.root)
    this.engineFactory = options.engineFactory ?? null
    this.engine = null
    this.server = null
    this.sockets = new Set()
    this.active = new Map()
    this.closing = null
    this.ownsSocket = false
  }

  async start() {
    if (this.server) return
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true })
    if (fs.existsSync(this.socketPath)) {
      try {
        const probe = await connectSocket(this.socketPath)
        probe.destroy()
        throw new Error(`an active CodeGraph daemon already owns ${this.socketPath}`)
      } catch (error) {
        if (/already owns/.test(error.message)) throw error
        fs.rmSync(this.socketPath, { force: true })
      }
    }
    try {
      if (this.engineFactory) this.engine = await this.engineFactory()
      else {
        const { DaemonQueryEngine } = await import('./daemon-query-engine.mjs')
        this.engine = new DaemonQueryEngine(this.root)
      }
      const server = net.createServer((socket) => this.#accept(socket))
      this.server = server
      server.listen(this.socketPath)
      await once(server, 'listening')
      this.ownsSocket = true
    }
    catch (error) { this.server?.close(); this.server = null; await this.engine?.dispose?.(); this.engine = null; throw error }
  }

  #accept(socket) {
    socket.queryDaemonId = crypto.randomUUID()
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    socket.once('close', () => {
      this.sockets.delete(socket)
      for (const [key, request] of this.active) if (request.socket === socket) { request.controller.abort(); this.active.delete(key) }
    })
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let message
      try { message = JSON.parse(line) }
      catch { socket.write(`${JSON.stringify({ error: 'invalid JSON', done: true })}\n`); return }
      const objectMessage = message !== null && typeof message === 'object' && !Array.isArray(message)
      const supported = objectMessage && (message.op === 'query' || message.op === 'queryBatch' || message.op === 'cancel')
      const validQuery = message?.op === 'cancel' || (message?.query !== null && typeof message?.query === 'object' && !Array.isArray(message?.query))
      if (!supported || !validQuery) {
        socket.write(`${JSON.stringify({ id: objectMessage ? message.id : undefined, error: 'invalid request', done: true })}\n`)
        return
      }
      if (message.op === 'cancel') {
        this.active.get(`${socket.queryDaemonId}:${message.id}`)?.controller.abort()
        return
      }
      void this.#run(socket, message)
    })
  }

  async #run(socket, request) {
    const key = `${socket.queryDaemonId}:${request.id}`
    const controller = new AbortController()
    this.active.set(key, { socket, controller })
    try {
      if (request.op === 'queryBatch') {
        const queryOptions = { signal: controller.signal, maxQueue: request.maxQueue }
        const rows = this.engine.queryBatch ? await this.engine.queryBatch(request.query, queryOptions) : []
        if (!this.engine.queryBatch) for await (const row of this.engine.query(request.query, queryOptions)) rows.push(row)
        if (socket.writable) socket.write(`${JSON.stringify({ id: request.id, rows, done: true, cancelled: controller.signal.aborted })}\n`)
        return
      }
      for await (const row of this.engine.query(request.query, { signal: controller.signal, maxQueue: request.maxQueue })) {
        if (!socket.writable || controller.signal.aborted) break
        if (!socket.write(`${JSON.stringify({ id: request.id, row })}\n`)) await once(socket, 'drain')
      }
      if (socket.writable) socket.write(`${JSON.stringify({ id: request.id, done: true, cancelled: controller.signal.aborted })}\n`)
    } catch (error) {
      if (socket.writable) socket.write(`${JSON.stringify({ id: request.id, error: error.message, done: true })}\n`)
    } finally { this.active.delete(key) }
  }

  close() {
    if (this.closing) return this.closing
    this.closing = this.#close()
    return this.closing
  }

  async #close() {
    for (const request of this.active.values()) request.controller.abort()
    const server = this.server
    this.server = null
    if (server) {
      const closed = new Promise((resolve) => server.close(resolve))
      if (this.ownsSocket) fs.rmSync(this.socketPath, { force: true })
      this.ownsSocket = false
      for (const socket of this.sockets) socket.destroy()
      await closed
    } else if (this.ownsSocket) fs.rmSync(this.socketPath, { force: true })
    this.ownsSocket = false
    await this.engine?.dispose()
    this.engine = null
  }
}

export class QueryDaemonClient {
  constructor(root, options = {}) {
    this.root = path.resolve(root)
    this.socketPath = daemonSocketPath(this.root)
    this.startDaemon = options.startDaemon ?? null
    this.socket = null
    this.lines = null
    this.pending = new Map()
    this.nextId = 1
    this.connecting = null
    this.closed = false
  }

  async connect() {
    if (this.closed) throw new Error('CodeGraph daemon client is closed')
    if (this.socket && !this.socket.destroyed) return this
    if (!this.connecting) this.connecting = connectSocket(this.socketPath).then((socket) => { this._attach(socket); return this }).finally(() => { this.connecting = null })
    return this.connecting
  }

  _attach(socket) {
    if (this.closed) { socket.destroy(); throw new Error('CodeGraph daemon client is closed') }
    this.socket = socket
    socket.setEncoding('utf8')
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    this.lines = lines
    lines.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const pending = this.pending.get(message.id)
      if (!pending) return
      if ('row' in message) pending.push(message.row)
      if ('rows' in message) pending.setRows(message.rows)
      if (message.done) {
        this.pending.delete(message.id)
        message.error ? pending.fail(new Error(message.error)) : pending.finish(message.rows)
      }
    })
    socket.once('close', () => {
      if (this.socket === socket) this.socket = null
      for (const [id, pending] of this.pending) if (pending.socket === socket) {
        pending.fail(new Error('CodeGraph daemon connection closed'))
        this.pending.delete(id)
      }
    })
  }

  async *query(query, options = {}) {
    const rows = await this.queryBatch(query, options)
    for (const row of rows) { if (options.signal?.aborted) return; yield row }
  }

  async queryBatch(query, options = {}) {
    if (options.signal?.aborted) return []
    let attempt = 0
    while (attempt < 2) {
      try {
        if (!this.socket || this.socket.destroyed) {
          const socket = await connectAfterStart(this.root, this.startDaemon)
          this._attach(socket)
        }
        return await this.#queryBatchOnce(query, options)
      } catch (error) {
        if (options.signal?.aborted) return []
        if (this.closed) throw error
        if (attempt++ > 0 || !this.startDaemon || !/connection|EPIPE|ECONN/.test(error.message)) throw error
        this.socket?.destroy()
        this.socket = null
        const socket = await connectAfterStart(this.root, this.startDaemon)
        this._attach(socket)
      }
    }
    return []
  }

  #queryBatchOnce(query, options) {
    const id = this.nextId++
    const socket = this.socket
    return new Promise((resolve, reject) => {
      let rows = []
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
      }
      const pending = {
        socket,
        push(value) { rows.push(value) },
        setRows(value) { rows = value },
        finish(value) { cleanup(); resolve(value ?? rows) },
        fail(error) { cleanup(); reject(error) },
      }
      const abort = () => {
        if (socket?.writable) socket.write(`${JSON.stringify({ op: 'cancel', id })}\n`)
      }
      this.pending.set(id, pending)
      options.signal?.addEventListener('abort', abort, { once: true })
      socket.write(`${JSON.stringify({ op: 'queryBatch', id, query, maxQueue: options.maxQueue })}\n`)
    })
  }

  async close() {
    this.closed = true
    this.lines?.close()
    this.socket?.destroy()
    this.socket = null
  }
}

export async function connectQueryDaemon(root, options = {}) {
  const startDaemon = options.startDaemon ?? (() => defaultStartDaemon(path.resolve(root)))
  const client = new QueryDaemonClient(root, { ...options, startDaemon })
  try { await client.connect(); return client }
  catch {
    const socket = await connectAfterStart(client.root, client.startDaemon)
    client._attach(socket)
    return client
  }
}
