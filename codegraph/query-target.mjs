export function qualifiedQuery(raw, metadata = {}) {
  const extensions = metadata.analyzers?.flatMap((analyzer) => analyzer.extensions) ?? [...(metadata.extensions ?? [])]
  const separator = raw.lastIndexOf(':')
  const file = separator < 0 ? raw : raw.slice(0, separator)
  if (extensions.includes(file.slice(file.lastIndexOf('.')).toLowerCase())) {
    return separator < 0 ? { file } : { file, name: raw.slice(separator + 1) }
  }
  return { name: raw }
}
