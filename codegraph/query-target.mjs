export function qualifiedQuery(raw) {
  const match = raw.match(/^(.*\.[cm]?[jt]sx?):(.+)$/)
  if (match) return { file: match[1], name: match[2] }
  if (/\.[cm]?[jt]sx?$/.test(raw)) return { file: raw }
  return { name: raw }
}
