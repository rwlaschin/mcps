import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
