import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import * as parserProfiles from '../parser-apartment-pool.mjs'
import * as semanticProfiles from '../semantic-checker-worker.mjs'

test('domain analysis: parser and semantic workers expose the same profiler derivation implementation', () => {
  assert.equal(semanticProfiles.deriveWorkerProfile, parserProfiles.deriveWorkerProfile)
})

test('combinatorial boundary: semantic worker label derives distinct CPU and heap names while preserving unrelated flags', () => {
  assert.deepEqual(
    semanticProfiles.deriveWorkerProfile([
      '--cpu-prof', '--cpu-prof-dir=/profiles/cpu', '--cpu-prof-name=main.cpuprofile',
      '--heap-prof', '--heap-prof-dir=/profiles/heap', '--heap-prof-name=main.heapprofile',
      '--stack-trace-limit=50',
    ], 'semantic'),
    {
      execArgv: [
        '--cpu-prof', '--cpu-prof-dir=/profiles/cpu', '--cpu-prof-name=main.worker-semantic.cpuprofile',
        '--heap-prof', '--heap-prof-dir=/profiles/heap', '--heap-prof-name=main.worker-semantic.heapprofile',
        '--stack-trace-limit=50',
      ],
      artifacts: {
        cpu: '/profiles/cpu/main.worker-semantic.cpuprofile',
        heap: '/profiles/heap/main.worker-semantic.heapprofile',
      },
    },
  )
})

test('equivalence partition: semantic worker derivation leaves an unprofiled parent argument list unchanged', () => {
  assert.deepEqual(
    semanticProfiles.deriveWorkerProfile(['--stack-trace-limit=50'], 'semantic'),
    { execArgv: ['--stack-trace-limit=50'], artifacts: {} },
  )
})

test('error guessing: a real profiled semantic worker cannot overwrite the parent CPU or heap artifact', (t) => {
  const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-worker-profiles-'))
  t.after(() => fs.rmSync(profiles, { recursive: true, force: true }))
  const driver = String.raw`
    const { SemanticCheckerWorker } = await import('./semantic-checker-worker.mjs')
    const worker = new SemanticCheckerWorker()
    await worker.hydrate({}).catch(() => {})
    await worker.dispose()
  `

  const result = spawnSync(process.execPath, [
    '--cpu-prof', `--cpu-prof-dir=${profiles}`, '--cpu-prof-name=main.cpuprofile',
    '--heap-prof', `--heap-prof-dir=${profiles}`, '--heap-prof-name=main.heapprofile',
    '--input-type=module', '--eval', driver,
  ], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000 })

  assert.deepEqual(
    { status: result.status, signal: result.signal, stderr: result.stderr, files: fs.readdirSync(profiles).sort() },
    {
      status: 0,
      signal: null,
      stderr: '',
      files: [
        'main.cpuprofile',
        'main.heapprofile',
        'main.worker-semantic.cpuprofile',
        'main.worker-semantic.heapprofile',
      ],
    },
  )
})
