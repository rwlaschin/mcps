#!/usr/bin/env node
// Builds the symbol graph once and serializes it. Queries then need no type checker.
// Symbols get dense ids 0..N-1, so adjacency is direct-addressed (no hashing at query time).
import { Project, Node, SyntaxKind } from 'ts-morph'
import fs from 'node:fs'
import path from 'node:path'

const argRoot = (() => {
  const i = process.argv.indexOf('--root')
  return i >= 0 ? process.argv[i + 1] : null
})()
const ROOT = path.resolve(argRoot ?? process.env.CODEGRAPH_ROOT ?? process.cwd())
if (!fs.existsSync(path.join(ROOT, 'tsconfig.json'))) {
  console.error(`codegraph: no tsconfig.json in ${ROOT} — pass --root <repo> or set CODEGRAPH_ROOT`)
  process.exit(1)
}
const OUT = path.join(ROOT, '.codegraph')
const GLOBS = [
  'app/**/*.{ts,tsx}',
  'lib/**/*.{ts,tsx}',
  'src/**/*.{ts,tsx}',
  'tests/**/*.{ts,tsx}',
  'e2e/**/*.{ts,tsx}',
  'middleware.ts',
]

const DECL_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
]

const t = () => Number(process.hrtime.bigint() / 1000000n)
const step = (label, a) => console.log(`  ${label.padEnd(24)} ${String(t() - a).padStart(7)}ms`)

function kindOf(node) {
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer()
    return init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) ? 'fn' : 'var'
  }
  return { FunctionDeclaration: 'fn', MethodDeclaration: 'method', ClassDeclaration: 'class',
    InterfaceDeclaration: 'interface', TypeAliasDeclaration: 'type', EnumDeclaration: 'enum' }[node.getKindName()] ?? 'symbol'
}

let a = t()
const project = new Project({
  tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
})
project.addSourceFilesAtPaths(GLOBS.map((g) => path.join(ROOT, g)))
const sourceFiles = project.getSourceFiles()
step(`parse ${sourceFiles.length} files`, a)

// Each file gets a module pseudo-symbol so top-level references have a real source id.
a = t()
const files = []
const symbols = []
const declToId = new Map()
const moduleId = new Map()

for (const file of sourceFiles) {
  const relPath = path.relative(ROOT, file.getFilePath())
  const fileIdx = files.push(relPath) - 1
  moduleId.set(file, symbols.push({ name: '<module>', file: fileIdx, line: 1, kind: 'module', exp: 0 }) - 1)

  const exported = new Set()
  for (const decls of file.getExportedDeclarations().values()) {
    for (const decl of decls) if (decl.getSourceFile() === file) exported.add(decl)
  }

  for (const kind of DECL_KINDS) {
    for (const node of file.getDescendantsOfKind(kind)) {
      const name = node.getName?.()
      if (!name) continue
      declToId.set(node, symbols.push({
        name, file: fileIdx, line: node.getStartLineNumber(), kind: kindOf(node),
        exp: exported.has(node) ? 1 : 0,
      }) - 1)
    }
  }
}
step(`index ${symbols.length} symbols`, a)

// Attribute a reference to the nearest enclosing FUNCTION, not the nearest declaration —
// `const res = await acceptInvitation()` should credit the function, not the variable `res`.
const CALLABLE = ['fn', 'method', 'class']
const enclosingId = (node) => {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    const id = declToId.get(cur)
    if (id !== undefined && CALLABLE.includes(symbols[id].kind)) return id
  }
  return moduleId.get(node.getSourceFile())
}

// Is this identifier the callee of a call expression? Separates `deps` (calls) from the
// full reference set (imports, type positions) that `refs` reports.
const isCallee = (ident) => {
  const parent = ident.getParent()
  if (Node.isCallExpression(parent)) return parent.getExpression() === ident
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ident) {
    const grand = parent.getParent()
    return Node.isCallExpression(grand) && grand.getExpression() === parent
  }
  return false
}

// One pass over every identifier: resolve to its declaration, emit an edge from whatever
// declaration encloses the reference. Cheaper than findReferences() per symbol.
a = t()
const from = []
const to = []
const line = []
const call = []
for (const file of sourceFiles) {
  for (const ident of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    let symbol = ident.getSymbol()
    if (!symbol) continue
    try { symbol = symbol.getAliasedSymbol() ?? symbol } catch {}
    let target
    for (const decl of symbol.getDeclarations()) {
      target = declToId.get(decl)
      if (target !== undefined) break
    }
    if (target === undefined) continue
    const source = enclosingId(ident)
    if (source === target) continue
    from.push(source)
    to.push(target)
    line.push(ident.getStartLineNumber())
    call.push(isCallee(ident) ? 1 : 0)
  }
}
step(`resolve ${from.length} edges`, a)

// CSR in both directions: forward answers "what does X use", reverse answers "what references X".
function csr(sources, targets, lines, calls, n) {
  const offsets = new Int32Array(n + 1)
  for (const s of sources) offsets[s + 1]++
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i]
  const cursor = Int32Array.from(offsets)
  const outTarget = new Int32Array(targets.length)
  const outLine = new Int32Array(lines.length)
  const outCall = new Int32Array(calls.length)
  for (let e = 0; e < sources.length; e++) {
    const slot = cursor[sources[e]]++
    outTarget[slot] = targets[e]
    outLine[slot] = lines[e]
    outCall[slot] = calls[e]
  }
  return { offsets, target: outTarget, line: outLine, call: outCall }
}

a = t()
const n = symbols.length
const fwd = csr(from, to, line, call, n)
const rev = csr(to, from, line, call, n)
step('build CSR', a)

fs.mkdirSync(OUT, { recursive: true })
const parts = [
  new Int32Array([n, from.length]),
  fwd.offsets, fwd.target, fwd.line, fwd.call,
  rev.offsets, rev.target, rev.line, rev.call,
]
fs.writeFileSync(path.join(OUT, 'graph.bin'), Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))))
fs.writeFileSync(
  path.join(OUT, 'meta.json'),
  JSON.stringify({
    files,
    symbols,
    edges: from.length,
    // Staleness check: any source file newer than this invalidates the index.
    maxMtimeMs: Math.max(...sourceFiles.map((f) => fs.statSync(f.getFilePath()).mtimeMs)),
  }),
)

const bytes = fs.statSync(path.join(OUT, 'graph.bin')).size + fs.statSync(path.join(OUT, 'meta.json')).size
console.log(`\n  ${n} symbols, ${from.length} edges, ${(bytes / 1048576).toFixed(2)}MB in .codegraph/`)
