import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dirname, '..')

// Construction helper only: meaningful platform, credential inputs, and expected results stay in each row.
function isolatedDriver(t, source, { loaderSource } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-platform-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const driver = path.join(root, 'driver.mjs')
  fs.writeFileSync(driver, source.replaceAll('FIXTURE_ROOT', JSON.stringify(root)).replaceAll('DAEMON_URL', JSON.stringify(pathToFileURL(path.join(repo, 'query-daemon.mjs')).href)))
  const args = []
  if (loaderSource) {
    const loader = path.join(root, 'loader.mjs')
    fs.writeFileSync(loader, loaderSource)
    args.push('--no-warnings', '--experimental-loader', loader)
  }
  return { root, driver, args }
}

for (const { name, platform, mode, shape, expected } of [
  { name: 'POSIX rejects world-readable credentials', platform: 'darwin', mode: 0o777, shape: 'file', expected: 'insecure CodeGraph service token path' },
  { name: 'Windows accepts inherited credentials despite POSIX mode bits', platform: 'win32', mode: 0o777, shape: 'file', expected: 'ready' },
  { name: 'Windows rejects a token symlink despite permissive mode handling', platform: 'win32', mode: 0o700, shape: 'symlink', expected: 'insecure CodeGraph service token path' },
  { name: 'Windows rejects a credential-directory symlink', platform: 'win32', mode: 0o700, shape: 'directory-symlink', expected: 'insecure CodeGraph service token path' },
  { name: 'Windows rejects a token directory despite permissive mode handling', platform: 'win32', mode: 0o700, shape: 'directory', expected: 'insecure CodeGraph service token path' },
  { name: 'POSIX accepts private credentials', platform: 'darwin', mode: 0o700, shape: 'file', expected: 'ready' },
]) test(`all-pairs credential boundary: ${name}`, { timeout: 5000 }, (t) => {
  const { driver, args } = isolatedDriver(t, `
import fs from 'node:fs'; import path from 'node:path'
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })
const { QueryDaemon, daemonSocketPath } = await import(DAEMON_URL)
const root = FIXTURE_ROOT; const directory = path.join(root, 'credentials'); const token = path.join(directory, 'token')
fs.mkdirSync(directory, { mode: ${mode} }); fs.chmodSync(directory, ${mode})
if (${JSON.stringify(shape)} === 'directory') fs.mkdirSync(token)
else if (${JSON.stringify(shape)} === 'symlink') { fs.writeFileSync(path.join(root, 'target'), 'old'); fs.symlinkSync(path.join(root, 'target'), token) }
else fs.writeFileSync(token, 'old', { mode: 0o600 })
if (${JSON.stringify(shape)} === 'directory-symlink') { fs.renameSync(directory, path.join(root, 'real-credentials')); fs.symlinkSync(path.join(root, 'real-credentials'), directory, 'dir') }
const daemon = new QueryDaemon(root, { endpoint: { host: '127.0.0.1', port: 0 }, tokenPath: token, serviceFactory: async () => ({ close: async () => {} }) })
let result; try { await daemon.start(); result = 'ready' } catch (error) { result = error.message } finally { await daemon.close() }
process.stdout.write(JSON.stringify({ result, endpoint: daemonSocketPath() }))
`)
  const result = spawnSync(process.execPath, [...args, driver], { encoding: 'utf8', timeout: 3500 })
  assert.deepEqual({ status: result.status, observation: result.stdout && JSON.parse(result.stdout) }, { status: 0, observation: { result: expected, endpoint: { host: '127.0.0.1', port: 37193 } } }, `subprocess stderr=${result.stderr}; signal=${result.signal}; error=${result.error?.message}`)
})

test('error guessing: an injected launcher failure appears in the readiness message and original cause', { timeout: 5000 }, (t) => {
  const { driver, args } = isolatedDriver(t, `
const { QueryDaemonClient } = await import(DAEMON_URL)
const client = new QueryDaemonClient(FIXTURE_ROOT, { endpoint: { host: '127.0.0.1', port: 1 }, tokenPath: FIXTURE_ROOT + '/missing', startDaemon: async () => { throw new Error('launcher permission denied EACCES') } })
let result; try { await client.connect() } catch (error) { result = { visible: error.message.includes('launcher permission denied EACCES'), cause: error.cause?.message } } finally { await client.close() }
process.stdout.write(JSON.stringify(result))
`)
  const result = spawnSync(process.execPath, [...args, driver], { encoding: 'utf8', timeout: 3500 })
  assert.deepEqual({ status: result.status, observation: result.stdout && JSON.parse(result.stdout) }, { status: 0, observation: { visible: true, cause: 'launcher permission denied EACCES' } }, `subprocess stderr=${result.stderr}; signal=${result.signal}; error=${result.error?.message}`)
})

const subscriptionLoader = `export async function load(url, context, nextLoad) {
  if (url.endsWith('/query-client.mjs')) return { format: 'module', shortCircuit: true, source: 'export async function* streamQuery() {} export async function subscribeChanges() { return async () => {} }' }
  return nextLoad(url, context)
}`

for (const name of ['space directory', 'encoded # percent % directory']) test(`boundary executable path: visualizer starts from ${name}`, { timeout: 5000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-visualizer-path-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, name); fs.mkdirSync(directory)
  const executable = path.join(directory, 'visualizer.mjs')
  fs.copyFileSync(path.join(repo, 'visualizer.mjs'), executable)
  fs.symlinkSync(path.join(repo, 'visualizer-graph.mjs'), path.join(directory, 'visualizer-graph.mjs'))
  fs.writeFileSync(path.join(directory, 'query-client.mjs'), '')
  const loader = path.join(root, 'loader.mjs'); fs.writeFileSync(loader, subscriptionLoader)
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, executable, '--root', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let stderr = ''
  const outcome = await new Promise(resolve => {
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('CodeGraph visualizer: http://127.0.0.1:')) resolve('listening') })
    child.once('exit', () => resolve('exited without listening'))
  })
  assert.equal(outcome, 'listening', `child exit=${child.exitCode} signal=${child.signalCode}; stderr=${stderr}`)
  const address = stderr.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  const response = await fetch(address)
  const html = await response.text()
  assert.deepEqual({ status: response.status, hasVisualizerTitle: html.includes('<title>CodeGraph — Layered Call Flow</title>') }, { status: 200, hasVisualizerTitle: true })
  child.kill('SIGTERM'); await once(child, 'exit')
})

test('equivalence partition: importing the visualizer from an encoded path does not listen', { timeout: 5000 }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-visualizer-import-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'space # percent %'); fs.mkdirSync(directory)
  const executable = path.join(directory, 'visualizer.mjs')
  fs.copyFileSync(path.join(repo, 'visualizer.mjs'), executable)
  fs.symlinkSync(path.join(repo, 'visualizer-graph.mjs'), path.join(directory, 'visualizer-graph.mjs'))
  fs.writeFileSync(path.join(directory, 'query-client.mjs'), '')
  const loader = path.join(root, 'loader.mjs'); fs.writeFileSync(loader, subscriptionLoader)
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(executable).href)}); console.log('imported')`], { encoding: 'utf8', timeout: 3500 })
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: 'imported\n', stderr: '' })
})

// Real launcher API is exercised; the child lifecycle is controlled to avoid detached host jobs.
const launcherLoader = `export async function load(url, context, nextLoad) {
  if (url === 'node:child_process') return { format: 'module', shortCircuit: true, source: \`
    import fs from 'node:fs'; import { EventEmitter } from 'node:events'
    export function spawn(executable, args, options) {
      const trace = globalThis.launchTrace; trace.launchCount = (trace.launchCount ?? 0) + 1; const child = new EventEmitter(); child.unref = () => {}; child.exitCode = null; child.signalCode = null
      trace.child = child; trace.detached = options.detached
      const fd = Array.isArray(options.stdio) ? options.stdio[2] : undefined
      trace.regularStderr = typeof fd === 'number' && fs.fstatSync(fd).isFile()
      trace.parentFd = fd
      trace.parentIdentity = trace.regularStderr ? fs.fstatSync(fd) : null
      if (trace.regularStderr) { trace.childFd = fs.openSync(trace.file, 'a'); fs.writeSync(trace.childFd, trace.text) }
      setImmediate(async () => {
        if (trace.kind === 'spawn-error') { child.emit('error', new Error('spawn EACCES launcher denied')); return }
        child.emit('spawn')
        globalThis.childSpawned?.()
        if (trace.kind === 'concurrent-failure') await globalThis.releaseFailureGate
        await new Promise(resolve => setImmediate(resolve))
        try { const current = fs.fstatSync(fd); trace.parentClosedBeforeChildWork = !current.isFile() || current.ino !== trace.parentIdentity?.ino || current.dev !== trace.parentIdentity?.dev } catch { trace.parentClosedBeforeChildWork = true }
        if (trace.kind === 'success' || trace.kind === 'singleton-loser') { await globalThis.startHealthyDaemon(); if (trace.kind === 'singleton-loser') { child.exitCode = 1; child.emit('exit', 1, null) }; return }
        setImmediate(() => { child.exitCode = trace.kind === 'signal' ? null : 23; child.signalCode = trace.kind === 'signal' ? 'SIGTERM' : null; child.emit('exit', child.exitCode, child.signalCode); child.emit('close', child.exitCode, child.signalCode) })
      })
      return child
    }
  \` }
  return nextLoad(url, context)
}`

for (const { name, kind, detail, text } of [
  { name: 'spawn failure', kind: 'spawn-error', detail: 'EACCES', text: 'launcher stderr sentinel' },
  { name: 'nonzero child exit', kind: 'exit', detail: '23', text: 'launcher stderr sentinel' },
  { name: 'signal termination', kind: 'signal', detail: 'SIGTERM', text: 'launcher stderr sentinel' },
  { name: 'bounded 8192-byte diagnostic tail', kind: 'exit', detail: '23', text: 'DROP_PREFIX_' + 'x'.repeat(8200) + 'KEEP_TAIL' },
]) test(`error guessing launcher boundary: ${name} retains details and cleans its diagnostic file`, { timeout: 5000 }, (t) => {
  const { driver, args } = isolatedDriver(t, `
import fs from 'node:fs'
const originalOpen = fs.openSync, originalClose = fs.closeSync
const trace = globalThis.launchTrace = { kind: ${JSON.stringify(kind)}, text: ${JSON.stringify(text)}, file: null }
fs.openSync = function(file, flags, mode) { const fd = originalOpen(file, flags, mode); if (String(flags).includes('x')) trace.file = String(file); return fd }
const { connectQueryDaemon } = await import(DAEMON_URL)
let error; try { await connectQueryDaemon(FIXTURE_ROOT, { endpoint: { host: '127.0.0.1', port: 1 }, tokenPath: FIXTURE_ROOT + '/token' }) } catch (failure) { error = failure }
const message = error?.message ?? ''; const cause = error?.cause?.message ?? ''
let parentClosed = false; try { fs.fstatSync(trace.parentFd) } catch { parentClosed = true }
const result = { failed: !!error, visibleDetail: message.includes(${JSON.stringify(detail)}), visibleTail: message.includes(${JSON.stringify(kind === 'spawn-error' ? 'EACCES' : text.endsWith('KEEP_TAIL') ? 'KEEP_TAIL' : 'launcher stderr sentinel')}), causeDetail: cause.includes(${JSON.stringify(detail)}), regularStderr: trace.regularStderr, parentClosed, removed: !!trace.file && !fs.existsSync(trace.file), listeners: trace.child.listenerCount('error') + trace.child.listenerCount('exit'), prefixAbsent: !message.includes('DROP_PREFIX_') }
if (trace.childFd !== undefined) originalClose(trace.childFd)
process.stdout.write(JSON.stringify(result))
`, { loaderSource: launcherLoader })
  const result = spawnSync(process.execPath, [...args, driver], { encoding: 'utf8', timeout: 3500 })
  assert.deepEqual({ status: result.status, observation: result.stdout && JSON.parse(result.stdout) }, { status: 0, observation: { failed: true, visibleDetail: true, visibleTail: true, causeDetail: true, regularStderr: true, parentClosed: true, removed: true, listeners: 0, prefixAbsent: true } }, `subprocess stderr=${result.stderr}; signal=${result.signal}; error=${result.error?.message}`)
})

for (const { name, kind, expectedExit } of [
  { name: 'healthy child remains running', kind: 'success', expectedExit: null },
  { name: 'singleton loser exits while authenticated winner serves', kind: 'singleton-loser', expectedExit: 1 },
]) test(`domain analysis: authenticated startup cleans diagnostics when ${name}`, { timeout: 5000 }, (t) => {
  const { driver, args } = isolatedDriver(t, `
import fs from 'node:fs'; import net from 'node:net'; import { once } from 'node:events'; import path from 'node:path'
const trace = globalThis.launchTrace = { kind: ${JSON.stringify(kind)}, text: 'healthy launcher diagnostic', file: null }
const originalOpen = fs.openSync, originalClose = fs.closeSync
fs.openSync = function(file, flags, mode) { const fd = originalOpen(file, flags, mode); if (String(flags).includes('x')) trace.file = String(file); return fd }
const { QueryDaemon, connectQueryDaemon } = await import(DAEMON_URL)
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
const endpoint = { host: '127.0.0.1', port }; const tokenPath = path.join(FIXTURE_ROOT, 'credentials', 'token')
const daemon = new QueryDaemon(FIXTURE_ROOT, { endpoint, tokenPath, serviceFactory: async () => ({ close: async () => {} }) })
globalThis.startHealthyDaemon = () => daemon.start()
const client = await connectQueryDaemon(FIXTURE_ROOT, { endpoint, tokenPath })
let parentClosed = false; try { fs.fstatSync(trace.parentFd) } catch { parentClosed = true }
let childStderrValid = false; if (trace.childFd !== undefined) { fs.writeSync(trace.childFd, 'still writable'); childStderrValid = true; originalClose(trace.childFd) }
const observation = { regularStderr: trace.regularStderr, parentClosed: trace.parentClosedBeforeChildWork, removed: !!trace.file && !fs.existsSync(trace.file), childStderrValid, exitCode: trace.child.exitCode, listeners: trace.child.listenerCount('error') + trace.child.listenerCount('exit') }
await client.close(); await daemon.close(); process.stdout.write(JSON.stringify(observation))
`, { loaderSource: launcherLoader })
  const result = spawnSync(process.execPath, [...args, driver], { encoding: 'utf8', timeout: 3500 })
  assert.deepEqual({ status: result.status, observation: result.stdout && JSON.parse(result.stdout) }, { status: 0, observation: { regularStderr: true, parentClosed: true, removed: true, childStderrValid: true, exitCode: expectedExit, listeners: 0 } }, `subprocess stderr=${result.stderr}; signal=${result.signal}; error=${result.error?.message}`)
})


test('error guessing: coalesced clients retain the same launcher stderr after the first client unlinks diagnostics', { timeout: 5000 }, (t) => {
  const failedSocketLoader = launcherLoader.replace("export async function load(url, context, nextLoad) {", `export async function load(url, context, nextLoad) {
    if (url === 'node:net') return { format: 'module', shortCircuit: true, source: \`import { EventEmitter } from 'node:events'
      export default { createConnection() {
        const socket = new EventEmitter(); socket.destroy = () => {}; socket.off = socket.removeListener
        setImmediate(() => { globalThis.failedSocketAttempts += 1; socket.emit('error', new Error('connect ECONNREFUSED controlled')); if (globalThis.failedSocketAttempts >= 2) globalThis.twoSocketsFailed() })
        return socket
      } }
    \` }
  `)
  const { driver, args } = isolatedDriver(t, `
import fs from 'node:fs'
const originalOpen = fs.openSync, originalClose = fs.closeSync
const trace = globalThis.launchTrace = { kind: 'concurrent-failure', text: 'shared launcher stderr sentinel', file: null }
fs.openSync = function(file, flags, mode) { const fd = originalOpen(file, flags, mode); if (String(flags).includes('x')) trace.file = String(file); return fd }
globalThis.failedSocketAttempts = 0
const twoFailures = new Promise(resolve => { globalThis.twoSocketsFailed = resolve })
const spawned = new Promise(resolve => { globalThis.childSpawned = resolve })
let release; globalThis.releaseFailureGate = new Promise(resolve => { release = resolve })
const { connectQueryDaemon } = await import(DAEMON_URL)
const first = connectQueryDaemon(FIXTURE_ROOT, { endpoint: { host: '127.0.0.1', port: 1 }, tokenPath: FIXTURE_ROOT + '/token' }).catch(error => error)
const second = connectQueryDaemon(FIXTURE_ROOT, { endpoint: { host: '127.0.0.1', port: 1 }, tokenPath: FIXTURE_ROOT + '/token' }).catch(error => error)
await Promise.all([twoFailures, spawned]); release()
const failures = await Promise.all([first, second])
const observation = { launchCount: trace.launchCount, errors: failures.map(error => ({ visibleStderr: error.message.includes('shared launcher stderr sentinel'), causeStderr: error.cause?.message.includes('shared launcher stderr sentinel'), visibleExit: error.message.includes('23') })), removed: !!trace.file && !fs.existsSync(trace.file) }
if (trace.childFd !== undefined) originalClose(trace.childFd)
process.stdout.write(JSON.stringify(observation))
`, { loaderSource: failedSocketLoader })
  const result = spawnSync(process.execPath, [...args, driver], { encoding: 'utf8', timeout: 3500 })
  assert.deepEqual({ status: result.status, observation: result.stdout && JSON.parse(result.stdout) }, { status: 0, observation: { launchCount: 1, errors: [{ visibleStderr: true, causeStderr: true, visibleExit: true }, { visibleStderr: true, causeStderr: true, visibleExit: true }], removed: true } }, `subprocess stderr=${result.stderr}; signal=${result.signal}; error=${result.error?.message}`)
})
