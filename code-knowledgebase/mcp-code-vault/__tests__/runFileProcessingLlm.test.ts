/**
 * @jest-environment node
 */

const mockGetCachedVaultLlmModels = jest.fn();
jest.mock('../src/llm/vaultLlmModelsCache', () => ({
  getCachedVaultLlmModels: (...args: unknown[]) => mockGetCachedVaultLlmModels(...args)
}));

const mockInvoke = jest.fn().mockResolvedValue({ content: 'summary text' });
jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation(() => ({ invoke: mockInvoke }))
}));

const mockPostMetric = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/stats/metricsClient', () => ({
  postMetric: mockPostMetric
}));

const mockProjectLean: {
  key: string
  file_processing_driver: 'prompt' | 'agent'
  file_processing_model_categories: string[]
  file_processing_agent_id?: string
  file_processing_prompt_slug?: string
} = {
  key: 'proj',
  file_processing_driver: 'prompt',
  file_processing_model_categories: ['fast']
};

jest.mock('../src/db/models/Project', () => ({
  Project: {
    findOne: jest.fn(() => ({
      lean: jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve(mockProjectLean))
      }))
    }))
  }
}));

const mockLoadAgentBundle = jest.fn();
jest.mock('../src/agent/loadAgentExecutionBundle', () => ({
  loadAgentExecutionBundleById: (...args: unknown[]) => mockLoadAgentBundle(...args)
}));

jest.mock('../src/db/models/SystemPrompt', () => ({
  SystemPrompt: {
    findOne: jest.fn(() => ({
      lean: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue({ prompt: 'SYS PROMPT' })
      }))
    }))
  }
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { METRIC_OPERATION_MODEL_CALL } from '../src/llm/metricsConstants';
import { runFileProcessingLlm } from '../src/llm/runFileProcessingLlm';

const CALLER_TEST = 'test_caller';

const defaultModels = [
  {
    _id: '507f1f77bcf86cd799439011',
    name: 'gemini-flash',
    provider: 'google',
    label: 'G',
    categories: ['fast'],
    priority: 1,
    access_key: 'test-key'
  }
];

describe('runFileProcessingLlm', () => {
  let tmp: string;
  const origGemini = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    mockProjectLean.file_processing_driver = 'prompt';
    delete mockProjectLean.file_processing_agent_id;
    mockProjectLean.file_processing_model_categories = ['fast'];
    mockLoadAgentBundle.mockReset();
    mockInvoke.mockClear().mockResolvedValue({ content: 'summary text' });
    mockPostMetric.mockClear();
    mockGetCachedVaultLlmModels.mockReset().mockResolvedValue(defaultModels);
    process.env.GEMINI_API_KEY = origGemini;
    tmp = path.join(os.tmpdir(), `fv-${Date.now()}.ts`);
    fs.writeFileSync(tmp, 'export const x = 1;\n', 'utf-8');
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGemini;
  });

  it('invokes vault model chain and posts model_call with UI token keys', async () => {
    const r = await runFileProcessingLlm({
      projectKey: 'proj',
      filePath: tmp,
      rootDir: path.dirname(tmp),
      caller: CALLER_TEST
    });
    expect(r.source).toBe('db_chain');
    expect(r.summary).toBe('summary text');
    expect(mockInvoke).toHaveBeenCalled();
    const rows = mockPostMetric.mock.calls.map((c) => c[0]).filter((p) => p.operation === METRIC_OPERATION_MODEL_CALL);
    expect(rows.some((m) => m.status === 'ok')).toBe(true);
    const ok = rows.find((m) => m.status === 'ok');
    expect(ok?.metadata).toMatchObject({
      projectKey: 'proj',
      caller: CALLER_TEST,
      tokens_in: undefined,
      tokens_out: undefined
    });
    expect(ok?.metadata).toHaveProperty('file_path');
    expect(ok?.metadata).toMatchObject({ file_processing_driver: 'prompt:_default' });
  });

  it('uses agent bundle when driver is agent and posts driver tag', async () => {
    mockProjectLean.file_processing_driver = 'agent';
    mockProjectLean.file_processing_agent_id = '507f1f77bcf86cd799439012';
    mockLoadAgentBundle.mockResolvedValue({
      agent: {
        name: 'Idx',
        description: 'd',
        system_prompt: 'AGENT SYS',
        tool_name: 'index_stuff',
        model_categories: ['fast'],
        tools: { file_watch: false, db_read_write: false, web_search: false, run_shell: false }
      },
      globalPrompt: null,
      personas: []
    });
    const r = await runFileProcessingLlm({
      projectKey: 'proj',
      filePath: tmp,
      rootDir: path.dirname(tmp),
      caller: CALLER_TEST
    });
    expect(r.source).toBe('db_chain');
    expect(mockLoadAgentBundle).toHaveBeenCalled();
    const rows = mockPostMetric.mock.calls.map((c) => c[0]).filter((p) => p.operation === METRIC_OPERATION_MODEL_CALL);
    const ok = rows.find((m) => m.status === 'ok');
    expect(ok?.metadata).toMatchObject({ file_processing_driver: 'agent:index_stuff' });
  });

  it('falls back to GEMINI when vault has no usable models', async () => {
    mockGetCachedVaultLlmModels.mockResolvedValueOnce([]);
    process.env.GEMINI_API_KEY = 'env-gemini';
    mockInvoke.mockResolvedValueOnce({ content: 'from env' });
    const r = await runFileProcessingLlm({
      projectKey: 'proj',
      filePath: tmp,
      rootDir: path.dirname(tmp),
      caller: CALLER_TEST
    });
    expect(r.source).toBe('env_gemini');
    expect(r.summary).toBe('from env');
    expect(mockInvoke).toHaveBeenCalled();
    const rows = mockPostMetric.mock.calls.map((c) => c[0]).filter((p) => p.operation === METRIC_OPERATION_MODEL_CALL);
    expect(rows.some((m) => m.status === 'ok')).toBe(true);
  });

  it('throws and posts model_call error when no vault models and no GEMINI_API_KEY', async () => {
    mockGetCachedVaultLlmModels.mockResolvedValueOnce([]);
    delete process.env.GEMINI_API_KEY;
    await expect(
      runFileProcessingLlm({
        projectKey: 'proj',
        filePath: tmp,
        rootDir: path.dirname(tmp),
        caller: CALLER_TEST
      })
    ).rejects.toThrow(/GEMINI_API_KEY/);
    const errRows = mockPostMetric.mock.calls.map((c) => c[0]).filter((p) => p.operation === METRIC_OPERATION_MODEL_CALL);
    expect(errRows.some((m) => m.status === 'error')).toBe(true);
  });
});
