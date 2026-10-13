import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const failureFixtures = path.resolve(import.meta.dirname, '../test/fixtures/go-language-analyzer')
const loadGoAnalyzer = () => import('../go-language-analyzer.mjs')
const oneSource = [['main.go', 'package main\nfunc main() {}\n']]
const manySources = [['main.go', 'package main\nfunc main() { helper() }\n'], ['helper.go', 'package main\nfunc helper() {}\n'], ['value.go', 'package main\nconst value = 1\n']]

test('dependency contract: one zero-transitive runtime and one vendored Go grammar are pinned', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  assert.deepEqual(
    {
      runtime: packageJson.dependencies?.['web-tree-sitter'],
      runtimeTransitiveDependencies: packageLock.packages?.['node_modules/web-tree-sitter']?.dependencies ?? {},
      allLanguagePackageInstalled: packageJson.dependencies?.['tree-sitter-wasm'] ?? null,
      grammar: packageJson.codegraph?.goGrammar,
    },
    {
      runtime: '0.27.0',
      runtimeTransitiveDependencies: {},
      allLanguagePackageInstalled: null,
      grammar: { path: 'vendor/tree-sitter-go.wasm', provenance: 'tree-sitter-wasm', version: '1.1.8', sha256: packageJson.codegraph?.goGrammar?.sha256 },
    },
  )
  assert.match(import.meta.resolve('web-tree-sitter'), /^file:/)
  assert.match(packageJson.codegraph.goGrammar.sha256, /^[a-f0-9]{64}$/)
  const grammar = fs.readFileSync(path.join(projectRoot, packageJson.codegraph.goGrammar.path))
  assert.equal(crypto.createHash('sha256').update(grammar).digest('hex'), packageJson.codegraph.goGrammar.sha256)
})

test('boundary analysis: zero sources leave the packaged Go parser uninitialized', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  assert.deepEqual(worker.runtimeState(), { initialized: false, parserCount: 0, disposed: false })
  await worker.dispose()
})

test('boundary analysis: one Go source initializes one in-process WASM parser', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  await worker.index({ root: projectRoot, sources: oneSource, sourceBlobs: {} })
  assert.deepEqual(worker.runtimeState(), { initialized: true, parserCount: 1, disposed: false })
  await worker.dispose()
})

test('boundary analysis: many Go sources reuse one in-process WASM parser', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  await worker.index({ root: projectRoot, sources: manySources, sourceBlobs: {} })
  assert.deepEqual(worker.runtimeState(), { initialized: true, parserCount: 1, disposed: false })
  await worker.dispose()
})

test('domain analysis: repeated parsing reuses the same packaged WASM parser', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  await worker.index({ root: projectRoot, sources: oneSource, sourceBlobs: {} })
  await worker.index({ root: projectRoot, sources: manySources, sourceBlobs: {} })
  assert.deepEqual(worker.runtimeState(), { initialized: true, parserCount: 1, disposed: false })
  await worker.dispose()
})

test('domain analysis: dispose releases the initialized WASM parser exactly once', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  await worker.index({ root: projectRoot, sources: oneSource, sourceBlobs: {} })
  await worker.dispose()
  await worker.dispose()
  assert.deepEqual(worker.runtimeState(), { initialized: false, parserCount: 0, disposed: true })
})

test('error guessing: parsing after dispose rejects without recreating the parser', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  await worker.dispose()
  await assert.rejects(worker.index({ root: projectRoot, sources: oneSource, sourceBlobs: {} }), /disposed|closed/i)
  assert.deepEqual(worker.runtimeState(), { initialized: false, parserCount: 0, disposed: true })
})

const failedPublication = async (option, asset, expected) => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-runtime-failure-'))
  fs.mkdirSync(path.join(root, '.codegraph'))
  fs.writeFileSync(path.join(root, '.codegraph', 'CURRENT'), 'generation-before\n')
  let publications = 0
  const worker = createGoLanguageAnalyzer(root, { [option]: asset, publish: () => { publications += 1 } }).createSemanticWorker()
  await assert.rejects(worker.index({ root, sources: oneSource, sourceBlobs: {} }), expected)
  assert.deepEqual({ publications, current: fs.readFileSync(path.join(root, '.codegraph', 'CURRENT'), 'utf8') }, { publications: 0, current: 'generation-before\n' })
}

test('error guessing: missing runtime WASM fails before publication and preserves CURRENT', async () => {
  await failedPublication('runtimeAsset', path.join(failureFixtures, 'missing-runtime.wasm'), /runtime.*(?:missing|ENOENT)|ENOENT.*runtime/i)
})

test('error guessing: corrupt grammar WASM fails before publication and preserves CURRENT', async () => {
  await failedPublication('grammarAsset', path.join(failureFixtures, 'corrupt-go.wasm'), /grammar.*(?:corrupt|invalid|WASM)|WASM.*grammar/i)
})

test('error guessing: mismatched grammar identity fails before publication and preserves CURRENT', async () => {
  await failedPublication('grammarAsset', path.join(failureFixtures, 'mismatched-language.wasm'), /grammar.*(?:mismatch|language|version)|mismatch.*grammar/i)
})

test('architecture contract: Go runtime has no network process toolchain native helper download or compilation path', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'go-language-analyzer.mjs'), 'utf8')
  // RegExp.exec is local parsing; child-process imports and bare exec remain forbidden.
  assert.deepEqual({ network: /\bfetch\s*\(|https?\.|node:(?:http|https|net|tls|dgram)/.test(source), process: /node:child_process|\b(?:spawn|fork)\s*\(|(?<![\w.])exec\s*\(/.test(source), toolchain: /\bgo\s+(?:run|build|install|env|list)\b/.test(source), native: /node-gyp|\.node['"]|native helper/i.test(source), download: /download|curl|wget|npm install/i.test(source), compile: /compileStreaming|WebAssembly\.compile|build.*wasm/i.test(source) }, { network: false, process: false, toolchain: false, native: false, download: false, compile: false })
})

test('error guessing: parsing performs zero network calls', async () => {
  const { createGoLanguageAnalyzer } = await loadGoAnalyzer()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('network access attempted') }
  const worker = createGoLanguageAnalyzer(projectRoot).createSemanticWorker()
  try {
    await worker.index({ root: projectRoot, sources: oneSource, sourceBlobs: {} })
    assert.equal(calls, 0)
  } finally {
    await worker.dispose()
    globalThis.fetch = originalFetch
  }
})
