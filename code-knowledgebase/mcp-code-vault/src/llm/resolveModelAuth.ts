import type { Types } from 'mongoose';
import type { ILLMModel } from '../db/models/LLMModel';
import { ModelProviderCredential } from '../db/models/ModelProviderCredential';

export type ResolvedModelAuth = {
  apiKey: string;
  baseUrl?: string;
  localApiMode?: 'ollama' | 'openai';
};

function trimOrUndef(s: string | undefined | null): string | undefined {
  const t = String(s ?? '').trim();
  return t === '' ? undefined : t;
}

/**
 * Merge row-level `LLMModel` fields with optional shared `ModelProviderCredential`.
 * Callers still decide whether `apiKey` is required for a given provider.
 */
export async function resolveModelAuthForLlm(model: Pick<
  ILLMModel,
  'access_key' | 'api_base_url' | 'local_api_mode' | 'credential_id'
>): Promise<ResolvedModelAuth> {
  let apiKey = trimOrUndef(model.access_key) ?? '';
  let baseUrl = trimOrUndef(model.api_base_url);
  let localApiMode = model.local_api_mode;

  const cid = model.credential_id as Types.ObjectId | undefined | null;
  if (cid) {
    const row = await ModelProviderCredential.findById(cid).lean().exec();
    if (row) {
      const ck = trimOrUndef(row.access_key);
      if (ck) apiKey = ck;
      const bu = trimOrUndef(row.api_base_url);
      if (bu) baseUrl = bu;
      const lm = row.local_api_mode;
      if (lm === 'ollama' || lm === 'openai') localApiMode = lm;
    }
  }

  return { apiKey, baseUrl, localApiMode };
}

export async function batchResolveModelAuth(
  models: Array<Pick<ILLMModel, 'access_key' | 'api_base_url' | 'local_api_mode' | 'credential_id'>>
): Promise<ResolvedModelAuth[]> {
  const ids = new Set<string>();
  for (const m of models) {
    const id = m.credential_id?.toString();
    if (id) ids.add(id);
  }
  const creds =
    ids.size > 0
      ? await ModelProviderCredential.find({ _id: { $in: [...ids] } })
          .lean()
          .exec()
      : [];
  const byId = new Map(creds.map((c) => [String(c._id), c]));

  const out: ResolvedModelAuth[] = [];
  for (const m of models) {
    let apiKey = trimOrUndef(m.access_key) ?? '';
    let baseUrl = trimOrUndef(m.api_base_url);
    let localApiMode = m.local_api_mode;
    const id = m.credential_id?.toString();
    if (id) {
      const row = byId.get(id);
      if (row) {
        const ck = trimOrUndef(row.access_key);
        if (ck) apiKey = ck;
        const bu = trimOrUndef(row.api_base_url);
        if (bu) baseUrl = bu;
        const lm = row.local_api_mode;
        if (lm === 'ollama' || lm === 'openai') localApiMode = lm;
      }
    }
    out.push({ apiKey, baseUrl, localApiMode });
  }
  return out;
}
