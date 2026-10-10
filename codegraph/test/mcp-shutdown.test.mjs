import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('error guessing: stdio proxy and shared daemon cancel active work before draining and closing transport', () => {
  const daemon = fs.readFileSync(new URL('../query-daemon.mjs', import.meta.url), 'utf8')
  const proxy = fs.readFileSync(new URL('../mcp.mjs', import.meta.url), 'utf8')
  const close = daemon.slice(daemon.indexOf('async #close(options)'))
  const finish = proxy.slice(proxy.indexOf('async function finish()'), proxy.indexOf("lines.on('close', finish)"))
  assert.deepEqual({
    daemonCancelsBeforeEngineClose: close.indexOf('request.controller.abort()') >= 0 && close.indexOf('request.controller.abort()') < close.indexOf('this.engine?.close?.()'),
    daemonDrainsBeforeSocketClose: close.indexOf('await Promise.allSettled', close.indexOf('request.controller.abort()')) > close.indexOf('request.controller.abort()') && close.indexOf('await Promise.allSettled', close.indexOf('request.controller.abort()')) < close.indexOf('socket.destroy()'),
    proxySignalCancelsBeforeFinish: /process.on\('SIGTERM',.*controller.abort\(\).*finish\(\)/.test(proxy),
    proxyDrainsBeforeClientClose: finish.indexOf('await Promise.allSettled') >= 0 && finish.indexOf('await Promise.allSettled') < finish.indexOf('await client?.close()'),
    proxyDoesNotOwnWorker: !/worker\.terminate|new Worker/.test(proxy),
  }, { daemonCancelsBeforeEngineClose: true, daemonDrainsBeforeSocketClose: true, proxySignalCancelsBeforeFinish: true, proxyDrainsBeforeClientClose: true, proxyDoesNotOwnWorker: true })
})
