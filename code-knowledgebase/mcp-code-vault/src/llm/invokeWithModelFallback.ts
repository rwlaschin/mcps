import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { invokeChatWithOutputTruncationContinuation } from './invokeWithContinuation';
import { isRetryableLlmError, sleep } from './retryable';
import type { LlmTokenUsage } from './tokenUsage';

export type LlmModelAttemptMeta = {
  modelId: string;
  provider: string;
  label: string;
  name: string;
};

export type InvokeWithFallbackResult = {
  text: string;
  usage: LlmTokenUsage;
  used: LlmModelAttemptMeta;
  attempts: number;
  /** Number of LLM `invoke` calls on the winning model (includes max-output continuations). */
  continuationRounds?: number;
  outputTruncated?: boolean;
  lastFinishReason?: string;
};

export type ChatModelSlot = {
  meta: LlmModelAttemptMeta;
  chat: BaseChatModel;
};

/**
 * Try each chat model in order. Per model: small retry loop for transient errors, then rotate.
 */
export async function invokeWithModelFallback(params: {
  slots: ChatModelSlot[];
  messages: BaseMessage[];
  retriesPerModel?: number;
  baseDelayMs?: number;
  /** Cap on continuation turns when `finish_reason` is length / max_tokens (see `invokeWithContinuation.ts`). */
  maxContinuationRounds?: number;
}): Promise<InvokeWithFallbackResult> {
  const retriesPerModel = Math.max(0, params.retriesPerModel ?? 2);
  const baseDelayMs = Math.max(50, params.baseDelayMs ?? 400);
  const { messages } = params;
  if (!params.slots.length) {
    throw new Error('invokeWithModelFallback: no chat models in chain');
  }

  let totalAttempts = 0;
  let lastErr: unknown;

  for (const slot of params.slots) {
    for (let attempt = 0; attempt <= retriesPerModel; attempt++) {
      totalAttempts += 1;
      try {
        const cont = await invokeChatWithOutputTruncationContinuation({
          chat: slot.chat,
          messages,
          maxContinuationRounds: params.maxContinuationRounds
        });
        return {
          text: cont.text,
          usage: cont.usage,
          used: slot.meta,
          attempts: totalAttempts,
          continuationRounds: cont.rounds,
          outputTruncated: cont.outputTruncated,
          lastFinishReason: cont.lastFinishReason
        };
      } catch (e) {
        lastErr = e;
        const retryable = isRetryableLlmError(e);
        if (attempt < retriesPerModel && retryable) {
          const backoff = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 120);
          await sleep(backoff);
          continue;
        }
        break;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
