import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  finishReasonImpliesMaxOutputLength,
  invokeChatWithOutputTruncationContinuation
} from '../src/llm/invokeWithContinuation';

describe('finishReasonImpliesMaxOutputLength', () => {
  it('treats length / max-token style reasons as truncations', () => {
    expect(finishReasonImpliesMaxOutputLength('length')).toBe(true);
    expect(finishReasonImpliesMaxOutputLength('MAX_TOKENS')).toBe(true);
    expect(finishReasonImpliesMaxOutputLength('max_output_tokens')).toBe(true);
  });

  it('treats normal stop as complete', () => {
    expect(finishReasonImpliesMaxOutputLength('stop')).toBe(false);
    expect(finishReasonImpliesMaxOutputLength('STOP')).toBe(false);
    expect(finishReasonImpliesMaxOutputLength('END_TURN')).toBe(false);
  });

  it('empty reason is not length', () => {
    expect(finishReasonImpliesMaxOutputLength('')).toBe(false);
  });
});

describe('invokeChatWithOutputTruncationContinuation', () => {
  it('chains user follow-ups when finish_reason is length then stop', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: 'part-a',
        response_metadata: { finish_reason: 'length' }
      })
      .mockResolvedValueOnce({
        content: 'part-b',
        response_metadata: { finish_reason: 'stop' }
      });
    const chat = { invoke } as unknown as BaseChatModel;

    const r = await invokeChatWithOutputTruncationContinuation({
      chat,
      messages: [new SystemMessage('sys'), new HumanMessage('hi')],
      maxContinuationRounds: 8
    });

    expect(r.text).toBe('part-apart-b');
    expect(r.rounds).toBe(2);
    expect(r.outputTruncated).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    const secondCall = invoke.mock.calls[1]![0] as unknown[];
    expect(secondCall.length).toBeGreaterThanOrEqual(4);
  });

  it('sets outputTruncated when max rounds exhausted on length', async () => {
    const invoke = jest.fn().mockResolvedValue({
      content: 'x'.repeat(200),
      response_metadata: { finish_reason: 'length' }
    });
    const chat = { invoke } as unknown as BaseChatModel;

    const r = await invokeChatWithOutputTruncationContinuation({
      chat,
      messages: [new HumanMessage('go')],
      maxContinuationRounds: 2
    });

    expect(r.outputTruncated).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(r.text.length).toBeGreaterThan(0);
  });
});
