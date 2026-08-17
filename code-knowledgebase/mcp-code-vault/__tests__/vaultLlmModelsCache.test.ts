jest.mock('../src/db/models/LLMModel', () => ({
  LLMModel: {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        lean: jest.fn(() => ({
          exec: jest.fn().mockResolvedValue([
            {
              _id: '507f1f77bcf86cd799439011',
              name: 'm1',
              provider: 'openai',
              label: 'L',
              categories: ['fast'],
              priority: 10,
              enabled: true
            }
          ])
        }))
      }))
    }))
  }
}));

import { LLMModel } from '../src/db/models/LLMModel';
import {
  getCachedVaultLlmModels,
  invalidateVaultLlmModelsCache,
  resetVaultLlmModelsCacheForTesting
} from '../src/llm/vaultLlmModelsCache';

describe('vaultLlmModelsCache', () => {
  let randomSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    resetVaultLlmModelsCacheForTesting();
    jest.clearAllMocks();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it('loads from DB and caches', async () => {
    const a = await getCachedVaultLlmModels();
    expect(a).toHaveLength(1);
    expect(a[0]!.name).toBe('m1');
    await getCachedVaultLlmModels();
    const findMock = LLMModel.find as jest.Mock;
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateVaultLlmModelsCache forces a reload', async () => {
    await getCachedVaultLlmModels();
    invalidateVaultLlmModelsCache();
    await getCachedVaultLlmModels();
    expect((LLMModel.find as jest.Mock).mock.calls.length).toBe(2);
  });
});
