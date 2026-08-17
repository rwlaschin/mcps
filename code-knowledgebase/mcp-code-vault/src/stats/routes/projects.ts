import type { FastifyInstance } from 'fastify';
import { Project } from '../../db/models/Project';

export async function projectRoutes(fastify: FastifyInstance) {
  fastify.get('/projects', async (_request, reply) => {
    const docs = await Project.find({}).sort({ name: 1 }).lean();
    const list = docs.map((d) => ({
      key: (d as { key: string }).key,
      name: (d as { name: string }).name
    }));
    return reply.send({ projects: list });
  });
}
