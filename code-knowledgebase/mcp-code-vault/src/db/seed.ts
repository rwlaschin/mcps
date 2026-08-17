import * as fs from 'fs';
import * as path from 'path';
import type { Types } from 'mongoose';
import { Persona } from './models/Persona';
import { LLMModel } from './models/LLMModel';
import { Project } from './models/Project';
import { Agent } from './models/Agent';
import {
  SystemPrompt,
  type PromptCategory,
  type PromptType,
  derivePromptTypeFromUsageType,
  deriveUsageTypeFromPromptType
} from './models/SystemPrompt';
import {
  defaultModelCategoriesIfEmpty,
  normalizeModelCategoriesInput
} from '../utils/modelCategories';

const SEED_DIR = 'configs/seed';
const PROMPTS_SEED_PRIMARY = 'prompts.json';
const PROMPTS_SEED_LEGACY = 'global-prompts.json';

interface PromptSeedRow {
  slug: string;
  name: string;
  prompt: string;
  usage_type?: string;
  prompt_type?: PromptType;
  category: PromptCategory;
  is_default?: boolean;
  save_to_seed?: boolean;
  structure_mode?: 'unstructured' | 'structured';
  structure_preset?: string;
  structure_mime?: 'application/json' | 'application/x-yaml-extended';
}

interface PersonaSeed {
  name: string;
  description: string;
  prompt: string;
}

interface ModelSeed {
  name: string;
  provider: string;
  label: string;
  categories?: string[];
}

interface ProjectSeed {
  name: string;
  key: string;
}

interface AgentSeed {
  name: string;
  description: string;
  system_prompt: string;
  tool_name: string;
  /** @deprecated use tool_name */
  focus?: string;
  project_key: string;
  model_categories?: string[];
  persona_names: string[];
  tools: { file_watch?: boolean; db_read_write?: boolean; web_search?: boolean; run_shell?: boolean };
  global_prompt_slug?: string;
}

function getSeedDir(): string {
  const cwd = process.cwd();
  const dir = path.join(cwd, SEED_DIR);
  if (!fs.existsSync(dir)) {
    throw new Error(`Seed config directory not found: ${dir} (cwd: ${cwd})`);
  }
  return dir;
}

function loadJson<T>(dir: string, file: string): T {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

export type SeedResult = 'ran' | 'skipped';

export type PromptSeedResult = 'inserted' | 'skipped' | 'no_file';

function resolvePromptsSeedPath(dir: string): string | null {
  const primary = path.join(dir, PROMPTS_SEED_PRIMARY);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(dir, PROMPTS_SEED_LEGACY);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/**
 * If the Mongo `prompts` collection is empty, inserts rows from configs/seed/prompts.json
 * (or legacy on-disk configs/seed/global-prompts.json when prompts.json is absent).
 * Safe to call on every startup (idempotent when data already exists).
 */
export async function ensurePromptsFromSeed(): Promise<PromptSeedResult> {
  const existing = await SystemPrompt.countDocuments();
  if (existing > 0) {
    return 'skipped';
  }
  const dir = getSeedDir();
  const filePath = resolvePromptsSeedPath(dir);
  if (!filePath) {
    return 'no_file';
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const rows = JSON.parse(raw) as PromptSeedRow[];
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'no_file';
  }
  for (const row of rows) {
    if (!row.slug || !row.name || !row.prompt || !row.category) {
      throw new Error(`Invalid prompt seed row (missing fields): ${JSON.stringify(row)}`);
    }
    const usageTypeRaw = String(row.usage_type ?? '').trim();
    const usageType =
      usageTypeRaw ||
      (row.prompt_type === 'processing' || row.prompt_type === 'agent'
        ? deriveUsageTypeFromPromptType(row.prompt_type)
        : '');
    if (!usageType) {
      throw new Error(`Invalid prompt seed row (usage_type or prompt_type required): ${JSON.stringify(row)}`);
    }
    const promptType: PromptType =
      row.prompt_type === 'processing' || row.prompt_type === 'agent'
        ? row.prompt_type
        : derivePromptTypeFromUsageType(usageType);
    await SystemPrompt.create({
      name: row.name,
      slug: row.slug,
      prompt: row.prompt,
      usage_type: usageType,
      prompt_type: promptType,
      category: row.category,
      is_default: Boolean(row.is_default),
      save_to_seed: row.save_to_seed ?? true,
      seed_baseline_prompt: row.prompt,
      structure_mode: row.structure_mode === 'structured' ? 'structured' : 'unstructured',
      structure_preset: String(row.structure_preset ?? 'agent_pipeline_steps').trim() || 'agent_pipeline_steps',
      structure_mime:
        row.structure_mime === 'application/x-yaml-extended'
          ? 'application/x-yaml-extended'
          : 'application/json'
    });
  }
  return 'inserted';
}

/**
 * Idempotent seed: loads personas, models, project, and agents from
 * configs/seed/*.json and inserts them only when the DB is empty (no personas).
 * Returns 'ran' when data was inserted, 'skipped' when DB already had data.
 */
export async function runSeed(): Promise<SeedResult> {
  const count = await Persona.countDocuments();
  if (count > 0) {
    return 'skipped';
  }

  const dir = getSeedDir();
  const personasSeed = loadJson<PersonaSeed[]>(dir, 'personas.json');
  const modelsSeed = loadJson<ModelSeed[]>(dir, 'models.json');
  const projectsSeed = loadJson<ProjectSeed[]>(dir, 'projects.json');
  const agentsSeed = loadJson<AgentSeed[]>(dir, 'agents.json');

  const nameToPersonaId = new Map<string, string>();
  for (const row of personasSeed) {
    const p = await Persona.create({
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      save_to_seed: true,
      seed_baseline_name: row.name,
      seed_baseline_description: row.description,
      seed_baseline_prompt: row.prompt
    });
    nameToPersonaId.set(p.name, p._id.toString());
  }

  const nameToModelId = new Map<string, string>();
  if (modelsSeed.length > 0) {
    const models = await LLMModel.insertMany(
      modelsSeed.map((row) => ({
        name: row.name,
        provider: row.provider,
        label: row.label,
        categories: defaultModelCategoriesIfEmpty(normalizeModelCategoriesInput(row.categories))
      }))
    );
    models.forEach((m) => nameToModelId.set(m.name, m._id.toString()));
  }

  const projects = await Project.insertMany(projectsSeed);
  const keyToProjectId = new Map<string, string>();
  projects.forEach((p) => keyToProjectId.set(p.key, p._id.toString()));

  await ensurePromptsFromSeed();

  for (const a of agentsSeed) {
    const toolName = (a.tool_name ?? a.focus ?? '').trim();
    if (!toolName) throw new Error(`Seed agent "${a.name}": tool_name is required`);
    const projectId = keyToProjectId.get(a.project_key);
    if (!projectId) throw new Error(`Seed agent "${a.name}": project_key "${a.project_key}" not found`);
    const personaIds = (a.persona_names || [])
      .map((n) => nameToPersonaId.get(n))
      .filter((id): id is string => id != null);
    const tools = {
      file_watch: a.tools?.file_watch ?? false,
      db_read_write: a.tools?.db_read_write ?? false,
      web_search: a.tools?.web_search ?? false,
      run_shell: a.tools?.run_shell ?? false
    };
    const model_categories = normalizeModelCategoriesInput(a.model_categories);
    let globalPromptOid: Types.ObjectId | null = null;
    let seedBaselineGlobalSlug: string | undefined;
    if (a.global_prompt_slug) {
      const gp = await SystemPrompt.findOne({ slug: a.global_prompt_slug }).select('_id').lean();
      if (gp?._id) {
        globalPromptOid = gp._id;
        seedBaselineGlobalSlug = a.global_prompt_slug;
      }
    }
    await Agent.create({
      name: a.name,
      description: a.description,
      system_prompt: a.system_prompt,
      tool_name: toolName,
      model_categories,
      project_id: projectId,
      persona_ids: personaIds,
      global_prompt_id: globalPromptOid ?? null,
      tools,
      save_to_seed: true,
      seed_baseline_description: a.description,
      seed_baseline_system_prompt: a.system_prompt,
      seed_baseline_tool_name: toolName,
      seed_baseline_model_categories: [...model_categories],
      seed_baseline_persona_names: [...(a.persona_names || [])],
      ...(seedBaselineGlobalSlug ? { seed_baseline_global_prompt_slug: seedBaselineGlobalSlug } : {}),
      seed_baseline_tools: { ...tools }
    });
  }
  return 'ran';
}
