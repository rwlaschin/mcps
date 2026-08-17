import * as fs from 'fs';
import * as path from 'path';
import type { Types } from 'mongoose';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Project } from '../db/models/Project';
import { SystemPrompt } from '../db/models/SystemPrompt';
import { normalizeModelCategoryToken } from '../utils/modelCategories';
import { getGeminiLLM } from '../llm';
import { batchResolveModelAuth } from './resolveModelAuth';
import { createChatModelForSavedModel } from './createChatModelForSavedModel';
import { invokeWithModelFallback, type ChatModelSlot } from './invokeWithModelFallback';
import { invokeChatWithOutputTruncationContinuation } from './invokeWithContinuation';
import type { LlmTokenUsage } from './tokenUsage';
import { getCachedVaultLlmModels } from './vaultLlmModelsCache';
import { postModelCallMetric } from './postModelCallMetric';
import {
  loadAgentExecutionBundleById,
  type AgentExecutionBundle
} from '../agent/loadAgentExecutionBundle';

const MAX_FILE_CHARS = 120_000;

export type RunFileProcessingLlmResult = {
  summary: string;
  usage: LlmTokenUsage;
  source: 'db_chain' | 'env_gemini';
  modelLabel?: string;
  provider?: string;
  modelId?: string;
  attempts?: number;
  continuationRounds?: number;
  outputTruncated?: boolean;
  lastFinishReason?: string;
};

function filterModelsForProject(
  models: Awaited<ReturnType<typeof getCachedVaultLlmModels>>,
  categoriesFilter: string[] | undefined
): typeof models {
  if (!categoriesFilter?.length) return [...models];
  const want = new Set(
    categoriesFilter.map((c) => normalizeModelCategoryToken(c)).filter((c): c is string => Boolean(c))
  );
  return models.filter((m) => {
    const cats = m.categories.length ? m.categories : ['fast'];
    return cats.some((c) => want.has(normalizeModelCategoryToken(c)));
  });
}

async function resolveFileProcessorSystemPrompt(projectLean: {
  file_processing_prompt_slug?: string;
} | null): Promise<string> {
  const slug = projectLean?.file_processing_prompt_slug?.trim();
  if (slug) {
    const bySlug = await SystemPrompt.findOne({ slug }).lean().exec();
    if (bySlug?.prompt) return String(bySlug.prompt);
  }
  const def = await SystemPrompt.findOne({ usage_type: 'file processor', is_default: true }).lean().exec();
  if (def?.prompt) return String(def.prompt);
  const any = await SystemPrompt.findOne({ usage_type: 'file processor' }).lean().exec();
  if (any?.prompt) return String(any.prompt);
  return 'Summarize the following source file for indexing. Stay factual; describe symbols and responsibilities.';
}

function buildFileProcessingSystemFromBundle(bundle: AgentExecutionBundle): string {
  const parts: string[] = [];
  if (bundle.globalPrompt?.prompt) {
    parts.push(`[Global: ${bundle.globalPrompt.name}]\n${bundle.globalPrompt.prompt}`);
  }
  parts.push(bundle.agent.system_prompt);
  if (bundle.personas.length) {
    parts.push(
      'Personas (voice / expertise):\n' +
        bundle.personas.map((p) => `### ${p.name}\n${p.description}\n${p.prompt}`).join('\n\n')
    );
  }
  return parts.join('\n\n---\n\n');
}

type ResolvedFileProcessing = {
  systemText: string;
  categoriesFilter: string[] | undefined;
  fileProcessingDriver: string;
};

async function resolveFileProcessingForProject(projectLean: Record<string, unknown> | null): Promise<ResolvedFileProcessing> {
  const row = projectLean ?? {};
  const driver = row.file_processing_driver === 'agent' ? 'agent' : 'prompt';
  const agentIdRaw = row.file_processing_agent_id as Types.ObjectId | string | undefined | null;

  if (driver === 'agent' && agentIdRaw) {
    const bundle = await loadAgentExecutionBundleById(agentIdRaw);
    if (bundle) {
      const cats = bundle.agent.model_categories;
      return {
        systemText: buildFileProcessingSystemFromBundle(bundle),
        categoriesFilter: cats.length ? cats : undefined,
        fileProcessingDriver: `agent:${bundle.agent.tool_name}`
      };
    }
    return {
      systemText: await resolveFileProcessorSystemPrompt(
        row as { file_processing_prompt_slug?: string } | null
      ),
      categoriesFilter: (row.file_processing_model_categories as string[] | undefined)?.length
        ? (row.file_processing_model_categories as string[])
        : undefined,
      fileProcessingDriver: 'agent:MISSING'
    };
  }

  const slug = String(row.file_processing_prompt_slug ?? '').trim();
  const systemText = await resolveFileProcessorSystemPrompt(
    row as { file_processing_prompt_slug?: string } | null
  );
  const cats = row.file_processing_model_categories as string[] | undefined;
  return {
    systemText,
    categoriesFilter: cats?.length ? cats : undefined,
    fileProcessingDriver: slug ? `prompt:${slug}` : 'prompt:_default'
  };
}

/** @public Call-site identifiers for `model_call` metrics. */
export const MODEL_CALL_CALLER_FILE_PROCESSING = 'file_processing_watcher';
export const MODEL_CALL_CALLER_SCAN_ANALYZE = 'scan_analyze_file';

/**
 * File-indexing LLM step: resolves vault **`file processor`** prompts and model chain from Mongo,
 * with `GEMINI_API_KEY` fallback. Emits **`model_call`** metrics for every completion (success or error).
 */
export async function runFileProcessingLlm(params: {
  projectKey: string;
  filePath: string;
  rootDir: string;
  /** Passed through to `model_call` metadata (`caller`) for dashboards. */
  caller: string;
}): Promise<RunFileProcessingLlmResult> {
  const t0 = Date.now();
  const rel = path.relative(params.rootDir, params.filePath).split(path.sep).join('/') || params.filePath;
  const raw = fs.readFileSync(params.filePath, 'utf-8');
  const body =
    raw.length > MAX_FILE_CHARS ? `${raw.slice(0, MAX_FILE_CHARS)}\n\n[truncated]\n` : raw;

  const project = await Project.findOne({ key: params.projectKey }).lean().exec();
  const { systemText, categoriesFilter, fileProcessingDriver } = await resolveFileProcessingForProject(
    project as Record<string, unknown> | null
  );

  const messages = [new SystemMessage(systemText), new HumanMessage(`File: ${rel}\n\n---\n\n${body}`)];

  const cached = await getCachedVaultLlmModels();
  const candidates = filterModelsForProject(cached, categoriesFilter).sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
  );

  if (candidates.length > 0) {
    const auths = await batchResolveModelAuth(
      candidates.map((c) => ({
        access_key: c.access_key,
        api_base_url: c.api_base_url,
        local_api_mode: c.local_api_mode,
        credential_id: c.credential_id as Types.ObjectId | undefined
      }))
    );
    const slots: ChatModelSlot[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const doc = candidates[i]!;
      const auth = auths[i]!;
      const chat = createChatModelForSavedModel(
        {
          name: doc.name,
          provider: doc.provider,
          label: doc.label,
          local_api_mode: doc.local_api_mode,
          api_base_url: doc.api_base_url
        },
        auth,
        { temperature: 0.2 }
      );
      if (!chat) continue;
      slots.push({
        meta: {
          modelId: doc._id,
          provider: doc.provider,
          label: doc.label,
          name: doc.name
        },
        chat
      });
    }
    if (slots.length > 0) {
      try {
        const r = await invokeWithModelFallback({ slots, messages });
        const usage = r.usage;
        const out: RunFileProcessingLlmResult = {
          summary: r.text,
          usage,
          source: 'db_chain',
          modelLabel: r.used.label,
          provider: r.used.provider,
          modelId: r.used.modelId,
          attempts: r.attempts,
          continuationRounds: r.continuationRounds,
          outputTruncated: r.outputTruncated,
          lastFinishReason: r.lastFinishReason
        };
        await postModelCallMetric({
          projectKey: params.projectKey,
          caller: params.caller,
          durationMs: Date.now() - t0,
          status: 'ok',
          usage,
          provider: out.provider,
          modelId: out.modelId,
          modelLabel: out.modelLabel,
          filePath: rel,
          fileProcessingDriver,
          continuationRounds: out.continuationRounds,
          outputTruncated: out.outputTruncated,
          lastFinishReason: out.lastFinishReason
        });
        return out;
      } catch (e) {
        const durationMs = Date.now() - t0;
        await postModelCallMetric({
          projectKey: params.projectKey,
          caller: params.caller,
          durationMs,
          status: 'error',
          errorCode: e instanceof Error ? e.name : 'error',
          usage: {},
          filePath: rel,
          fileProcessingDriver
        });
        throw e;
      }
    }
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const durationMs = Date.now() - t0;
    await postModelCallMetric({
      projectKey: params.projectKey,
      caller: params.caller,
      durationMs,
      status: 'error',
      errorCode: 'no_llm_config',
      usage: {},
      filePath: rel,
      fileProcessingDriver
    });
    throw new Error(
      'No vault LLM models with usable credentials, and GEMINI_API_KEY is not set. Add models in Config or set GEMINI_API_KEY.'
    );
  }

  try {
    const llm = getGeminiLLM(apiKey);
    const cont = await invokeChatWithOutputTruncationContinuation({ chat: llm, messages });
    const out: RunFileProcessingLlmResult = {
      summary: cont.text,
      usage: cont.usage,
      source: 'env_gemini',
      provider: 'gemini',
      modelLabel: 'gemini-pro',
      continuationRounds: cont.rounds,
      outputTruncated: cont.outputTruncated,
      lastFinishReason: cont.lastFinishReason
    };
    await postModelCallMetric({
      projectKey: params.projectKey,
      caller: params.caller,
      durationMs: Date.now() - t0,
      status: 'ok',
      usage: cont.usage,
      provider: 'gemini',
      modelLabel: 'gemini-pro',
      filePath: rel,
      fileProcessingDriver,
      continuationRounds: cont.rounds,
      outputTruncated: cont.outputTruncated,
      lastFinishReason: cont.lastFinishReason
    });
    return out;
  } catch (e) {
    await postModelCallMetric({
      projectKey: params.projectKey,
      caller: params.caller,
      durationMs: Date.now() - t0,
      status: 'error',
      errorCode: e instanceof Error ? e.name : 'error',
      usage: {},
      provider: 'gemini',
      modelLabel: 'gemini-pro',
      filePath: rel,
      fileProcessingDriver
    });
    throw e;
  }
}
