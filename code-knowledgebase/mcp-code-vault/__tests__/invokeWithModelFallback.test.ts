import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { invokeWithModelFallback } from '../src/llm/invokeWithModelFallback';

describe('invokeWithModelFallback', () => {
  it('uses first model on success', async () => {
    const good: Pick<BaseChatModel, 'invoke'> = {
      invoke: jest.fn().mockResolvedValue({ content: 'ok' })
    };
    const bad: Pick<BaseChatModel, 'invoke'> = {
      invoke: jest.fn().mockRejectedValue(new Error('429'))
    };
    const r = await invokeWithModelFallback({
      slots: [
        {
          meta: { modelId: '1', provider: 'openai', label: 'A', name: 'a' },
          chat: good as BaseChatModel
        },
        {
          meta: { modelId: '2', provider: 'openai', label: 'B', name: 'b' },
          chat: bad as BaseChatModel
        }
      ],
      messages: [new HumanMessage('hi')],
      retriesPerModel: 0
    });
    expect(r.text).toBe('ok');
    expect(r.used.modelId).toBe('1');
    expect(good.invoke).toHaveBeenCalledTimes(1);
    expect(bad.invoke).not.toHaveBeenCalled();
  });

  it('falls back when first fails non-retryable', async () => {
    const bad: Pick<BaseChatModel, 'invoke'> = {
      invoke: jest.fn().mockRejectedValue(new Error('invalid api key'))
    };
    const good: Pick<BaseChatModel, 'invoke'> = {
      invoke: jest.fn().mockResolvedValue({ content: 'fallback' })
    };
    const r = await invokeWithModelFallback({
      slots: [
        { meta: { modelId: '1', provider: 'x', label: 'bad', name: 'bad' }, chat: bad as BaseChatModel },
        { meta: { modelId: '2', provider: 'x', label: 'good', name: 'good' }, chat: good as BaseChatModel }
      ],
      messages: [new HumanMessage('x')],
      retriesPerModel: 0
    });
    expect(r.text).toBe('fallback');
    expect(r.used.modelId).toBe('2');
  });

  it('throws when chain exhausted', async () => {
    const bad: Pick<BaseChatModel, 'invoke'> = {
      invoke: jest.fn().mockRejectedValue(new Error('hard fail'))
    };
    await expect(
      invokeWithModelFallback({
        slots: [{ meta: { modelId: '1', provider: 'x', label: 'x', name: 'x' }, chat: bad as BaseChatModel }],
        messages: [new HumanMessage('x')],
        retriesPerModel: 0
      })
    ).rejects.toThrow('hard fail');
  });

  it('retries same model on retryable error then succeeds', async () => {
    const flaky: Pick<BaseChatModel, 'invoke'> = {
      invoke: jest
        .fn()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce({ content: 'after retry' })
    };
    const r = await invokeWithModelFallback({
      slots: [{ meta: { modelId: '1', provider: 'x', label: 'x', name: 'x' }, chat: flaky as BaseChatModel }],
      messages: [new HumanMessage('x')],
      retriesPerModel: 2,
      baseDelayMs: 1
    });
    expect(r.text).toBe('after retry');
    expect(flaky.invoke).toHaveBeenCalledTimes(2);
  });
});
