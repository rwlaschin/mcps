import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import './compile-cache.mjs'
const { default: ts } = await import('@ts-morph/common/dist/typescript.js')
const { parseFile } = await import('./incremental-resolver.mjs')

const root = path.resolve(workerData.root)
const realRoot = fs.realpathSync(root)
const retained = new Map()
let retainedBytes = 0
const RETAINED_MAX_ENTRIES = 32
const RETAINED_MAX_BYTES = 1024 * 1024

const resolveTarget = (relativePath) => {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new TypeError('parser path must be relative')
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`parser path escapes root: ${relativePath}`)
  const realTarget = fs.realpathSync(target); const realRelative = path.relative(realRoot, realTarget)
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`parser path escapes root through symbolic link: ${relativePath}`)
  return realTarget
}

parentPort.on('message', (message) => {
  if (message?.type === 'release') { const previous = retained.get(message.fileId); if (previous) { retained.delete(message.fileId); retainedBytes -= previous.bytes } return }
  if (message?.type !== 'parse') return
  const response = { requestId: message.requestId, fileId: message.fileId, revision: message.revision }
  try {
    if (message.mode === 'structural') {
      if (typeof message.source !== 'string') throw new TypeError('structural parser source must be supplied')
      const relative = path.relative(root, path.resolve(root, message.path))
      if (path.isAbsolute(message.path) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`parser path escapes root: ${message.path}`)
      import('./internal-graph.mjs').then(({ buildInternalGraph }) => {
        const parsed = buildInternalGraph({ file: message.path, source: message.source, compilerOptions: message.compilerOptions })
        parentPort.postMessage({ type: 'result', path: message.path, ...response, parsed })
      }).catch(error => parentPort.postMessage({ type: 'error', path: message.path, ...response, error: error?.message ?? String(error) }))
      return
    }
    const target = resolveTarget(message.path)
    const source = fs.readFileSync(target, 'utf8')
    const previous = retained.get(message.fileId)
    const sourceFile = previous ? previous.sourceFile.update(source, { span: { start: 0, length: previous.source.length }, newLength: source.length }) : ts.createSourceFile(message.path, source, ts.ScriptTarget.Latest, true)
    const parsed = parseFile(message.path, source, sourceFile, { includeSource: false })
    if (previous) { retained.delete(message.fileId); retainedBytes -= previous.bytes }
    const entry = { source, sourceFile, bytes: parsed.sourceBytes + parsed.nodeCount * 192 }; retained.set(message.fileId, entry); retainedBytes += entry.bytes
    while (retained.size > RETAINED_MAX_ENTRIES || retainedBytes > RETAINED_MAX_BYTES) { const oldestId = retained.keys().next().value; const oldest = retained.get(oldestId); retained.delete(oldestId); retainedBytes -= oldest.bytes }
    parentPort.postMessage({ type: 'result', path: message.path, ...response, parsed })
  } catch (error) {
    parentPort.postMessage({ type: 'error', path: message.path, ...response, error: error?.message ?? String(error) })
  }
})
