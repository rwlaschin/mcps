/** Align with `mcp-code-vault/src/utils/modelCategories.ts` (browser-safe). */

export function normalizeModelCategoryToken(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  const low = t.toLowerCase()
  if (low === 'fast') return 'fast'
  if (low === 'blended' || low === 'blend') return 'blended'
  if (low === 'thinking') return 'thinking'
  return t
}

export function normalizeModelCategoriesInput(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of arr) {
    const n = normalizeModelCategoryToken(String(x))
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function categoriesFromSavedModel(m: { categories?: unknown; category?: unknown }): string[] {
  const fromArr = normalizeModelCategoriesInput(m.categories)
  if (fromArr.length) return fromArr
  const c = normalizeModelCategoryToken(String(m.category ?? ''))
  return c ? [c] : ['fast']
}

export function defaultModelCategoriesIfEmpty(cats: string[]): string[] {
  return cats.length ? cats : ['fast']
}
