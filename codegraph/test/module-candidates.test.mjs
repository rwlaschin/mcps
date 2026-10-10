import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { moduleCandidates } from '../module-candidates.mjs'

test('boundary value and domain analysis: a nested relative specifier yields the base eight extension and four index candidates in exact resolution order', () => {
  assert.deepEqual(moduleCandidates('src/features/nested/caller.ts', '../../shared/value'), [
    'src/shared/value',
    'src/shared/value.ts',
    'src/shared/value.tsx',
    'src/shared/value.js',
    'src/shared/value.jsx',
    'src/shared/value.mts',
    'src/shared/value.cts',
    'src/shared/value.mjs',
    'src/shared/value.cjs',
    'src/shared/value/index.ts',
    'src/shared/value/index.tsx',
    'src/shared/value/index.js',
    'src/shared/value/index.jsx',
  ])
})

test('architecture contract: parser resolver and TypeScript analyzer import the single module candidate owner', () => {
  const parser = fs.readFileSync(path.join(import.meta.dirname, '..', 'parser.mjs'), 'utf8')
  const resolver = fs.readFileSync(path.join(import.meta.dirname, '..', 'incremental-resolver.mjs'), 'utf8')
  const bindings = fs.readFileSync(path.join(import.meta.dirname, '..', 'cached-binding-resolver.mjs'), 'utf8')
  const analyzer = fs.readFileSync(path.join(import.meta.dirname, '..', 'typescript-language-analyzer.mjs'), 'utf8')

  assert.deepEqual(
    {
      parserImportsOwner: /from ['"]\.\/module-candidates\.mjs['"]/.test(parser),
      resolverImportsOwner: /from ['"]\.\/cached-binding-resolver\.mjs['"]/.test(resolver) && /from ['"]\.\/module-candidates\.mjs['"]/.test(bindings),
      analyzerImportsOwner: /from ['"]\.\/module-candidates\.mjs['"]/.test(analyzer),
      duplicateCandidateExtensionLists: [parser, resolver, analyzer, bindings].filter((source) => /\['\.ts', '\.tsx', '\.js', '\.jsx', '\.mts', '\.cts', '\.mjs', '\.cjs'\]/.test(source)).length,
      duplicateIndexCandidateLists: [parser, resolver, analyzer, bindings].filter((source) => /\['\/index\.ts', '\/index\.tsx', '\/index\.js', '\/index\.jsx'\]/.test(source)).length,
    },
    {
      parserImportsOwner: true,
      resolverImportsOwner: true,
      analyzerImportsOwner: true,
      duplicateCandidateExtensionLists: 0,
      duplicateIndexCandidateLists: 0,
    },
  )
})
