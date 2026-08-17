import { FastifyInstance } from 'fastify';
import { writeProcessLog } from '../../stdioMode';
import { streamToUI } from '../streamChannel';

export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/metrics/stream', async (_request, reply) => {
    reply.sse(streamToUI());
  });
}
