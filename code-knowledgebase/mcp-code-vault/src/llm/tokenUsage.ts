export type LlmTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
};

function num(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isFinite(x)) return Math.max(0, Math.floor(x));
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return undefined;
}

/**
 * Best-effort token counts from LangChain AIMessage / provider-specific metadata.
 * Providers differ; missing fields are omitted rather than guessed.
 */
export function extractTokenUsageFromAiMessage(msg: unknown): LlmTokenUsage {
  const m = msg as Record<string, unknown>;
  const usageMeta = m.usage_metadata as Record<string, unknown> | undefined;
  if (usageMeta && typeof usageMeta === 'object') {
    const input =
      num(usageMeta.input_tokens) ??
      num(usageMeta.prompt_tokens) ??
      num(usageMeta.inputTokens);
    const output =
      num(usageMeta.output_tokens) ??
      num(usageMeta.completion_tokens) ??
      num(usageMeta.outputTokens);
    const details = usageMeta.output_token_details as Record<string, unknown> | undefined;
    const thinking =
      num(details?.reasoning) ??
      num(usageMeta.reasoning_tokens) ??
      num(usageMeta.thoughtsTokenCount);
    const out: LlmTokenUsage = {};
    if (input !== undefined) out.inputTokens = input;
    if (output !== undefined) out.outputTokens = output;
    if (thinking !== undefined) out.thinkingTokens = thinking;
    if (Object.keys(out).length) return out;
  }

  const rm = m.response_metadata as Record<string, unknown> | undefined;
  if (rm && typeof rm === 'object') {
    const tu = rm.token_usage as Record<string, unknown> | undefined;
    if (tu && typeof tu === 'object') {
      const input = num(tu.prompt_tokens) ?? num(tu.input_tokens);
      const output = num(tu.completion_tokens) ?? num(tu.output_tokens);
      const total = num(tu.total_tokens);
      const out: LlmTokenUsage = {};
      if (input !== undefined) out.inputTokens = input;
      if (output !== undefined) out.outputTokens = output;
      else if (total !== undefined && input !== undefined) out.outputTokens = Math.max(0, total - input);
      if (Object.keys(out).length) return out;
    }
  }

  return {};
}
