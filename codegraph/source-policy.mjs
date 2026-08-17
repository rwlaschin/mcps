import fs from 'node:fs'
import path from 'node:path'
import { minimatch } from 'minimatch'

export const MANDATORY_IGNORES = new Set(['node_modules', 'vendor', 'third_party', '.git', '.codegraph', '.codegraph-v2'])
export const BUILD_IGNORES = new Set(['dist', 'build', 'coverage', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.cache', 'target', 'out'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])

const posix = (value) => value.split(path.sep).join('/')

export function createSourcePolicy(root) {
  root = path.resolve(root)
  const symlinkDirs = new Set()
  const normalize = (file) => posix(path.relative(root, path.resolve(file)))
  const segments = (rel) => rel.split('/').filter(Boolean)
  const readPatterns = (name) => {
    try { return fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')) } catch { return [] }
  }
  const ignorePatterns = [...readPatterns('.gitignore'), ...readPatterns('.codegraphignore')]
  const config = (() => {
    const file = ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(root, name)).find(fs.existsSync)
    if (!file) return {}
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')) } catch { return {} }
  })()
  const matchPattern = (rel, raw) => {
    let pattern = raw.replace(/^\//, '').replace(/\/$/, '/**')
    if (!pattern.includes('/')) pattern = `**/${pattern}`
    return minimatch(rel, pattern, { dot: true, matchBase: true })
  }
  const configured = (rel) => {
    const include = config.include ?? []
    const exclude = config.exclude ?? []
    if (exclude.some((pattern) => matchPattern(rel, pattern))) return false
    return !include.length || include.some((pattern) => matchPattern(rel, pattern) || matchPattern(rel, `${pattern.replace(/\/$/, '')}/**`))
  }
  const ignoredRelative = (rel) => {
    if (rel.startsWith('../') || path.isAbsolute(rel) || segments(rel).some((part) => MANDATORY_IGNORES.has(part) || BUILD_IGNORES.has(part))) return true
    let ignored = false
    for (const raw of ignorePatterns) {
      const negated = raw.startsWith('!'); const pattern = negated ? raw.slice(1) : raw
      if (matchPattern(rel, pattern)) ignored = !negated
    }
    return ignored
  }
  const sourceRelative = (rel) => !ignoredRelative(rel) && configured(rel) && SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())

  function scan() {
    const found = []
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name)
        const rel = normalize(absolute)
        if (ignoredRelative(rel)) continue
        if (entry.isSymbolicLink()) { if (entry.isDirectory() || safeDirectory(absolute)) symlinkDirs.add(rel); continue }
        if (entry.isDirectory()) visit(absolute)
        else if (entry.isFile() && sourceRelative(rel)) found.push(rel)
      }
    }
    if (fs.existsSync(root)) visit(root)
    return found.sort()
  }

  const safeDirectory = (absolute) => { try { return fs.statSync(absolute).isDirectory() } catch { return false } }
  const acceptWatchPath = (file) => {
    const rel = normalize(file)
    if (!sourceRelative(rel)) return false
    for (const linked of symlinkDirs) if (rel === linked || rel.startsWith(`${linked}/`)) return false
    let cursor = path.dirname(path.resolve(file))
    while (cursor.startsWith(root) && cursor !== root) {
      try { if (fs.lstatSync(cursor).isSymbolicLink()) return false } catch { return false }
      cursor = path.dirname(cursor)
    }
    return true
  }
  return { root, scan, acceptWatchPath, isSourceRelative: sourceRelative, isIgnoredRelative: ignoredRelative, normalize }
}
