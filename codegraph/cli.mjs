#!/usr/bin/env node
// Queries the prebuilt symbol graph. No type checker at query time — dense symbol ids
// index straight into CSR adjacency, so lookups are array reads.
// Rebuild with `npm run graph index` after changing source.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const argRoot = (() => {
  const i = process.argv.indexOf('--root')
  return i >= 0 ? process.argv[i + 1] : null
})()
const ROOT = path.resolve(argRoot ?? process.env.CODEGRAPH_ROOT ?? process.cwd())
if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`codegraph: "${ROOT}" is not a directory — pass --root <repo> or set CODEGRAPH_ROOT`)
  process.exit(1)
}
const OUT = path.join(ROOT, '.codegraph')

const fail = (msg) => { console.error(`codegraph: ${msg}`); process.exit(1) }
const VERBOSE = process.argv.includes('--verbose')

// A stale index is self-healing: rebuild rather than telling the caller to. The old warning went
// to stderr, which MCP clients often swallow — so the one signal that answers were untrustworthy
// was the one least likely to be seen.
const rebuild = (why) => {
  process.stderr.write(`# ${why} — rebuilding index for ${path.basename(ROOT)}…\n`)
  try {
    execFileSync(process.execPath, [path.join(import.meta.dirname, 'build.mjs'), '--root', ROOT], {
      stdio: VERBOSE ? 'inherit' : ['ignore', 'ignore', 'pipe'],
    })
  } catch (err) {
    fail(`index rebuild failed: ${err.stderr?.toString().trim() || err.message}`)
  }
}

// Why the index can't be trusted, or null when it's good.
const staleReason = () => {
  if (!fs.existsSync(path.join(OUT, 'graph.bin')) || !fs.existsSync(path.join(OUT, 'meta.json'))) return 'no index'
  let meta
  try { meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8')) } catch { return 'index unreadable' }
  if (!Array.isArray(meta.files) || typeof meta.maxMtimeMs !== 'number') return 'index format changed'
  for (const f of meta.files) {
    let m
    try { m = fs.statSync(path.join(ROOT, f)).mtimeMs } catch { return 'source file removed' }
    if (m > meta.maxMtimeMs + 1000) return 'source changed'
  }
  return null
}

function loadIndex() {
  if (!fs.existsSync(path.join(OUT, 'graph.bin'))) fail(`no index at ${OUT}`)
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'))
  const buf = fs.readFileSync(path.join(OUT, 'graph.bin'))
  const words = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

  const n = words[0]
  const m = words[1]
  let at = 2
  const slice = (len) => words.subarray(at, (at += len))
  const fwd = { offsets: slice(n + 1), target: slice(m), line: slice(m), call: slice(m) }
  const rev = { offsets: slice(n + 1), target: slice(m), line: slice(m), call: slice(m) }

  const byName = new Map()
  meta.symbols.forEach((s, id) => {
    if (!byName.has(s.name)) byName.set(s.name, [])
    byName.get(s.name).push(id)
  })
  return { meta, n, m, fwd, rev, byName }
}

// Loaded lazily: `help` and `index` must not trigger a build just by starting up.
let g = null
const ensureIndex = () => {
  const reason = staleReason()
  if (reason) rebuild(reason)
  g = loadIndex()
}
const loc = (id) => `${g.meta.files[g.meta.symbols[id].file]}:${g.meta.symbols[id].line}`
const fileOf = (id) => g.meta.files[g.meta.symbols[id].file]
const edges = (csr, id, callsOnly = false) => {
  const out = []
  for (let e = csr.offsets[id]; e < csr.offsets[id + 1]; e++) {
    if (callsOnly && !csr.call[e]) continue
    out.push([csr.target[e], csr.line[e]])
  }
  return out
}

// `name`, `file.ts:name`, or `file.ts` for every symbol declared in it.
function resolve(query) {
  if (/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(query)) {
    const fileIdx = g.meta.files.findIndex((f) => f.endsWith(query))
    if (fileIdx === -1) return []
    return g.meta.symbols.flatMap((s, id) => (s.file === fileIdx && s.kind !== 'module' ? [id] : []))
  }
  const [maybeFile, name] = query.includes(':') ? query.split(':') : [null, query]
  const ids = g.byName.get(name) ?? []
  return maybeFile ? ids.filter((id) => fileOf(id).endsWith(maybeFile)) : ids
}

function cmdRefs(query) {
  const ids = resolve(query)
  if (!ids.length) return fail(`no symbol named "${query}"`)
  for (const id of ids) {
    const sym = g.meta.symbols[id]
    const refs = edges(g.rev, id)
    const external = refs.filter(([from]) => fileOf(from) !== fileOf(id))
    console.log(`\n${sym.kind} ${sym.name}  ${loc(id)}`)
    console.log(`  ${refs.length} reference(s), ${external.length} outside its own file`)
    for (const [from, line] of refs) {
      console.log(`    ${fileOf(from)}:${line}  in ${g.meta.symbols[from].name}()`)
    }
  }
}

function cmdDeps(query) {
  const ids = resolve(query).filter((id) => ['fn', 'method', 'class'].includes(g.meta.symbols[id].kind))
  if (!ids.length) return fail(`no symbol matching "${query}"`)
  for (const id of ids) {
    const out = new Map()
    for (const [target] of edges(g.fwd, id, true)) out.set(`${g.meta.symbols[target].name}  ${loc(target)}`, true)
    if (!out.size) continue
    console.log(`\n${g.meta.symbols[id].kind} ${g.meta.symbols[id].name}  ${loc(id)} calls:`)
    for (const l of out.keys()) console.log(`    ${l}`)
  }
}

// Frontier expansion over a visited bitset: 32 symbols cleared per word, so each level
// costs one pass regardless of how many nodes it touches.
function cmdCallers(query, depth) {
  const roots = resolve(query)
  if (!roots.length) return fail(`no symbol named "${query}"`)
  const visited = new Int32Array(Math.ceil(g.n / 32))
  const seen = (id) => (visited[id >> 5] >>> (id & 31)) & 1
  const mark = (id) => { visited[id >> 5] |= 1 << (id & 31) }

  const walk = (ids, level, indent) => {
    for (const id of ids) {
      const mine = seen(id) ? ' (seen)' : ''
      console.log(`${indent}${g.meta.symbols[id].name}  ${loc(id)}${mine}`)
      if (mine || level >= depth) continue
      mark(id)
      const parents = [...new Set(edges(g.rev, id, true).map(([from]) => from))].filter((p) => p !== id)
      walk(parents, level + 1, indent + '  ')
    }
  }
  walk(roots, 0, '')
}

// Called by the framework, never by code — static resolution cannot see these, and a text
// search "confirms" they are unused. Withheld from the listing so nothing downstream can
// mistake them for deletable.
const FRAMEWORK_EXPORTS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'default', 'middleware',
  'generateMetadata', 'generateStaticParams', 'generateViewport', 'metadata', 'viewport',
  'revalidate', 'dynamic', 'dynamicParams', 'runtime', 'fetchCache', 'preferredRegion', 'maxDuration',
])

// Next.js file conventions: the framework imports these by PATH, and a default export keeps its
// function name (`export default function ApprovalsPage`), so a name check alone misses them.
const FRAMEWORK_FILES =
  /(^|\/)(page|layout|route|template|default|error|global-error|loading|not-found|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image|instrumentation|middleware)\.(ts|tsx|js|jsx)$/

function cmdDead(prefix = '', includeFramework = false) {
  const dead = []
  let withheld = 0
  g.meta.symbols.forEach((sym, id) => {
    if (!sym.exp || sym.kind === 'module') return
    if (prefix && !fileOf(id).startsWith(prefix)) return
    if (edges(g.rev, id).some(([from]) => fileOf(from) !== fileOf(id))) return
    if (FRAMEWORK_EXPORTS.has(sym.name) || FRAMEWORK_FILES.test(fileOf(id))) {
      withheld++
      if (!includeFramework) return
    }
    dead.push(`${loc(id)}  ${sym.name}`)
  })
  console.log(`${dead.length} export(s) with no reference outside their own file.`)
  if (withheld && !includeFramework) {
    console.log(`${withheld} framework-convention export(s) withheld (called by the framework, not by code).`)
  }
  console.log('NOT PROOF OF DEAD CODE. Dynamic/string-keyed access is invisible here.')
  console.log('Do NOT delete anything from this list without explicit human approval.')
  for (const l of dead.sort()) console.log(`  ${l}`)
}

const argv = process.argv.slice(2).filter((a, i, all) => a !== '--root' && all[i - 1] !== '--root')
const [cmd, arg, ...rest] = argv

if (!cmd || cmd === 'help') {
  console.log(`codegraph <command>

  index                          rebuild the graph (run after changing source)
  refs <name|file.ts:name>       every reference, type-resolved (grep, but correct)
  deps <name|file.ts>            what a symbol or file calls, in-repo only
  callers <name> [--depth N]     inverted call tree upward (default depth 3)
  dead [path/prefix]             exports with no reference outside their own file`)
  process.exit(0)
}

if (cmd === 'index') {
  // Must forward --root: build.mjs would otherwise index cwd, not the repo being queried.
  execFileSync(process.execPath, [path.join(import.meta.dirname, 'build.mjs'), '--root', ROOT], { stdio: 'inherit' })
  process.exit(0)
}

ensureIndex()
if (VERBOSE) console.error(`# ${g.n} symbols, ${g.m} edges in ${ROOT}`)

const depthFlag = rest.indexOf('--depth')
const depth = depthFlag >= 0 ? Number(rest[depthFlag + 1]) : 3

if (cmd === 'refs') cmdRefs(arg)
else if (cmd === 'deps') cmdDeps(arg)
else if (cmd === 'callers') cmdCallers(arg, depth)
else if (cmd === 'dead') cmdDead(arg, rest.includes('--include-framework'))
else fail(`unknown command "${cmd}"`)
