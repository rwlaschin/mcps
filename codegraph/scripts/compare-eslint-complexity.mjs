#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { GraphStore, openInternalPartition } from '../store.mjs'

export const parseEslintComplexityMessage = (message) => {
  const value = message.match(/ has a complexity of (\d+)/)
  if (!value) return null
  const quoted = message.match(/'([^']+)'/)
  const privateName = message.match(/\b(?:method|getter|setter)\s+(#[^\s]+)/i)
  return { name: quoted?.[1] ?? privateName?.[1] ?? (/^Constructor\b/.test(message) ? 'constructor' : '<anonymous>'), complexity: Number(value[1]) }
}

async function main() {
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => value.startsWith('--') ? [...pairs, [value.slice(2), values[index + 1]]] : pairs, []))
const root = path.resolve(args.root ?? process.cwd())
const output = path.resolve(args.output ?? path.join(process.cwd(), 'eslint-complexity-comparison.json'))
const eslintApi = path.join(root, 'node_modules/eslint/lib/api.js')
if (!fs.existsSync(eslintApi)) throw new Error(`ESLint is not installed in ${root}`)
if (args.build !== '0') {
  const result = spawnSync(process.execPath, [path.resolve('tool.mjs'), 'build', '--root', root], { cwd: path.resolve('.'), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`CodeGraph build failed (${result.status}): ${result.stderr}`)
}

const store = new GraphStore(root)
const manifest = store.readGeneration()
const codegraph = []
for (const [file, partitionId] of Object.entries(manifest.internalPartitions ?? {})) {
  const view = openInternalPartition(store.readInternalPartition(partitionId))
  for (const owner of view.owners()) if (owner.kind !== 'module') codegraph.push({ file, line: owner.line, column: owner.column, start: owner.start, end: owner.end, name: owner.name, kind: owner.kind, complexity: owner.cyclomatic })
}

const { ESLint } = await import(pathToFileURL(eslintApi))
const eslint = new ESLint({ cwd: root, overrideConfig: { rules: { complexity: ['error', { max: 0, variant: 'classic' }] } } })
const eslintRows = []
for (const result of await eslint.lintFiles(['.'])) for (const message of result.messages) if (message.ruleId === 'complexity') {
  const parsed = parseEslintComplexityMessage(message.message)
  if (parsed) eslintRows.push({ file: path.relative(root, result.filePath).split(path.sep).join('/'), line: message.line, column: message.column, eslintKind: message.message, ...parsed })
}

const matched = []; const eslintOnly = []; const used = new Set()
for (const other of eslintRows) {
  const sameLine = codegraph.map((row, index) => ({ row, index })).filter(({ row, index }) => !used.has(index) && row.file === other.file && row.line === other.line)
  const label = other.eslintKind.toLowerCase()
  const acceptedKinds = label.includes('class field initializer') ? new Set(['field-initializer']) : label.includes('static block') ? new Set(['static-block']) : label.includes('constructor') ? new Set(['constructor']) : label.includes('method') || label.includes('getter') || label.includes('setter') ? new Set(['method', 'getter', 'setter']) : label.includes('arrow function') ? new Set(['arrow']) : new Set(['function'])
  let candidates = sameLine.filter(({ row }) => row.column === other.column)
  let matchBasis = 'file-line-column'
  if (!candidates.length) { candidates = sameLine.filter(({ row }) => acceptedKinds.has(row.kind)); matchBasis = 'file-line-kind' }
  candidates.sort((a, b) => Number(other.name !== '<anonymous>' && b.row.name === other.name) - Number(other.name !== '<anonymous>' && a.row.name === other.name) || Math.abs(a.row.column - other.column) - Math.abs(b.row.column - other.column))
  const selected = candidates[0]; const row = selected?.row
  if (!row) eslintOnly.push(other); else {
    used.add(selected.index)
    matched.push({ ...row, eslintComplexity: other.complexity, delta: row.complexity - other.complexity, matchBasis })
  }
}
const codegraphOnly = codegraph.filter((_, index) => !used.has(index))
const mismatched = matched.filter(({ delta }) => delta !== 0).map((row) => {
  const source = fs.readFileSync(path.join(root, row.file), 'utf8').slice(row.start, row.end)
  const classification = row.delta > 0 && /\btry\b/.test(source) ? 'cfg-exception-flow' : row.delta > 0 ? 'cfg-abrupt-or-component-flow' : 'unexplained-cfg-traversal-gap'
  return { ...row, classification, sourceExample: source.replace(/\s+/g, ' ').slice(0, 240) }
})
const deltaCounts = Object.fromEntries([...new Set(mismatched.map(({ delta }) => delta))].sort((a, b) => a - b).map((delta) => [delta, mismatched.filter((row) => row.delta === delta).length]))
const classificationCounts = Object.fromEntries([...new Set(mismatched.map(({ classification }) => classification))].sort().map((classification) => [classification, mismatched.filter((row) => row.classification === classification).length]))
const eslintVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/eslint/package.json'), 'utf8')).version
const report = { root, generation: manifest.generation, eslintVersion, profileNote: 'CodeGraph cyclomatic is compared with ESLint classic. Every mismatch and unmatched executable blocks completion.', counts: { codegraph: codegraph.length, eslint: eslintRows.length, matched: matched.length, equal: matched.length - mismatched.length, mismatched: mismatched.length, codegraphOnly: codegraphOnly.length, eslintOnly: eslintOnly.length }, deltaCounts, classificationCounts, mismatches: mismatched, examples: { mismatched: mismatched.slice(0, 25), codegraphOnly: codegraphOnly.slice(0, 25), eslintOnly: eslintOnly.slice(0, 25) } }
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report.counts)}\n${output}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
