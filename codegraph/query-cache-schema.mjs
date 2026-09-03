import fs from 'node:fs'
import path from 'node:path'

export const CACHE_SCHEMA_VERSION = 2
export const QUERY_VIEW_CACHE_FILE = 'query-view-cache.bin'

export const prepareQueryViewCache = (cacheDir) => {
  const stable = path.join(cacheDir, QUERY_VIEW_CACHE_FILE)
  const versioned = path.join(cacheDir, `query-view-cache-v${CACHE_SCHEMA_VERSION}.bin`)
  if (!fs.existsSync(versioned)) return stable
  try { fs.renameSync(versioned, stable); return stable } catch { return versioned }
}
