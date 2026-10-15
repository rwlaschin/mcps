import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import readline from 'node:readline'
import { once } from 'node:events'
import { QueryDaemon, QueryDaemonClient, connectQueryDaemon, daemonSocketPath } from '../query-daemon.mjs'

const openDaemons = new Set()
const openClients = new Set()
const temporaryRoots = new Set()

// Ephemeral endpoint allocation is transport setup, not query fixture data.
async function reserveTransport(root) {
  const listener = net.createServer()
  listener.listen({ host: '127.0.0.1', port: 0 })
  await once(listener, 'listening')
  const endpoint = { host: '127.0.0.1', port: listener.address().port }
  await new Promise((resolve) => listener.close(resolve))
  return { endpoint, tokenPath: path.join(root, 'credentials', 'token') }
}

async function endpointAccepts(endpoint) {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function authenticate(socket, root, tokenPath) {
  const reader = readline.createInterface({ input: socket })
  const reply = once(reader, 'line')
  socket.write(`${JSON.stringify({ op: 'auth', id: 'fixture-auth', token: fs.readFileSync(tokenPath, 'utf8'), root })}\n`)
  const [data] = await reply
  reader.close()
  socket.resume()
  assert.deepEqual(JSON.parse(data), { id: 'fixture-auth', result: {}, done: true })
}

test.afterEach(async () => {
  await Promise.allSettled([...openClients].map((client) => client.close()))
  await Promise.allSettled([...openDaemons].map((daemon) => daemon.close()))
  openClients.clear()
  openDaemons.clear()
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
  temporaryRoots.clear()
})

test('equivalence partition: the same project root receives the fixed machine endpoint', () => {
  assert.deepEqual(daemonSocketPath('/tmp/codegraph-project-one'), { host: '127.0.0.1', port: 37193 })
})

test('domain analysis: different project roots share one fixed machine endpoint', () => {
  assert.deepEqual(daemonSocketPath('/tmp/codegraph-project-two'), { host: '127.0.0.1', port: 37193 })
})

test('boundary value: Unicode root length cannot change the machine endpoint', () => {
  assert.deepEqual(daemonSocketPath('/tmp/é/مشروع/🚀'), { host: '127.0.0.1', port: 37193 })
})

test('domain analysis: two concurrent requests retain their own IDs when their rows complete out of order', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-correlate-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let releaseSlow = () => {}
  let slowStarted = () => {}
  const slowReady = new Promise((resolve) => { slowStarted = resolve })
  const slowRelease = new Promise((resolve) => { releaseSlow = resolve })
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * (query) { if (query.name === 'slow') { slowStarted(); await slowRelease } yield { name: query.name } }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()

  const slowRows = (async () => { const rows = []; for await (const row of client.query({ type: 'symbols', name: 'slow' })) rows.push(row); return rows })()
  await slowReady
  const fastRows = []
  for await (const row of client.query({ type: 'symbols', name: 'fast' })) fastRows.push(row)
  releaseSlow()

  assert.deepEqual({ fastRows, slowRows: await slowRows }, { fastRows: [{ name: 'fast' }], slowRows: [{ name: 'slow' }] })
})

test('equivalence partition: sequential queries reuse one warm engine instance for a project root', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-warm-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let engineCreations = 0
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => { engineCreations += 1; return { query: async function * (query) { yield { name: query.name } }, dispose: async () => {} } } })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()

  const first = []
  for await (const row of client.query({ type: 'symbols', name: 'first' })) first.push(row)
  const second = []
  for await (const row of client.query({ type: 'symbols', name: 'second' })) second.push(row)

  assert.deepEqual({ engineCreations, first, second }, { engineCreations: 1, first: [{ name: 'first' }], second: [{ name: 'second' }] })
})

test('error guessing: cancelling one request aborts that engine signal without cancelling a concurrent request', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-cancel-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let cancelledSignal
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * (query, options) { if (query.name === 'cancelled') { cancelledSignal = options.signal; yield { sequence: 1 }; await once(options.signal, 'abort'); return } yield { sequence: 2 } }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()
  const controller = new AbortController()

  const cancelledRows = []
  const cancelled = (async () => { for await (const row of client.query({ type: 'symbols', name: 'cancelled' }, { signal: controller.signal })) { cancelledRows.push(row); controller.abort() } })()
  const survivingRows = []
  for await (const row of client.query({ type: 'symbols', name: 'surviving' })) survivingRows.push(row)
  await cancelled

  assert.deepEqual({ cancelledRows, cancelled: cancelledSignal.aborted, survivingRows }, { cancelledRows: [{ sequence: 1 }], cancelled: true, survivingRows: [{ sequence: 2 }] })
})

test('boundary value: an already-aborted request never enters the engine query', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-preabort-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let queryCalls = 0
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { queryCalls += 1; yield { unexpected: true } }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()
  const controller = new AbortController()
  controller.abort()

  const rows = []
  for await (const row of client.query({ type: 'graph' }, { signal: controller.signal })) rows.push(row)

  assert.deepEqual({ queryCalls, rows }, { queryCalls: 0, rows: [] })
})

test('error guessing: failed initialization closes its bound endpoint and removes its credentials', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-failed-init-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  const daemon = new QueryDaemon(root, { ...transport, serviceFactory: async () => { throw new Error('initialization failed') } })
  openDaemons.add(daemon)

  await assert.rejects(daemon.start(), /initialization failed/)
  const listening = await endpointAccepts(transport.endpoint)

  assert.deepEqual({ listening, credentialsExist: fs.existsSync(transport.tokenPath) }, { listening: false, credentialsExist: false })
})

test('domain analysis: a foreign live endpoint is not replaced or given service credentials', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-live-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  const existing = net.createServer((socket) => socket.destroy())
  existing.listen(transport.endpoint)
  await once(existing, 'listening')
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () {}, dispose: async () => {} }) })
  openDaemons.add(daemon)
  try {
    await assert.rejects(daemon.start(), /already|active|listen|address|EADDRINUSE/i)
    assert.deepEqual({ listening: await endpointAccepts(transport.endpoint), credentialsExist: fs.existsSync(transport.tokenPath) }, { listening: true, credentialsExist: false })
  } finally { await new Promise((resolve) => existing.close(resolve)) }
})

test('equivalence partition: connectQueryDaemon uses an existing daemon without invoking automatic startup', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-existing-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let starts = 0
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { yield { source: 'existing' } }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()

  let diagnostic = ''
  const originalWrite = process.stderr.write
  process.stderr.write = (chunk) => { diagnostic += String(chunk); return true }
  let client
  try {
    client = await connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1 } })
  } finally { process.stderr.write = originalWrite }
  openClients.add(client)
  const rows = []
  for await (const row of client.query({ type: 'graph' })) rows.push(row)

  assert.deepEqual({ starts, rows, diagnostic }, { starts: 0, rows: [{ source: 'existing' }], diagnostic: `CodeGraph: reusing existing daemon at ${transport.endpoint.host}:${transport.endpoint.port} for root ${root}\n` })
})

test('equivalence partition: connectQueryDaemon starts one daemon when the project socket is absent', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-autostart-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let starts = 0

  const client = await connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1; const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { yield { source: 'started' } }, dispose: async () => {} }) }); openDaemons.add(daemon); await daemon.start() } })
  openClients.add(client)
  const rows = []
  for await (const row of client.query({ type: 'graph' })) rows.push(row)

  assert.deepEqual({ starts, rows }, { starts: 1, rows: [{ source: 'started' }] })
})

test('boundary value regression: automatic startup waits for socket readiness when daemon initialization exceeds one second', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-slow-start-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let delayedDaemon
  const daemonStarted = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        delayedDaemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { yield { source: 'slow-start' } }, dispose: async () => {} }) })
        openDaemons.add(delayedDaemon)
        await delayedDaemon.start()
        resolve()
      } catch (error) { reject(error) }
    }, 1100)
  })
  let client

  try {
    client = await connectQueryDaemon(root, { ...transport, startDaemon: async () => {} })
    openClients.add(client)
    const rows = []
    for await (const row of client.query({ type: 'graph' })) rows.push(row)

    assert.deepEqual(rows, [{ source: 'slow-start' }])
  } finally {
    await daemonStarted
  }
})

test('error guessing: a launcher that exits without creating its socket reports daemon readiness failure instead of raw ENOENT', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-launch-failure-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)

  await assert.rejects(
    connectQueryDaemon(root, { ...transport, startDaemon: async () => {} }),
    (error) => /CodeGraph daemon failed to become ready/.test(error.message) && error.message.includes(root) && error.cause?.code === 'ECONNREFUSED',
  )
})

test('error guessing: concurrent absent-socket connections coalesce automatic startup for one project root', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-autostart-race-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let starts = 0

  const firstConnection = connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1; await new Promise((resolve) => setImmediate(resolve)); const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { yield { source: 'shared' } }, dispose: async () => {} }) }); openDaemons.add(daemon); await daemon.start() } })
  const secondConnection = connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1; await new Promise((resolve) => setImmediate(resolve)); const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { yield { source: 'duplicate' } }, dispose: async () => {} }) }); openDaemons.add(daemon); await daemon.start() } })
  const [firstClient, secondClient] = await Promise.all([firstConnection, secondConnection])
  openClients.add(firstClient)
  openClients.add(secondClient)

  assert.equal(starts, 1)
})

test('domain analysis: queries captured during startup flush to the live socket exactly once and in submission order', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-capture-feed-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let releaseStartup = () => {}
  const startupGate = new Promise((resolve) => { releaseStartup = resolve })
  let starts = 0
  const observedQueries = []
  const client = new QueryDaemonClient(root, { ...transport, startDaemon: async () => { starts += 1; await startupGate; const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * (query) { observedQueries.push(query.name); yield { name: query.name } }, dispose: async () => {} }) }); openDaemons.add(daemon); await daemon.start() } })
  openClients.add(client)

  const first = (async () => { const rows = []; for await (const row of client.query({ type: 'symbols', name: 'first' })) rows.push(row); return rows })()
  const second = (async () => { const rows = []; for await (const row of client.query({ type: 'symbols', name: 'second' })) rows.push(row); return rows })()
  const third = (async () => { const rows = []; for await (const row of client.query({ type: 'symbols', name: 'third' })) rows.push(row); return rows })()
  await new Promise((resolve) => setImmediate(resolve))
  releaseStartup()
  const [firstRows, secondRows, thirdRows] = await Promise.all([first, second, third])

  assert.deepEqual(
    { starts, observedQueries, first: firstRows, second: secondRows, third: thirdRows },
    { starts: 1, observedQueries: ['first', 'second', 'third'], first: [{ name: 'first' }], second: [{ name: 'second' }], third: [{ name: 'third' }] },
  )
})

test('error guessing: startup failure rejects every captured query and a later feed never replays the emptied capture queue', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-capture-failure-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let releaseFailure = () => {}
  const failureGate = new Promise((resolve) => { releaseFailure = resolve })
  let failStartup = true
  let starts = 0
  const observedQueries = []
  const client = new QueryDaemonClient(root, { ...transport, startDaemon: async () => { starts += 1; if (failStartup) { await failureGate; throw new Error('captured feeder startup failed') } const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * (query) { observedQueries.push(query.name); yield { name: query.name } }, dispose: async () => {} }) }); openDaemons.add(daemon); await daemon.start() } })
  openClients.add(client)

  const first = (async () => { try { for await (const _row of client.query({ type: 'symbols', name: 'first' })) {} } catch (error) { return { message: error.message, cause: error.cause?.message } } })()
  const second = (async () => { try { for await (const _row of client.query({ type: 'symbols', name: 'second' })) {} } catch (error) { return { message: error.message, cause: error.cause?.message } } })()
  const third = (async () => { try { for await (const _row of client.query({ type: 'symbols', name: 'third' })) {} } catch (error) { return { message: error.message, cause: error.cause?.message } } })()
  await new Promise((resolve) => setImmediate(resolve))
  releaseFailure()
  const failedResults = await Promise.all([first, second, third])
  failStartup = false
  const recoveredRows = []
  for await (const row of client.query({ type: 'symbols', name: 'recovered' })) recoveredRows.push(row)

  assert.deepEqual(
    { starts, failedResults, observedQueries, recoveredRows },
    { starts: 2, failedResults: [{ message: `CodeGraph daemon failed to become ready for ${root}: captured feeder startup failed`, cause: 'captured feeder startup failed' }, { message: `CodeGraph daemon failed to become ready for ${root}: captured feeder startup failed`, cause: 'captured feeder startup failed' }, { message: `CodeGraph daemon failed to become ready for ${root}: captured feeder startup failed`, cause: 'captured feeder startup failed' }], observedQueries: ['recovered'], recoveredRows: [{ name: 'recovered' }] },
  )
})

test('error guessing: one daemon restart reconnects the existing client and retries an interrupted query exactly once', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-restart-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let starts = 0
  const firstDaemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * (_query, options) { setImmediate(() => { void firstDaemon.close() }); await once(options.signal, 'abort') }, dispose: async () => {} }) })
  openDaemons.add(firstDaemon)
  await firstDaemon.start()

  const client = await connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1; const replacement = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * () { yield { source: 'replacement' } }, dispose: async () => {} }) }); openDaemons.add(replacement); await replacement.start() } })
  openClients.add(client)
  const rows = []
  for await (const row of client.query({ type: 'graph' })) rows.push(row)

  assert.deepEqual({ starts, rows }, { starts: 1, rows: [{ source: 'replacement' }] })
})

test('boundary value: a second connection failure is surfaced after the single permitted reconnect attempt', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-one-retry-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let starts = 0

  const client = await connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1 } }).catch((error) => error)

  assert.deepEqual({ starts, isError: client instanceof Error }, { starts: 1, isError: true })
})

test('error guessing: clean close aborts active queries, awaits disposal, and releases its endpoint credentials', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-close-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let releaseDispose = () => {}
  let closeSettled = false
  let querySignal
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ query: async function * (_query, options) { querySignal = options.signal; yield { sequence: 1 }; await once(options.signal, 'abort') }, dispose: async () => { await new Promise((resolve) => { releaseDispose = resolve }) } }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()
  const querying = (async () => { for await (const _row of client.query({ type: 'graph' })) {} })().catch(() => {})
  while (!querySignal) await new Promise((resolve) => setImmediate(resolve))

  const closing = daemon.close().then(() => { closeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  const beforeDispose = { aborted: querySignal.aborted, closeSettled, bindHeld: await endpointAccepts(transport.endpoint) }
  const rejectedClient = new QueryDaemonClient(root, transport)
  openClients.add(rejectedClient)
  await assert.rejects(rejectedClient.connect(), /closed|closing|stopping|ECONNRESET/i)
  releaseDispose()
  await closing
  await querying

  assert.deepEqual({ beforeDispose, afterDispose: { closeSettled, credentialsExist: fs.existsSync(transport.tokenPath), listening: await endpointAccepts(transport.endpoint) } }, { beforeDispose: { aborted: true, closeSettled: false, bindHeld: true }, afterDispose: { closeSettled: true, credentialsExist: false, listening: false } })
})

test('hotpath boundary: a batch request of at most 200 rows receives one response frame with its exact request ID', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-batch-frame-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async () => [{ name: 'a' }, { name: 'b' }], dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const socket = net.createConnection(transport.endpoint)
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  socket.setEncoding('utf8')
  await authenticate(socket, root, transport.tokenPath)
  const frames = []
  let buffered = ''
  const received = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) if (line) { frames.push(JSON.parse(line)); if (frames.at(-1).done) resolve() }
    })
  })

  socket.write(`${JSON.stringify({ op: 'queryBatch', id: 73, query: { type: 'symbols', limit: 200 } })}\n`)
  await received
  socket.destroy()

  assert.deepEqual(frames, [{ id: 73, rows: [{ name: 'a' }, { name: 'b' }], done: true, cancelled: false }])
})

test('hotpath integration: a resolved relationship batch crosses daemon transport in one frame without a graph request', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-resolved-frame-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  const observedQueries = []
  const resolvedRow = {
    from: 'caller-id', to: 'target-id', line: 7, call: true,
    fromSymbol: { id: 'caller-id', name: 'caller', file: 'src/caller.ts', line: 6, kind: 'function' },
    toSymbol: { id: 'target-id', name: 'target', file: 'src/target.ts', line: 2, kind: 'function' },
  }
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async (query) => { observedQueries.push(query); return [resolvedRow] }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const socket = net.createConnection(transport.endpoint)
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  socket.setEncoding('utf8')
  await authenticate(socket, root, transport.tokenPath)
  const frames = []
  let buffered = ''
  const received = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) if (line) { frames.push(JSON.parse(line)); if (frames.at(-1).done) resolve() }
    })
  })

  socket.write(`${JSON.stringify({ op: 'queryBatch', id: 91, query: { type: 'refs', name: 'target', resolved: true, limit: 200 } })}\n`)
  await received
  socket.destroy()

  assert.deepEqual({ observedQueries, frames }, {
    observedQueries: [{ type: 'refs', name: 'target', resolved: true, limit: 200 }],
    frames: [{ id: 91, rows: [resolvedRow], done: true, cancelled: false }],
  })
})

test('equivalence partition: QueryDaemonClient queryBatch returns the same ordered rows as its compatible async query stream', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-batch-compatible-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async () => [{ sequence: 1 }, { sequence: 2 }], query: async function * () { yield { sequence: 1 }; yield { sequence: 2 } }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()

  const batchRows = await client.queryBatch({ type: 'symbols', limit: 200 })
  const streamedRows = []
  for await (const row of client.query({ type: 'symbols', limit: 200 })) streamedRows.push(row)

  assert.deepEqual({ batchRows, streamedRows }, { batchRows: [{ sequence: 1 }, { sequence: 2 }], streamedRows: [{ sequence: 1 }, { sequence: 2 }] })
})

test('combinatorial concurrency: two queryBatch requests retain their own IDs when batches finish out of order', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-batch-correlate-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let releaseSlow = () => {}
  let slowStarted = () => {}
  const slowReady = new Promise((resolve) => { slowStarted = resolve })
  const slowRelease = new Promise((resolve) => { releaseSlow = resolve })
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async (query) => { if (query.name === 'slow') { slowStarted(); await slowRelease } return [{ name: query.name }] }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()

  const slowRows = client.queryBatch({ type: 'symbols', name: 'slow', limit: 200 })
  await slowReady
  const fastRows = await client.queryBatch({ type: 'symbols', name: 'fast', limit: 200 })
  releaseSlow()

  assert.deepEqual({ fastRows, slowRows: await slowRows }, { fastRows: [{ name: 'fast' }], slowRows: [{ name: 'slow' }] })
})

test('error guessing: an already-aborted daemon queryBatch preserves cancellation and never enters the engine', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-batch-cancel-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let queryBatchCalls = 0
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async () => { queryBatchCalls += 1; return [{ unexpected: true }] }, dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()
  const controller = new AbortController()
  controller.abort()

  const rows = await client.queryBatch({ type: 'symbols', limit: 200 }, { signal: controller.signal })

  assert.deepEqual({ queryBatchCalls, rows }, { queryBatchCalls: 0, rows: [] })
})

test('error guessing: queryBatch reconnects once after daemon loss and returns only the replacement response', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-batch-reconnect-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  let starts = 0
  const firstDaemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async (_query, options) => { setImmediate(() => { void firstDaemon.close() }); await once(options.signal, 'abort'); return [] }, dispose: async () => {} }) })
  openDaemons.add(firstDaemon)
  await firstDaemon.start()
  const client = await connectQueryDaemon(root, { ...transport, startDaemon: async () => { starts += 1; const replacement = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async () => [{ source: 'replacement' }], dispose: async () => {} }) }); openDaemons.add(replacement); await replacement.start() } })
  openClients.add(client)

  const rows = await client.queryBatch({ type: 'graph' })

  assert.deepEqual({ starts, rows }, { starts: 1, rows: [{ source: 'replacement' }] })
})

test('equivalence partition and error guessing: every valid-JSON invalid request returns an error while preserving the connection for a subsequent valid query', { timeout: 3000 }, async (t) => {
  const cases = [
    { name: 'null request', wire: 'null' },
    { name: 'numeric primitive request', wire: '7' },
    { name: 'boolean primitive request', wire: 'true' },
    { name: 'string primitive request', wire: '"query"' },
    { name: 'array request', wire: '[]' },
    { name: 'object with no operation or query', wire: '{}' },
    { name: 'queryBatch operation with missing query', wire: '{"op":"queryBatch","id":41}' },
    { name: 'unsupported operation', wire: '{"op":"launchMissiles","id":42,"query":{"type":"symbols"}}' },
  ]
  for (const entry of cases) await t.test(entry.name, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-invalid-request-'))
    temporaryRoots.add(root)
    const transport = await reserveTransport(root)
    const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async (query) => [{ accepted: query.name }], dispose: async () => {} }) })
    openDaemons.add(daemon)
    await daemon.start()
    const socket = net.createConnection(transport.endpoint)
    t.after(() => socket.destroy())
    await once(socket, 'connect')
    socket.setEncoding('utf8')
    await authenticate(socket, root, transport.tokenPath)
    const frames = []
    let buffered = ''
    const received = new Promise((resolve) => {
      socket.on('data', (chunk) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop()
        for (const line of lines) {
          if (!line) continue
          frames.push(JSON.parse(line))
          if (frames.length === 1) socket.write(`${JSON.stringify({ op: 'queryBatch', id: 99, query: { type: 'symbols', name: 'alive', limit: 1 } })}\n`)
          if (frames.length === 2) resolve()
        }
      })
    })

    socket.write(`${entry.wire}\n`)
    await received
    socket.destroy()

    assert.deepEqual({ invalid: { done: frames[0].done, hasError: typeof frames[0].error === 'string' && frames[0].error.length > 0 }, subsequent: frames[1] }, {
      invalid: { done: true, hasError: true },
      subsequent: { id: 99, rows: [{ accepted: 'alive' }], done: true, cancelled: false },
    })
  })
})

test('transport contract: daemon streams generation-pinned internal summaries without changing their records', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-internal-summary-'))
  temporaryRoots.add(root)
  const transport = await reserveTransport(root)
  const daemon = new QueryDaemon(root, { ...transport, engineFactory: () => ({ queryBatch: async (query) => [{ type: query.type, generation: query.generation, cyclomatic: 4 }], dispose: async () => {} }) })
  openDaemons.add(daemon)
  await daemon.start()
  const client = new QueryDaemonClient(root, transport)
  openClients.add(client)
  await client.connect()
  const rows = await client.queryBatch({ type: 'internal-summaries', generation: 'generation-a' })
  assert.deepEqual(rows, [{ type: 'internal-summaries', generation: 'generation-a', cyclomatic: 4 }])
})
