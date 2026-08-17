import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ILLMModel } from '../db/models/LLMModel';
import type { ResolvedModelAuth } from './resolveModelAuth';

const PLACEHOLDER_LOCAL_KEY = 'ollama';

function normalizeProvider(p: string): string {
  return String(p ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function ollamaOpenAiBase(raw?: string): string | undefined {
  const u = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!u) return undefined;
  if (/\/v\d+$/.test(u)) return u;
  return `${u}/v1`;
}

/**
 * Construct a LangChain chat model for a saved `LLMModel` row + resolved credentials.
 * Returns `null` when configuration is unusable (caller should try the next model in the chain).
 */
export function createChatModelForSavedModel(
  model: Pick<
    ILLMModel,
    'name' | 'provider' | 'label' | 'local_api_mode' | 'api_base_url'
  >,
  auth: ResolvedModelAuth,
  opts?: { temperature?: number; maxOutputTokens?: number }
): BaseChatModel | null {
  const temperature = opts?.temperature ?? 0.2;
  const maxTokens = opts?.maxOutputTokens;
  const prov = normalizeProvider(model.provider);

  if (prov === 'google' || prov === 'gemini' || prov === 'google_genai' || prov === 'google-ai') {
    if (!auth.apiKey) return null;
    return new ChatGoogleGenerativeAI({
      apiKey: auth.apiKey,
      model: model.name,
      temperature
    });
  }

  if (
    prov === 'openai' ||
    prov === 'openai_compatible' ||
    prov === 'github' ||
    prov === 'github_models' ||
    prov === 'groq' ||
    prov === 'together' ||
    prov === 'mistral'
  ) {
    if (!auth.apiKey) return null;
    const configuration =
      auth.baseUrl && auth.baseUrl.trim() !== ''
        ? { baseURL: auth.baseUrl.trim().replace(/\/+$/, '') }
        : undefined;
    return new ChatOpenAI({
      model: model.name,
      apiKey: auth.apiKey,
      temperature,
      maxTokens,
      configuration
    });
  }

  if (prov === 'anthropic' || prov === 'claude') {
    if (!auth.apiKey) return null;
    return new ChatAnthropic({
      model: model.name,
      apiKey: auth.apiKey,
      temperature,
      maxTokens
    });
  }

  if (prov === 'local' || prov === 'ollama' || prov === 'lmstudio' || prov === 'localmodels') {
    const mode = auth.localApiMode ?? model.local_api_mode ?? 'openai';
    const base = auth.baseUrl ?? model.api_base_url;
    if (mode === 'openai') {
      const root = String(base ?? '').trim();
      if (!root) return null;
      const openAiRoot = ollamaOpenAiBase(root) ?? root;
      return new ChatOpenAI({
        model: model.name,
        apiKey: auth.apiKey.trim() !== '' ? auth.apiKey : PLACEHOLDER_LOCAL_KEY,
        temperature,
        maxTokens,
        configuration: { baseURL: openAiRoot }
      });
    }
    if (mode === 'ollama') {
      const root = String(base ?? '').trim();
      if (!root) return null;
      const openAiRoot = ollamaOpenAiBase(root);
      if (!openAiRoot) return null;
      return new ChatOpenAI({
        model: model.name,
        apiKey: auth.apiKey.trim() !== '' ? auth.apiKey : PLACEHOLDER_LOCAL_KEY,
        temperature,
        maxTokens,
        configuration: { baseURL: openAiRoot }
      });
    }
  }

  return null;
}
