import type { FastifyReply } from 'fastify';

/**
 * Seed JSON files (configs/seed/*.json) may be updated from the Config API only when the
 * stats server is not running as production — i.e. development / local `npm run dev`.
 */
export function isDevConfigSeedWrites(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function assertDevSeedWriteAllowed(reply: FastifyReply): boolean {
  if (isDevConfigSeedWrites()) return true;
  reply.code(403).send({
    error:
      'Updating seed JSON files is only allowed in development (when NODE_ENV is not production). Run the stats server via `npm run dev` or set NODE_ENV=development.'
  });
  return false;
}
