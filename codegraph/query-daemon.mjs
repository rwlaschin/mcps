import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const startupBySocket = new Map()
const defaultEndpoint = () => ({ host: '127.0.0.1', port: 37193 })
const defaultTokenPath = () => path.join(os.tmpdir(), `codegraph-service-${process.getuid?.() ?? os.userInfo().username}`, 'token')
export function daemonSocketPath() { return defaultEndpoint() }
function tokenAt(tokenPath) {
  const directory = fs.lstatSync(path.dirname(tokenPath)), file = fs.lstatSync(tokenPath)
  if (directory.isSymbolicLink() || !directory.isDirectory() || file.isSymbolicLink() || !file.isFile() || process.platform !== 'win32' && ((directory.mode & 0o077) || (file.mode & 0o077) || process.getuid && (file.uid !== process.getuid() || directory.uid !== process.getuid()))) throw new Error('insecure CodeGraph service token path')
  return fs.readFileSync(tokenPath, 'utf8').trim()
}
function connectSocket(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    socket.once('error', reject)
    socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
  })
}
async function defaultStartDaemon(root) {
  const diagnosticPath = path.join(os.tmpdir(), `codegraph-startup-${crypto.randomUUID()}.stderr`)
  const descriptor = fs.openSync(diagnosticPath, 'wx', 0o600)
  let child
  try {
    child = spawn(process.execPath, [path.join(import.meta.dirname, 'tool.mjs'), 'daemon', '--root', root], { detached: true, stdio: ['ignore', 'ignore', descriptor] })
  } catch (error) { fs.closeSync(descriptor); fs.unlinkSync(diagnosticPath); throw error }
  fs.closeSync(descriptor)
  const receipt = { child, diagnosticPath, error: null, exitCode: null, signal: null }
  receipt.onExit = (code, signal) => { receipt.exitCode = code; receipt.signal = signal }
  child.on('exit', receipt.onExit)
  child.unref()
  let onSpawn
  await new Promise(resolve => {
    onSpawn = resolve
    receipt.onError = error => { receipt.error = error; resolve() }
    child.on('error', receipt.onError)
    child.once('spawn', onSpawn)
  })
  child.off('spawn', onSpawn)
  return receipt
}
function readinessError(root, cause, receipts = []) {
  let detail = cause.message, originalCause = cause
  for (const receipt of receipts) {
    if (receipt.error) { detail += `; ${receipt.error.message}`; originalCause = receipt.error }
    if (receipt.exitCode !== null) detail += `; launcher exited with code ${receipt.exitCode}`
    if (receipt.signal) detail += `; launcher terminated by ${receipt.signal}`
    if (receipt.stderrTail === undefined && fs.existsSync(receipt.diagnosticPath)) {
      const descriptor = fs.openSync(receipt.diagnosticPath, 'r')
      try {
        const size = fs.fstatSync(descriptor).size
        const tail = Buffer.alloc(Math.min(size, 8192))
        fs.readSync(descriptor, tail, 0, tail.length, Math.max(0, size - tail.length))
        receipt.stderrTail = tail.toString('utf8')
      } finally { fs.closeSync(descriptor) }
    }
    if (receipt.stderrTail) detail += `; ${receipt.stderrTail}`
  }
  return new Error(`CodeGraph daemon failed to become ready for ${root}: ${detail}`, { cause: receipts.length ? new Error(detail, { cause: originalCause }) : cause })
}
async function connectAfterStart(root, startDaemon, endpoint, deadline, startup) {
  const receipts = startup.receipts
  try { return { socket: await connectSocket(endpoint), reused: true } } catch (firstError) {
    if (!startDaemon) throw firstError
    const key = `${endpoint.host}:${endpoint.port}`
    if (!startupBySocket.has(key)) startupBySocket.set(key, Promise.resolve().then(startDaemon).catch(error => { throw readinessError(root, error) }))
    startup.promise = startupBySocket.get(key)
    const receipt = await startup.promise
    if (receipt && !receipts.includes(receipt)) receipts.push(receipt)
    while (Date.now() < deadline) {
      try { return { socket: await connectSocket(endpoint), reused: false } } catch {}
      if (receipts.some(launch => launch.error || launch.signal || launch.exitCode !== null)) {
        try { return await connectSocket(endpoint) } catch { throw firstError }
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw receipts.length ? firstError : readinessError(root, firstError)
  }
}
export class QueryDaemon {
  constructor(root, options = {}) {
    this.root = path.resolve(root); this.options = options
    this.endpoint = options.endpoint ?? defaultEndpoint(); this.socketPath = this.endpoint
    this.tokenPath = options.tokenPath ?? defaultTokenPath()
    this.ready = new Promise(resolve => { this.markReady = resolve })
    this.server = null; this.engine = null; this.sockets = new Set(); this.active = new Set(); this.closing = null; this.token = null
  }
  async start() {
    if (this.server) return
    const server = net.createServer(socket => this.#accept(socket)); this.server = server
    try {
      server.listen(this.endpoint); await once(server, 'listening')
      const address = server.address(); this.endpoint = { host: '127.0.0.1', port: address.port }; this.socketPath = this.endpoint
      const directory = path.dirname(this.tokenPath)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const stat = fs.lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory() || process.platform !== 'win32' && (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) throw new Error('insecure CodeGraph service token path')
      if (fs.lstatSync(this.tokenPath, { throwIfNoEntry: false })) tokenAt(this.tokenPath)
      this.token = crypto.randomBytes(32).toString('hex')
      this.#writeToken()
      if (this.options.engineFactory) this.engine = await this.options.engineFactory()
      else if (this.options.serviceFactory) this.engine = await this.options.serviceFactory(this.root)
      else {
        const { ensureNativeMmap } = await import('./native/build-optional.mjs'); await ensureNativeMmap()
        const { createService } = await import('./mcp-server.mjs'); this.engine = createService()
      }
      this.markReady()
    } catch (error) { this.markReady(); await this.close(); throw error }
  }
  #writeToken() {
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
  }
  #accept(socket) {
    if (this.stopping) { socket.destroy(); return }
    // $TMPDIR can be purged under a long-lived daemon; without the token file every client fails auth.
    if (this.token && !fs.existsSync(this.tokenPath)) try { this.#writeToken() } catch {}
    this.sockets.add(socket); socket.setEncoding('utf8')
    const state = { authenticated: false, root: this.root, requests: new Map(), mcpRequests: new Map(), subscriptions: new Map(), roots: new Set() }
    socket.once('error', () => {})
    socket.once('close', () => {
      this.sockets.delete(socket)
      for (const request of state.requests.values()) request.controller.abort()
      for (const unsubscribe of state.subscriptions.values()) unsubscribe()
      for (const root of state.roots) void this.engine?.release?.(root, socket)
    })
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('error', error => socket.destroy(error))
    lines.on('line', async line => {
      await this.ready
      if (!this.engine) { socket.destroy(); return }
      if (!line.trim()) return
      let request
      try { request = JSON.parse(line) } catch { this.#write(socket, { error: 'invalid JSON', done: true }); return }
      if (!request || typeof request !== 'object' || Array.isArray(request)) { this.#write(socket, { error: 'invalid request', done: true }); return }
      if (this.draining && !state.authenticated) { await this.#write(socket, { id: request.id, error: 'CodeGraph service reloading', done: true }); socket.end(); return }
      if (!state.authenticated) {
        if (request.op !== 'auth' || typeof request.token !== 'string' || request.token !== this.token) { this.#write(socket, { id: request.id, error: 'authentication failed', done: true }); return }
        state.authenticated = true; state.root = request.root ?? this.root
        this.#write(socket, { id: request.id, result: {}, done: true }); return
      }
      if (request.op === 'mcp' && request.request?.method === 'notifications/cancelled') {
        state.mcpRequests.get(request.request.params?.requestId)?.controller.abort()
        await this.#write(socket, { id: request.id, done: true }); return
      }
      if (request.op === 'mcp' && request.request?.id !== undefined && state.mcpRequests.has(request.request.id)) {
        await this.#write(socket, { id: request.id, result: { jsonrpc: '2.0', id: request.request.id, error: { code: -32600, message: 'duplicate outstanding request id' } }, done: true }); return
      }
      if (request.op === 'cancel') { state.requests.get(request.id)?.controller.abort(); return }
      if (request.op === 'unsubscribe') { state.subscriptions.get(request.subscriptionId)?.(); state.subscriptions.delete(request.subscriptionId); this.#write(socket, { id: request.id, result: {}, done: true }); return }
      if (this.stopping) { socket.destroy(); return }
      if (this.draining) { await this.#write(socket, { id: request.id, error: 'CodeGraph service reloading', done: true }); return }
      if (state.requests.has(request.id)) { this.#write(socket, { id: request.id, error: 'duplicate outstanding request id', done: true }); return }
      const controller = new AbortController()
      const pending = { controller, promise: null }; state.requests.set(request.id, pending)
      if (request.op === 'mcp' && request.request?.id !== undefined) state.mcpRequests.set(request.request.id, pending)
      pending.promise = this.#run(socket, state, request, controller).finally(() => { state.requests.delete(request.id); if (request.op === 'mcp') state.mcpRequests.delete(request.request?.id); this.active.delete(pending) })
      this.active.add(pending)
    })
  }
  async #write(socket, record) {
    if (this.stopping || !socket.writable || socket.destroyed) return
    if (!socket.write(`${JSON.stringify(record)}\n`)) await new Promise(resolve => {
      const done = () => { socket.off('drain', done); socket.off('close', done); socket.off('error', done); resolve() }
      socket.once('drain', done); socket.once('close', done); socket.once('error', done)
    })
  }
  async #run(socket, state, request, controller) {
    try {
      if (['query', 'queryBatch'].includes(request.op) && (!request.query || typeof request.query !== 'object' || Array.isArray(request.query))) throw new Error('invalid request')
      let root = request.root ?? state.root
      if (request.op === 'mcp' && request.request?.method === 'tools/call') {
        root = request.request?.params?.arguments?.root ?? (Object.hasOwn(request, 'defaultRoot') ? request.defaultRoot : root)
        // Tool handlers own argument errors and their existing MCP result envelope.
        if (typeof root === 'string' && root.trim()) {
          try {
            const canonical = fs.realpathSync(path.resolve(root.trim()))
            if (fs.statSync(canonical).isDirectory()) { root = canonical; state.roots.add(root) }
          } catch {}
        }
      } else if (['query', 'queryBatch', 'build', 'incremental', 'reconcile', 'subscribe'].includes(request.op) || request.op === 'refresh' && request.root !== undefined) {
        if (typeof root !== 'string') throw new Error('invalid root')
        root = fs.realpathSync(path.resolve(root)); if (!fs.statSync(root).isDirectory()) throw new Error('invalid root')
        state.roots.add(root)
      }
      const context = { root, owner: socket, signal: controller.signal, maxQueue: request.maxQueue }
      let result
      if (request.op === 'mcp') result = await this.engine.handle(request.request, context)
      else if (request.op === 'queryBatch') {
        if (!this.options.engineFactory) result = await this.engine.queryBatch(root, request.query, context)
        else if (this.engine.queryBatch) result = await this.engine.queryBatch(request.query, context)
        else { result = []; for await (const row of this.engine.query(request.query, context)) result.push(row) }
      }
      else if (request.op === 'query') {
        const rows = this.options.engineFactory ? this.engine.query(request.query, context) : this.engine.query(root, request.query, context)
        for await (const row of rows) { if (controller.signal.aborted || socket.destroyed) break; await this.#write(socket, { id: request.id, row }) }
      }
      else if (request.op === 'refresh') {
        await Promise.allSettled([...state.requests.values()].filter(pending => pending.controller !== controller).map(pending => pending.promise))
        for (const target of request.root === undefined ? state.roots : [root]) await this.engine.mutate(target, 'refresh', request, { ...context, root: target })
        result = {}
      }
      else if (['build', 'incremental', 'reconcile'].includes(request.op)) {
        const { id, op, root: requestedRoot, ...args } = request
        result = await this.engine.mutate(root, op, args, context)
      }
      else if (request.op === 'subscribe') {
        const unsubscribe = await this.engine.subscribe(root, event => void this.#write(socket, { subscriptionId: request.id, event }), context)
        state.subscriptions.set(request.id, unsubscribe); result = {}
      }
      else if (request.op === 'status') result = this.engine.status()
      else if (request.op === 'shutdown' || request.op === 'reload') {
        if (request.op === 'reload') { this.draining = true }
        if (request.op === 'reload') for (const peer of this.sockets) await this.#write(peer, { control: 'reload' })
        await this.#write(socket, { id: request.id, result: {}, done: true })
        setImmediate(() => void this.close({ drain: request.op === 'reload' })); return
      }
      else throw new Error('invalid request')
      await this.#write(socket, { id: request.id, ...(request.op === 'queryBatch' ? { rows: result } : result === undefined ? {} : { result }), done: true, cancelled: controller.signal.aborted })
    } catch (error) { await this.#write(socket, { id: request.id, error: error.message, done: true }) }
  }
  close(options = {}) { return this.closing ??= this.#close(options) }
  async #close(options) {
    this.stopping = !options.drain
    const server = this.server; this.server = null
    if (options.drain) await Promise.allSettled([...this.active].map(request => request.promise))
    this.stopping = true
    // Cancel runtime work before draining transport promises.
    for (const request of this.active) request.controller.abort()
    let failure
    try { await (this.engine?.close?.() ?? this.engine?.dispose?.()) } catch (error) { failure = error }
    const stopped = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve()
    await Promise.allSettled([...this.active].map(request => request.promise))
    for (const socket of this.sockets) socket.destroy()
    await stopped
    if (this.token && fs.existsSync(this.tokenPath) && fs.readFileSync(this.tokenPath, 'utf8') === this.token) fs.rmSync(this.tokenPath)
    this.engine = null
    this.onClose?.(failure)
    if (failure) throw failure
  }
}
export class QueryDaemonClient {
  constructor(root, options = {}) {
    this.root = path.resolve(root)
    this.endpoint = options.endpoint ?? defaultEndpoint()
    this.socketPath = this.endpoint
    this.tokenPath = options.tokenPath ?? defaultTokenPath()
    this.subscriptions = new Map()
    this.onControl = options.onControl
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
    if (this.connecting) return this.connecting
    if (this.socket && !this.socket.destroyed) return this
    if (!this.connecting) this.connecting = (async () => {
      const deadline = Date.now() + 15000
      const startup = { receipts: [], promise: null }
      const receipts = startup.receipts
      try {
        while (true) {
          try {
            const connection = await connectAfterStart(this.root, this.startDaemon, this.endpoint, deadline, startup)
            if (connection.reused) process.stderr.write(`CodeGraph: reusing existing daemon at ${this.endpoint.host}:${this.endpoint.port} for root ${this.root}\n`)
            this._attach(connection.socket)
            let timer
            try {
              await Promise.race([
                this.request('auth', { token: tokenAt(this.tokenPath), root: this.root }, { connected: true }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(readinessError(this.root, new Error('authentication timed out'))), Math.max(1, deadline - Date.now())) }),
              ])
            } finally { clearTimeout(timer) }
            return this
          } catch (error) {
            this.socket?.destroy(); this.socket = null
            if (!this.startDaemon || Date.now() >= deadline || !/ENOENT|authentication failed|connection closed|service reloading/.test(error.message)) throw error
            await new Promise(resolve => setTimeout(resolve, 20))
          }
        }
      } catch (error) { throw receipts.length ? readinessError(this.root, error, receipts) : error }
      finally {
        const key = `${this.endpoint.host}:${this.endpoint.port}`
        if (startupBySocket.get(key) === startup.promise) startupBySocket.delete(key)
        for (const receipt of receipts) {
          receipt.child.off('error', receipt.onError)
          receipt.child.off('exit', receipt.onExit)
          if (fs.existsSync(receipt.diagnosticPath)) fs.unlinkSync(receipt.diagnosticPath)
        }
      }
    })().finally(() => { this.connecting = null })
    return this.connecting
  }

  _attach(socket) {
    if (this.closed) { socket.destroy(); throw new Error('CodeGraph daemon client is closed') }
    this.socket = socket
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('error', error => socket.destroy(error))
    this.lines = lines
    lines.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.control) { this.onControl?.(message.control); return }
      if (message.event) { this.subscriptions.get(message.subscriptionId)?.(message.event); return }
      const pending = this.pending.get(message.id)
      if (!pending) return
      if ('row' in message) pending.push(message.row)
      if ('rows' in message) pending.setRows(message.rows)
      if (message.done) {
        this.pending.delete(message.id)
        message.error ? pending.fail(new Error(message.error)) : pending.finish(message.result ?? message.rows)
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

  // Streams over the daemon's op:'query' path rather than awaiting queryBatch. Batching deadlocks
  // any consumer that cancels in response to a row: the daemon drains the whole generator before
  // writing, so an engine awaiting an abort waits on a client that is waiting on the batch.
  async *query(query, options = {}) {
    let attempt = 0
    let delivered = 0
    while (attempt < 2) {
      if (options.signal?.aborted) return
      // Same connect-or-start path as queryBatch: a bare connect() skips daemon startup and the
      // queries captured while it is coming up.
      await this.connect()
      const id = this.nextId++
      const socket = this.socket
      const queued = []
      let notify = null
      let done = false
      let failure = null
      const wake = () => { const resume = notify; notify = null; resume?.() }
      const abort = () => { if (socket?.writable) socket.write(`${JSON.stringify({ op: 'cancel', id })}\n`) }
      this.pending.set(id, {
        socket,
        push(row) { queued.push(row); wake() },
        setRows(rows) { queued.push(...rows); wake() },
        finish(rows) { if (rows) queued.push(...rows); done = true; wake() },
        fail(error) { failure = error; done = true; wake() },
      })
      options.signal?.addEventListener('abort', abort, { once: true })
      socket.write(`${JSON.stringify({ op: 'query', id, query, maxQueue: options.maxQueue })}\n`)
      if (options.signal?.aborted) abort()
      try {
        while (true) {
          while (queued.length && !options.signal?.aborted) { delivered += 1; yield queued.shift() }
          if (done && !failure) return
          if (failure) break
          // After cancelling, drain to the daemon's done frame rather than returning at once: the
          // frame is what proves the daemon delivered the abort to the engine.
          await new Promise((resolve) => { notify = resolve })
        }
      } finally {
        this.pending.delete(id)
        options.signal?.removeEventListener('abort', abort)
        // A consumer that breaks out of the loop runs this without the daemon ever being told, so
        // the engine would keep producing rows for an id nobody reads. Cancel unless it finished.
        if (!done && socket?.writable) socket.write(`${JSON.stringify({ op: 'cancel', id })}\n`)
      }
      // Retry only a connection loss that delivered nothing — rows already yielded cannot be
      // un-yielded, so a mid-stream failure has to surface.
      if (options.signal?.aborted) return
      if (this.closed || delivered > 0 || attempt++ > 0 || !this.startDaemon || !/connection|EPIPE|ECONN/.test(failure.message)) throw failure
      this.socket?.destroy()
      this.socket = null
    }
  }

  async queryBatch(query, options = {}) {
    if (options.signal?.aborted) return []
    let attempt = 0
    while (attempt < 2) {
      try {
        await this.connect()
        return await this.#queryBatchOnce(query, options)
      } catch (error) {
        if (options.signal?.aborted) return []
        if (this.closed) throw error
        if (attempt++ > 0 || !this.startDaemon || !/connection|EPIPE|ECONN/.test(error.message)) throw error
        this.socket?.destroy()
        this.socket = null
        await this.connect()
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
      if (options.signal?.aborted) abort()
    })
  }

  async request(op, payload = {}, options = {}) {
    if (!options.connected) await this.connect()
    const id = this.nextId++, socket = this.socket
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.pending.delete(id); options.signal?.removeEventListener('abort', abort) }
      const abort = () => { if (socket.writable) socket.write(`${JSON.stringify({ op: 'cancel', id })}\n`) }
      this.pending.set(id, { socket, push() {}, setRows() {}, finish(value) { cleanup(); resolve(value) }, fail(error) { cleanup(); reject(error) } })
      options.signal?.addEventListener('abort', abort, { once: true })
      socket.write(`${JSON.stringify({ ...payload, op, id })}\n`)
      if (options.signal?.aborted) abort()
    })
  }
  mcp(request, options = {}) { return this.request('mcp', { request, defaultRoot: options.root }, options) }
  async subscribe(listener, options = {}) {
    await this.connect()
    const id = this.nextId
    this.subscriptions.set(id, listener)
    try { await this.request('subscribe', { root: options.root }, options) }
    catch (error) { this.subscriptions.delete(id); throw error }
    return async () => { this.subscriptions.delete(id); if (this.socket?.writable) await this.request('unsubscribe', { subscriptionId: id }) }
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
  await client.connect(); return client
}
