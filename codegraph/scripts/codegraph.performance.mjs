#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GraphStore } from '../store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const TIMEOUT_MS = 60_000
const STDERR_TAIL_BYTES = (64 * 1024) - 256
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
  { key: 'cyclo', label: 'Cyclomatic complexity', tool: 'codegraph_internals', arguments: { operation: 'metrics', file: 'src/query/event.ts', owner: { symbol: 'useSessionEvent' }, metrics: ['cyclomatic'] } },
]

export const workloadsFor = (symbol) => symbol ? WORKLOADS.map((workload) => {
  if (workload.key === 'refs') return { ...workload, arguments: { symbol } }
  if (workload.key === 'queryNamed') return { ...workload, arguments: { query: { ...workload.arguments.query, name: symbol } } }
  if (workload.key === 'querySingle') return { ...workload, arguments: { query: { type: 'symbols', name: symbol, limit: 1 } } }
  return workload
}) : WORKLOADS

export const resolveMcpPath = () => path.join(PROJECT, 'mcp.mjs')

export function parseArgs(argv) {
  const options = { root: undefined, samples: 5, json: undefined, markdown: undefined, readme: undefined }
  let profile = false
  const profilePaths = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (['--root', '--samples', '--json', '--markdown', '--readme', '--symbol'].includes(key)) options[key.slice(2)] = argv[++index]
    else if (key === '--refresh-snapshot') options.refreshSnapshot = true
    else if (key === '--profile') profile = true
    else if (['--cpu', '--heap', '--trace'].includes(key)) profilePaths[key.slice(2)] = argv[++index]
    else if (key === '--diagnostic-log') options.diagnosticLog = argv[++index]
    else throw new Error(`unknown option: ${key}`)
  }
  if (!options.root) throw new Error('--root is required')
  options.root = path.resolve(options.root)
  options.samples = Number(options.samples)
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a positive integer')
  if (profile) {
    if (!Object.keys(profilePaths).length) throw new Error('--profile requires --cpu, --heap, or --trace')
    options.symbol ??= undefined
    options.profile = profilePaths
  } else if (options.diagnosticLog) throw new Error('--diagnostic-log requires --profile')
  else if (Object.keys(profilePaths).length) throw new Error('--cpu, --heap, and --trace require --profile')
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
    cyclo: /"record":"metrics".*"cyclomatic":\s*[1-9]\d*/,
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

export async function measureWatcherUpdate({ root, state, previousGeneration, phase, timeoutMs = TIMEOUT_MS, mutate = applyStateMutation, readMetadata, afterValidated = async () => {}, wait = () => new Promise((resolve) => setTimeout(resolve, 25)), clock = performance.now.bind(performance) }) {
  const started = clock()
  mutate(root, state)
  return withTimeout((async () => {
    for (;;) {
      const metadata = await readMetadata(root, previousGeneration)
      const generation = metadata.generation ?? metadata.validatedGeneration
      const status = metadata.status ?? metadata.freshness
      if (generation && generation !== previousGeneration && status === 'validated') {
        await afterValidated(root, generation)
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

export const startMcp = ({ root, profile, diagnosticLog, spawnChild = spawn, platform = process.platform, killProcess = process.kill, controller = process, requestTimeoutMs = TIMEOUT_MS, shutdownTimeoutMs = 10_000 } = {}) => {
  const args = []
  const cpuDestination = profile?.cpu ? path.resolve(profile.cpu) : null
  const cpuDirectory = cpuDestination ? path.dirname(cpuDestination) : null
  if (profile) {
    for (const file of Object.values(profile)) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  }
  const diagnosticPath = diagnosticLog ? path.resolve(diagnosticLog) : null
  if (diagnosticPath) fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true })
  const existingCpuProfiles = cpuDirectory
    ? new Set(fs.readdirSync(cpuDirectory).filter((name) => name.startsWith('CPU.')))
    : null
  if (profile) {
    if (profile.cpu) args.push('--cpu-prof', `--cpu-prof-dir=${cpuDirectory}`)
    if (profile.heap) args.push('--heap-prof', `--heap-prof-dir=${path.dirname(path.resolve(profile.heap))}`, `--heap-prof-name=${path.basename(profile.heap)}`)
    if (profile.trace) args.push('--trace-event-categories=v8,node,node.async_hooks', `--trace-event-file-pattern=${path.resolve(profile.trace)}`)
  }
  args.push(resolveMcpPath())
  const diagnosticFd = diagnosticPath ? fs.openSync(diagnosticPath, 'w') : null
  const environment = root || diagnosticPath
    ? { ...process.env, ...(root && { CODEGRAPH_ROOT: root }), ...(diagnosticPath && { CODEGRAPH_DEBUG_POOL: '1' }) }
    : process.env
  const child = spawnChild(process.execPath, args, { cwd: PROJECT, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32' })
  const signalChild = (signal) => platform === 'win32' ? child.kill(signal) : killProcess(-child.pid, signal)
  let lifecycleActive = true
  const controllerSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const onControllerExit = () => { try { if (child.exitCode === null && child.signalCode === null) signalChild('SIGTERM') } catch {} }
  const signalHandlers = new Map(controllerSignals.map((signal) => [signal, () => {
    unregisterLifecycle()
    try { if (child.exitCode === null && child.signalCode === null) signalChild('SIGTERM') } finally {
      if (typeof controller.kill === 'function' && Number.isInteger(controller.pid)) controller.kill(controller.pid, signal)
    }
  }]))
  function unregisterLifecycle() {
    if (!lifecycleActive) return
    lifecycleActive = false
    for (const [signal, handler] of signalHandlers) controller.off(signal, handler)
    controller.off('exit', onControllerExit)
  }
  for (const [signal, handler] of signalHandlers) controller.once(signal, handler)
  controller.once('exit', onControllerExit)
  let output = ''; let errors = Buffer.alloc(0); let id = 0; let diagnosticClosed = false
  const waiting = new Map()
  const closeDiagnostic = () => {
    if (diagnosticFd === null || diagnosticClosed) return
    diagnosticClosed = true
    fs.closeSync(diagnosticFd)
  }
  const errorText = () => errors.toString('utf8').trim()
  child.stderr.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (diagnosticFd !== null) fs.writeSync(diagnosticFd, bytes)
    errors = errors.length ? Buffer.concat([errors, bytes]) : bytes
    if (errors.length > STDERR_TAIL_BYTES) errors = errors.subarray(errors.length - STDERR_TAIL_BYTES)
  })
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
    unregisterLifecycle()
    for (const pending of waiting.values()) pending.reject(new Error(`MCP exited (${code ?? signal}): ${errorText()}`))
    waiting.clear()
  })
  const request = (method, params) => withTimeout(new Promise((resolve, reject) => {
    const requestId = ++id
    waiting.set(requestId, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
  }), requestTimeoutMs, 'MCP request')
  const timed = async (method, params, label = 'MCP request') => { const started = performance.now(); const message = await withTimeout(request(method, params), requestTimeoutMs, label); return { message, ms: performance.now() - started } }
  let shutdownArtifacts
  const retainCpuProfiles = () => {
    if (!cpuDestination) return undefined
    if (shutdownArtifacts) return shutdownArtifacts
    const extension = '.cpuprofile'
    const stem = cpuDestination.endsWith(extension) ? cpuDestination.slice(0, -extension.length) : cpuDestination
    const generated = fs.readdirSync(cpuDirectory)
      .filter((name) => name.startsWith('CPU.') && !existingCpuProfiles.has(name))
      .sort()
    const cpu = generated.map((name, index) => {
      const destination = `${stem}-${index + 1}${extension}`
      fs.renameSync(path.join(cpuDirectory, name), destination)
      return destination
    })
    shutdownArtifacts = { cpu }
    return shutdownArtifacts
  }
  const stop = () => new Promise((resolve, reject) => {
    unregisterLifecycle()
    if (child.exitCode !== null || child.signalCode !== null) {
      closeDiagnostic()
      return child.exitCode === 0 || child.signalCode === 'SIGTERM' ? resolve(retainCpuProfiles()) : reject(new Error(`MCP shutdown failed (${child.exitCode ?? child.signalCode})`))
    }
    const timer = setTimeout(() => {
      try { signalChild('SIGKILL') } catch (error) { retainCpuProfiles(); closeDiagnostic(); reject(error); return }
      retainCpuProfiles()
      closeDiagnostic()
      reject(new Error('MCP shutdown timed out'))
    }, shutdownTimeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); const artifacts = retainCpuProfiles(); closeDiagnostic(); code === 0 || signal === 'SIGTERM' ? resolve(artifacts) : reject(new Error(`MCP shutdown failed (${code ?? signal}): ${errorText()}`)) })
    child.stdin.end()
    if (platform === 'win32') child.kill('SIGTERM')
    else signalChild('SIGTERM')
  })
  return { timed, stop }
}

export const stopAfter = async (mcp, operation) => {
  let result; let failure
  try { result = await operation() } catch (error) { failure = error }
  try { await mcp.stop() } catch (error) {
    if (!failure) throw error
    failure.message += `; MCP shutdown also failed: ${error.message}`
  }
  if (failure) throw failure
  return result
}

const toolCall = async (mcp, root, name, args, label = name) => {
  const argumentsForMcp = name === 'codegraph_deps' && args.file ? { ...args, target: args.file } : args
  if (argumentsForMcp.target) delete argumentsForMcp.file
  const { message, ms } = await mcp.timed('tools/call', { name, arguments: { root, ...argumentsForMcp } }, label)
  const text = message.result?.content?.[0]?.text ?? ''
  if (message.error || message.result?.isError) throw new Error(`${name} failed: ${message.error?.message ?? text}`)
  return { text, ms }
}

const semanticReceipt = (workload, text) => ['deps', 'queryNamed', 'queryCapped', 'querySingle', 'cyclo'].includes(workload.key) ? normalizeSemanticReceipt(text) : text
const assertWorkloadReceipt = (workload, text, symbol) => {
  if (symbol && workload.key === 'refs') {
    if (!/:\d+\s*->\s*[^\n]+:\d+/.test(text)) throw new Error(`refs receipt is not semantically expected: ${text.slice(0, 200)}`)
    return text
  }
  if (!symbol || !['queryNamed', 'querySingle'].includes(workload.key)) return assertExpectedReceipt(workload.key, text)
  if (!text.includes(symbol)) throw new Error(`${workload.key} receipt is not semantically expected: ${text.slice(0, 200)}`)
  return text
}

export async function runSweep(mcp, root, workloads = WORKLOADS, symbol, warmRefs = false) {
  const sweep = {}
  for (const workload of workloads) {
    const result = await toolCall(mcp, root, workload.tool, structuredClone(workload.arguments))
    const receipt = semanticReceipt(workload, result.text)
    assertWorkloadReceipt(workload, receipt, symbol)
    if (warmRefs && workload.key === 'refs') {
      const warm = semanticReceipt(workload, (await toolCall(mcp, root, workload.tool, structuredClone(workload.arguments))).text)
      if (warm !== receipt) throw new Error('refs semantic output drifted between cold and warm calls')
    }
    sweep[workload.key] = { ms: result.ms, receipt, sha256: crypto.createHash('sha256').update(receipt).digest('hex') }
  }
  return sweep
}

const readUpdate = ({ text, ms }) => {
  let result
  try { result = JSON.parse(text) } catch { throw new Error(`update returned invalid JSON: ${text}`) }
  const parsedFiles = result.parsedFiles?.length ?? 0
  return { ms, generation: result.generation, parsedFiles, validatedFiles: result.validatedFiles?.length ?? parsedFiles }
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

const snapshotLocation = (sourceRoot) => {
  const identity = crypto.createHash('sha256').update(sourceRoot).digest('hex').slice(0, 12)
  return path.join(PROJECT, '.performance-snapshots', `${path.basename(sourceRoot)}-${identity}`)
}

export async function withSnapshotLock(root, operation, { directory, target: requestedTarget } = {}) {
  const target = requestedTarget ?? snapshotLocation(fs.realpathSync(root))
  const lockDirectory = directory ?? path.dirname(target)
  const lock = path.join(lockDirectory, `${path.basename(target)}.lock`)
  fs.mkdirSync(lockDirectory, { recursive: true })
  let descriptor
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lock, 'wx')
      try { fs.writeFileSync(descriptor, `${process.pid}\n`) } catch (error) { fs.closeSync(descriptor); descriptor = undefined; fs.rmSync(lock, { force: true }); throw error }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = Number(fs.readFileSync(lock, 'utf8').trim())
      try { process.kill(owner, 0) } catch (signalError) {
        if (signalError.code === 'ESRCH' && attempt === 0) {
          const backup = `${target}.${owner}.previous`
          if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target)
          else if (fs.existsSync(target) && fs.existsSync(backup)) {
            if (fs.existsSync(path.join(target, 'manifest.json'))) readFrozenSnapshot(target)
            fs.rmSync(backup, { recursive: true })
          }
          fs.rmSync(lock, { force: true })
          continue
        }
      }
      throw new Error(`performance snapshot is already in use: ${target}`)
    }
  }
  try { return await operation() } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(lock, { force: true })
  }
}

const readFrozenSnapshot = (target) => {
  const source = path.join(target, 'source')
  const manifestFile = path.join(target, 'manifest.json')
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory() || !fs.statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`frozen performance snapshot is missing or invalid: ${target}; run again with --refresh-snapshot`)
  }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { throw new Error(`frozen performance snapshot manifest is invalid: ${manifestFile}; run again with --refresh-snapshot`) }
  validateFixtures(source)
  const hash = sourceSnapshot(source)
  if (manifest.schemaVersion !== 1 || manifest.sha256 !== hash) throw new Error(`frozen performance snapshot failed validation: ${target}; run again with --refresh-snapshot`)
  return { root: source, target, manifest }
}

export function resolvePerformanceSnapshot(root, { refresh = false } = {}) {
  const sourceRoot = fs.realpathSync(root)
  const target = snapshotLocation(sourceRoot)
  if (!refresh) return readFrozenSnapshot(target)

  validateFixtures(sourceRoot)
  const before = sourceSnapshot(sourceRoot)
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}-`))
  const replacement = path.join(temporary, path.basename(target))
  const replacementSource = path.join(replacement, 'source')
  const backup = `${target}.${process.pid}.previous`
  try {
    fs.mkdirSync(replacement)
    fs.cpSync(sourceRoot, replacementSource, { recursive: true, filter: excluded })
    validateFixtures(replacementSource)
    const copied = sourceSnapshot(replacementSource)
    if (copied !== before || sourceSnapshot(sourceRoot) !== before) throw new Error('repository changed while refreshing the frozen performance snapshot; existing snapshot was preserved')
    const manifest = { schemaVersion: 1, sourceRoot, repository: path.basename(sourceRoot), commit: gitValue(sourceRoot, ['rev-parse', 'HEAD'], 'unavailable'), sha256: copied, createdAt: new Date().toISOString() }
    fs.writeFileSync(path.join(replacement, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    readFrozenSnapshot(replacement)
    if (fs.existsSync(target)) fs.renameSync(target, backup)
    try { fs.renameSync(replacement, target) } catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, target); throw error }
    fs.rmSync(backup, { recursive: true, force: true })
    return readFrozenSnapshot(target)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export const watcherMetadata = (root, previousGeneration, state) => {
  const cache = path.join(root, '.codegraph')
  const store = new GraphStore(root)
  const generation = fs.readFileSync(path.join(cache, 'CURRENT'), 'utf8').trim()
  if (generation === previousGeneration) return { generation, status: 'validated' }
  const readManifest = (id) => JSON.parse(fs.readFileSync(path.join(cache, 'generations', `${id}.json`), 'utf8'))
  const before = readManifest(previousGeneration); const after = readManifest(generation)
  const changed = state === 'leaf' ? ['src/utils/plotSameSelectedItem.ts'] : ['src/types/index.ts']
  const importers = new Map()
  for (const [file, id] of Object.entries(before.partitions)) {
    const partition = store.readPartition(id)
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

export const captureLifecycle = async (sourceRoot, { samples = 1, withMirror = withDisposableMirror, start = startMcp, coldBuild = measureColdBuild, watcherUpdate = measureWatcherUpdate, readMetadata = watcherMetadata, progress = (phase) => process.stderr.write(`[${new Date().toISOString()}] ${phase}\n`), profile, diagnosticLog, symbol } = {}) => withMirror(sourceRoot, async (root) => {
  progress('cold index')
  const initialIndex = await coldBuild(root)
  progress('start MCP')
  const mcp = start({ root, profile, ...(diagnosticLog && { diagnosticLog }) })
  return stopAfter(mcp, async () => {
    await mcp.timed('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codegraph-performance', version: '2' } })
    const workloads = workloadsFor(symbol)
    progress(samples === 1 ? 'indexed queries' : `sample 1/${samples}: indexed queries`)
    let indexed = await runSweep(mcp, root, workloads, symbol, Boolean(diagnosticLog))
    progress('watcher readiness')
    await toolCall(mcp, root, 'codegraph_refresh', {}, 'watcher readiness')
    const captured = []
    let generation = initialIndex.generation
    for (let index = 0; index < samples; index += 1) {
      if (index) {
        progress(`sample ${index + 1}/${samples}: indexed queries`)
        indexed = await runSweep(mcp, root, workloads, symbol, Boolean(diagnosticLog))
      }
      progress(samples === 1 ? 'leaf update' : `sample ${index + 1}/${samples}: leaf update`)
      const leaf = await watcherUpdate({ root, state: 'leaf', previousGeneration: generation, phase: 'leaf incremental update', readMetadata: (target, previous) => readMetadata(target, previous, 'leaf'), afterValidated: async () => { const result = await toolCall(mcp, root, 'codegraph_refs', structuredClone(workloads[0].arguments), 'first complete refs query'); assertWorkloadReceipt(workloads[0], result.text, symbol) } })
      assertGenerationAdvanced(generation, leaf.generation)
      const leafSweep = await runSweep(mcp, root, workloads, symbol, Boolean(diagnosticLog)); assertReceiptsMatch(indexed, leafSweep)
      progress(samples === 1 ? 'cascade update' : `sample ${index + 1}/${samples}: cascade update`)
      const cascade = await watcherUpdate({ root, state: 'cascade', previousGeneration: leaf.generation, phase: 'cascade incremental update', readMetadata: (target, previous) => readMetadata(target, previous, 'cascade') })
      assertGenerationAdvanced(leaf.generation, cascade.generation); assertCascadeValidation(cascade.validatedFiles)
      const cascadeSweep = await runSweep(mcp, root, workloads, symbol, Boolean(diagnosticLog)); assertReceiptsMatch(indexed, cascadeSweep)
      generation = cascade.generation
      captured.push({ root, sourceFiles: initialIndex.parsedFiles, sweeps: { indexed, leaf: leafSweep, cascade: cascadeSweep }, updates: { leaf, cascade } })
    }
    progress('full reindex')
    const fullReindex = readUpdate(await toolCall(mcp, root, 'codegraph_index', {}, 'full reindex'))
    captured[0].updates.initialIndex = initialIndex
    captured.at(-1).updates.fullReindex = fullReindex
    return captured
  })
})

export const captureSample = async (sourceRoot, options = {}) => (await captureLifecycle(sourceRoot, { ...options, samples: 1 }))[0]

export const gitValue = (root, args, fallback) => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() || fallback : fallback }

export function assertCompleteReport(report) {
  for (const { key } of WORKLOADS) for (const state of STATES) if (!report.benchmarks?.[key]?.[state]) throw new Error(`report is missing ${key} ${state}`)
  for (const update of ['initialIndex', 'leaf', 'cascade', 'fullReindex']) if (!report.updates?.[update]) throw new Error(`report is missing ${update}`)
  for (const update of ['initialIndex', 'cascade', 'fullReindex']) {
    if (!Number.isFinite(report.updates[update].parsedFiles)) throw new Error(`${update} parsed-file count is missing`)
    if (!Number.isFinite(report.updates[update].validatedFiles)) throw new Error(`${update} validated-file count is missing`)
  }
  if (!report.correctness?.consistent) throw new Error('semantic output is not consistent; output drifted')
  if (!report.correctness?.originalRepositoryUnchanged) throw new Error('original repository is not unchanged; mutation detected')
  if (!report.correctness?.cleanShutdown) throw new Error('MCP shutdown was not clean')
  return report
}

export async function captureReport(options, { snapshot = resolvePerformanceSnapshot, capture = captureLifecycle, lock } = {}) {
  if (!fs.statSync(options.root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`repository root is not a directory: ${options.root}`)
  const sourceRoot = path.resolve(options.root)
  const guard = lock ?? (snapshot === resolvePerformanceSnapshot ? withSnapshotLock : async (_root, operation) => operation())
  return guard(sourceRoot, async () => {
    const frozen = await snapshot(sourceRoot, { refresh: options.refreshSnapshot === true })
    const snapshotRoot = typeof frozen === 'string' ? frozen : frozen.root
    if (typeof frozen !== 'string') validateFixtures(snapshotRoot)
    const samples = []
    for (let index = 0; index < options.samples; index += 1) {
      const lifecycle = await capture(snapshotRoot, { samples: 1, profile: options.profile, diagnosticLog: options.diagnosticLog, symbol: options.symbol })
      if (!Array.isArray(lifecycle) || lifecycle.length !== 1) throw new Error(`benchmark lifecycle returned ${lifecycle?.length ?? 0} samples; expected 1`)
      samples.push(lifecycle[0])
    }
    const expectedReceipts = samples[0].sweeps.indexed
    for (const sample of samples) for (const state of STATES) assertReceiptsMatch(expectedReceipts, sample.sweeps[state])
    const benchmarks = Object.fromEntries(WORKLOADS.map(({ key }) => [key, Object.fromEntries(STATES.map((state) => [state, summarizeSamples(samples.map((sample) => sample.sweeps[state][key].ms))]))]))
    const updates = {
      initialIndex: summarizeSamples(samples.map((sample) => sample.updates.initialIndex.ms)),
      leaf: summarizeSamples(samples.map((sample) => sample.updates.leaf.ms)),
      cascade: summarizeSamples(samples.map((sample) => sample.updates.cascade.ms)),
      fullReindex: summarizeSamples(samples.map((sample) => sample.updates.fullReindex.ms)),
    }
    for (const key of ['initialIndex', 'leaf', 'cascade', 'fullReindex']) {
      updates[key].parsedFiles = Math.max(...samples.map((sample) => sample.updates[key].parsedFiles))
      updates[key].validatedFiles = Math.max(...samples.map((sample) => sample.updates[key].validatedFiles))
    }
    return assertCompleteReport({ schemaVersion: 2, provenance: { root: samples[0].root, sourceRoot: frozen.manifest?.sourceRoot ?? sourceRoot, repository: path.basename(sourceRoot), sourceFiles: samples[0].sourceFiles, commit: frozen.manifest?.commit ?? gitValue(sourceRoot, ['rev-parse', 'HEAD'], 'unavailable'), snapshot: { root: snapshotRoot, sha256: frozen.manifest?.sha256 ?? sourceSnapshot(snapshotRoot), createdAt: frozen.manifest?.createdAt ?? 'injected' } }, benchmarks, updates, correctness: { consistent: true, originalRepositoryUnchanged: true, cleanShutdown: true } })
  })
}

const formatPair = ({ p50Ms, p90Ms }) => `${p50Ms.toFixed(2)} / ${p90Ms.toFixed(2)} ms`

export function renderMarkdown(report) {
  assertCompleteReport(report)
  const rows = [
    `CodeGraph was tested against the ${report.provenance.sourceFiles.toLocaleString('en-US')}-source-file D&D Community and Marketplace project, covering all query endpoints, initial indexing, leaf updates, cascade updates, and full reindexing.`,
    '', '## Metrics', '', '| Operation | Indexed | Leaf update | Cascade update |', '| :--- | ---: | ---: | ---: |',
    ...WORKLOADS.map(({ key, label }) => `| ${label} | ${formatPair(report.benchmarks[key].indexed)} | ${formatPair(report.benchmarks[key].leaf)} | ${formatPair(report.benchmarks[key].cascade)} |`),
    '', '| Update | p50 / p90 | Parsed files | Validated files |', '| :--- | ---: | ---: | ---: |',
    `| CLI cold index | ${formatPair(report.updates.initialIndex)} | ${report.updates.initialIndex.parsedFiles} | ${report.updates.initialIndex.validatedFiles} |`,
    `| Leaf incremental update | ${formatPair(report.updates.leaf)} | ${report.updates.leaf.parsedFiles} | ${report.updates.leaf.validatedFiles} |`,
    `| Cascade incremental update | ${formatPair(report.updates.cascade)} | ${report.updates.cascade.parsedFiles} | ${report.updates.cascade.validatedFiles} |`,
    `| Full reindex | ${formatPair(report.updates.fullReindex)} | ${report.updates.fullReindex.parsedFiles} | ${report.updates.fullReindex.validatedFiles} |`,
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
