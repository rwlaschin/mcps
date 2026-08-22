import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Minimatch } from 'minimatch'
import { createSourcePolicy } from '../source-policy.mjs'

test('scan and watcher share source policy and prune ignored/symlink trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'bad'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'ok.ts'), 'export const ok = 1')
  fs.writeFileSync(path.join(root, 'node_modules', 'bad', 'no.ts'), 'export const no = 1')
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'linked'), 'dir')
  const policy = createSourcePolicy(root)
  assert.deepEqual(policy.scan(), ['src/ok.ts'])
  assert.equal(policy.acceptWatchPath(path.join(root, 'src', 'ok.ts')), true)
  assert.equal(policy.acceptWatchPath(path.join(root, 'node_modules', 'bad', 'no.ts')), false)
  assert.equal(policy.acceptWatchPath(path.join(root, 'linked', 'ok.ts')), false)
})

test('gitignore and codegraphignore patterns apply equally to scans and watcher paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ignore-files-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src', 'generated'] }))
  fs.writeFileSync(path.join(root, '.gitignore'), 'src/git-ignored.ts\n')
  fs.writeFileSync(path.join(root, '.codegraphignore'), 'generated/\n!generated/kept.ts\n')
  fs.writeFileSync(path.join(root, 'src', 'kept.ts'), 'export const kept = 1')
  fs.writeFileSync(path.join(root, 'src', 'git-ignored.ts'), 'export const ignored = 1')
  fs.writeFileSync(path.join(root, 'generated', 'dropped.ts'), 'export const dropped = 1')
  fs.writeFileSync(path.join(root, 'generated', 'kept.ts'), 'export const restored = 1')
  const policy = createSourcePolicy(root)

  assert.deepEqual(policy.scan(), ['generated/kept.ts', 'src/kept.ts'])
  assert.equal(policy.acceptWatchPath(path.join(root, 'src', 'git-ignored.ts')), false)
  assert.equal(policy.acceptWatchPath(path.join(root, 'generated', 'dropped.ts')), false)
  assert.equal(policy.acceptWatchPath(path.join(root, 'generated', 'kept.ts')), true)
})

test('mandatory dependency directories cannot be re-included by ignore negation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mandatory-ignore-'))
  fs.mkdirSync(path.join(root, 'node_modules', 'package'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraphignore'), '!node_modules/package/index.ts\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'package', 'index.ts'), 'export const dependency = 1')
  const policy = createSourcePolicy(root)

  assert.deepEqual(policy.scan(), [])
  assert.equal(policy.acceptWatchPath(path.join(root, 'node_modules', 'package', 'index.ts')), false)
})

test('equivalence partition: watcher policy accepts each root control file without adding it to source scans', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-controls-'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  fs.writeFileSync(path.join(root, 'jsconfig.json'), '{}')
  fs.writeFileSync(path.join(root, '.gitignore'), '')
  fs.writeFileSync(path.join(root, '.codegraphignore'), '')
  const policy = createSourcePolicy(root)

  assert.deepEqual(
    { tsconfig: policy.acceptWatchPath(path.join(root, 'tsconfig.json')), jsconfig: policy.acceptWatchPath(path.join(root, 'jsconfig.json')), gitignore: policy.acceptWatchPath(path.join(root, '.gitignore')), codegraphignore: policy.acceptWatchPath(path.join(root, '.codegraphignore')), scan: policy.scan() },
    { tsconfig: true, jsconfig: true, gitignore: true, codegraphignore: true, scan: [] },
  )
})

test('reuses compiled include exclude and ordered ignore globs across scans and watcher checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-compiled-globs-'))
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'], exclude: ['dist'] }))
  fs.writeFileSync(path.join(root, '.gitignore'), 'src/generated/**\n')
  fs.writeFileSync(path.join(root, '.codegraphignore'), '!src/generated/kept.ts\n')
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const main = 1')
  fs.writeFileSync(path.join(root, 'src', 'generated', 'dropped.ts'), 'export const dropped = 1')
  fs.writeFileSync(path.join(root, 'src', 'generated', 'kept.ts'), 'export const kept = 1')
  fs.writeFileSync(path.join(root, 'dist', 'bundle.ts'), 'export const bundle = 1')

  const originalMake = Minimatch.prototype.make
  let compilations = 0
  Minimatch.prototype.make = function (...args) {
    compilations += 1
    return originalMake.apply(this, args)
  }

  try {
    const policy = createSourcePolicy(root)
    const compilationsAfterCreation = compilations
    const firstScan = policy.scan()
    const firstWatch = policy.acceptWatchPath(path.join(root, 'src', 'generated', 'kept.ts'))
    const compilationsAfterFirstChecks = compilations
    const secondScan = policy.scan()
    const secondWatch = policy.acceptWatchPath(path.join(root, 'src', 'generated', 'dropped.ts'))

    assert.deepEqual(
      { compilationsAfterCreation, compilationsAfterFirstChecks, compilationsAfterRepeatedChecks: compilations, firstScan, secondScan, firstWatch, secondWatch },
      { compilationsAfterCreation: 5, compilationsAfterFirstChecks: 5, compilationsAfterRepeatedChecks: 5, firstScan: ['src/generated/kept.ts', 'src/main.ts'], secondScan: ['src/generated/kept.ts', 'src/main.ts'], firstWatch: true, secondWatch: false },
    )
  } finally {
    Minimatch.prototype.make = originalMake
  }
})

test('error guessing: scan carries nested relative paths without path.relative while preserving negation and symlink pruning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-relative-scan-'))
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
  fs.writeFileSync(path.join(root, '.codegraphignore'), 'src/generated/**\n!src/generated/kept.ts\n')
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const main = 1')
  fs.writeFileSync(path.join(root, 'src', 'generated', 'dropped.ts'), 'export const dropped = 1')
  fs.writeFileSync(path.join(root, 'src', 'generated', 'kept.ts'), 'export const kept = 1')
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'linked'), 'dir')
  const policy = createSourcePolicy(root)
  const originalRelative = path.relative
  let relativeCalls = 0
  path.relative = (...args) => {
    relativeCalls += 1
    return originalRelative(...args)
  }

  try {
    assert.deepEqual(
      { files: policy.scan(), relativeCalls },
      { files: ['src/generated/kept.ts', 'src/main.ts'], relativeCalls: 0 },
    )
  } finally {
    path.relative = originalRelative
  }
})

test('allocation regression: source-policy hot traversals avoid callback and iterator loops', () => {
  const source = fs.readFileSync(new URL('../source-policy.mjs', import.meta.url), 'utf8')

  assert.deepEqual(
    {
      callbackMatchers: /(?:excludeMatchers|includeMatchers|segments\(rel\))\.some\(/.test(source),
      iteratorMatchers: /for \(const \{ negated, matcher \} of ignoreMatchers\)/.test(source),
      iteratorEntries: /for \(const entry of fs\.readdirSync\(/.test(source),
    },
    { callbackMatchers: false, iteratorMatchers: false, iteratorEntries: false },
  )
})

test('performance regression: scan evaluates ignore rules once per visited entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-single-ignore-pass-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codegraphignore'), 'src/dropped.ts\n')
  fs.writeFileSync(path.join(root, 'src', 'kept.ts'), 'export const kept = 1')
  fs.writeFileSync(path.join(root, 'src', 'dropped.ts'), 'export const dropped = 1')
  fs.writeFileSync(path.join(root, 'src', 'notes.txt'), 'not source code')
  const policy = createSourcePolicy(root)
  const originalMatch = Minimatch.prototype.match
  let matches = 0
  Minimatch.prototype.match = function (...args) {
    if (typeof args[0] === 'string') matches += 1
    return originalMatch.apply(this, args)
  }

  try {
    assert.deepEqual(
      { files: policy.scan(), ignoreMatcherCalls: matches },
      { files: ['src/kept.ts'], ignoreMatcherCalls: 5 },
    )
  } finally {
    Minimatch.prototype.match = originalMatch
  }
})

test('equivalence partition: public source checks still evaluate the complete ignore policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-public-ignore-'))
  fs.writeFileSync(path.join(root, '.codegraphignore'), 'blocked.ts\n')
  const policy = createSourcePolicy(root)
  const originalMatch = Minimatch.prototype.match
  let matches = 0
  Minimatch.prototype.match = function (...args) {
    if (typeof args[0] === 'string') matches += 1
    return originalMatch.apply(this, args)
  }

  try {
    assert.deepEqual(
      { accepted: policy.isSourceRelative('blocked.ts'), ignoreMatcherCalls: matches },
      { accepted: false, ignoreMatcherCalls: 1 },
    )
  } finally {
    Minimatch.prototype.match = originalMatch
  }
})

test('domain analysis: watcher checks still evaluate the complete ignore policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-watcher-ignore-'))
  fs.writeFileSync(path.join(root, '.codegraphignore'), 'blocked.ts\n')
  fs.writeFileSync(path.join(root, 'blocked.ts'), 'export const blocked = 1')
  const policy = createSourcePolicy(root)
  const originalMatch = Minimatch.prototype.match
  let matches = 0
  Minimatch.prototype.match = function (...args) {
    if (typeof args[0] === 'string') matches += 1
    return originalMatch.apply(this, args)
  }

  try {
    assert.deepEqual(
      { accepted: policy.acceptWatchPath(path.join(root, 'blocked.ts')), ignoreMatcherCalls: matches },
      { accepted: false, ignoreMatcherCalls: 1 },
    )
  } finally {
    Minimatch.prototype.match = originalMatch
  }
})
