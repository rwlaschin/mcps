import * as fs from 'fs';
import pino from 'pino';
import Fastify from 'fastify';
import FastifyCompress from '@fastify/compress';
import FastifyCors from '@fastify/cors';
import FastifySSE from 'fastify-sse-v2';
import { connectMongoose } from '../db/mongoose';
import { getMcpServerInstance } from '../mcp/server';
import { registerProjectAgentMcpTools } from '../mcp/registerAgentTools';
import { runSeed, ensurePromptsFromSeed } from '../db/seed';
import { ensureProjectFromConfig } from '../db/ensureProject';
import { ensureProjectCollections } from '../db/projectDb';
import { pushToStream } from './streamChannel';
import { postMetric } from './metricsClient';
import { stdioMode } from '../stdioMode';
import { getLogPath, ensureLogDir } from '../logFile';
import { getServerCwd, getServerPort } from '../mcp/context';
import { mongoUrlLinesForSettingsContent } from '../utils/redactMongoUrl';
import { logger } from '../logger';
import { streamRoutes } from './routes/stream';
import { metricRoutes } from './routes/metrics';
import { projectRoutes } from './routes/projects';
import { scanRoutes } from './routes/scan';
import { configRoutes } from './routes/config';

function buildSettingsContent(projectNameOverride: string | null): string {
  const projectName =
    projectNameOverride != null && projectNameOverride !== ''
      ? projectNameOverride
      : process.env.MCP_PROJECT_NAME !== undefined && process.env.MCP_PROJECT_NAME !== ''
        ? process.env.MCP_PROJECT_NAME
        : '(not set)';

  const mongoBlock = mongoUrlLinesForSettingsContent(process.env.MONGO_URL);
  const pwd = process.env.PWD !== undefined && process.env.PWD !== '' ? process.env.PWD : '(not set)';

  const cwd = getServerCwd();
  const port = getServerPort();
  const mcpProjectEnv = projectNameOverride ?? process.env.MCP_PROJECT_NAME ?? '';

  const snippet = JSON.stringify(
    {
      mcpServers: {
        'mcp-code-vault': {
          command: 'node',
          args: ['dist/index.js'],
          cwd,
          env: {
            PORT: port,
            MCP_PROJECT_NAME: mcpProjectEnv,
            WORKING_DIRECTORY: cwd
          }
        }
      }
    },
    null,
    2
  );

  return `Code-vault config\nprojectName: ${projectName}\n${mongoBlock}\nworkingDirectory: ${cwd}\ncwd: ${cwd}\npwd: ${pwd}\nport: ${port}\n\nMCP snippet (for Cursor)\n${snippet}`;
}

export async function createStatsServer() {
  await connectMongoose();
  logger.info({ event: 'mongo_connected' });
  pushToStream(
    'db:connected',
    JSON.stringify({ ts: new Date().toISOString() })
  );
  const seedResult = await runSeed();
  const promptsSeedResult = await ensurePromptsFromSeed();
  pushToStream(
    'seed:checked',
    JSON.stringify({
      ts: new Date().toISOString(),
      action: seedResult,
      promptsSeed: promptsSeedResult
    })
  );
  const projectKeyRaw = process.env.MCP_PROJECT_NAME?.trim();
  if (projectKeyRaw !== undefined && projectKeyRaw !== '') {
    const projectKey = projectKeyRaw;
    const rootPath = getServerCwd();
    const ensureResult = await ensureProjectFromConfig(projectKey, rootPath);
    pushToStream(
      'project',
      JSON.stringify({
        ts: new Date().toISOString(),
        projectKey,
        rootPath,
        action: ensureResult
      })
    );

    const startedAt = new Date().toISOString();
    await ensureProjectCollections(projectKey);
    const endedAt = new Date().toISOString();
    await postMetric({
      instance_id: process.env.INSTANCE_ID ?? 'mcp-code-vault',
      operation: 'init',
      kind: 'event',
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
      status: 'ok',
      metadata: { content: 'connections_ensured', project: projectKey, ts: startedAt }
    });

    const mcp = getMcpServerInstance();
    if (mcp) await registerProjectAgentMcpTools(mcp);
  }

  const isTest = process.env.NODE_ENV === 'test';
  const logLevel =
    isTest ? 'silent' : stdioMode ? 'silent' : (process.env.LOG_LEVEL ?? 'info');
  if (!stdioMode && !isTest) ensureLogDir();
  let loggerOpt: false | { level: string; stream: ReturnType<typeof pino.destination> } = false;
  if (!stdioMode && !isTest) {
    const logPath = getLogPath();
    const fd = fs.openSync(logPath, 'a');
    loggerOpt = { level: logLevel, stream: pino.destination({ fd, sync: false }) };
  }
  const fastify = Fastify({ logger: loggerOpt });
  // The UI makes cross-origin HTTP requests to the primary when proxying is disabled.
  // Be explicit so browser preflights (OPTIONS) and `Content-Type` headers succeed.
  await fastify.register(FastifyCors, {
    origin: true, // reflect caller origin
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    preflightContinue: false
  });
  await fastify.register(FastifyCompress, { global: true, encodings: ['gzip', 'deflate', 'br'] });
  await fastify.register(FastifySSE);

  // HTTP surface on the primary only (secondaries skip createStatsServer). No URL prefix on this app;
  // UI hits these directly on the stats port or via Nuxt `/api/stats/<path>`:
  // - streamRoutes / metricRoutes: SSE + metrics
  // - projectRoutes: GET /projects  (project picker; plural, not /project)
  // - scanRoutes: GET /scan/files
  // - configRoutes: /config/prompts, personas, agents, /config/models (+ discover, credentials, verify-local, CRUD)
  await fastify.register(streamRoutes);
  await fastify.register(metricRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(scanRoutes);
  await fastify.register(configRoutes);

  fastify.get('/config', async (request) => {
    const projectKeyRaw = (request.query as Record<string, unknown> | undefined)?.projectKey;
    const projectKey =
      typeof projectKeyRaw === 'string' && projectKeyRaw.trim() !== '' ? projectKeyRaw.trim() : null;
    return { config: buildSettingsContent(projectKey) };
  });

  fastify.get('/docs', async () => ({ docs: 'empty' }));

  return fastify;
}
