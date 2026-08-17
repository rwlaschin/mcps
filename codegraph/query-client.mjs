import { connectQueryDaemon } from './query-daemon.mjs'

export async function *streamQuery(root, query, options = {}) {
  const client = await connectQueryDaemon(root)
  try { yield * client.query(query, options) }
  finally { await client.close() }
}
