import type { Types } from 'mongoose';
import { Agent } from '../db/models/Agent';
import { Persona } from '../db/models/Persona';
import { SystemPrompt } from '../db/models/SystemPrompt';

/**
 * Resolved stack for running a vault agent (e.g. from a future MCP tool):
 * 1. If `globalPrompt` is set, run that vault prompt first on the user/task context.
 * 2. Combine that output with `agent` system prompt, `tool_name`, and `personas` for the main step.
 */
export type AgentExecutionBundle = {
  agent: {
    name: string;
    description: string;
    system_prompt: string;
    tool_name: string;
    model_categories: string[];
    tools: {
      file_watch: boolean;
      db_read_write: boolean;
      web_search: boolean;
      run_shell: boolean;
    };
  };
  globalPrompt: {
    slug: string;
    name: string;
    prompt: string;
    category: string;
    usage_type: string;
    prompt_type: string;
    structure_mode: 'unstructured' | 'structured';
    structure_preset: string;
    structure_mime: 'application/json' | 'application/x-yaml-extended';
  } | null;
  personas: Array<{ name: string; description: string; prompt: string }>;
};

async function bundleFromAgentLean(
  row: {
    name: string;
    description: string;
    system_prompt: string;
    tool_name: string;
    model_categories?: string[];
    persona_ids?: Types.ObjectId[];
    tools: AgentExecutionBundle['agent']['tools'];
    global_prompt_id?: Types.ObjectId | null;
  } | null
): Promise<AgentExecutionBundle | null> {
  if (!row) return null;

  let globalPrompt: AgentExecutionBundle['globalPrompt'] = null;
  if (row.global_prompt_id) {
    const gp = await SystemPrompt.findById(row.global_prompt_id).lean();
    if (gp) {
      const sm = String((gp as { structure_mode?: string }).structure_mode ?? '');
      const mime = String((gp as { structure_mime?: string }).structure_mime ?? '');
      const usage =
        String((gp as { usage_type?: string }).usage_type ?? '').trim() ||
        (String((gp as { prompt_type?: string }).prompt_type) === 'agent' ? 'user request' : 'file processor');
      globalPrompt = {
        slug: String(gp.slug),
        name: String(gp.name),
        prompt: String(gp.prompt),
        category: String(gp.category),
        usage_type: usage,
        prompt_type: String((gp as { prompt_type?: string }).prompt_type ?? ''),
        structure_mode: sm === 'structured' ? 'structured' : 'unstructured',
        structure_preset: String((gp as { structure_preset?: string }).structure_preset ?? 'agent_pipeline_steps'),
        structure_mime:
          mime === 'application/x-yaml-extended' ? 'application/x-yaml-extended' : 'application/json'
      };
    }
  }

  const ids = row.persona_ids ?? [];
  const personas =
    ids.length > 0
      ? (
          await Persona.find({ _id: { $in: ids } })
            .sort({ name: 1 })
            .lean()
        ).map((p) => ({
          name: String(p.name),
          description: String(p.description),
          prompt: String(p.prompt)
        }))
      : [];

  return {
    agent: {
      name: row.name,
      description: row.description,
      system_prompt: row.system_prompt,
      tool_name: row.tool_name,
      model_categories: Array.isArray(row.model_categories) ? [...row.model_categories] : [],
      tools: { ...row.tools }
    },
    globalPrompt,
    personas
  };
}

export async function loadAgentExecutionBundleById(
  agentId: string | Types.ObjectId
): Promise<AgentExecutionBundle | null> {
  const row = await Agent.findById(agentId).lean();
  if (!row) return null;
  return bundleFromAgentLean({
    name: row.name,
    description: row.description,
    system_prompt: row.system_prompt,
    tool_name: row.tool_name,
    model_categories: row.model_categories,
    persona_ids: row.persona_ids,
    tools: {
      file_watch: Boolean(row.tools?.file_watch),
      db_read_write: Boolean(row.tools?.db_read_write),
      web_search: Boolean(row.tools?.web_search),
      run_shell: Boolean(row.tools?.run_shell)
    },
    global_prompt_id: row.global_prompt_id ?? null
  });
}

export async function loadAgentExecutionBundleByName(name: string): Promise<AgentExecutionBundle | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const row = await Agent.findOne({ name: trimmed }).lean();
  if (!row) return null;
  return loadAgentExecutionBundleById(row._id);
}
