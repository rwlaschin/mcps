import type { FastifyInstance } from 'fastify';
import { ServerInstance } from '../../db/models/ServerInstance';

export async function serverRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { limit?: string };
  }>('/servers', async (request, reply) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10), 1), 100);
    const docs = await ServerInstance.find()
      .sort({ started_at: -1 })
      .limit(limit)
      .lean();
    const servers = docs.map((d) => ({
      _id: (d as { _id?: unknown })._id?.toString?.() ?? (d as { id?: string }).id,
      started_at: (d as { started_at: Date }).started_at?.toISOString?.() ?? new Date((d as { started_at: string }).started_at).toISOString(),
      last_seen: (d as { last_seen: Date }).last_seen?.toISOString?.() ?? new Date((d as { last_seen: string }).last_seen).toISOString(),
      port: (d as { port: number }).port,
      local_url: (d as { local_url: string }).local_url,
      network_url: (d as { network_url?: string }).network_url,
      log_path: (d as { log_path: string }).log_path,
      pid: (d as { pid: number }).pid
    }));
    return reply.send({ servers });
  });
}
