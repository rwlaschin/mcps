const mockPostMetric = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/stats/metricsClient', () => ({
  postMetric: mockPostMetric
}));

import { METRIC_OPERATION_MODEL_CALL } from '../src/llm/metricsConstants';
import { postModelCallMetric } from '../src/llm/postModelCallMetric';

describe('postModelCallMetric', () => {
  beforeEach(() => {
    mockPostMetric.mockClear();
  });

  it('posts model_call with snake_case token metadata', async () => {
    await postModelCallMetric({
      projectKey: 'p1',
      caller: 'unit_test',
      durationMs: 42,
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 3 },
      provider: 'google',
      modelId: 'mid',
      modelLabel: 'flash',
      filePath: 'src/x.ts'
    });
    expect(mockPostMetric).toHaveBeenCalledTimes(1);
    const body = mockPostMetric.mock.calls[0]![0];
    expect(body.operation).toBe(METRIC_OPERATION_MODEL_CALL);
    expect(body.duration_ms).toBe(42);
    expect(body.metadata).toMatchObject({
      projectKey: 'p1',
      caller: 'unit_test',
      provider: 'google',
      model_id: 'mid',
      model_label: 'flash',
      file_path: 'src/x.ts',
      tokens_in: 10,
      tokens_out: 20,
      tokens_thinking: 3
    });
  });
});
