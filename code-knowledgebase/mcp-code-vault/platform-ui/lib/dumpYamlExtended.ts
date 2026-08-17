/**
 * Minimal YAML serializer for live previews (block scalars for long / multiline strings).
 * Paired in the UI with application/json — not a complete YAML 1.2 implementation.
 */

function isPlainKey(k: string): boolean {
  return /^[a-zA-Z_][\w]*$/.test(k)
}

function quoteKey(k: string): string {
  return isPlainKey(k) ? k : JSON.stringify(k)
}

/** Block scalar: `|` at `barDepth`, content lines indented one level deeper. */
function stringBlock(s: string, barDepth: number): string {
  const barPad = '  '.repeat(barDepth)
  const linePad = '  '.repeat(barDepth + 1)
  return `${barPad}|\n${s.split('\n').map((ln) => `${linePad}${ln}`).join('\n')}`
}

/** Inline JSON string (double-quoted) for short scalars */
function jsonString(s: string): string {
  return JSON.stringify(s)
}

function serializeScalarInline(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'string') {
    if (v.includes('\n') || v.length > 88) return '' // signal: use block
    return jsonString(v)
  }
  return jsonString(String(v))
}

function serialize(value: unknown, depth: number): string {
  const sp = '  '.repeat(depth)
  if (value === null || value === undefined) return `${sp}null`
  if (typeof value === 'boolean' || typeof value === 'number') {
    return `${sp}${serializeScalarInline(value)}`
  }
  if (typeof value === 'string') {
    const inline = serializeScalarInline(value)
    if (inline === '') {
      return stringBlock(value, depth)
    }
    return `${sp}${inline}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${sp}[]`
    const lines: string[] = []
    for (const el of value) {
      if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
        lines.push(`${sp}-`)
        const inner = serializeObject(el as Record<string, unknown>, depth + 1)
        lines.push(inner)
      } else if (Array.isArray(el)) {
        lines.push(`${sp}-`)
        lines.push(serialize(el, depth + 1))
      } else {
        const part = serializeScalarInline(el)
        lines.push(`${sp}- ${part}`)
      }
    }
    return lines.join('\n')
  }
  if (typeof value === 'object') {
    return serializeObject(value as Record<string, unknown>, depth)
  }
  return `${sp}${String(value)}`
}

function serializeObject(obj: Record<string, unknown>, depth: number): string {
  const sp = '  '.repeat(depth)
  const lines: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = quoteKey(k)
    if (typeof v === 'string') {
      const inline = serializeScalarInline(v)
      if (inline === '') {
        lines.push(`${sp}${key}:`)
        lines.push(stringBlock(v, depth + 1))
      } else {
        lines.push(`${sp}${key}: ${inline}`)
      }
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${sp}${key}:`)
      lines.push(serializeObject(v as Record<string, unknown>, depth + 1))
    } else if (Array.isArray(v)) {
      lines.push(`${sp}${key}:`)
      lines.push(serialize(v, depth + 1))
    } else {
      lines.push(`${sp}${key}: ${serializeScalarInline(v)}`)
    }
  }
  return lines.join('\n')
}

export function dumpYamlExtended(value: unknown): string {
  if (Array.isArray(value)) {
    return serialize(value, 0)
  }
  if (value !== null && typeof value === 'object') {
    return serializeObject(value as Record<string, unknown>, 0)
  }
  return serialize(value, 0).replace(/^\s+/, '')
}
