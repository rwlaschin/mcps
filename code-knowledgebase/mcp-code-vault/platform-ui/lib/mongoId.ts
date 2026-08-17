/** Normalize `_id` / `id` from API JSON for URL paths (string, Extended JSON `$oid`, or ObjectId-like). */
export function mongoIdString(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'object' && raw !== null && '$oid' in raw) {
    const o = (raw as { $oid: unknown }).$oid
    if (typeof o === 'string' && o.trim()) return o.trim()
  }
  try {
    const s = String(raw).trim()
    return s === '[object Object]' ? '' : s
  } catch {
    return ''
  }
}
