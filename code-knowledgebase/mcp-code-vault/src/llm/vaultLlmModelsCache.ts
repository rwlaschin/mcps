import { LLMModel } from '../db/models/LLMModel';
import { modelCategoriesFromDoc } from '../utils/modelCategories';

export type CachedVaultLlmModel = {
  _id: string;
  name: string;
  provider: string;
  label: string;
  categories: string[];
  priority: number;
  access_key?: string;
  credential_id?: unknown;
  api_base_url?: string;
  local_api_mode?: 'ollama' | 'openai';
};

const MAX_CACHE_MS = 5 * 60 * 1000;

let snapshot: { loadedAt: number; models: CachedVaultLlmModel[] } | null = null;
let inflight: Promise<CachedVaultLlmModel[]> | null = null;

function isSnapshotStale(): boolean {
  if (!snapshot) return true;
  if (Date.now() - snapshot.loadedAt > MAX_CACHE_MS) return true;
  return Math.random() < 0.05;
}

async function loadModelsFromDb(): Promise<CachedVaultLlmModel[]> {
  const rows = await LLMModel.find({ enabled: { $ne: false } })
    .sort({ priority: 1, name: 1 })
    .lean()
    .exec();

  return rows.map((m) => ({
    _id: String(m._id),
    name: String(m.name),
    provider: String(m.provider),
    label: String(m.label ?? m.name),
    categories: modelCategoriesFromDoc(m),
    priority: typeof m.priority === 'number' ? m.priority : 100,
    access_key: m.access_key ? String(m.access_key) : undefined,
    credential_id: m.credential_id,
    api_base_url: m.api_base_url ? String(m.api_base_url) : undefined,
    local_api_mode: m.local_api_mode === 'ollama' || m.local_api_mode === 'openai' ? m.local_api_mode : undefined
  }));
}

/**
 * Cached list of enabled vault models (5% random refresh + max age) to avoid hammering Mongo on every file.
 */
export async function getCachedVaultLlmModels(): Promise<CachedVaultLlmModel[]> {
  if (!isSnapshotStale() && snapshot) return snapshot.models;
  if (inflight) return inflight;

  inflight = loadModelsFromDb()
    .then((models) => {
      snapshot = { loadedAt: Date.now(), models };
      inflight = null;
      return models;
    })
    .catch((e) => {
      inflight = null;
      throw e;
    });

  return inflight;
}

/** Force next read to reload from Mongo (e.g. after config admin save). */
export function invalidateVaultLlmModelsCache(): void {
  snapshot = null;
}

/** Jest helper. */
export function resetVaultLlmModelsCacheForTesting(): void {
  snapshot = null;
  inflight = null;
}
