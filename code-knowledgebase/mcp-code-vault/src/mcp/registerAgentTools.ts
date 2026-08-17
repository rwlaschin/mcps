import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { validateToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation.js';
import { Types } from 'mongoose';
import { Agent } from '../db/models/Agent';
import { Project } from '../db/models/Project';
import { loadAgentExecutionBundleById } from '../agent/loadAgentExecutionBundle';
import { withMetrics } from '../stats/metricsClient';
import { logger } from '../logger';

const RESERVED = new Set(['ping', 'settings', 'config']);

let agentMcpToolsRegistered = false;

/** For unit tests that boot Mongo + MCP in one process more than once. */
export function __resetAgentMcpToolsRegistrationForTest(): void {
  agentMcpToolsRegistered = false;
}

/**
 * Registers one MCP tool per agent for the current `MCP_PROJECT_NAME` project, using each agent's `tool_name`.
 * Call after Mongo is connected and the project row exists. Idempotent per process.
 */
export async function registerProjectAgentMcpTools(server: McpServer): Promise<void> {
  if (agentMcpToolsRegistered) return;
  const projectKey = process.env.MCP_PROJECT_NAME?.trim();
  if (!projectKey) return;

  const project = await Project.findOne({ key: projectKey }).lean();
  if (!project?._id) return;

  const agents = await Agent.find({ project_id: project._id }).sort({ name: 1 }).lean();
  const usedNames = new Set<string>(RESERVED);

  for (const row of agents) {
    const id = row._id as Types.ObjectId;
    const raw = String(row.tool_name ?? '').trim();
    if (!raw) {
      logger.warn({ event: 'agent_mcp_tool_skip', reason: 'empty_tool_name', agentId: String(id), name: row.name });
      continue;
    }
    const v = validateToolName(raw);
    if (!v.isValid) {
      logger.warn({
        event: 'agent_mcp_tool_skip',
        reason: 'invalid_tool_name',
        agentId: String(id),
        name: row.name,
        tool_name: raw,
        warnings: v.warnings
      });
      continue;
    }
    if (usedNames.has(raw)) {
      logger.warn({
        event: 'agent_mcp_tool_skip',
        reason: 'duplicate_or_reserved_tool_name',
        agentId: String(id),
        name: row.name,
        tool_name: raw
      });
      continue;
    }
    usedNames.add(raw);

    const description =
      (row.description && String(row.description).trim()) ||
      `Vault agent "${row.name}" — returns the resolved execution bundle (prompts, personas, tool flags).`;

    try {
      const handler = withMetrics(raw, 'query', async () => {
        const bundle = await loadAgentExecutionBundleById(id);
        if (!bundle) {
          return {
            content: [{ type: 'text' as const, text: 'Agent not found or could not be loaded.' }],
            isError: true as const
          };
        }
        const text = JSON.stringify(bundle, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      });

      server.registerTool(
        raw,
        {
          description,
          inputSchema: {}
        },
        handler as (args: unknown, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({
        event: 'agent_mcp_tool_register_failed',
        agentId: String(id),
        name: row.name,
        tool_name: raw,
        err: msg
      });
    }
  }

  agentMcpToolsRegistered = true;
}
