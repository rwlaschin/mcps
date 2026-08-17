import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { baseMessageText } from './messageText';
import { extractTokenUsageFromAiMessage, type LlmTokenUsage } from './tokenUsage';

/**
 * Same idea as `DEFAULT_CONTINUATION_PROMPT` in Mathsense `llmShared.js`: next turn continues
 * from the tail of the previous output when the model stopped for max-output / length.
 */
export const DEFAULT_CONTINUATION_USER_PROMPT =
  'Continue the output from exactly where it left off. Here is the last part of the previous output:\n\n<START> {{lastChunk}} <END>\n\nOutput ONLY the continuation, no preamble or repeated content.';

const DEFAULT_SNIPPET_LEN = 500;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maxLlmContinuationRounds(): number {
  return parseIntEnv('FILE_PROCESSING_LLM_MAX_CONTINUATION_ROUNDS', 32);
}

function getFinishReason(msg: BaseMessage): string {
  const any = msg as unknown as Record<string, unknown>;
  const rm = any.response_metadata as Record<string, unknown> | undefined;
  if (rm && typeof rm === 'object') {
    const fr = rm.finish_reason ?? rm['finish_reason'];
    if (fr != null && fr !== '') {
      if (Array.isArray(fr)) return String(fr[0] ?? '');
      return String(fr);
    }
  }
  const ak = any.additional_kwargs as Record<string, unknown> | undefined;
  if (ak?.finish_reason != null) return String(ak.finish_reason);
  return '';
}

/**
 * Whether the provider stopped this turn because output hit the configured max (needs another user turn).
 * Mirrors `getResponse` in `llmShared.js` (`/LENGTH/i.test(finishReason)` plus common provider spellings).
 */
export function finishReasonImpliesMaxOutputLength(reason: string): boolean {
  const r = String(reason ?? '').trim();
  if (!r) return false;
  const u = r.toUpperCase();
  if (u === 'STOP' || u === 'END_TURN' || u === 'STOP_SEQUENCE') return false;
  return /LENGTH|MAX_TOKEN|MAX_OUTPUT|INCOMPLETE|LENGTH_CAP|TOKEN_LIMIT/i.test(r);
}

function mergeUsage(a: LlmTokenUsage, b: LlmTokenUsage): LlmTokenUsage {
  const inSum = (a.inputTokens ?? 0) + (b.inputTokens ?? 0);
  const outSum = (a.outputTokens ?? 0) + (b.outputTokens ?? 0);
  const thSum = (a.thinkingTokens ?? 0) + (b.thinkingTokens ?? 0);
  const out: LlmTokenUsage = {};
  if (inSum > 0) out.inputTokens = inSum;
  if (outSum > 0) out.outputTokens = outSum;
  if (thSum > 0) out.thinkingTokens = thSum;
  return out;
}

export type InvokeContinuationParams = {
  chat: BaseChatModel;
  messages: BaseMessage[];
  maxContinuationRounds?: number;
  lastChunkSnippetChars?: number;
  continuationUserPrompt?: string;
};

export type InvokeContinuationResult = {
  text: string;
  usage: LlmTokenUsage;
  rounds: number;
  lastFinishReason: string;
  /** True if we stopped only because `maxContinuationRounds` was hit while still length-limited. */
  outputTruncated: boolean;
};

/**
 * Invoke a chat model, then if `finish_reason` indicates output was cut by max tokens, send follow-up
 * user turns (continuation prompt + last chunk) until completion or round cap — same control flow as
 * `getResponse` in `functions/modules/llmShared.js`.
 */
export async function invokeChatWithOutputTruncationContinuation(
  params: InvokeContinuationParams
): Promise<InvokeContinuationResult> {
  const maxRounds = Math.max(1, params.maxContinuationRounds ?? maxLlmContinuationRounds());
  const snippetLen = Math.max(80, params.lastChunkSnippetChars ?? DEFAULT_SNIPPET_LEN);
  const tmpl = params.continuationUserPrompt ?? DEFAULT_CONTINUATION_USER_PROMPT;

  let conversation: BaseMessage[] = [...params.messages];
  const pieces: string[] = [];
  let merged: LlmTokenUsage = {};
  let lastFinish = '';
  let outputTruncated = false;
  let invokeRounds = 0;

  for (let i = 0; i < maxRounds; i++) {
    invokeRounds += 1;
    const ai = await params.chat.invoke(conversation);
    const text = baseMessageText(ai);
    if (text) pieces.push(text);
    merged = mergeUsage(merged, extractTokenUsageFromAiMessage(ai));
    lastFinish = getFinishReason(ai);

    const hitLength = finishReasonImpliesMaxOutputLength(lastFinish);
    if (!hitLength) {
      outputTruncated = false;
      break;
    }

    if (i === maxRounds - 1) {
      outputTruncated = true;
      break;
    }

    const lastPiece = pieces.length ? pieces[pieces.length - 1]! : text;
    const tail = lastPiece.slice(-snippetLen);
    if (!tail.trim()) {
      outputTruncated = true;
      break;
    }

    conversation = [...conversation, new AIMessage(text), new HumanMessage(tmpl.replace(/\{\{lastChunk\}\}/g, tail))];
  }

  return {
    text: pieces.join(''),
    usage: merged,
    rounds: Math.max(1, invokeRounds),
    lastFinishReason: lastFinish,
    outputTruncated
  };
}
