#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const TIMEOUT_MS = 120_000
const STATES = ['indexed', 'leaf', 'cascade']
const REQUIRED_FIXTURES = ['src/query/event.ts', 'src/pages/game/GamePopoutShell.tsx', 'src/services/data/session/storyArcState.ts', 'src/utils/plotSameSelectedItem.ts', 'src/types/index.ts']
const EXCLUDED_DIRECTORIES = new Set(['.git', '.codegraph', 'node_modules', 'dist', 'build', 'coverage', '.next', 'out'])

export const WORKLOADS = [
  { key: 'refs', label: 'References', tool: 'codegraph_refs', arguments: { symbol: 'src/query/event.ts:useSessionEvent' } },
  { key: 'deps', label: 'Dependencies', tool: 'codegraph_deps', arguments: { file: 'src/pages/game/GamePopoutShell.tsx' } },
  { key: 'callers', label: 'Callers', tool: 'codegraph_callers', arguments: { symbol: 'fetchSessionStoryArcState', depth: 3 } },
  { key: 'dead', label: 'Dead exports', tool: 'codegraph_dead', arguments: { prefix: 'src/query' } },
  { key: 'queryNamed', label: 'Named-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', name: 'useSessionEvent', limit: 2000 } } },
  { key: 'queryCapped', label: 'Symbol list (2,000 max)', tool: 'codegraph_query', arguments: { query: { type: 'symbols', limit: 2000 } } },
  { key: 'querySingle', label: 'Single-symbol query', tool: 'codegraph_query', arguments: { query: { type: 'symbols', file: 'src/query/event.ts', name: 'useSessionEvent', limit: 1 } } },
]

export const resolveMcpPath = () => path.join(PROJECT, 'mcp.mjs')

export function parseArgs(argv) {
  const options = { root: undefined, samples: 5, json: undefined, markdown: undefined, readme: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (['--root', '--samples', '--json', '--markdown', '--readme'].includes(key)) options[key.slice(2)] = argv[++index]
    else throw new Error(`unknown option: ${key}`)
  }
  if (!options.root) throw new Error('--root is required')
  options.root = path.resolve(options.root)
  options.samples = Number(options.samples)
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a positive integer')
  return options
}

export function summarizeSamples(samples) {
  if (!samples.length || samples.some((sample) => !Number.isFinite(sample))) throw new Error('timing samples must be nonempty and finite')
  const ordered = samples.toSorted((left, right) => left - right)
  const observed = (quantile) => ordered[Math.ceil(quantile * ordered.length) - 1]
  return { n: ordered.length, p50Ms: observed(0.5), p90Ms: observed(0.9) }
}

export const normalizeSemanticReceipt = (text) => text.replace(/^[^\n]*(?:validatedGeneration|generation)[^\n]*\n/i, '')

export function assertGenerationAdvanced(previous, current) {
  if (!current || previous === current) throw new Error('validated generation did not advance; generation is unchanged')
}

export function assertCascadeValidation(validatedFiles) {
  const count = Array.isArray(validatedFiles) ? validatedFiles.length : validatedFiles
  if (!Number.isInteger(count) || count < 2) throw new Error('cascade must validate at least two files')
}

export function assertExpectedReceipt(key, text) {
  if (!text?.trim()) throw new Error(`${key} returned an empty receipt`)
  const expected = {
    refs: /src\/query\/event\.ts|useSessionEvent/,
    deps: /src\//,
    callers: /storyArcState\.ts|fetchSessionStoryArcState/,
    dead: /export\(s\)|src\/query/,
    queryNamed: /useSessionEvent/,
    queryCapped: /"name"/,
    querySingle: /useSessionEvent/,
  }[key]
  if (!expected?.test(text)) throw new Error(`${key} receipt is not semantically expected: ${text.slice(0, 200)}`)
  return text
}

export function withTimeout(promise, milliseconds = TIMEOUT_MS, label = 'operation') {
  let timer
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds) })]).finally(() => clearTimeout(timer))
}

export const buildOnce = async (root, { run = spawnSync, clock = performance.now.bind(performance), timeoutMs = TIMEOUT_MS } = {}) => {
  const started = clock()
  const result = run(process.execPath, [path.join(PROJECT, 'tool.mjs'), 'build', '--root', root], { cwd: PROJECT, encoding: 'utf8', timeout: timeoutMs })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cold build failed (${result.status ?? result.signal}): ${result.stderr.trim()}`)
  return readUpdate({ text: result.stdout.trim(), ms: clock() - started })
}

export const measureColdBuild = (root, { build = buildOnce } = {}) => build(root)

const countFiles = (value) => Array.isArray(value) ? value.length : Number(value ?? 0)

export async function measureWatcherUpdate({ root, state, previousGeneration, phase, timeoutMs = TIMEOUT_MS, mutate = applyStateMutation, readMetadata, wait = () => new Promise((resolve) => setTimeout(resolve, 25)), clock = performance.now.bind(performance) }) {
  const started = clock()
  mutate(root, state)
  return withTimeout((async () => {
    for (;;) {
      const metadata = await readMetadata(root, previousGeneration)
      const generation = metadata.generation ?? metadata.validatedGeneration
      const status = metadata.status ?? metadata.freshness
      if (generation && generation !== previousGeneration && status === 'validated') {
        return { ms: clock() - started, generation, parsedFiles: countFiles(metadata.parsedFiles), validatedFiles: countFiles(metadata.validatedFiles) }
      }
      await wait()
    }
  })(), timeoutMs, phase)
}

export function applyStateMutation(root, state) {
  const relative = state === 'leaf' ? 'src/utils/plotSameSelectedItem.ts' : state === 'cascade' ? 'src/types/index.ts' : null
  if (!relative) throw new Error(`unknown benchmark state: ${state}`)
  fs.appendFileSync(path.join(root, relative), '// codegraph performance benchmark\n')
}

const excluded = (source) => {
  const name = path.basename(source)
  const stat = fs.lstatSync(source)
  return !EXCLUDED_DIRECTORIES.has(name) && !name.endsWith('.cache') && !name.endsWith('.sock') && !stat.isSocket() && !stat.isSymbolicLink()
}

export async function createDisposableMirror(sourceRoot) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-performance-'))
  const mirror = path.join(parent, path.basename(path.resolve(sourceRoot)))
  try { fs.cpSync(sourceRoot, mirror, { recursive: true, filter: excluded }); return mirror } catch (error) { fs.rmSync(parent, { recursive: true, force: true }); throw error }
}

export async function withDisposableMirror(sourceRoot, operation) {
  const mirror = await createDisposableMirror(sourceRoot)
  try { return await operation(mirror) } finally { fs.rmSync(path.dirname(mirror), { recursive: true, force: true }) }
}

export const startMcp = ({ spawnChild = spawn, platform = process.platform, killProcess = process.kill, requestTimeoutMs = TIMEOUT_MS, shutdownTimeoutMs = 10_000 } = {}) => {
  const child = spawnChild(process.execPath, [resolveMcpPath()], { cwd: PROJECT, stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32' })
  let output = ''; let errors = ''; let id = 0
  const waiting = new Map()
  child.stderr.on('data', (chunk) => { errors += chunk })
  child.stdout.on('data', (chunk) => {
    output += chunk
    for (let newline = output.indexOf('\n'); newline >= 0; newline = output.indexOf('\n')) {
      const line = output.slice(0, newline).trim(); output = output.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const pending = waiting.get(message.id)
      if (pending) { waiting.delete(message.id); pending.resolve(message) }
    }
  })
  child.once('exit', (code, signal) => {
    for (const pending of waiting.values()) pending.reject(new Error(`MCP exited (${code ?? signal}): ${errors.trim()}`))
    waiting.clear()
  })
  const request = (method, params) => withTimeout(new Promise((resolve, reject) => {
    const requestId = ++id
    waiting.set(requestId, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
  }), requestTimeoutMs, 'MCP request')
  const timed = async (method, params, label = 'MCP request') => { const started = performance.now(); const message = await withTimeout(request(method, params), requestTimeoutMs, label); return { message, ms: performance.now() - started } }
  const signalChild = (signal) => platform === 'win32' ? child.kill(signal) : killProcess(-child.pid, signal)
  const stop = () => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode === 0 || child.signalCode === 'SIGTERM' ? resolve() : reject(new Error(`MCP shutdown failed (${child.exitCode ?? child.signalCode})`))
    const timer = setTimeout(() => { try { signalChild('SIGKILL') } catch (error) { reject(error); return }; reject(new Error('MCP shutdown timed out')) }, shutdownTimeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 || signal === 'SIGTERM' ? resolve() : reject(new Error(`MCP shutdown failed (${code ?? signal}): ${errors.trim()}`)) })
    child.stdin.end()
    if (platform === 'win32') child.kill('SIGTERM')
    else signalChild('SIGTERM')
  })
  return { timed, stop }
}

export const stopAfter = async (mcp, operation) => { try { return await operation() } finally { await mcp.stop() } }

const toolCall = async (mcp, root, name, args, label = name) => {
  const argumentsForMcp = name === 'codegraph_deps' && args.file ? { ...args, target: args.file } : args
  if (argumentsForMcp.target) delete argumentsForMcp.file
  const { message, ms } = await mcp.timed('tools/call', { name, arguments: { root, ...argumentsForMcp } }, label)
  const text = message.result?.content?.[0]?.text ?? ''
  if (message.error || message.result?.isError) throw new Error(`${name} failed: ${message.error?.message ?? text}`)
  return { text, ms }
}

const semanticReceipt = (workload, text) => ['deps', 'queryNamed', 'queryCapped', 'querySingle'].includes(workload.key) ? normalizeSemanticReceipt(text) : text

export async function runSweep(mcp, root) {
  const sweep = {}
  for (const workload of WORKLOADS) {
    const result = await toolCall(mcp, root, workload.tool, structuredClone(workload.arguments))
    const receipt = semanticReceipt(workload, result.text)
    assertExpectedReceipt(workload.key, receipt)
    sweep[workload.key] = { ms: result.ms, receipt, sha256: crypto.createHash('sha256').update(receipt).digest('hex') }
  }
  return sweep
}

const readUpdate = ({ text, ms }) => {
  let result
  try { result = JSON.parse(text) } catch { throw new Error(`update returned invalid JSON: ${text}`) }
  return { ms, generation: result.generation, parsedFiles: result.parsedFiles?.length ?? 0, validatedFiles: result.validatedFiles?.length ?? 0 }
}

export const assertReceiptsMatch = (expected, actual) => {
  for (const { key } of WORKLOADS) if (expected[key].sha256 !== actual[key].sha256) throw new Error(`${key} semantic output drifted across update states`)
}

export const validateFixtures = (root) => {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`repository root is not a directory: ${root}`)
  for (const fixture of REQUIRED_FIXTURES) if (!fs.statSync(path.join(root, fixture), { throwIfNoEntry: false })?.isFile()) throw new Error(`required D&D fixture is missing: ${fixture}`)
}

export const sourceSnapshot = (root) => {
  const hash = crypto.createHash('sha256')
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name)
      if (!excluded(file)) continue
      hash.update(path.relative(root, file))
      if (entry.isDirectory()) walk(file)
      else hash.update(fs.readFileSync(file))
    }
  }
  walk(root)
  return hash.digest('hex')
}

export const watcherMetadata = (root, previousGeneration, state) => {
  const cache = path.join(root, '.codegraph')
  const generation = fs.readFileSync(path.join(cache, 'CURRENT'), 'utf8').trim()
  if (generation === previousGeneration) return { generation, status: 'validated' }
  const readManifest = (id) => JSON.parse(fs.readFileSync(path.join(cache, 'generations', `${id}.json`), 'utf8'))
  const before = readManifest(previousGeneration); const after = readManifest(generation)
  const changed = state === 'leaf' ? ['src/utils/plotSameSelectedItem.ts'] : ['src/types/index.ts']
  const importers = new Map()
  for (const [file, id] of Object.entries(before.partitions)) {
    const partition = JSON.parse(fs.readFileSync(path.join(cache, 'partitions', `${id}.json`), 'utf8'))
    for (const dependency of partition.dependencies ?? []) {
      const files = importers.get(dependency)
      if (files) files.push(file); else importers.set(dependency, [file])
    }
  }
  const validated = new Set(changed); const queue = [...changed]
  while (queue.length) for (const file of importers.get(queue.pop()) ?? []) if (!validated.has(file)) { validated.add(file); queue.push(file) }
  const parsedFiles = Object.keys(after.sources).filter((file) => before.sources[file] !== after.sources[file])
  return { generation, status: 'validated', parsedFiles, validatedFiles: [...validated] }
}

export const captureSample = async (sourceRoot, { withMirror = withDisposableMirror, start = startMcp, coldBuild = measureColdBuild, watcherUpdate = measureWatcherUpdate, readMetadata = watcherMetadata } = {}) => withMirror(sourceRoot, async (root) => {
  const initialIndex = await coldBuild(root)
  const mcp = start()
  return stopAfter(mcp, async () => {
    await mcp.timed('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codegraph-performance', version: '2' } })
    const indexed = await runSweep(mcp, root)
    await toolCall(mcp, root, 'codegraph_refresh', {}, 'watcher readiness')
    const leaf = await watcherUpdate({ root, state: 'leaf', previousGeneration: initialIndex.generation, phase: 'leaf incremental update', readMetadata: (target, generation) => readMetadata(target, generation, 'leaf') })
    assertGenerationAdvanced(initialIndex.generation, leaf.generation)
    const leafSweep = await runSweep(mcp, root); assertReceiptsMatch(indexed, leafSweep)
    const cascade = await watcherUpdate({ root, state: 'cascade', previousGeneration: leaf.generation, phase: 'cascade incremental update', readMetadata: (target, generation) => readMetadata(target, generation, 'cascade') })
    assertGenerationAdvanced(leaf.generation, cascade.generation); assertCascadeValidation(cascade.validatedFiles)
    const cascadeSweep = await runSweep(mcp, root); assertReceiptsMatch(indexed, cascadeSweep)
    const fullReindex = readUpdate(await toolCall(mcp, root, 'codegraph_index', {}, 'full reindex'))
    return { root, sourceFiles: initialIndex.parsedFiles, sweeps: { indexed, leaf: leafSweep, cascade: cascadeSweep }, updates: { initialIndex, leaf, cascade, fullReindex } }
  })
})

export const gitValue = (root, args, fallback) => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() || fallback : fallback }

export function assertCompleteReport(report) {
  for (const { key } of WORKLOADS) for (const state of STATES) if (!report.benchmarks?.[key]?.[state]) throw new Error(`report is missing ${key} ${state}`)
  for (const update of ['initialIndex', 'leaf', 'cascade', 'fullReindex']) if (!report.updates?.[update]) throw new Error(`report is missing ${update}`)
  if (!Number.isFinite(report.updates.cascade.parsedFiles)) throw new Error('cascade parsed-file count is missing')
  if (!Number.isFinite(report.updates.cascade.validatedFiles)) throw new Error('cascade validated-file count is missing')
  if (!report.correctness?.consistent) throw new Error('semantic output is not consistent; output drifted')
  if (!report.correctness?.originalRepositoryUnchanged) throw new Error('original repository is not unchanged; mutation detected')
  if (!report.correctness?.cleanShutdown) throw new Error('MCP shutdown was not clean')
  return report
}

export async function captureReport(options, { capture = captureSample } = {}) {
  validateFixtures(options.root)
  const sourceRoot = fs.realpathSync(options.root)
  const before = sourceSnapshot(sourceRoot)
  const samples = []
  for (let index = 0; index < options.samples; index += 1) samples.push(await capture(sourceRoot))
  const expectedReceipts = samples[0].sweeps.indexed
  for (const sample of samples) for (const state of STATES) assertReceiptsMatch(expectedReceipts, sample.sweeps[state])
  const benchmarks = Object.fromEntries(WORKLOADS.map(({ key }) => [key, Object.fromEntries(STATES.map((state) => [state, summarizeSamples(samples.map((sample) => sample.sweeps[state][key].ms))]))]))
  const updates = Object.fromEntries(['initialIndex', 'leaf', 'cascade', 'fullReindex'].map((key) => [key, summarizeSamples(samples.map((sample) => sample.updates[key].ms))]))
  for (const key of ['leaf', 'cascade']) {
    updates[key].parsedFiles = Math.max(...samples.map((sample) => sample.updates[key].parsedFiles))
    updates[key].validatedFiles = Math.max(...samples.map((sample) => sample.updates[key].validatedFiles))
  }
  return assertCompleteReport({ schemaVersion: 2, provenance: { root: samples[0].root, sourceRoot, repository: path.basename(sourceRoot), sourceFiles: samples[0].sourceFiles, commit: gitValue(sourceRoot, ['rev-parse', 'HEAD'], 'unavailable') }, benchmarks, updates, correctness: { consistent: true, originalRepositoryUnchanged: before === sourceSnapshot(sourceRoot), cleanShutdown: true } })
}

const formatPair = ({ p50Ms, p90Ms }) => `${p50Ms.toFixed(2)} / ${p90Ms.toFixed(2)} ms`

export function renderMarkdown(report) {
  assertCompleteReport(report)
  const rows = [
    `CodeGraph was tested against the ${report.provenance.sourceFiles.toLocaleString('en-US')}-source-file D&D Community and Marketplace project, covering all query endpoints, initial indexing, leaf updates, cascade updates, and full reindexing.`,
    '', '## Metrics', '', '| Operation | Indexed | Leaf update | Cascade update |', '| :--- | ---: | ---: | ---: |',
    ...WORKLOADS.map(({ key, label }) => `| ${label} | ${formatPair(report.benchmarks[key].indexed)} | ${formatPair(report.benchmarks[key].leaf)} | ${formatPair(report.benchmarks[key].cascade)} |`),
    '', '| Update | p50 / p90 | Parsed files | Validated files |', '| :--- | ---: | ---: | ---: |',
    `| CLI cold index | ${formatPair(report.updates.initialIndex)} | — | — |`,
    `| Leaf incremental update | ${formatPair(report.updates.leaf)} | ${report.updates.leaf.parsedFiles} | ${report.updates.leaf.validatedFiles} |`,
    `| Cascade incremental update | ${formatPair(report.updates.cascade)} | ${report.updates.cascade.parsedFiles} | ${report.updates.cascade.validatedFiles} |`,
    `| Full reindex | ${formatPair(report.updates.fullReindex)} | — | — |`,
  ]
  return `${rows.join('\n')}\n`
}

export const serializeReport = (report) => `${JSON.stringify(assertCompleteReport(report), null, 2)}\n`

export function replaceReadmeMetrics(readme, markdown) {
  const start = '<!-- codegraph-performance:start -->'; const end = '<!-- codegraph-performance:end -->'
  const from = readme.indexOf(start); const to = readme.indexOf(end)
  if (from < 0 || to < from) throw new Error('README performance markers are missing or invalid')
  return `${readme.slice(0, from + start.length)}\n${markdown.trim()}\n${readme.slice(to)}`
}

export const atomicWrite = (file, contents) => {
  if (!file) return
  const target = path.resolve(file); const temporary = `${target}.${process.pid}.tmp`
  try { fs.writeFileSync(temporary, contents); fs.renameSync(temporary, target) } finally { fs.rmSync(temporary, { force: true }) }
}

export function writeReportArtifacts(options, json, markdown) {
  atomicWrite(options.json, json); atomicWrite(options.markdown, markdown)
  if (options.readme) { const readme = path.resolve(options.readme); atomicWrite(readme, replaceReadmeMetrics(fs.readFileSync(readme, 'utf8'), markdown)) }
}

export async function main(argv = process.argv.slice(2), { capture = captureReport, writeArtifacts = writeReportArtifacts, stdout = process.stdout } = {}) {
  const options = parseArgs(argv); const report = await capture(options); const json = serializeReport(report); const markdown = renderMarkdown(report)
  writeArtifacts(options, json, markdown); stdout.write(markdown)
}

export async function runCli(argv = process.argv.slice(2), { runMain = main, stderr = process.stderr, setExitCode = (code) => { process.exitCode = code } } = {}) {
  try { await runMain(argv) } catch (error) { stderr.write(`${error.message}\n`); setExitCode(1) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCli()
