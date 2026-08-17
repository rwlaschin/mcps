export type LlmSlotCategory = 'fast' | 'blended' | 'thinking';

export type ProviderModel = {
  id: string;
  name: string;
  label: string;
  capabilities: string[];
  /** Vendor text (e.g. Gemini `description`) — best-for / use-case hints for the UI. */
  description?: string;
  /** UI default for Fast / Blended / Thinking before the user edits per row. */
  suggested_category?: LlmSlotCategory;
};

/** Heuristic category from provider + model id/label/description (Gemini: flash-lite→fast, flash→blended, pro→thinking). */
export function suggestedCategoryForDiscoveredModel(
  provider: string,
  m: Pick<ProviderModel, 'id' | 'name' | 'label'> & { description?: string }
): LlmSlotCategory {
  const p = provider.toLowerCase().trim();
  const blob = `${m.id} ${m.name} ${m.label} ${m.description ?? ''}`.toLowerCase();

  if (p === 'gemini' || p === 'google') {
    if (/(flash-lite|flash_lite)/.test(blob)) return 'fast';
    if (blob.includes('thinking') || blob.includes('reasoning')) return 'thinking';
    if (blob.includes('flash')) return 'blended';
    if (blob.includes('pro')) return 'thinking';
    return 'fast';
  }

  if (p === 'anthropic') {
    if (blob.includes('haiku')) return 'fast';
    if (blob.includes('opus')) return 'thinking';
    if (blob.includes('sonnet')) return 'blended';
    return 'blended';
  }

  if (p === 'openai' || p === 'openai_compatible') {
    if (/\bo3|o1\b|reason|thinking/i.test(blob)) return 'thinking';
    if (blob.includes('mini')) return 'fast';
    if (blob.includes('gpt-4') || blob.includes('gpt-5')) return 'blended';
    return 'fast';
  }

  return 'fast';
}

function attachDiscoveryMeta(provider: string, models: ProviderModel[]): ProviderModel[] {
  return models.map((m) => ({
    ...m,
    suggested_category: suggestedCategoryForDiscoveredModel(provider, m)
  }));
}

/**
 * Build GET …/models URL for APIs that follow OpenAI's "list models" shape (`{ data: [{ id }] }`).
 * If base already ends in /v1 (or /v2, etc.), append `/models`; otherwise append `/v1/models`.
 */
export function openAiCompatibleModelsListUrl(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v\d+$/.test(u)) return `${u}/models`;
  return `${u}/v1/models`;
}

/** Chat/inference root for GitHub Models (POST …/inference/chat/completions). Catalog is GET …/catalog/models. */
export const GITHUB_MODELS_INFERENCE_BASE = 'https://models.github.ai/inference';

export function isGithubModelsHostUrl(raw: string): boolean {
  try {
    return new URL(raw.trim()).hostname === 'models.github.ai';
  } catch {
    return false;
  }
}

/**
 * Any URL on models.github.ai is normalized to the inference API root so saved credentials match
 * OpenAI-style clients that append resource paths (and so we do not persist …/chat/completions or …/catalog/…).
 */
export function normalizeGithubModelsCredentialBaseUrl(raw: string): string {
  const t = raw.trim();
  if (!isGithubModelsHostUrl(t)) return t;
  return GITHUB_MODELS_INFERENCE_BASE;
}

/**
 * GitHub Models does not implement OpenAI's GET /v1/models; the catalog is a separate REST surface.
 * @see https://docs.github.com/en/rest/models/catalog
 */
export async function discoverGithubModelsCatalog(apiKey: string): Promise<ProviderModel[]> {
  const url = 'https://models.github.ai/catalog/models';
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10'
    }
  });
  if (!res.ok) {
    throw new Error(`GitHub Models catalog request failed with ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const arr = Array.isArray(body) ? body : [];
  return arr
    .map((row: Record<string, unknown>) => {
      const id = String(row.id ?? '').trim();
      const name = String(row.name ?? '').trim();
      const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
      const caps = Array.isArray(row.capabilities) ? row.capabilities.map(String) : [];
      const label = (name && name !== id ? name : id) || name || id;
      const out: ProviderModel = {
        id: id || name,
        name: id || name,
        label: label || id || name,
        capabilities: caps
      };
      if (summary) out.description = summary;
      return out;
    })
    .filter((m) => m.id.length > 0);
}

export async function discoverOpenAiCompatibleModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> {
  const url = openAiCompatibleModelsListUrl(baseUrl);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  if (!res.ok) throw new Error(`Provider request failed with ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const data = body.data ?? [];
  return data.map((m) => ({
    id: m.id,
    name: m.id,
    label: m.id,
    capabilities: []
  }));
}

export async function discoverOpenAiModels(apiKey: string): Promise<ProviderModel[]> {
  return discoverOpenAiCompatibleModels('https://api.openai.com/v1', apiKey);
}

export async function discoverGeminiModels(apiKey: string): Promise<ProviderModel[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gemini request failed with ${res.status}`);
  const body = (await res.json()) as {
    models?: Array<{
      name: string;
      displayName?: string;
      description?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  const data = body.models ?? [];
  return data.map((m) => {
    const desc = typeof m.description === 'string' ? m.description.trim() : '';
    const row: ProviderModel = {
      id: m.name,
      name: m.name,
      label: m.displayName || m.name,
      capabilities: m.supportedGenerationMethods ?? [],
      ...(desc ? { description: desc } : {})
    };
    return row;
  });
}

export async function discoverAnthropicModels(apiKey: string): Promise<ProviderModel[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  });
  if (!res.ok) throw new Error(`Anthropic request failed with ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  const data = body.data ?? [];
  return data.map((m) => ({
    id: m.id,
    name: m.id,
    label: m.display_name || m.id,
    capabilities: []
  }));
}

/**
 * Preset remotes that expose OpenAI-style `GET …/models` with `{ data: [{ id }] }`.
 * If a vendor changes their URL, use "Custom base URL" in the UI.
 */
export const OPENAI_COMPATIBLE_PRESETS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  perplexity: 'https://api.perplexity.ai',
  nebius: 'https://api.studio.nebius.com/v1',
  lepton: 'https://api.lepton.ai/api/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  novita: 'https://api.novita.ai/v3/openai/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  hyperbolic: 'https://api.hyperbolic.xyz/v1'
};

export async function discoverProviderModels(
  provider: string,
  apiKey: string,
  opts?: { base_url?: string }
): Promise<ProviderModel[]> {
  const normalized = provider.toLowerCase().trim();
  if (!apiKey) return [];
  if (normalized === 'openai') return attachDiscoveryMeta('openai', await discoverOpenAiModels(apiKey));
  if (normalized === 'gemini' || normalized === 'google') {
    return attachDiscoveryMeta('gemini', await discoverGeminiModels(apiKey));
  }
  if (normalized === 'anthropic') return attachDiscoveryMeta('anthropic', await discoverAnthropicModels(apiKey));
  if (normalized === 'openai_compatible') {
    const base = String(opts?.base_url ?? '').trim();
    if (!base) throw new Error('base_url is required for custom OpenAI-compatible providers');
    if (isGithubModelsHostUrl(base)) {
      return attachDiscoveryMeta('openai_compatible', await discoverGithubModelsCatalog(apiKey));
    }
    return attachDiscoveryMeta('openai_compatible', await discoverOpenAiCompatibleModels(base, apiKey));
  }
  const presetBase = OPENAI_COMPATIBLE_PRESETS[normalized];
  if (presetBase) {
    return attachDiscoveryMeta(normalized, await discoverOpenAiCompatibleModels(presetBase, apiKey));
  }
  return [];
}

export type LocalApiMode = 'ollama' | 'openai';

export type VerifyLocalResult =
  | { ok: true; modelsSample: string[] }
  | { ok: false; error: string };

/** Ping Ollama (`GET /api/tags`) or an OpenAI-compatible local server (`GET …/v1/models`). */
export async function verifyLocalConnection(params: {
  apiBaseUrl: string;
  mode: LocalApiMode;
  accessKey?: string;
  modelName?: string;
}): Promise<VerifyLocalResult> {
  const base = params.apiBaseUrl.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'Base URL is required.' };
  if (!/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error: 'Base URL must start with http:// or https:// (e.g. http://127.0.0.1:11434 for Ollama).'
    };
  }
  const want = params.modelName?.trim();
  try {
    if (params.mode === 'ollama') {
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) {
        return {
          ok: false,
          error: `Ollama returned HTTP ${res.status}. Check the server is running and the base URL is the origin only (e.g. http://127.0.0.1:11434), not …/v1.`
        };
      }
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (body.models ?? []).map((m) => m.name);
      if (want) {
        const found = names.some((n) => n === want || n.startsWith(`${want}:`) || n.split(':')[0] === want);
        if (!found) {
          const sample = names.slice(0, 8).join(', ') || '(no models pulled)';
          return {
            ok: false,
            error: `No tag matching "${want}". Try \`ollama list\`. Examples: ${sample}${names.length > 8 ? '…' : ''}`
          };
        }
      }
      return { ok: true, modelsSample: names.slice(0, 24) };
    }

    const listUrl = openAiCompatibleModelsListUrl(base);
    const headers: Record<string, string> = {};
    const k = params.accessKey?.trim();
    if (k) headers.Authorization = `Bearer ${k}`;
    const res = await fetch(listUrl, { headers });
    if (!res.ok) {
      return {
        ok: false,
        error: `OpenAI-compatible list failed (HTTP ${res.status}) at ${listUrl}. For LM Studio use a base like http://127.0.0.1:1234/v1`
      };
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (body.data ?? []).map((d) => d.id);
    if (want && !ids.includes(want)) {
      return {
        ok: false,
        error: `Model id "${want}" not in server list. Examples: ${ids.slice(0, 6).join(', ') || '(none)'}`
      };
    }
    return { ok: true, modelsSample: ids.slice(0, 24) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Connection failed';
    return { ok: false, error: `${msg} (is the host reachable from the stats server?)` };
  }
}
