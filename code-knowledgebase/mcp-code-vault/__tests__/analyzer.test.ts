jest.mock('../src/scannerRequirements', () => ({
  getProjectRoot: jest.fn().mockResolvedValue('/repo')
}));

const mockRunFileProcessingLlm = jest.fn();
jest.mock('../src/llm/runFileProcessingLlm', () => ({
  ...jest.requireActual<typeof import('../src/llm/runFileProcessingLlm')>('../src/llm/runFileProcessingLlm'),
  runFileProcessingLlm: (...args: unknown[]) => mockRunFileProcessingLlm(...args)
}));

import { analyzeFile } from '../src/analyzer';
import { getProjectRoot } from '../src/scannerRequirements';
import { MODEL_CALL_CALLER_SCAN_ANALYZE } from '../src/llm/runFileProcessingLlm';

describe('analyzeFile', () => {
  beforeEach(() => {
    mockRunFileProcessingLlm.mockReset();
    mockRunFileProcessingLlm.mockResolvedValue({
      summary: 'vault summary',
      usage: {},
      source: 'db_chain'
    });
  });

  it('delegates to runFileProcessingLlm with scan model_call caller', async () => {
    const out = await analyzeFile('proj', '/repo/src/a.ts');
    expect(out).toBe('vault summary');
    expect(getProjectRoot).toHaveBeenCalledWith('proj');
    expect(mockRunFileProcessingLlm).toHaveBeenCalledWith({
      projectKey: 'proj',
      filePath: '/repo/src/a.ts',
      rootDir: '/repo',
      caller: MODEL_CALL_CALLER_SCAN_ANALYZE
    });
  });

  it('propagates errors from runFileProcessingLlm', async () => {
    mockRunFileProcessingLlm.mockRejectedValueOnce(new Error('no models'));
    await expect(analyzeFile('proj', '/repo/x.ts')).rejects.toThrow('no models');
  });
});
