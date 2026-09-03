import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('error guessing: MCP release aborts active requests and wrapper shutdown has a bounded worker fallback', () => {
  const serverSource = fs.readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8')
  const wrapperSource = fs.readFileSync(new URL('../mcp.mjs', import.meta.url), 'utf8')
  const releaseStart = serverSource.indexOf('const releaseRoots = async () => {')
  const releaseEnd = serverSource.indexOf('\n}', releaseStart)
  const releaseSource = serverSource.slice(releaseStart, releaseEnd)
  const stopStart = wrapperSource.indexOf('const stop = async () => {')
  const stopEnd = wrapperSource.indexOf('\n}', stopStart)
  const stopSource = wrapperSource.slice(stopStart, stopEnd)

  assert.deepEqual(
    {
      abortsActiveRequestsBeforeDrain: releaseSource.indexOf('.abort()') >= 0 && releaseSource.indexOf('.abort()') < releaseSource.indexOf('while (inFlight.size)'),
      boundedReleaseWaitBeforeTerminate: /(?:setTimeout|AbortSignal\.timeout)/.test(stopSource) && stopSource.indexOf('worker.terminate()') > stopSource.search(/(?:setTimeout|AbortSignal\.timeout)/),
    },
    { abortsActiveRequestsBeforeDrain: true, boundedReleaseWaitBeforeTerminate: true },
  )
})
