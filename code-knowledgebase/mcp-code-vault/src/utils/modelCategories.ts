/**
 * Saved LLM models and agents share string category tags. Built-ins: fast, blended, thinking.
 * Any other non-empty string is a custom tag (e.g. Vision).
 */

export function normalizeModelCategoryToken(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const low = t.toLowerCase();
  if (low === 'fast') return 'fast';
  if (low === 'blended' || low === 'blend') return 'blended';
  if (low === 'thinking') return 'thinking';
  return t;
}

export function normalizeModelCategoriesInput(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : typeof input === 'string' ? [input] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const n = normalizeModelCategoryToken(String(x));
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** From a Mongo lean doc: prefer `categories[]`, else legacy single `category`. */
export function modelCategoriesFromDoc(doc: { category?: unknown; categories?: unknown }): string[] {
  const fromArr = normalizeModelCategoriesInput(doc.categories);
  if (fromArr.length) return fromArr;
  const c = normalizeModelCategoryToken(String(doc.category ?? ''));
  return c ? [c] : ['fast'];
}

/** Saved models must have at least one category. */
export function defaultModelCategoriesIfEmpty(cats: string[]): string[] {
  return cats.length ? cats : ['fast'];
}

/** Agent filter: empty list means "all models"; otherwise intersection with model.categories. */
export function normalizeAgentModelCategoriesInput(input: unknown): string[] {
  return normalizeModelCategoriesInput(input);
}
