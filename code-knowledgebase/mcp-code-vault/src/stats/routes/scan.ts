import type { FastifyInstance } from 'fastify';
import { Project } from '../../db/models/Project';
import { listFilesUnderRoot } from '../../scanner';
import * as path from 'path';

export async function scanRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { projectKey?: string; limit?: string; cursor?: string };
  }>('/scan/files', async (request, reply) => {
    const projectKey = request.query.projectKey ?? 'default';
    const limitRaw = parseInt(request.query.limit ?? '200', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
    const cursor = request.query.cursor ? String(request.query.cursor) : null;

    const project = await Project.findOne({ key: projectKey }).lean();
    if (!project?.root_path) {
      return reply.status(404).send({ error: 'Project not found or missing root path' });
    }

    // Stub "DB state": enumerate project files using scanner ignore rules and shape
    // into scan-friendly entries sorted by stable path order.
    const files = listFilesUnderRoot(project.root_path as string)
      .map((absolutePath) => path.relative(project.root_path as string, absolutePath).split(path.sep).join('/'))
      .sort((a, b) => a.localeCompare(b))
      .map((relativePath) => ({
        relativePath,
        state: 'new' as const
      }));

    let startIndex = 0;
    if (cursor) {
      const idx = files.findIndex((f) => f.relativePath === cursor);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }

    const pagePlusOne = files.slice(startIndex, startIndex + limit + 1);
    const hasMore = pagePlusOne.length > limit;
    if (hasMore) pagePlusOne.pop();
    const nextCursor = hasMore && pagePlusOne.length > 0 ? pagePlusOne[pagePlusOne.length - 1].relativePath : null;

    return reply.send({
      projectKey,
      entries: pagePlusOne,
      page: {
        limit,
        hasMore,
        nextCursor
      }
    });
  });
}
