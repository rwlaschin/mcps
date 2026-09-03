import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const CG = '/Users/mac/Documents/Projects/mcps/codegraph'
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-')))
const src = path.join(root, 'src')
fs.mkdirSync(src)
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, include: ['src'] }))
fs.writeFileSync(path.join(src, 'hub.ts'), 'export function target(value: number) { return value + 1 }\n')
fs.writeFileSync(path.join(src, 'barrel.ts'), "export { target as renamed } from './hub'\n")
const direct = 100, aliased = 100, decoys = 100
for (let index = 0; index < direct; index += 1) fs.writeFileSync(path.join(src, `direct-${index}.ts`), `import { target } from './hub'\nexport const direct${index} = () => target(${index})\n`)
for (let index = 0; index < aliased; index += 1) fs.writeFileSync(path.join(src, `alias-${index}.ts`), `import { renamed } from './barrel'\nexport const alias${index} = () => renamed(${index})\n`)
for (let index = 0; index < decoys; index += 1) fs.writeFileSync(path.join(src, `decoy-${index}.ts`), `export function target(value: string) { return value + '${index}' }\nexport const decoy${index} = () => target('x')\n`)
const rg = (pattern) => {
  const started = performance.now()
  const result = spawnSync('rg', ['-l', '--glob', '*.ts', pattern, src], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return { ms: performance.now() - started, files: result.stdout.trim().split('\n').filter(Boolean) }
}
const child = spawn(process.execPath, [path.join(CG, 'mcp.mjs')], { cwd: CG, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = '', nextId = 0
const waiting = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1)
    if (!line) continue
    const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id)
  }
})
const send = (method, params) => new Promise((resolve) => {
  const id = ++nextId; waiting.set(id, resolve)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const call = async (name, args = {}) => {
  const started = performance.now()
  const message = await send('tools/call', { name, arguments: { root, ...args } })
  assert.notEqual(message.result?.isError, true, message.result?.content?.[0]?.text)
  return { ms: performance.now() - started, text: message.result.content[0].text }
}
try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'search-comparison', version: '1' } })
  const cold = await call('codegraph_refs', { symbol: 'src/hub.ts:target' })
  const warm = []
  for (let index = 0; index < 25; index += 1) warm.push((await call('codegraph_refs', { symbol: 'src/hub.ts:target' })).ms)
  const exact = rg('target'), followedAlias = rg('renamed')
  const resolvedLines = cold.text.split('\n').filter((line) => line.includes('-> '))
  const exactTrueCallerFiles = exact.files.filter((file) => file.includes('/direct-')).length
  const exactDecoyFiles = exact.files.filter((file) => file.includes('/decoy-')).length
  const aliasCallerFiles = followedAlias.files.filter((file) => file.includes('/alias-')).length
  const ordered = warm.toSorted((a, b) => a - b)
  console.log(JSON.stringify({
    corpus: { files: direct + aliased + decoys + 2, expectedCallerFiles: direct + aliased, direct, aliased, decoys },
    exactNameGrep: { ms: exact.ms, candidateFiles: exact.files.length, trueCallerFilesFound: exactTrueCallerFiles, falsePositiveDecoyFiles: exactDecoyFiles, callerFilesMissed: direct + aliased - exactTrueCallerFiles },
    aliasFollowupGrep: { ms: followedAlias.ms, candidateFiles: followedAlias.files.length, trueCallerFilesFound: aliasCallerFiles },
    twoStepGrepWorkflow: { searches: 2, uniqueCandidateFilesToInspect: new Set([...exact.files, ...followedAlias.files]).size, contextCharacters: [...new Set([...exact.files, ...followedAlias.files])].reduce((total, file) => total + fs.readFileSync(file, 'utf8').length, 0), trueCallerFilesFound: exactTrueCallerFiles + aliasCallerFiles, falsePositiveDecoyFiles: exactDecoyFiles },
    codegraph: { mcpCalls: 1, coldMs: cold.ms, warmP50Ms: ordered[Math.floor(ordered.length / 2)], contextCharacters: cold.text.length, returnedRelationshipLines: resolvedLines.length, expectedCallerFiles: direct + aliased },
  }, null, 2))
} finally {
  child.stdin.end(); child.kill('SIGTERM'); await once(child, 'exit')
  fs.rmSync(root, { recursive: true, force: true })
}
