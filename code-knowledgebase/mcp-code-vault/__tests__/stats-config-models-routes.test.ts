jest.mock('../src/db/mongoose', () => ({
  connectMongoose: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/db/seed', () => ({
  runSeed: jest.fn().mockResolvedValue('skipped'),
  ensurePromptsFromSeed: jest.fn().mockResolvedValue('skipped')
}));
jest.mock('../src/db/ensureProject', () => ({
  ensureProjectFromConfig: jest.fn().mockResolvedValue('unchanged' as const)
}));
jest.mock('../src/db/projectDb', () => ({
  ...jest.requireActual('../src/db/projectDb'),
  ensureProjectCollections: jest.fn().mockResolvedValue(undefined)
}));

const mockDiscover = jest.fn();
const mockVerify = jest.fn();
jest.mock('../src/stats/providerDiscovery', () => ({
  ...jest.requireActual('../src/stats/providerDiscovery'),
  discoverProviderModels: (...a: unknown[]) => mockDiscover(...a),
  verifyLocalConnection: (...a: unknown[]) => mockVerify(...a)
}));

const mockFindLean = jest.fn();
const mockFindSort = jest.fn(() => ({ lean: mockFindLean }));
const mockFind = jest.fn(() => ({ sort: mockFindSort }));
const mockFindOneAndUpdate = jest.fn();
const mockFindById = jest.fn();
const mockFindByIdAndDelete = jest.fn();

jest.mock('../src/db/models/LLMModel', () => ({
  LLMModel: {
    get find() {
      return mockFind;
    },
    get findOneAndUpdate() {
      return mockFindOneAndUpdate;
    },
    get findById() {
      return mockFindById;
    },
    get findByIdAndDelete() {
      return mockFindByIdAndDelete;
    }
  }
}));

const mockCredCreate = jest.fn();
const mockCredFindByIdLean = jest.fn();
const mockCredFindLean = jest.fn();
const mockCredUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });

jest.mock('../src/db/models/ModelProviderCredential', () => ({
  ModelProviderCredential: {
    create: (...args: unknown[]) => mockCredCreate(...args),
    findById: () => ({ lean: () => mockCredFindByIdLean() }),
    find: () => ({ lean: () => mockCredFindLean() }),
    updateOne: (...args: unknown[]) => mockCredUpdateOne(...args)
  }
}));

jest.mock('../src/stats/metricsClient', () => ({
  ...jest.requireActual('../src/stats/metricsClient'),
  postMetric: jest.fn().mockResolvedValue(undefined)
}));

import { Types } from 'mongoose';
import { createStatsServer } from '../src/stats/server';

function mockModelDoc(overrides: Record<string, unknown> = {}) {
  const doc = {
    provider: 'gemini',
    name: 'models/gemini-pro',
    label: 'Gemini Pro',
    access_key: 'secret',
    api_base_url: undefined as string | undefined,
    local_api_mode: undefined as string | undefined,
    categories: ['fast'] as string[],
    set: jest.fn(function (this: Record<string, unknown>, key: string, val: unknown) {
      this[key] = val;
    }),
    save: jest.fn().mockResolvedValue(undefined),
    toObject(this: Record<string, unknown>) {
      const { set: _s, save: _sv, toObject: _t, ...rest } = this;
      return { ...rest };
    },
    ...overrides
  };
  return doc;
}

describe('Stats config — LLM model routes', () => {
  let fastify: Awaited<ReturnType<typeof createStatsServer>> | undefined;

  beforeAll(async () => {
    fastify = await createStatsServer();
  }, 8000);

  afterAll(async () => {
    if (fastify) await fastify.close();
  });

  beforeEach(() => {
    mockDiscover.mockReset();
    mockVerify.mockReset();
    mockFindLean.mockReset();
    mockFindSort.mockReturnValue({ lean: mockFindLean });
    mockFind.mockReturnValue({ sort: mockFindSort });
    mockFindLean.mockResolvedValue([]);
    mockFindOneAndUpdate.mockReset();
    mockFindById.mockReset();
    mockFindByIdAndDelete.mockReset();
    mockCredCreate.mockReset();
    mockCredFindByIdLean.mockReset();
    mockCredFindLean.mockReset().mockResolvedValue([]);
    mockCredUpdateOne.mockClear();
  });

  describe('GET /config/models', () => {
    it('returns models from LLMModel.find', async () => {
      mockFindLean.mockResolvedValue([{ _id: 'a1', name: 'x', provider: 'openai' }]);
      const res = await fastify!.inject({ method: 'GET', url: '/config/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: Array<{ categories: string[] }> };
      expect(body.models).toHaveLength(1);
      expect(body.models[0]!.categories).toEqual(['fast']);
      expect(mockFind).toHaveBeenCalledWith({});
    });

    it('maps legacy category to categories in GET response', async () => {
      mockFindLean.mockResolvedValue([{ _id: 'a1', name: 'x', provider: 'openai', category: 'blended' }]);
      const res = await fastify!.inject({ method: 'GET', url: '/config/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: Array<{ categories: string[] }> };
      expect(body.models[0]!.categories).toEqual(['blended']);
    });

    it('normalizes legacy google provider id to gemini in GET response', async () => {
      mockFindLean.mockResolvedValue([{ _id: 'a1', name: 'x', provider: 'google' }]);
      const res = await fastify!.inject({ method: 'GET', url: '/config/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: Array<{ provider: string }> };
      expect(body.models[0]!.provider).toBe('gemini');
    });

    it('fills access_key from credential when model row omits it', async () => {
      const credId = new Types.ObjectId();
      mockFindLean.mockResolvedValue([
        {
          _id: 'a1',
          name: 'm1',
          provider: 'openai_compatible',
          credential_id: credId,
          api_base_url: 'https://models.github.ai/inference'
        }
      ]);
      mockCredFindLean.mockResolvedValue([
        { _id: credId, access_key: 'from-cred', api_base_url: 'https://models.github.ai/inference' }
      ]);
      const res = await fastify!.inject({ method: 'GET', url: '/config/models' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: Array<{ access_key?: string }> };
      expect(body.models[0]!.access_key).toBe('from-cred');
    });
  });

  describe('POST /config/models/discover', () => {
    it('returns 400 without access_key', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/discover',
        payload: { provider: 'openai' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('normalizes google provider to gemini and returns models', async () => {
      mockDiscover.mockResolvedValue([{ id: 'm', name: 'm', label: 'M', capabilities: [] }]);
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/discover',
        payload: { provider: 'google', access_key: 'k' }
      });
      expect(res.statusCode).toBe(200);
      expect(mockDiscover).toHaveBeenCalledWith('gemini', 'k', { base_url: undefined });
    });

    it('returns 502 when discover throws', async () => {
      mockDiscover.mockRejectedValue(new Error('vendor down'));
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/discover',
        payload: { provider: 'groq', access_key: 'k' }
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toContain('vendor down');
    });
  });

  describe('POST /config/models/credentials', () => {
    it('returns 400 without access_key for preset remote', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/credentials',
        payload: { provider: 'groq' }
      });
      expect(res.statusCode).toBe(400);
      expect(mockCredCreate).not.toHaveBeenCalled();
    });

    it('creates credential document', async () => {
      mockCredCreate.mockResolvedValue({
        toObject: () => ({
          _id: '507f1f77bcf86cd799439055',
          provider: 'gemini',
          access_key: 'secret'
        })
      });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/credentials',
        payload: { provider: 'gemini', access_key: 'secret' }
      });
      expect(res.statusCode).toBe(200);
      expect(mockCredCreate).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gemini', access_key: 'secret' })
      );
      expect((res.json() as { credential: { _id: string } }).credential._id).toBe('507f1f77bcf86cd799439055');
    });
  });

  describe('POST /config/models/verify-local', () => {
    it('returns 400 when api_base_url missing', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/verify-local',
        payload: { local_api_mode: 'ollama' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when verify fails', async () => {
      mockVerify.mockResolvedValue({ ok: false, error: 'nope' });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/verify-local',
        payload: { api_base_url: 'http://127.0.0.1:11434', local_api_mode: 'ollama' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns samples on success', async () => {
      mockVerify.mockResolvedValue({ ok: true, modelsSample: ['a', 'b'] });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models/verify-local',
        payload: { api_base_url: 'http://127.0.0.1:11434', local_api_mode: 'openai' }
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { modelsSample: string[] }).modelsSample).toEqual(['a', 'b']);
    });
  });

  describe('POST /config/models', () => {
    it('returns 400 when name missing', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: { provider: 'openai', access_key: 'k' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for local without api_base_url', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: { provider: 'local', access_key: '', name: 'llama', label: 'L' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for local with invalid scheme', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'local',
          name: 'llama',
          label: 'L',
          access_key: '',
          api_base_url: 'ftp://127.0.0.1:11434',
          local_api_mode: 'ollama'
        }
      });
      expect(res.statusCode).toBe(400);
    });

    it('upserts local model with base URL', async () => {
      mockFindOneAndUpdate.mockResolvedValue({ toObject: () => ({ ok: true }) });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'local',
          name: 'llama',
          label: 'L',
          api_base_url: 'http://127.0.0.1:11434',
          local_api_mode: 'openai'
        }
      });
      expect(res.statusCode).toBe(200);
      expect(mockFindOneAndUpdate).toHaveBeenCalled();
      const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown> }, unknown];
      expect(update.$set.local_api_mode).toBe('openai');
    });

    it('returns 400 for openai_compatible without api_base_url', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: { provider: 'openai_compatible', access_key: 'k', name: 'm', label: 'M' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for openai_compatible with invalid URL scheme', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'openai_compatible',
          access_key: 'k',
          name: 'm',
          label: 'M',
          api_base_url: 'ftp://host/v1'
        }
      });
      expect(res.statusCode).toBe(400);
    });

    it('persists api_base_url for openai_compatible', async () => {
      mockFindOneAndUpdate.mockResolvedValue({ toObject: () => ({}) });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'openai_compatible',
          access_key: 'k',
          name: 'custom-1',
          label: 'C',
          api_base_url: 'https://api.example.com/v1'
        }
      });
      expect(res.statusCode).toBe(200);
      const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown>; $unset?: object }, unknown];
      expect(update.$set.api_base_url).toBe('https://api.example.com/v1');
      expect(update.$set.categories).toEqual(['fast']);
      expect(update.$unset).toEqual({ local_api_mode: 1, category: 1 });
    });

    it('normalizes google to gemini on create', async () => {
      mockFindOneAndUpdate.mockResolvedValue({ toObject: () => ({}) });
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'google',
          access_key: 'gk',
          name: 'models/gemini-pro',
          label: 'Gemini'
        }
      });
      expect(res.statusCode).toBe(200);
      const [filter] = mockFindOneAndUpdate.mock.calls[0] as [
        { provider: string; name: string; $or?: unknown[] },
        unknown,
        unknown
      ];
      expect(filter.provider).toBe('gemini');
      expect(filter.name).toBe('models/gemini-pro');
      expect(filter.$or).toBeDefined();
    });

    it('uses credential_id in upsert filter when provided', async () => {
      mockCredFindByIdLean.mockResolvedValue({ provider: 'gemini' });
      mockFindOneAndUpdate.mockResolvedValue({ toObject: () => ({}) });
      const credentialId = '507f1f77bcf86cd799439012';
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'gemini',
          access_key: 'gk',
          credential_id: credentialId,
          name: 'models/gemini-pro',
          label: 'Gemini'
        }
      });
      expect(res.statusCode).toBe(200);
      const [filter] = mockFindOneAndUpdate.mock.calls[0] as [
        { provider: string; name: string; credential_id?: Types.ObjectId },
        unknown,
        unknown
      ];
      expect(filter.provider).toBe('gemini');
      expect(filter.name).toBe('models/gemini-pro');
      expect(filter.credential_id?.toString()).toBe(credentialId);
      const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown> }, unknown];
      expect(update.$set.credential_id?.toString()).toBe(credentialId);
    });

    it('returns 400 when credential_id does not exist', async () => {
      mockCredFindByIdLean.mockResolvedValue(null);
      const res = await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: {
          provider: 'gemini',
          access_key: 'gk',
          credential_id: '507f1f77bcf86cd799439012',
          name: 'models/x',
          label: 'X'
        }
      });
      expect(res.statusCode).toBe(400);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('unsets api_base_url for preset remote', async () => {
      mockFindOneAndUpdate.mockResolvedValue({ toObject: () => ({}) });
      await fastify!.inject({
        method: 'POST',
        url: '/config/models',
        payload: { provider: 'groq', access_key: 'gk', name: 'llama-3', label: 'L3' }
      });
      const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $unset?: Record<string, 1> }, unknown];
      expect(update.$unset).toEqual({ api_base_url: 1, local_api_mode: 1, category: 1 });
    });
  });

  describe('PUT /config/models/:id', () => {
    it('returns 404 when not found', async () => {
      mockFindById.mockResolvedValue(null);
      const res = await fastify!.inject({
        method: 'PUT',
        url: '/config/models/507f1f77bcf86cd799439011',
        payload: { label: 'x' }
      });
      expect(res.statusCode).toBe(404);
    });

    it('ignores provider in PUT body (provider is immutable)', async () => {
      const doc = mockModelDoc({ provider: 'openai_compatible', api_base_url: 'https://x/v1' });
      mockFindById.mockResolvedValue(doc);
      const res = await fastify!.inject({
        method: 'PUT',
        url: '/config/models/507f1f77bcf86cd799439011',
        payload: { provider: 'gemini' }
      });
      expect(res.statusCode).toBe(200);
      expect(doc.provider).toBe('openai_compatible');
    });

    it('updates openai_compatible api_base_url and clears local_api_mode', async () => {
      const doc = mockModelDoc({ provider: 'openai_compatible', api_base_url: 'https://old/v1' });
      mockFindById.mockResolvedValue(doc);
      const res = await fastify!.inject({
        method: 'PUT',
        url: '/config/models/507f1f77bcf86cd799439011',
        payload: { api_base_url: 'https://new/v1' }
      });
      expect(res.statusCode).toBe(200);
      expect(doc.api_base_url).toBe('https://new/v1');
      expect(doc.set).toHaveBeenCalledWith('local_api_mode', undefined);
    });

    it('updates local model base URL and mode', async () => {
      const doc = mockModelDoc({
        provider: 'local',
        api_base_url: 'http://127.0.0.1:11434',
        local_api_mode: 'ollama'
      });
      mockFindById.mockResolvedValue(doc);
      const res = await fastify!.inject({
        method: 'PUT',
        url: '/config/models/507f1f77bcf86cd799439011',
        payload: { api_base_url: 'http://127.0.0.1:11435', local_api_mode: 'openai' }
      });
      expect(res.statusCode).toBe(200);
      expect(doc.api_base_url).toBe('http://127.0.0.1:11435');
      expect(doc.local_api_mode).toBe('openai');
    });

    it('patches linked credential when model has credential_id', async () => {
      const credOid = new Types.ObjectId('507f1f77bcf86cd7994390aa');
      const doc = mockModelDoc({ credential_id: credOid });
      mockFindById.mockResolvedValue(doc);
      const res = await fastify!.inject({
        method: 'PUT',
        url: '/config/models/507f1f77bcf86cd799439011',
        payload: { access_key: 'rotated' }
      });
      expect(res.statusCode).toBe(200);
      expect(mockCredUpdateOne).toHaveBeenCalledWith(
        { _id: credOid },
        { $set: expect.objectContaining({ access_key: 'rotated' }) }
      );
    });
  });

  describe('DELETE /config/models/:id', () => {
    it('returns 400 for invalid ObjectId', async () => {
      const res = await fastify!.inject({
        method: 'DELETE',
        url: '/config/models/not-a-valid-id'
      });
      expect(res.statusCode).toBe(400);
      expect(mockFindByIdAndDelete).not.toHaveBeenCalled();
    });

    it('returns 404 when missing', async () => {
      mockFindByIdAndDelete.mockResolvedValue(null);
      const res = await fastify!.inject({
        method: 'DELETE',
        url: '/config/models/507f1f77bcf86cd799439011'
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns ok when deleted', async () => {
      mockFindByIdAndDelete.mockResolvedValue({ _id: 'x' });
      const res = await fastify!.inject({
        method: 'DELETE',
        url: '/config/models/507f1f77bcf86cd799439011'
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
    });
  });
});
