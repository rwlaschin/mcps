const mockFindByIdExec = jest.fn();
const mockFindExec = jest.fn();

jest.mock('../src/db/models/ModelProviderCredential', () => ({
  ModelProviderCredential: {
    findById: jest.fn(() => ({
      lean: jest.fn(() => ({ exec: mockFindByIdExec }))
    })),
    find: jest.fn(() => ({
      lean: jest.fn(() => ({ exec: mockFindExec }))
    }))
  }
}));

import { Types } from 'mongoose';
import { ModelProviderCredential } from '../src/db/models/ModelProviderCredential';
import { batchResolveModelAuth, resolveModelAuthForLlm } from '../src/llm/resolveModelAuth';

describe('resolveModelAuth', () => {
  beforeEach(() => {
    mockFindByIdExec.mockReset();
    mockFindExec.mockReset();
    (ModelProviderCredential.findById as jest.Mock).mockClear();
    (ModelProviderCredential.find as jest.Mock).mockClear();
  });

  it('resolveModelAuthForLlm merges credential over model fields', async () => {
    const cid = new Types.ObjectId();
    mockFindByIdExec.mockResolvedValue({
      access_key: 'from-cred',
      api_base_url: 'https://cred.example',
      local_api_mode: 'openai'
    });
    const r = await resolveModelAuthForLlm({
      access_key: 'row-key',
      api_base_url: 'https://row.example',
      local_api_mode: 'ollama',
      credential_id: cid
    });
    expect(r.apiKey).toBe('from-cred');
    expect(r.baseUrl).toBe('https://cred.example');
    expect(r.localApiMode).toBe('openai');
    expect(ModelProviderCredential.findById).toHaveBeenCalledWith(cid);
  });

  it('resolveModelAuthForLlm uses model only when no credential', async () => {
    const r = await resolveModelAuthForLlm({
      access_key: '  k  ',
      api_base_url: undefined,
      local_api_mode: undefined,
      credential_id: undefined
    });
    expect(r.apiKey).toBe('k');
    expect(mockFindByIdExec).not.toHaveBeenCalled();
  });

  it('batchResolveModelAuth batches one find and maps per model', async () => {
    const id = new Types.ObjectId();
    mockFindExec.mockResolvedValue([
      { _id: id, access_key: 'batched', api_base_url: 'https://batch/v1', local_api_mode: 'openai' }
    ]);
    const out = await batchResolveModelAuth([
      { access_key: '', api_base_url: undefined, local_api_mode: undefined, credential_id: id },
      { access_key: 'solo', api_base_url: undefined, local_api_mode: undefined, credential_id: undefined }
    ]);
    expect(ModelProviderCredential.find).toHaveBeenCalledWith({ _id: { $in: [id.toString()] } });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      apiKey: 'batched',
      baseUrl: 'https://batch/v1',
      localApiMode: 'openai'
    });
    expect(out[1]).toEqual({ apiKey: 'solo', baseUrl: undefined, localApiMode: undefined });
  });

  it('batchResolveModelAuth skips find when no credential ids', async () => {
    const out = await batchResolveModelAuth([
      { access_key: 'a', api_base_url: undefined, local_api_mode: undefined, credential_id: undefined }
    ]);
    expect(ModelProviderCredential.find).not.toHaveBeenCalled();
    expect(out[0]).toEqual({ apiKey: 'a', baseUrl: undefined, localApiMode: undefined });
  });
});
