import { connectQueryDaemon } from './query-daemon.mjs'

// The generic daemon protocol forwards `internal-summaries` and scoped `internals` queries,
// including their generation pin. Cancellation is owned by the daemon client, which sends cancel
// and drains through the terminal done frame before close.

export async function *streamQuery(root, query, options = {}) {
  const client = await connectQueryDaemon(root)
  try { yield * client.query(query, options) }
  finally { await client.close() }
}

export async function subscribeChanges(root, listener, options = {}) {
  const client = await connectQueryDaemon(root, options)
  const unsubscribe = await client.subscribe(listener, { root })
  return async () => { await unsubscribe(); await client.close() }
}
