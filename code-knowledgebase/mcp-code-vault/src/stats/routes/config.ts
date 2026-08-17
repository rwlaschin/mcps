import type { FastifyInstance, FastifyReply } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { Types } from 'mongoose';
import {
  SystemPrompt,
  type PromptCategory,
  type PromptStructureMime,
  type PromptStructureMode,
  type PromptType,
  derivePromptTypeFromUsageType,
  deriveUsageTypeFromPromptType
} from '../../db/models/SystemPrompt';
import { LLMModel } from '../../db/models/LLMModel';
import { ModelProviderCredential } from '../../db/models/ModelProviderCredential';
import { Persona } from '../../db/models/Persona';
import { Agent } from '../../db/models/Agent';
import { Project } from '../../db/models/Project';
import { assertDevSeedWriteAllowed, isDevConfigSeedWrites } from '../configAdmin';
import {
  readPersonaSeedRows,
  writePersonaSeedRows,
  readAgentSeedRows,
  writeAgentSeedRows,
  type AgentSeedRow,
  type PersonaSeedRow
} from '../configSeedJson';
import {
  discoverProviderModels,
  normalizeGithubModelsCredentialBaseUrl,
  verifyLocalConnection,
  type LocalApiMode
} from '../providerDiscovery';
import {
  defaultModelCategoriesIfEmpty,
  modelCategoriesFromDoc,
  normalizeAgentModelCategoriesInput,
  normalizeModelCategoriesInput
} from '../../utils/modelCategories';
import { isValidMcpToolNameId } from '../../utils/mcpToolName';
import { DEFAULT_AGENT_TOOLS_ON_CREATE } from '../../utils/defaultAgentTools';

const SEED_DIR = path.join(process.cwd(), 'configs', 'seed');
const PROMPTS_SEED_PRIMARY = path.join(SEED_DIR, 'prompts.json');
const PROMPTS_SEED_LEGACY = path.join(SEED_DIR, 'global-prompts.json');

function promptsSeedPathForRead(): string | null {
  if (fs.existsSync(PROMPTS_SEED_PRIMARY)) return PROMPTS_SEED_PRIMARY;
  if (fs.existsSync(PROMPTS_SEED_LEGACY)) return PROMPTS_SEED_LEGACY;
  return null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Align DB / UI with the Add-remote wizard (`google` → `gemini`). */
function normalizeLlmProviderId(raw: string): string {
  const p = raw.trim().toLowerCase();
  if (p === 'google') return 'gemini';
  return p;
}

/**
 * Legacy upserts match documents with no `credential_id` so older clients keep one row per provider+name.
 * With `credentialId`, the same vendor model id can exist under different credential documents.
 */
function llmModelUpsertFilter(
  provider: string,
  name: string,
  credentialId: Types.ObjectId | undefined
): Record<string, unknown> {
  if (credentialId) {
    return { provider, name, credential_id: credentialId };
  }
  return {
    provider,
    name,
    $or: [{ credential_id: { $exists: false } }, { credential_id: null }]
  };
}

async function resolveLlmCredentialId(
  reply: FastifyReply,
  provider: string,
  raw: unknown
): Promise<Types.ObjectId | false | undefined> {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const s = String(raw).trim();
  if (!Types.ObjectId.isValid(s)) {
    await reply.code(400).send({ error: 'invalid credential_id' });
    return false;
  }
  const oid = new Types.ObjectId(s);
  const cred = await ModelProviderCredential.findById(oid).lean();
  if (!cred) {
    await reply.code(400).send({ error: 'credential_id not found' });
    return false;
  }
  const credProvider = normalizeLlmProviderId(String((cred as { provider?: string }).provider ?? ''));
  if (credProvider !== provider) {
    await reply.code(400).send({ error: 'credential provider does not match model provider' });
    return false;
  }
  return oid;
}

type PromptSeedBaselineRow = {
  slug: string;
  name: string;
  prompt: string;
  usage_type: string;
  prompt_type: PromptType;
  category: PromptCategory;
  is_default?: boolean;
  structure_mode?: PromptStructureMode;
  structure_preset?: string;
  structure_mime?: PromptStructureMime;
};


function normalizeUsageTypeInput(raw: unknown): string {
  return String(raw ?? '').trim();
}

function effectivePromptUsageType(doc: { usage_type?: string; prompt_type?: string; slug?: string }): string {
  const slug = String(doc.slug ?? '')
    .trim()
    .toLowerCase();
  const uRaw = String(doc.usage_type ?? '').trim();
  const uLow = uRaw.toLowerCase();
  /** Repair rows where `usage_type` was back-filled as file processor but slug is a known agent prompt. */
  if (uLow === 'file processor') {
    if (slug === 'user-request') return 'user request';
    if (slug === 'agent-platform-assistant') return 'platform assistant';
  }
  if (uRaw) return uRaw;
  if (slug === 'user-request') return 'user request';
  if (slug === 'agent-platform-assistant') return 'platform assistant';
  const pt = doc.prompt_type;
  if (pt === 'agent' || pt === 'processing') return deriveUsageTypeFromPromptType(pt);
  return 'file processor';
}

async function migratePromptDocsMissingUsageType(): Promise<void> {
  const stale = await SystemPrompt.find({
    $or: [{ usage_type: { $exists: false } }, { usage_type: null }, { usage_type: '' }]
  });
  const list = Array.isArray(stale) ? stale : [];
  for (const doc of list) {
    const ut = effectivePromptUsageType(
      doc as { usage_type?: string; prompt_type?: string; slug?: string }
    );
    doc.usage_type = ut;
    doc.prompt_type = derivePromptTypeFromUsageType(ut);
    await doc.save();
  }
}

function normalizePromptStructureMode(raw: unknown): PromptStructureMode {
  return raw === 'structured' ? 'structured' : 'unstructured';
}

function normalizePromptStructureMime(raw: unknown): PromptStructureMime {
  if (raw === 'application/x-yaml-extended') return 'application/x-yaml-extended';
  return 'application/json';
}

function normalizePromptStructurePreset(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s || 'agent_pipeline_steps';
}

function readPromptSeedBaselines(): PromptSeedBaselineRow[] {
  const seedPath = promptsSeedPathForRead();
  if (!seedPath) return [];
  try {
    const raw = fs.readFileSync(seedPath, 'utf-8');
    const parsed = JSON.parse(raw) as Array<
      Omit<PromptSeedBaselineRow, 'usage_type'> & { usage_type?: string; prompt_type?: PromptType }
    >;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => {
      const ut =
        String(row.usage_type ?? '').trim() ||
        (row.prompt_type === 'agent' || row.prompt_type === 'processing'
          ? deriveUsageTypeFromPromptType(row.prompt_type)
          : '');
      const pt: PromptType =
        row.prompt_type === 'agent' || row.prompt_type === 'processing'
          ? row.prompt_type
          : derivePromptTypeFromUsageType(ut || 'file processor');
      return {
        ...row,
        usage_type: ut || deriveUsageTypeFromPromptType(pt),
        prompt_type: pt
      };
    });
  } catch {
    return [];
  }
}

function writePromptSeedBaselines(prompts: PromptSeedBaselineRow[]): void {
  if (!fs.existsSync(SEED_DIR)) fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.writeFileSync(PROMPTS_SEED_PRIMARY, JSON.stringify(prompts, null, 2), 'utf-8');
}

const seedMeta = () => ({ seedWriteEnabled: isDevConfigSeedWrites() });

/**
 * Agents are a global platform concept in the UI; Mongo still stores `project_id` for legacy/seed.
 * New agents use `projectKey` when provided, else `default`, else the lexicographically first project.
 */
async function resolveAgentProject(
  projectKey?: string
): Promise<{ projectId: Types.ObjectId; key: string } | null> {
  const trimmed = String(projectKey ?? '').trim();
  if (trimmed) {
    const project = await Project.findOne({ key: trimmed });
    if (!project) return null;
    return { projectId: project._id, key: trimmed };
  }
  const byDefault = await Project.findOne({ key: 'default' });
  if (byDefault) return { projectId: byDefault._id, key: 'default' };
  const list = await Project.find({}).lean();
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const row = rows[0] as { _id: Types.ObjectId; key: string };
  return { projectId: row._id, key: String(row.key) };
}

async function personaNamesForIds(ids: Types.ObjectId[] | undefined): Promise<string[]> {
  if (!ids?.length) return [];
  const personas = await Persona.find({ _id: { $in: ids } }).lean();
  const map = new Map(personas.map((p) => [String(p._id), p.name as string]));
  return ids.map((id) => map.get(String(id)) ?? '').filter((n) => n !== '');
}

type AgentLeanRow = {
  _id: unknown;
  name: string;
  description: string;
  system_prompt: string;
  tool_name: string;
  model_categories?: string[];
  /** @deprecated */
  model_category?: string;
  persona_ids?: Types.ObjectId[];
  global_prompt_id?: Types.ObjectId | null;
  tools: unknown;
  save_to_seed: boolean;
  project_id?: Types.ObjectId;
};

async function resolveGlobalPromptObjectId(
  reply: FastifyReply,
  raw: unknown
): Promise<Types.ObjectId | null | false> {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!Types.ObjectId.isValid(s)) {
    await reply.code(400).send({ error: 'invalid global_prompt_id' });
    return false;
  }
  const oid = new Types.ObjectId(s);
  const n = await SystemPrompt.countDocuments({ _id: oid });
  if (n === 0) {
    await reply.code(400).send({ error: 'global_prompt_id not found' });
    return false;
  }
  return oid;
}

function agentModelCategoriesForApi(a: AgentLeanRow): string[] {
  const fromNew = normalizeAgentModelCategoriesInput(a.model_categories);
  if (fromNew.length) return fromNew;
  if (a.model_category) return normalizeModelCategoriesInput([a.model_category]);
  return [];
}

async function agentsLeanToApiPayload(
  raw: AgentLeanRow[],
  projectKeyForRow: (row: AgentLeanRow) => string
) {
  const gpIds = [
    ...new Set(
      raw.map((a) => a.global_prompt_id).filter(Boolean).map((id) => String(id))
    )
  ];
  const gpDocs =
    gpIds.length > 0
      ? await SystemPrompt.find({ _id: { $in: gpIds } }).select('name').lean()
      : [];
  const gpNameById = new Map(gpDocs.map((g) => [String(g._id), String(g.name)]));

  return Promise.all(
    raw.map(async (a) => {
      const persona_names = await personaNamesForIds(a.persona_ids as Types.ObjectId[]);
      const gpid = a.global_prompt_id ? String(a.global_prompt_id) : null;
      return {
        _id: a._id,
        name: a.name,
        description: a.description,
        system_prompt: a.system_prompt,
        tool_name: a.tool_name,
        save_to_seed: a.save_to_seed,
        model_categories: agentModelCategoriesForApi(a),
        project_key: projectKeyForRow(a),
        persona_names,
        global_prompt_id: gpid,
        global_prompt_name: gpid ? gpNameById.get(gpid) ?? null : null,
        tools: a.tools
      };
    })
  );
}

async function personaIdsFromNames(names: string[]): Promise<Types.ObjectId[]> {
  const out: Types.ObjectId[] = [];
  for (const n of names) {
    const name = n.trim();
    if (!name) continue;
    const p = await Persona.findOne({ name });
    if (p) out.push(p._id);
  }
  return out;
}

async function agentToSeedRow(agent: {
  name: string;
  description: string;
  system_prompt: string;
  tool_name: string;
  model_categories: string[];
  persona_ids: Types.ObjectId[];
  global_prompt_id?: Types.ObjectId | null;
  tools: { file_watch: boolean; db_read_write: boolean; web_search: boolean; run_shell: boolean };
}, projectKey: string): Promise<AgentSeedRow> {
  const persona_names = await personaNamesForIds(agent.persona_ids);
  let global_prompt_slug: string | undefined;
  if (agent.global_prompt_id) {
    const gp = await SystemPrompt.findById(agent.global_prompt_id);
    if (gp && typeof gp === 'object' && 'slug' in gp && (gp as { slug?: string }).slug) {
      global_prompt_slug = String((gp as { slug: string }).slug);
    }
  }
  return {
    name: agent.name,
    description: agent.description,
    system_prompt: agent.system_prompt,
    tool_name: agent.tool_name,
    project_key: projectKey,
    ...(agent.model_categories.length ? { model_categories: [...agent.model_categories] } : {}),
    persona_names,
    ...(global_prompt_slug ? { global_prompt_slug } : {}),
    tools: {
      file_watch: agent.tools.file_watch,
      db_read_write: agent.tools.db_read_write,
      web_search: agent.tools.web_search,
      run_shell: agent.tools.run_shell
    }
  };
}

function upsertPersonaSeedFile(row: PersonaSeedRow): void {
  const rows = readPersonaSeedRows();
  const next = rows.filter((r) => r.name !== row.name);
  next.push(row);
  next.sort((a, b) => a.name.localeCompare(b.name));
  writePersonaSeedRows(next);
}

function upsertAgentSeedFile(row: AgentSeedRow): void {
  const rows = readAgentSeedRows();
  const next = rows.filter((r) => !(r.name === row.name && r.project_key === row.project_key));
  next.push(row);
  next.sort((a, b) => a.name.localeCompare(b.name));
  writeAgentSeedRows(next);
}

export async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/config/prompts', async () => {
    await migratePromptDocsMissingUsageType();
    const rawPrompts = await SystemPrompt.find({}).sort({ updatedAt: -1 }).lean();
    const prompts = rawPrompts.map((row) => {
      const plain = row as Record<string, unknown>;
      const u = effectivePromptUsageType(row as { usage_type?: string; prompt_type?: string });
      /** Always align with `usage_type` so legacy rows (e.g. user request + prompt_type processing) do not confuse clients. */
      const pt: PromptType = derivePromptTypeFromUsageType(u);
      return { ...plain, usage_type: u, prompt_type: pt };
    });
    const baselines = readPromptSeedBaselines();
    return { prompts, seedBaselines: baselines, ...seedMeta() };
  });

  fastify.get('/config/personas', async () => {
    const personas = await Persona.find({}).sort({ name: 1 }).lean();
    const seedBaselines = readPersonaSeedRows();
    return { personas, seedBaselines, ...seedMeta() };
  });

  fastify.post('/config/prompts', async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: string;
      prompt?: string;
      usage_type?: string;
      prompt_type?: PromptType;
      category?: PromptCategory;
      is_default?: boolean;
      save_to_seed?: boolean;
      structure_mode?: PromptStructureMode;
      structure_preset?: string;
      structure_mime?: PromptStructureMime;
    };
    const name = String(body.name ?? '').trim();
    const prompt = String(body.prompt ?? '').trim();
    const usageType =
      normalizeUsageTypeInput(body.usage_type) ||
      (body.prompt_type === 'agent' || body.prompt_type === 'processing'
        ? deriveUsageTypeFromPromptType(body.prompt_type)
        : '');
    if (!usageType) {
      return reply.code(400).send({ error: 'usage_type is required' });
    }
    const promptType = derivePromptTypeFromUsageType(usageType);
    const category = body.category ?? 'fast';
    const structureMode = normalizePromptStructureMode(body.structure_mode);
    const structurePreset = normalizePromptStructurePreset(body.structure_preset);
    const structureMime = normalizePromptStructureMime(body.structure_mime);
    if (!name || !prompt) return reply.code(400).send({ error: 'name and prompt are required' });

    const slug = slugify(name);
    if (!slug) return reply.code(400).send({ error: 'invalid name' });
    const existingSlug = await SystemPrompt.findOne({ slug });
    if (existingSlug) {
      return reply.code(409).send({
        error: 'A prompt with this name already exists (slug is in use). Choose a different name or edit the existing prompt.'
      });
    }
    const promptDoc = await SystemPrompt.create({
      name,
      slug,
      prompt,
      usage_type: usageType,
      prompt_type: promptType,
      category,
      is_default: Boolean(body.is_default),
      save_to_seed: Boolean(body.save_to_seed),
      structure_mode: structureMode,
      structure_preset: structurePreset,
      structure_mime: structureMime,
      seed_baseline_prompt: prompt
    });
    if (body.is_default) {
      await SystemPrompt.updateMany(
        { usage_type: usageType, _id: { $ne: promptDoc._id } },
        { $set: { is_default: false } }
      );
    }
    if (body.save_to_seed) {
      if (!assertDevSeedWriteAllowed(reply)) return;
      const baselines = readPromptSeedBaselines();
      const next = baselines.filter((b) => b.slug !== slug);
      next.push({
        slug,
        name,
        prompt,
        usage_type: usageType,
        prompt_type: promptType,
        category,
        is_default: Boolean(body.is_default),
        structure_mode: structureMode,
        structure_preset: structurePreset,
        structure_mime: structureMime
      });
      writePromptSeedBaselines(next);
    }
    return { prompt: promptDoc };
  });

  fastify.put('/config/prompts/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<{
      name: string;
      prompt: string;
      usage_type: string;
      prompt_type: PromptType;
      category: PromptCategory;
      is_default: boolean;
      save_to_seed: boolean;
      structure_mode: PromptStructureMode;
      structure_preset: string;
      structure_mime: PromptStructureMime;
    }>;
    const promptDoc = await SystemPrompt.findById(params.id);
    if (!promptDoc) return reply.code(404).send({ error: 'prompt not found' });
    if (typeof body.name === 'string' && body.name.trim() !== '') {
      promptDoc.name = body.name.trim();
      const nextSlug = slugify(promptDoc.name);
      const slugClash = await SystemPrompt.findOne({
        slug: nextSlug,
        _id: { $ne: promptDoc._id }
      });
      if (slugClash) {
        return reply.code(409).send({
          error: 'Another prompt already uses this name (slug). Choose a different name.'
        });
      }
      promptDoc.slug = nextSlug;
    }
    if (typeof body.prompt === 'string' && body.prompt.trim() !== '') promptDoc.prompt = body.prompt.trim();
    if (body.usage_type !== undefined) {
      const ut = normalizeUsageTypeInput(body.usage_type);
      if (ut) {
        promptDoc.usage_type = ut;
        promptDoc.prompt_type = derivePromptTypeFromUsageType(ut);
      }
    } else if (body.prompt_type === 'agent' || body.prompt_type === 'processing') {
      promptDoc.prompt_type = body.prompt_type;
      promptDoc.usage_type = deriveUsageTypeFromPromptType(body.prompt_type);
    }
    if (body.category) promptDoc.category = body.category;
    if (typeof body.save_to_seed === 'boolean') promptDoc.save_to_seed = body.save_to_seed;
    if (typeof body.is_default === 'boolean') promptDoc.is_default = body.is_default;
    if (body.structure_mode !== undefined) {
      promptDoc.structure_mode = normalizePromptStructureMode(body.structure_mode);
    }
    if (body.structure_preset !== undefined) {
      promptDoc.structure_preset = normalizePromptStructurePreset(body.structure_preset);
    }
    if (body.structure_mime !== undefined) {
      promptDoc.structure_mime = normalizePromptStructureMime(body.structure_mime);
    }
    await promptDoc.save();
    if (promptDoc.is_default) {
      await SystemPrompt.updateMany(
        { usage_type: promptDoc.usage_type, _id: { $ne: promptDoc._id } },
        { $set: { is_default: false } }
      );
    }
    if (promptDoc.save_to_seed) {
      if (!assertDevSeedWriteAllowed(reply)) return;
      const baselines = readPromptSeedBaselines();
      const next = baselines.filter((b) => b.slug !== promptDoc.slug);
      next.push({
        slug: promptDoc.slug,
        name: promptDoc.name,
        prompt: promptDoc.prompt,
        usage_type: promptDoc.usage_type,
        prompt_type: promptDoc.prompt_type as PromptType,
        category: promptDoc.category,
        is_default: promptDoc.is_default,
        structure_mode: promptDoc.structure_mode,
        structure_preset: promptDoc.structure_preset,
        structure_mime: promptDoc.structure_mime
      });
      writePromptSeedBaselines(next);
    }
    return { prompt: promptDoc };
  });

  fastify.post('/config/prompts/:id/restore-default', async (request, reply) => {
    const params = request.params as { id: string };
    const promptDoc = await SystemPrompt.findById(params.id);
    if (!promptDoc) return reply.code(404).send({ error: 'prompt not found' });
    const baselines = readPromptSeedBaselines();
    const baseline = baselines.find((b) => b.slug === promptDoc.slug);
    const baselinePrompt = baseline?.prompt || promptDoc.seed_baseline_prompt;
    if (!baselinePrompt) return reply.code(404).send({ error: 'no baseline found for prompt' });
    promptDoc.prompt = baselinePrompt;
    await promptDoc.save();
    return { prompt: promptDoc };
  });

  fastify.post('/config/personas', async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: string;
      description?: string;
      prompt?: string;
      save_to_seed?: boolean;
    };
    const name = String(body.name ?? '').trim();
    const description = String(body.description ?? '').trim();
    const prompt = String(body.prompt ?? '').trim();
    if (!name || !description || !prompt) {
      return reply.code(400).send({ error: 'name, description, and prompt are required' });
    }
    const dup = await Persona.findOne({ name });
    if (dup) return reply.code(409).send({ error: 'persona name already exists' });
    const saveToSeed = Boolean(body.save_to_seed);
    if (saveToSeed && !assertDevSeedWriteAllowed(reply)) return;
    const doc = await Persona.create({
      name,
      description,
      prompt,
      save_to_seed: saveToSeed,
      seed_baseline_name: name,
      seed_baseline_description: description,
      seed_baseline_prompt: prompt
    });
    if (saveToSeed) upsertPersonaSeedFile({ name, description, prompt });
    return { persona: doc };
  });

  fastify.put('/config/personas/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<{
      name: string;
      description: string;
      prompt: string;
      save_to_seed: boolean;
    }>;
    const doc = await Persona.findById(params.id);
    if (!doc) return reply.code(404).send({ error: 'persona not found' });
    if (typeof body.name === 'string' && body.name.trim() !== '') {
      const nextName = body.name.trim();
      if (nextName !== doc.name) {
        const taken = await Persona.findOne({ name: nextName, _id: { $ne: doc._id } });
        if (taken) return reply.code(409).send({ error: 'persona name already exists' });
      }
      doc.name = nextName;
    }
    if (typeof body.description === 'string') doc.description = body.description.trim();
    if (typeof body.prompt === 'string') doc.prompt = body.prompt.trim();
    if (typeof body.save_to_seed === 'boolean') doc.save_to_seed = body.save_to_seed;
    await doc.save();
    if (doc.save_to_seed) {
      if (!assertDevSeedWriteAllowed(reply)) return;
      upsertPersonaSeedFile({
        name: doc.name,
        description: doc.description,
        prompt: doc.prompt
      });
    }
    return { persona: doc };
  });

  fastify.post('/config/personas/:id/restore-default', async (request, reply) => {
    const params = request.params as { id: string };
    const doc = await Persona.findById(params.id);
    if (!doc) return reply.code(404).send({ error: 'persona not found' });
    const fromFile = readPersonaSeedRows().find((r) => r.name === doc.name);
    const name = doc.seed_baseline_name ?? fromFile?.name;
    const description = doc.seed_baseline_description ?? fromFile?.description;
    const prompt = doc.seed_baseline_prompt ?? fromFile?.prompt;
    if (!name || !description || !prompt) {
      return reply.code(404).send({ error: 'no seed baseline found for this persona' });
    }
    doc.name = name;
    doc.description = description;
    doc.prompt = prompt;
    await doc.save();
    return { persona: doc };
  });

  fastify.get('/config/agents', async (request) => {
    const q = request.query as { projectKey?: string };
    const filterKey = String(q.projectKey ?? '').trim();
    if (filterKey) {
      const project = await Project.findOne({ key: filterKey }).lean();
      if (!project) return { agents: [], seedBaselines: readAgentSeedRows(), ...seedMeta() };
      const raw = await Agent.find({ project_id: project._id }).sort({ name: 1 }).lean();
      const agents = await agentsLeanToApiPayload(raw as AgentLeanRow[], () => filterKey);
      return { agents, seedBaselines: readAgentSeedRows(), ...seedMeta() };
    }
    const raw = await Agent.find({}).sort({ name: 1 }).lean();
    const projectIds = [...new Set(raw.map((a) => String(a.project_id)))];
    const projects =
      projectIds.length > 0 ? await Project.find({ _id: { $in: projectIds } }).lean() : [];
    const keyById = new Map(projects.map((p) => [String(p._id), String(p.key)]));
    const agents = await agentsLeanToApiPayload(raw as AgentLeanRow[], (row) =>
      row.project_id ? keyById.get(String(row.project_id)) ?? '' : ''
    );
    return { agents, seedBaselines: readAgentSeedRows(), ...seedMeta() };
  });

  fastify.post('/config/agents', async (request, reply) => {
    const body = (request.body ?? {}) as {
      projectKey?: string;
      name?: string;
      description?: string;
      system_prompt?: string;
      tool_name?: string;
      /** @deprecated use tool_name */
      focus?: string;
      model_categories?: unknown;
      persona_names?: string[];
      global_prompt_id?: unknown;
      tools?: Partial<{ file_watch: boolean; db_read_write: boolean; web_search: boolean; run_shell: boolean }>;
      save_to_seed?: boolean;
    };
    const name = String(body.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const resolved = await resolveAgentProject(body.projectKey);
    if (!resolved) {
      return reply.code(404).send({ error: 'no project in database; create or register a project first' });
    }
    const { projectId, key: projectKey } = resolved;
    const description = String(body.description ?? '').trim();
    const system_prompt = String(body.system_prompt ?? '').trim();
    const tool_name = String(body.tool_name ?? body.focus ?? '').trim();
    if (!description || !system_prompt || !tool_name) {
      return reply.code(400).send({ error: 'description, system_prompt, and tool_name are required' });
    }
    if (!isValidMcpToolNameId(tool_name)) {
      return reply.code(400).send({
        error:
          'tool_name must be 1–128 characters and only use letters, digits, underscore (_), dash (-), or dot (.)'
      });
    }
    const dupTool = await Agent.findOne({ project_id: projectId, tool_name });
    if (dupTool) return reply.code(409).send({ error: 'tool_name already in use for this project' });
    const dup = await Agent.findOne({ name });
    if (dup) return reply.code(409).send({ error: 'agent name already exists' });
    const saveToSeed = Boolean(body.save_to_seed);
    if (saveToSeed && !assertDevSeedWriteAllowed(reply)) return;
    const tools =
      body.tools !== undefined && body.tools !== null
        ? {
            file_watch: Boolean(body.tools.file_watch),
            db_read_write: Boolean(body.tools.db_read_write),
            web_search: Boolean(body.tools.web_search),
            run_shell: Boolean(body.tools.run_shell)
          }
        : { ...DEFAULT_AGENT_TOOLS_ON_CREATE };
    const model_categories = normalizeAgentModelCategoriesInput(body.model_categories);
    const persona_ids = await personaIdsFromNames(body.persona_names ?? []);
    const globalPromptOid = await resolveGlobalPromptObjectId(reply, body.global_prompt_id);
    if (globalPromptOid === false) return;
    let seedBaselineGlobalSlug: string | undefined;
    if (globalPromptOid) {
      const gp = await SystemPrompt.findById(globalPromptOid);
      if (gp && typeof gp === 'object' && 'slug' in gp && (gp as { slug?: string }).slug) {
        seedBaselineGlobalSlug = String((gp as { slug: string }).slug);
      }
    }
    const doc = await Agent.create({
      name,
      description,
      system_prompt,
      tool_name,
      model_categories,
      project_id: projectId,
      persona_ids,
      global_prompt_id: globalPromptOid ?? null,
      tools,
      save_to_seed: saveToSeed,
      seed_baseline_description: description,
      seed_baseline_system_prompt: system_prompt,
      seed_baseline_tool_name: tool_name,
      seed_baseline_model_categories: [...model_categories],
      seed_baseline_persona_names: [...(body.persona_names ?? []).map((n) => n.trim()).filter(Boolean)],
      ...(seedBaselineGlobalSlug ? { seed_baseline_global_prompt_slug: seedBaselineGlobalSlug } : {}),
      seed_baseline_tools: { ...tools }
    });
    if (saveToSeed) {
      const row = await agentToSeedRow(doc, projectKey);
      upsertAgentSeedFile(row);
    }
    const persona_names = await personaNamesForIds(doc.persona_ids);
    const gpid = doc.global_prompt_id ? String(doc.global_prompt_id) : null;
    const gpNameDoc = gpid ? await SystemPrompt.findById(gpid) : null;
    return {
      agent: {
        ...doc.toObject(),
        model_categories: normalizeAgentModelCategoriesInput(doc.model_categories),
        project_key: projectKey,
        persona_names,
        global_prompt_id: gpid,
        global_prompt_name:
          gpNameDoc && typeof gpNameDoc === 'object' && 'name' in gpNameDoc
            ? String((gpNameDoc as { name: string }).name)
            : null
      }
    };
  });

  fastify.put('/config/agents/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<{
      name: string;
      description: string;
      system_prompt: string;
      tool_name: string;
      /** @deprecated use tool_name */
      focus: string;
      model_categories: unknown;
      persona_names: string[];
      global_prompt_id: unknown;
      tools: { file_watch: boolean; db_read_write: boolean; web_search: boolean; run_shell: boolean };
      save_to_seed: boolean;
    }>;
    const doc = await Agent.findById(params.id);
    if (!doc) return reply.code(404).send({ error: 'agent not found' });
    const project = await Project.findById(doc.project_id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const projectKey = project.key;
    if (typeof body.name === 'string' && body.name.trim() !== '') {
      const nextName = body.name.trim();
      if (nextName !== doc.name) {
        const taken = await Agent.findOne({ name: nextName, _id: { $ne: doc._id } });
        if (taken) return reply.code(409).send({ error: 'agent name already exists' });
      }
      doc.name = nextName;
    }
    if (typeof body.description === 'string') doc.description = body.description.trim();
    if (typeof body.system_prompt === 'string') doc.system_prompt = body.system_prompt.trim();
    const toolBody = body as { tool_name?: string; focus?: string };
    if (
      Object.prototype.hasOwnProperty.call(toolBody, 'tool_name') ||
      Object.prototype.hasOwnProperty.call(toolBody, 'focus')
    ) {
      const nextTool = String(toolBody.tool_name ?? toolBody.focus ?? '').trim();
      if (!nextTool) return reply.code(400).send({ error: 'tool_name cannot be empty' });
      if (!isValidMcpToolNameId(nextTool)) {
        return reply.code(400).send({
          error:
            'tool_name must be 1–128 characters and only use letters, digits, underscore (_), dash (-), or dot (.)'
        });
      }
      const taken = await Agent.findOne({
        project_id: doc.project_id,
        tool_name: nextTool,
        _id: { $ne: doc._id }
      });
      if (taken) return reply.code(409).send({ error: 'tool_name already in use for this project' });
      doc.tool_name = nextTool;
    }
    if (body.model_categories !== undefined) {
      doc.model_categories = normalizeAgentModelCategoriesInput(body.model_categories);
    }
    if (body.tools) {
      doc.tools = {
        file_watch: Boolean(body.tools.file_watch),
        db_read_write: Boolean(body.tools.db_read_write),
        web_search: Boolean(body.tools.web_search),
        run_shell: Boolean(body.tools.run_shell)
      };
    }
    if (Array.isArray(body.persona_names)) {
      doc.persona_ids = await personaIdsFromNames(body.persona_names);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'global_prompt_id')) {
      const nextGp = await resolveGlobalPromptObjectId(reply, body.global_prompt_id);
      if (nextGp === false) return;
      doc.global_prompt_id = nextGp ?? null;
    }
    if (typeof body.save_to_seed === 'boolean') doc.save_to_seed = body.save_to_seed;
    await doc.save();
    if (doc.save_to_seed) {
      if (!assertDevSeedWriteAllowed(reply)) return;
      const row = await agentToSeedRow(doc, projectKey);
      upsertAgentSeedFile(row);
    }
    const persona_names = await personaNamesForIds(doc.persona_ids);
    const gpidPut = doc.global_prompt_id ? String(doc.global_prompt_id) : null;
    const gpNamePut = gpidPut ? await SystemPrompt.findById(gpidPut) : null;
    return {
      agent: {
        ...doc.toObject(),
        model_categories: normalizeAgentModelCategoriesInput(doc.model_categories),
        project_key: projectKey,
        persona_names,
        global_prompt_id: gpidPut,
        global_prompt_name:
          gpNamePut && typeof gpNamePut === 'object' && 'name' in gpNamePut
            ? String((gpNamePut as { name: string }).name)
            : null
      }
    };
  });

  fastify.post('/config/agents/:id/restore-default', async (request, reply) => {
    const params = request.params as { id: string };
    const doc = await Agent.findById(params.id);
    if (!doc) return reply.code(404).send({ error: 'agent not found' });
    const project = await Project.findById(doc.project_id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const projectKey = project.key;
    const fromFile = readAgentSeedRows().find((r) => r.name === doc.name && r.project_key === projectKey) as
      | AgentSeedRow
      | undefined;
    const fromFileLegacy = fromFile as AgentSeedRow & { focus?: string };
    const description = doc.seed_baseline_description ?? fromFile?.description;
    const system_prompt = doc.seed_baseline_system_prompt ?? fromFile?.system_prompt;
    const tool_name =
      doc.seed_baseline_tool_name ?? fromFile?.tool_name ?? fromFileLegacy?.focus;
    const personaNames = doc.seed_baseline_persona_names?.length
      ? doc.seed_baseline_persona_names
      : fromFile?.persona_names;
    const toolsFromBaseline = doc.seed_baseline_tools ?? fromFile?.tools;
    let modelCategoriesBaseline = doc.seed_baseline_model_categories?.length
      ? normalizeAgentModelCategoriesInput(doc.seed_baseline_model_categories)
      : normalizeAgentModelCategoriesInput(fromFile?.model_categories);
    if (!modelCategoriesBaseline.length && fromFile) {
      const legacy = fromFile as { model_category?: unknown };
      if (legacy.model_category !== undefined && legacy.model_category !== null) {
        modelCategoriesBaseline = normalizeModelCategoriesInput([legacy.model_category]);
      }
    }
    if (!description || !system_prompt || !tool_name || !personaNames || !toolsFromBaseline) {
      return reply.code(404).send({ error: 'no seed baseline found for this agent' });
    }
    doc.description = description;
    doc.system_prompt = system_prompt;
    doc.tool_name = tool_name;
    doc.model_categories = [...modelCategoriesBaseline];
    doc.persona_ids = await personaIdsFromNames(personaNames);
    doc.tools = {
      file_watch: Boolean(toolsFromBaseline.file_watch),
      db_read_write: Boolean(toolsFromBaseline.db_read_write),
      web_search: Boolean(toolsFromBaseline.web_search),
      run_shell: Boolean(toolsFromBaseline.run_shell)
    };
    const globalSlug = doc.seed_baseline_global_prompt_slug ?? fromFile?.global_prompt_slug;
    let restoredGpId: Types.ObjectId | null = null;
    if (globalSlug) {
      const gp = await SystemPrompt.findOne({ slug: globalSlug });
      if (gp && typeof gp === 'object' && '_id' in gp && (gp as { _id: unknown })._id) {
        restoredGpId = (gp as { _id: Types.ObjectId })._id;
      }
    }
    doc.global_prompt_id = restoredGpId;
    await doc.save();
    const persona_names = await personaNamesForIds(doc.persona_ids);
    const gpidRest = doc.global_prompt_id ? String(doc.global_prompt_id) : null;
    const gpNameRest = gpidRest ? await SystemPrompt.findById(gpidRest) : null;
    return {
      agent: {
        ...doc.toObject(),
        model_categories: normalizeAgentModelCategoriesInput(doc.model_categories),
        project_key: projectKey,
        persona_names,
        global_prompt_id: gpidRest,
        global_prompt_name:
          gpNameRest && typeof gpNameRest === 'object' && 'name' in gpNameRest
            ? String((gpNameRest as { name: string }).name)
            : null
      }
    };
  });

  fastify.get('/config/models', async () => {
    const raw = await LLMModel.find({}).sort({ priority: 1, updatedAt: -1 }).lean();
    const credIdStrs = [
      ...new Set(
        raw
          .map((m) => m.credential_id)
          .filter((id) => id != null && Types.ObjectId.isValid(String(id)))
          .map((id) => String(id))
      )
    ];
    const credById = new Map<string, { access_key?: string; api_base_url?: string }>();
    if (credIdStrs.length) {
      const oids = credIdStrs.map((id) => new Types.ObjectId(id));
      const creds = await ModelProviderCredential.find({ _id: { $in: oids } }).lean();
      for (const c of creds) {
        const id = String(c._id);
        credById.set(id, {
          access_key: typeof c.access_key === 'string' ? c.access_key : undefined,
          api_base_url: typeof c.api_base_url === 'string' ? c.api_base_url : undefined
        });
      }
    }
    const models = raw.map((m) => {
      const row = m as Record<string, unknown>;
      const {
        category: _legacyCat,
        provider: rawProvider,
        access_key: rowAccessKey,
        api_base_url: rowApiBase,
        ...rest
      } = row;
      let access_key = typeof rowAccessKey === 'string' ? rowAccessKey : undefined;
      let api_base_url = typeof rowApiBase === 'string' ? rowApiBase : undefined;
      const cid = m.credential_id && Types.ObjectId.isValid(String(m.credential_id)) ? String(m.credential_id) : '';
      const cred = cid ? credById.get(cid) : undefined;
      if (cred) {
        if (!access_key?.trim() && cred.access_key?.trim()) access_key = cred.access_key.trim();
        if (!api_base_url?.trim() && cred.api_base_url?.trim()) api_base_url = cred.api_base_url.trim();
      }
      return {
        ...rest,
        access_key: access_key?.trim() || undefined,
        api_base_url: api_base_url?.trim() || undefined,
        provider: normalizeLlmProviderId(String(rawProvider ?? '')),
        categories: modelCategoriesFromDoc(m as { category?: unknown; categories?: unknown })
      };
    });
    return { models };
  });

  fastify.post('/config/models/verify-local', async (request, reply) => {
    const body = (request.body ?? {}) as {
      api_base_url?: string;
      local_api_mode?: string;
      access_key?: string;
      model_name?: string;
    };
    const apiBaseUrl = String(body.api_base_url ?? '').trim();
    const mode = (body.local_api_mode === 'openai' ? 'openai' : 'ollama') as LocalApiMode;
    if (!apiBaseUrl) return reply.code(400).send({ error: 'api_base_url is required' });
    const result = await verifyLocalConnection({
      apiBaseUrl,
      mode,
      accessKey: typeof body.access_key === 'string' ? body.access_key : undefined,
      modelName: typeof body.model_name === 'string' ? body.model_name : undefined
    });
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true as const, modelsSample: result.modelsSample };
  });

  fastify.post('/config/models/discover', async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: string; access_key?: string; base_url?: string };
    const provider = normalizeLlmProviderId(String(body.provider ?? '').trim());
    const accessKey = String(body.access_key ?? '').trim();
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
    if (!provider || !accessKey) return reply.code(400).send({ error: 'provider and access_key are required' });
    try {
      const models = await discoverProviderModels(provider, accessKey, { base_url: baseUrl || undefined });
      return { models };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'discover failed' });
    }
  });

  fastify.post('/config/models/credentials', async (request, reply) => {
    const body = (request.body ?? {}) as {
      provider?: string;
      access_key?: string;
      api_base_url?: string;
      local_api_mode?: string;
    };
    const provider = normalizeLlmProviderId(String(body.provider ?? '').trim());
    if (!provider) return reply.code(400).send({ error: 'provider is required' });
    const accessKey = String(body.access_key ?? '').trim();
    const apiBase = String(body.api_base_url ?? '').trim();
    const localMode = (body.local_api_mode === 'openai' ? 'openai' : 'ollama') as LocalApiMode;

    if (provider === 'local') {
      if (!apiBase) {
        return reply.code(400).send({
          error:
            'api_base_url is required for local credentials. Examples: http://127.0.0.1:11434 (Ollama) or http://127.0.0.1:1234/v1 (OpenAI-compatible).'
        });
      }
      if (!/^https?:\/\//i.test(apiBase)) {
        return reply.code(400).send({ error: 'api_base_url must start with http:// or https://' });
      }
    } else if (provider === 'openai_compatible') {
      if (!apiBase) {
        return reply.code(400).send({
          error: 'api_base_url is required for custom OpenAI-compatible credentials.'
        });
      }
      if (!/^https?:\/\//i.test(apiBase)) {
        return reply.code(400).send({ error: 'api_base_url must start with http:// or https://' });
      }
      if (!accessKey) return reply.code(400).send({ error: 'access_key is required' });
    } else {
      if (!accessKey) return reply.code(400).send({ error: 'access_key is required' });
    }

    const docPayload: Record<string, unknown> = {
      provider,
      access_key: accessKey || undefined
    };
    if (provider === 'local') {
      docPayload.api_base_url = apiBase;
      docPayload.local_api_mode = localMode;
    } else if (provider === 'openai_compatible') {
      docPayload.api_base_url = normalizeGithubModelsCredentialBaseUrl(apiBase);
    }

    const doc = await ModelProviderCredential.create(docPayload);
    return { credential: doc.toObject() };
  });

  fastify.post('/config/models', async (request, reply) => {
    const body = (request.body ?? {}) as {
      provider?: string;
      access_key?: string;
      credential_id?: string;
      api_base_url?: string;
      local_api_mode?: string;
      name?: string;
      label?: string;
      categories?: unknown;
      category?: string;
      priority?: number;
      capabilities?: string[];
      enabled?: boolean;
      is_custom?: boolean;
    };
    const provider = normalizeLlmProviderId(String(body.provider ?? '').trim());
    const name = String(body.name ?? '').trim();
    if (!provider || !name) return reply.code(400).send({ error: 'provider and name are required' });

    const credentialResolved = await resolveLlmCredentialId(reply, provider, body.credential_id);
    if (credentialResolved === false) return;
    const credentialId = credentialResolved;

    const apiBase = String(body.api_base_url ?? '').trim();
    const localMode = (body.local_api_mode === 'openai' ? 'openai' : 'ollama') as LocalApiMode;
    if (provider === 'local') {
      if (!apiBase) {
        return reply.code(400).send({
          error:
            'api_base_url is required for local models. Examples: http://127.0.0.1:11434 (Ollama) or http://127.0.0.1:1234/v1 (LM Studio OpenAI-compatible).'
        });
      }
      if (!/^https?:\/\//i.test(apiBase)) {
        return reply.code(400).send({ error: 'api_base_url must start with http:// or https://' });
      }
    }
    if (provider === 'openai_compatible') {
      if (!apiBase) {
        return reply.code(400).send({
          error: 'api_base_url is required for custom OpenAI-compatible providers (same value you use in Add remote).'
        });
      }
      if (!/^https?:\/\//i.test(apiBase)) {
        return reply.code(400).send({ error: 'api_base_url must start with http:// or https://' });
      }
    }

    const categories = defaultModelCategoriesIfEmpty(
      normalizeModelCategoriesInput(body.categories ?? (body.category ? [body.category] : []))
    );
    const setDoc: Record<string, unknown> = {
      provider,
      name,
      label: String(body.label ?? name).trim(),
      access_key: String(body.access_key ?? '').trim() || undefined,
      categories,
      priority: Number.isFinite(body.priority) ? Number(body.priority) : 100,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      is_custom: typeof body.is_custom === 'boolean' ? body.is_custom : false
    };
    if (credentialId) {
      setDoc.credential_id = credentialId;
    }
    if (provider === 'local') {
      setDoc.api_base_url = apiBase;
      setDoc.local_api_mode = localMode;
    } else if (provider === 'openai_compatible') {
      setDoc.api_base_url = normalizeGithubModelsCredentialBaseUrl(apiBase);
    }
    const baseUnset: Record<string, 1> = { category: 1 };
    const update: { $set: Record<string, unknown>; $unset?: Record<string, 1> } = { $set: setDoc };
    if (provider === 'local') {
      update.$unset = { ...baseUnset };
    } else if (provider === 'openai_compatible') {
      update.$unset = { ...baseUnset, local_api_mode: 1 };
    } else {
      update.$unset = { ...baseUnset, api_base_url: 1, local_api_mode: 1 };
    }
    const model = await LLMModel.findOneAndUpdate(llmModelUpsertFilter(provider, name, credentialId), update, {
      upsert: true,
      returnDocument: 'after'
    });
    if (!model) return reply.code(500).send({ error: 'model upsert failed' });
    const mo = model.toObject() as Record<string, unknown>;
    const { category: _lc, ...rest } = mo;
    return {
      model: {
        ...rest,
        categories: modelCategoriesFromDoc(mo as { category?: unknown; categories?: unknown })
      }
    };
  });

  fastify.put('/config/models/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<{
      provider: string;
      access_key: string;
      api_base_url: string;
      local_api_mode: LocalApiMode;
      name: string;
      label: string;
      categories: unknown;
      category: string;
      priority: number;
      capabilities: string[];
      enabled: boolean;
      is_custom: boolean;
    }>;
    const model = await LLMModel.findById(params.id);
    if (!model) return reply.code(404).send({ error: 'model not found' });
    // Provider is immutable on update — UI must not retarget rows to another vendor.
    if (body.name) model.name = body.name.trim();
    if (body.label) model.label = body.label.trim();
    if (body.categories !== undefined) {
      model.categories = defaultModelCategoriesIfEmpty(normalizeModelCategoriesInput(body.categories));
      model.set('category', undefined);
    } else if (body.category !== undefined && body.category !== null && String(body.category).trim()) {
      model.categories = defaultModelCategoriesIfEmpty(normalizeModelCategoriesInput([body.category]));
      model.set('category', undefined);
    }
    if (typeof body.access_key === 'string') {
      const ak = body.access_key.trim();
      model.access_key = ak || undefined;
    }
    if (Number.isFinite(body.priority)) model.priority = Number(body.priority);
    if (Array.isArray(body.capabilities)) model.capabilities = body.capabilities;
    if (typeof body.enabled === 'boolean') model.enabled = body.enabled;
    if (typeof body.is_custom === 'boolean') model.is_custom = body.is_custom;

    const p = model.provider;
    if (p === 'local') {
      if (typeof body.api_base_url === 'string') {
        const u = body.api_base_url.trim();
        model.api_base_url = u || undefined;
      }
      if (body.local_api_mode === 'ollama' || body.local_api_mode === 'openai') {
        model.local_api_mode = body.local_api_mode;
      }
    } else if (p === 'openai_compatible') {
      if (typeof body.api_base_url === 'string') {
        const u = body.api_base_url.trim();
        model.api_base_url = u ? normalizeGithubModelsCredentialBaseUrl(u) : undefined;
      }
      model.set('local_api_mode', undefined);
    } else {
      model.set('api_base_url', undefined);
      model.set('local_api_mode', undefined);
    }

    if (model.credential_id) {
      const credPatch: Record<string, unknown> = {};
      if (typeof body.access_key === 'string') credPatch.access_key = body.access_key.trim() || undefined;
      if (p === 'local') {
        if (typeof body.api_base_url === 'string') credPatch.api_base_url = body.api_base_url.trim() || undefined;
        if (body.local_api_mode === 'ollama' || body.local_api_mode === 'openai') {
          credPatch.local_api_mode = body.local_api_mode;
        }
      } else if (p === 'openai_compatible') {
        if (typeof body.api_base_url === 'string') {
          const u = body.api_base_url.trim();
          credPatch.api_base_url = u ? normalizeGithubModelsCredentialBaseUrl(u) : undefined;
        }
      }
      if (Object.keys(credPatch).length) {
        await ModelProviderCredential.updateOne({ _id: model.credential_id }, { $set: credPatch });
      }
    }

    await model.save();
    const mo = model.toObject() as Record<string, unknown>;
    const { category: _lc, ...rest } = mo;
    return {
      model: {
        ...rest,
        categories: modelCategoriesFromDoc(mo as { category?: unknown; categories?: unknown })
      }
    };
  });



  fastify.get('/config/project-file-processing', async (request, reply) => {
    const projectKeyRaw = (request.query as Record<string, unknown> | undefined)?.projectKey;
    const projectKey =
      typeof projectKeyRaw === 'string' && projectKeyRaw.trim() !== '' ? projectKeyRaw.trim() : '';
    if (!projectKey) {
      return reply.code(400).send({ error: 'projectKey is required' });
    }
    const project = await Project.findOne({ key: projectKey }).lean();
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const batch = project.file_processing_batch_size ?? 30;
    const pause = project.file_processing_pause_ms ?? 100;
    const conc = project.file_processing_concurrency ?? 3;
    const debounce = project.file_processing_debounce_ms ?? 5000;
    const slug = project.file_processing_prompt_slug?.trim() ?? '';
    const cats = project.file_processing_model_categories ?? [];
    const driver =
      project.file_processing_driver === 'agent' || project.file_processing_driver === 'prompt'
        ? project.file_processing_driver
        : 'prompt';
    const agentId = project.file_processing_agent_id;
    let agentToolName: string | null = null;
    if (agentId) {
      const ag = await Agent.findById(agentId).lean();
      agentToolName = ag && typeof ag.tool_name === 'string' ? ag.tool_name : null;
    }
    let file_processing_driver_display = '';
    if (driver === 'agent' && agentId) {
      file_processing_driver_display = agentToolName ? `agent:${agentToolName}` : 'agent:MISSING';
    } else {
      file_processing_driver_display = slug ? `prompt:${slug}` : 'prompt:_default';
    }
    return {
      projectKey,
      file_processing_batch_size: batch,
      file_processing_pause_ms: pause,
      file_processing_concurrency: conc,
      file_processing_debounce_ms: debounce,
      file_processing_driver: driver,
      file_processing_agent_id: agentId ? String(agentId) : '',
      file_processing_prompt_slug: slug,
      file_processing_model_categories: Array.isArray(cats) ? [...cats] : [],
      file_processing_driver_display
    };
  });

  fastify.put('/config/project-file-processing', async (request, reply) => {
    const projectKeyRaw = (request.query as Record<string, unknown> | undefined)?.projectKey;
    const projectKey =
      typeof projectKeyRaw === 'string' && projectKeyRaw.trim() !== '' ? projectKeyRaw.trim() : '';
    if (!projectKey) {
      return reply.code(400).send({ error: 'projectKey is required' });
    }
    const body = (request.body ?? {}) as Partial<{
      file_processing_batch_size: unknown;
      file_processing_pause_ms: unknown;
      file_processing_concurrency: unknown;
      file_processing_debounce_ms: unknown;
      file_processing_prompt_slug: unknown;
      file_processing_model_categories: unknown;
      file_processing_driver: unknown;
      file_processing_agent_id: unknown;
    }>;
    const project = await Project.findOne({ key: projectKey });
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (body.file_processing_batch_size !== undefined) {
 const n = Number(body.file_processing_batch_size);
 if (!Number.isFinite(n) || n < 1) return reply.code(400).send({ error: 'invalid file_processing_batch_size' });
 project.file_processing_batch_size = Math.min(10_000, Math.floor(n));
    }
    if (body.file_processing_pause_ms !== undefined) {
 const n = Number(body.file_processing_pause_ms);
 if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: 'invalid file_processing_pause_ms' });
 project.file_processing_pause_ms = Math.floor(n);
    }
    if (body.file_processing_concurrency !== undefined) {
 const n = Number(body.file_processing_concurrency);
 if (!Number.isFinite(n) || n < 1) return reply.code(400).send({ error: 'invalid file_processing_concurrency' });
 project.file_processing_concurrency = Math.min(100, Math.floor(n));
    }
    if (body.file_processing_debounce_ms !== undefined) {
 const n = Number(body.file_processing_debounce_ms);
 if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: 'invalid file_processing_debounce_ms' });
 project.file_processing_debounce_ms = Math.min(600_000, Math.floor(n));
    }
    if (body.file_processing_prompt_slug !== undefined) {
      const nextSlug = String(body.file_processing_prompt_slug).trim();
      if (nextSlug) {
        const doc = await SystemPrompt.findOne({ slug: nextSlug }).lean();
        if (!doc) return reply.code(400).send({ error: 'file_processing_prompt_slug not found' });
        const ut = effectivePromptUsageType(doc as { usage_type?: string; prompt_type?: string });
        if (ut.trim().toLowerCase() !== 'file processor') {
          return reply.code(400).send({ error: 'file_processing_prompt_slug must reference a file processor prompt' });
        }
      }
      project.file_processing_prompt_slug = nextSlug;
    }
    if (body.file_processing_model_categories !== undefined) {
 project.file_processing_model_categories = defaultModelCategoriesIfEmpty(
        normalizeModelCategoriesInput(body.file_processing_model_categories)
      );
    }
    if (body.file_processing_driver !== undefined) {
      const d = String(body.file_processing_driver).trim().toLowerCase();
      if (d !== 'prompt' && d !== 'agent') {
        return reply.code(400).send({ error: 'file_processing_driver must be prompt or agent' });
      }
      project.file_processing_driver = d as 'prompt' | 'agent';
    }
    if (body.file_processing_agent_id !== undefined) {
      const raw = body.file_processing_agent_id;
      if (raw === null || raw === '') {
        project.file_processing_agent_id = undefined;
      } else {
        const idStr = String(raw).trim();
        if (!Types.ObjectId.isValid(idStr)) {
          return reply.code(400).send({ error: 'invalid file_processing_agent_id' });
        }
        const oid = new Types.ObjectId(idStr);
        project.file_processing_agent_id = oid;
      }
    }
    const driver = project.file_processing_driver === 'agent' ? 'agent' : 'prompt';
    if (driver === 'agent' && !project.file_processing_agent_id) {
      return reply.code(400).send({ error: 'file_processing_agent_id is required when driver is agent' });
    }
    if (driver === 'prompt') {
      project.set('file_processing_agent_id', null);
    } else if (project.file_processing_agent_id) {
      const agRow = await Agent.findById(project.file_processing_agent_id).lean();
      if (!agRow) return reply.code(400).send({ error: 'agent not found' });
      if (!Boolean((agRow as { tools?: { file_watch?: boolean } }).tools?.file_watch)) {
        return reply.code(400).send({ error: 'file processing agent must have file watch enabled' });
      }
    }
    await project.save();
    const batch = project.file_processing_batch_size ?? 30;
    const pause = project.file_processing_pause_ms ?? 100;
    const conc = project.file_processing_concurrency ?? 3;
    const debounce = project.file_processing_debounce_ms ?? 5000;
    const slug = project.file_processing_prompt_slug?.trim() ?? '';
    const cats = project.file_processing_model_categories ?? [];
    let agentToolName: string | null = null;
    if (project.file_processing_agent_id) {
      const ag = await Agent.findById(project.file_processing_agent_id).lean();
      agentToolName = ag && typeof ag.tool_name === 'string' ? ag.tool_name : null;
    }
    const file_processing_driver_display =
      driver === 'agent' && project.file_processing_agent_id
        ? agentToolName
          ? `agent:${agentToolName}`
          : 'agent:MISSING'
        : slug
          ? `prompt:${slug}`
          : 'prompt:_default';
    return {
      ok: true,
      projectKey,
      file_processing_batch_size: batch,
      file_processing_pause_ms: pause,
      file_processing_concurrency: conc,
      file_processing_debounce_ms: debounce,
      file_processing_driver: driver,
      file_processing_agent_id: project.file_processing_agent_id
        ? String(project.file_processing_agent_id)
        : '',
      file_processing_prompt_slug: slug,
      file_processing_model_categories: Array.isArray(cats) ? [...cats] : [],
      file_processing_driver_display
    };
  });

  fastify.delete('/config/models/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const id = String(params.id ?? '').trim();
    if (!Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: 'invalid model id' });
    }
    const res = await LLMModel.findByIdAndDelete(id);
    if (!res) return reply.code(404).send({ error: 'model not found' });
    return { ok: true };
  });
}
