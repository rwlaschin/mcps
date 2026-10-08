import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createWrappedNode, ts } from 'ts-morph'
import { createSemanticProject, parsePartition, prepareSemanticProject } from '../parser.mjs'

test('one-file raw TypeScript program matches the complete semantic Project partition', () => {
  const root = '/private/tmp/codegraph-one-file-parity'
  const rel = 'example.ts'
  const absolute = path.join(root, rel)
  const source = 'export function caller() {\n  target()\n  target()\n}\nexport function target() { return 7 }\n'
  const sources = new Map([[rel, source]])
  const knownFiles = new Set([rel])
  const options = { allowJs: true }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    file === absolute ? ts.createSourceFile(file, source, languageVersion) : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  host.fileExists = (file) => file === absolute || fileExists(file)
  host.readFile = (file) => file === absolute ? source : readFile(file)

  const program = ts.createProgram([absolute], options, host)
  const wrapped = createWrappedNode(program.getSourceFile(absolute), { typeChecker: program.getTypeChecker(), compilerOptions: options })
  const adapter = {
    getSourceFiles: () => [wrapped],
    getSourceFile: (file) => file === absolute ? wrapped : undefined,
    getCompilerOptions: () => options,
  }
  wrapped.getProject = () => adapter
  const candidate = parsePartition(rel, source, knownFiles, prepareSemanticProject(adapter, root))
  const oracle = parsePartition(rel, source, knownFiles, prepareSemanticProject(createSemanticProject(root, sources, { skipLoadingLibFiles: true }), root))

  assert.ok(Buffer.isBuffer(candidate.internalPartition))
  assert.deepStrictEqual(candidate, oracle)
})
