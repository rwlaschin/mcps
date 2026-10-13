import fs from 'node:fs'
import path from 'node:path'

export const CACHE_SCHEMA_VERSION = 4
export const QUERY_VIEW_CACHE_FILE = 'query-view-cache.bin'

export const prepareQueryViewCache = (cacheDir) => {
  const stable = path.join(cacheDir, QUERY_VIEW_CACHE_FILE)
  const versioned = path.join(cacheDir, `query-view-cache-v${CACHE_SCHEMA_VERSION}.bin`)
  const priorVersioned = path.join(cacheDir, 'query-view-cache-v3.bin')
  const legacyVersioned = path.join(cacheDir, 'query-view-cache-v2.bin')
  const source = fs.existsSync(versioned) ? versioned : fs.existsSync(priorVersioned) ? priorVersioned : legacyVersioned
  if (!fs.existsSync(source)) return stable
  try { fs.renameSync(source, stable); return stable } catch { return source }
}
