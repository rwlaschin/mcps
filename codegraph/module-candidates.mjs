import path from 'node:path'

export const typescriptSourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']

export function moduleCandidates(file, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  return [base, ...typescriptSourceExtensions.map((extension) => base + extension), ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map((extension) => base + extension)]
}
