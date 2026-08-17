import { isRetryableLlmError, sleep } from '../src/llm/retryable';
import { HumanMessage } from '@langchain/core/messages';
import { messageContentToString, baseMessageText } from '../src/llm/messageText';
import { extractTokenUsageFromAiMessage } from '../src/llm/tokenUsage';

describe('llm retryable', () => {
  it('detects retryable patterns', () => {
    expect(isRetryableLlmError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableLlmError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableLlmError({ status: 503 })).toBe(true);
    expect(isRetryableLlmError(new Error('syntax error in prompt'))).toBe(false);
  });

  it('sleep resolves', async () => {
    const t0 = Date.now();
    await sleep(5);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3);
  });
});

describe('messageContentToString', () => {
  it('handles string and block arrays', () => {
    expect(messageContentToString('hi')).toBe('hi');
    expect(messageContentToString([{ type: 'text', text: 'a' }, 'b'])).toBe('ab');
  });
});

describe('baseMessageText', () => {
  it('reads HumanMessage content', () => {
    expect(baseMessageText(new HumanMessage('hello'))).toBe('hello');
  });
});

describe('extractTokenUsageFromAiMessage', () => {
  it('reads usage_metadata shape', () => {
    const u = extractTokenUsageFromAiMessage({
      usage_metadata: { input_tokens: 3, output_tokens: 7, reasoning_tokens: 2 }
    });
    expect(u).toEqual({ inputTokens: 3, outputTokens: 7, thinkingTokens: 2 });
  });

  it('reads response_metadata.token_usage', () => {
    const u = extractTokenUsageFromAiMessage({
      response_metadata: { token_usage: { prompt_tokens: 1, completion_tokens: 4 } }
    });
    expect(u).toEqual({ inputTokens: 1, outputTokens: 4 });
  });
});
