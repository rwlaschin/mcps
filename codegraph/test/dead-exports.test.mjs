// Regression cover for the CLI/MCP dead-export divergence: codegraph_dead advertised
// withholding framework-convention exports but only cli.mjs implemented it, and the MCP
// path filtered on ANY incoming edge instead of a cross-file one.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isFrameworkExport, FRAMEWORK_EXPORTS, FRAMEWORK_FILES } from '../framework-exports.mjs'

const PACKAGE = path.resolve(import.meta.dirname, '..')
const temporaryRoots = new Set()

test.after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryRoots.add(root)
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext' }, include: ['src'] }))
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
  const indexed = spawnSync(process.execPath, ['cli.mjs', 'index', '--root', root], { cwd: PACKAGE, encoding: 'utf8' })
  assert.equal(indexed.status, 0, `index failed: ${indexed.stderr}`)
  // Prime the mapped view codegraph_dead reads. Unprimed, the first MCP read has to build the
  // complete-coverage graph, and stdin's end disposes the engine mid-flight.
  const primed = spawnSync(process.execPath, ['tool.mjs', 'query', JSON.stringify({ type: 'graph', edgeCoverage: 'complete', limit: 200 }), '--root', root], { cwd: PACKAGE, encoding: 'utf8' })
  assert.equal(primed.status, 0, `prime failed: ${primed.stderr}`)
  return root
}

function callDead(root, args = {}) {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_dead', arguments: { root, ...args } } }) + '\n'
  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: PACKAGE, encoding: 'utf8', input: request, timeout: 30_000 })
  assert.equal(result.status, 0, `mcp.mjs exited ${result.status}: ${result.stderr}`)
  const response = JSON.parse(result.stdout.trim())
  assert.equal(response.result?.isError, undefined, `tool errored: ${response.result?.content?.[0]?.text ?? JSON.stringify(response)}`)
  return response.result.content[0].text
}

test('shared framework-export policy matches by export name and by Next.js path convention', () => {
  assert.deepEqual(
    {
      byName: isFrameworkExport('GET', 'src/lib/handlers.ts'),
      byPath: isFrameworkExport('ApprovalsPage', 'src/app/approvals/page.tsx'),
      byPathNested: isFrameworkExport('anything', 'src/app/(group)/[id]/layout.js'),
      ordinary: isFrameworkExport('formatCurrency', 'src/lib/money.ts'),
      ordinaryInNormalFile: isFrameworkExport('helper', 'src/app/approvals/helpers.ts'),
      nameCount: FRAMEWORK_EXPORTS.size,
      regexIsGlobalFree: FRAMEWORK_FILES.global,
    },
    { byName: true, byPath: true, byPathNested: true, ordinary: false, ordinaryInNormalFile: false, nameCount: 21, regexIsGlobalFree: false },
  )
})

test('codegraph_dead schema advertises the framework toggle it implements', () => {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: PACKAGE, encoding: 'utf8', input: request, timeout: 15_000 })
  const tool = JSON.parse(result.stdout.trim()).result.tools.find((entry) => entry.name === 'codegraph_dead')

  assert.deepEqual(
    {
      status: result.status,
      hasIncludeFramework: tool.inputSchema.properties.includeFramework?.type,
      hasPrefix: tool.inputSchema.properties.prefix?.type,
      claimsWithholding: /Framework-convention exports are withheld/.test(tool.description),
      documentsToggle: /includeFramework/.test(tool.description),
    },
    { status: 0, hasIncludeFramework: 'boolean', hasPrefix: 'string', claimsWithholding: true, documentsToggle: true },
  )
})

test('codegraph_dead withholds framework-convention exports by default and lists them on request', () => {
  const root = fixture('cg-dead-framework-', {
    'src/app/approvals/page.tsx': 'export default function ApprovalsPage() { return null }\n',
    'src/app/api/things/route.ts': 'export function GET() { return new Response("ok") }\n',
    'src/lib/orphan.ts': 'export function trulyUnreferenced() { return 1 }\n',
  })

  const withheldByDefault = callDead(root)
  const listedOnRequest = callDead(root, { includeFramework: true })

  assert.deepEqual(
    {
      defaultListsOrphan: withheldByDefault.includes('trulyUnreferenced'),
      defaultHidesPage: withheldByDefault.includes('ApprovalsPage'),
      defaultHidesRoute: /\bGET\b/.test(withheldByDefault.split('\n').slice(4).join('\n')),
      defaultReportsWithheldCount: /2 framework-convention export\(s\) withheld/.test(withheldByDefault),
      includeListsPage: listedOnRequest.includes('ApprovalsPage'),
      includeSuppressesWithheldNote: /framework-convention export\(s\) withheld/.test(listedOnRequest),
      carriesNotProofWarning: withheldByDefault.includes('NOT PROOF OF DEAD CODE'),
      carriesNoDeleteWarning: withheldByDefault.includes('Do NOT delete anything from this list'),
    },
    {
      defaultListsOrphan: true,
      defaultHidesPage: false,
      defaultHidesRoute: false,
      defaultReportsWithheldCount: true,
      includeListsPage: true,
      includeSuppressesWithheldNote: false,
      carriesNotProofWarning: true,
      carriesNoDeleteWarning: true,
    },
  )
})

test('codegraph_dead counts deadness across files, so a same-file-only reference stays listed', () => {
  const root = fixture('cg-dead-samefile-', {
    // usedInternally is referenced only by a sibling in its OWN file: still dead to the outside.
    'src/lib/internal.ts': 'export function usedInternally() { return 1 }\nexport function localCaller() { return usedInternally() }\n',
    'src/lib/exported.ts': 'export function crossFileTarget() { return 2 }\n',
    'src/lib/consumer.ts': 'import { crossFileTarget } from "./exported"\nexport function consume() { return crossFileTarget() }\n',
  })

  const output = callDead(root)

  assert.deepEqual(
    {
      sameFileOnlyStaysListed: output.includes('usedInternally'),
      crossFileReferencedIsExcluded: output.includes('crossFileTarget'),
      headlineWordsItAsCrossFile: /export\(s\) with no reference outside their own file/.test(output),
    },
    { sameFileOnlyStaysListed: true, crossFileReferencedIsExcluded: false, headlineWordsItAsCrossFile: true },
  )
})

test('codegraph_dead prefix scoping still applies alongside framework withholding', () => {
  const root = fixture('cg-dead-prefix-', {
    'src/keep/orphan.ts': 'export function insideScope() { return 1 }\n',
    'src/other/orphan.ts': 'export function outsideScope() { return 2 }\n',
  })

  const output = callDead(root, { prefix: 'src/keep' })

  assert.deepEqual(
    { listsInScope: output.includes('insideScope'), excludesOutOfScope: output.includes('outsideScope') },
    { listsInScope: true, excludesOutOfScope: false },
  )
})

test('mcp.mjs starts and answers without cli.mjs present on disk', () => {
  // The old startup guard exited 1 when cli.mjs was missing, though no tool shelled out to it.
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dead-nocli-'))
  temporaryRoots.add(staged)
  for (const entry of fs.readdirSync(PACKAGE)) {
    if (entry === 'cli.mjs' || entry === '.git') continue
    fs.cpSync(path.join(PACKAGE, entry), path.join(staged, entry), { recursive: true, verbatimSymlinks: true })
  }

  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
  const result = spawnSync(process.execPath, ['mcp.mjs'], { cwd: staged, encoding: 'utf8', input: request, timeout: 15_000 })

  assert.deepEqual(
    {
      cliAbsent: fs.existsSync(path.join(staged, 'cli.mjs')),
      status: result.status,
      listedDead: JSON.parse(result.stdout.trim()).result.tools.some((entry) => entry.name === 'codegraph_dead'),
    },
    { cliAbsent: false, status: 0, listedDead: true },
  )
})
