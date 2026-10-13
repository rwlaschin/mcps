import { parentPort } from 'node:worker_threads'
import { buildGoFileFacts } from './go-language-analyzer.mjs'

parentPort.on('message', async (message) => {
  if (message?.type !== 'parse') return
  const identity = { path: message.path, requestId: message.requestId, fileId: message.fileId, revision: message.revision }
  try {
    const parsed = await buildGoFileFacts(message.path, message.source)
    parentPort.postMessage({ type: 'result', ...identity, parsed })
  } catch (error) {
    parentPort.postMessage({ type: 'error', ...identity, error: error?.message ?? String(error) })
  }
})
