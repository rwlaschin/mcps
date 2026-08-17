/** Read server JSON `{ error }` / `{ message }` or short text body (response body consumed once). */
export async function readApiErrorMessage(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (typeof j.error === 'string' && j.error.trim()) return j.error.trim()
    if (typeof j.message === 'string' && j.message.trim()) return j.message.trim()
  } catch {
    const t = text.trim()
    if (t.length > 0 && t.length < 240) return t
  }
  const fallback = `${res.status} ${res.statusText}`.trim()
  return fallback || 'Request failed'
}
