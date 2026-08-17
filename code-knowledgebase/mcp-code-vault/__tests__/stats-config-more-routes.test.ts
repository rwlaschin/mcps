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
jest.mock('../src/stats/metricsClient', () => ({
  ...jest.requireActual('../src/stats/metricsClient'),
  postMetric: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs') as typeof import('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => '[]'),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn()
  };
});

const mockPromptLean = jest.fn().mockResolvedValue([]);
const mockSystemPromptGpInLean = jest.fn().mockResolvedValue([]);
const mockSystemPromptFindOneAndUpdate = jest.fn();
const mockSystemPromptCreate = jest.fn();
const mockSystemPromptFindById = jest.fn();
const mockSystemPromptFindOne = jest.fn().mockResolvedValue(null);
const mockSystemPromptCountDocuments = jest.fn().mockResolvedValue(0);
const mockSystemPromptUpdateMany = jest.fn().mockResolvedValue({});

jest.mock('../src/db/models/SystemPrompt', () => {
  const actual = jest.requireActual('../src/db/models/SystemPrompt') as typeof import('../src/db/models/SystemPrompt');
  return {
    ...actual,
    SystemPrompt: {
      find: jest.fn((q?: { _id?: unknown }) => {
        if (q && typeof q === 'object' && q._id != null) {
          return {
            select: () => ({ lean: mockSystemPromptGpInLean })
          };
        }
        return {
          sort: jest.fn(() => ({ lean: mockPromptLean }))
        };
      }),
      findOne: (...a: unknown[]) => mockSystemPromptFindOne(...a),
      findOneAndUpdate: (...a: unknown[]) => mockSystemPromptFindOneAndUpdate(...a),
      create: (...a: unknown[]) => mockSystemPromptCreate(...a),
      findById: (...a: unknown[]) => mockSystemPromptFindById(...a),
      countDocuments: (...a: unknown[]) => mockSystemPromptCountDocuments(...a),
      updateMany: (...a: unknown[]) => mockSystemPromptUpdateMany(...a)
    }
  };
});

const mockPersonaLean = jest.fn().mockResolvedValue([]);
/** `Persona.find({ _id: { $in } }).lean()` for agent list mapping */
const mockPersonaLeanByIds = jest.fn().mockResolvedValue([]);
const mockPersonaFindById = jest.fn();
const mockPersonaFindOne = jest.fn();
const mockPersonaCreate = jest.fn();
jest.mock('../src/db/models/Persona', () => ({
  Persona: {
    find: jest.fn((q?: unknown) => {
      if (q && typeof q === 'object' && q !== null && '_id' in q) {
        return { lean: () => mockPersonaLeanByIds() };
      }
      return { sort: jest.fn(() => ({ lean: mockPersonaLean })) };
    }),
    findOne: (...a: unknown[]) => mockPersonaFindOne(...a),
    get findById() {
      return mockPersonaFindById;
    },
    create: (...a: unknown[]) => mockPersonaCreate(...a)
  }
}));

/** Mongoose-like query: supports `await q` and `await q.lean()`. */
function asQuery<T>(doc: T | null) {
  const p = Promise.resolve(doc);
  return {
    lean: () => p,
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p)
  };
}

let projectFindOneDoc: Record<string, unknown> | null = null;
const mockProjectFindOne = jest.fn(() => asQuery(projectFindOneDoc));
const mockProjectFindById = jest.fn();
const mockProjectFindLean = jest.fn().mockResolvedValue([]);

jest.mock('../src/db/models/Project', () => ({
  Project: {
    get findOne() {
      return mockProjectFindOne;
    },
    findById: (...a: unknown[]) => mockProjectFindById(...a),
    find: jest.fn(() => ({
      lean: () => mockProjectFindLean()
    }))
  }
}));

const mockAgentLean = jest.fn().mockResolvedValue([]);
const mockAgentFindOne = jest.fn();
const mockAgentCreate = jest.fn();
const mockAgentFindById = jest.fn();
jest.mock('../src/db/models/Agent', () => ({
  Agent: {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({ lean: mockAgentLean }))
    })),
    findOne: (...a: unknown[]) => mockAgentFindOne(...a),
    create: (...a: unknown[]) => mockAgentCreate(...a),
    findById: (...a: unknown[]) => mockAgentFindById(...a)
  }
}));

const mockLLMLean = jest.fn().mockResolvedValue([]);
const mockLLMFindOne = jest.fn();
jest.mock('../src/db/models/LLMModel', () => ({
  LLMModel: {
    find: jest.fn(() => ({ lean: mockLLMLean })),
    findOne: (...a: unknown[]) => mockLLMFindOne(...a),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    findByIdAndDelete: jest.fn()
  }
}));

import * as fs from 'fs';
import { createStatsServer } from '../src/stats/server';

describe('Stats config — prompts, personas, agents', () => {
  let fastify: Awaited<ReturnType<typeof createStatsServer>> | undefined;

  beforeAll(async () => {
    fastify = await createStatsServer();
  }, 8000);

  afterAll(async () => {
    if (fastify) await fastify.close();
  });

  beforeEach(() => {
    mockPromptLean.mockResolvedValue([]);
    mockPersonaLean.mockResolvedValue([]);
    mockAgentLean.mockResolvedValue([]);
    projectFindOneDoc = null;
    mockSystemPromptFindOneAndUpdate.mockReset();
    mockSystemPromptCreate.mockReset();
    mockSystemPromptFindById.mockReset();
    mockSystemPromptFindOne.mockReset();
    mockSystemPromptFindOne.mockResolvedValue(null);
    mockSystemPromptCountDocuments.mockReset();
    mockSystemPromptCountDocuments.mockResolvedValue(0);
    mockSystemPromptGpInLean.mockReset();
    mockSystemPromptGpInLean.mockResolvedValue([]);
    mockSystemPromptUpdateMany.mockReset();
    mockPersonaFindById.mockReset();
    mockPersonaFindOne.mockReset();
    mockPersonaCreate.mockReset();
    mockPersonaLeanByIds.mockReset();
    mockPersonaLeanByIds.mockResolvedValue([]);
    mockAgentFindOne.mockReset();
    mockAgentCreate.mockReset();
    mockAgentFindById.mockReset();
    mockProjectFindById.mockReset();
    mockProjectFindLean.mockReset();
    mockProjectFindLean.mockResolvedValue([]);
    mockLLMFindOne.mockReset();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('[]');
    (fs.writeFileSync as jest.Mock).mockClear();
    (fs.mkdirSync as jest.Mock).mockClear();
  });

  it('GET /config/prompts returns prompts and seed meta', async () => {
    const res = await fastify!.inject({ method: 'GET', url: '/config/prompts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompts: unknown[]; seedBaselines: unknown };
    expect(Array.isArray(body.prompts)).toBe(true);
    expect(body).toHaveProperty('seedWriteEnabled');
  });

  it('GET /config/personas returns personas', async () => {
    const res = await fastify!.inject({ method: 'GET', url: '/config/personas' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { personas: unknown[] };
    expect(Array.isArray(body.personas)).toBe(true);
  });

  it('GET /config/agents without projectKey returns all agents with project_key', async () => {
    mockAgentLean.mockResolvedValue([
      {
        _id: 'a1',
        name: 'Coder',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        project_id: '507f1f77bcf86cd799439011',
        model_categories: ['fast'],
        persona_ids: [],
        tools: {},
        save_to_seed: false
      }
    ]);
    mockProjectFindLean.mockResolvedValue([{ _id: '507f1f77bcf86cd799439011', key: 'default' }]);
    const res = await fastify!.inject({ method: 'GET', url: '/config/agents' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: Array<{ name: string; project_key: string }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.name).toBe('Coder');
    expect(body.agents[0]!.project_key).toBe('default');
  });

  it('GET /config/agents returns empty when project missing', async () => {
    projectFindOneDoc = null;
    const res = await fastify!.inject({ method: 'GET', url: '/config/agents?projectKey=none' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });

  it('GET /config/agents maps agents when project exists', async () => {
    projectFindOneDoc = { _id: '507f1f77bcf86cd799439011', key: 'default' };
    mockAgentLean.mockResolvedValue([
      {
        _id: 'a1',
        name: 'Coder',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        model_categories: [],
        persona_ids: [],
        tools: {},
        save_to_seed: false
      }
    ]);
    const res = await fastify!.inject({ method: 'GET', url: '/config/agents?projectKey=default' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: Array<{ name: string; project_key: string; model_categories: string[] }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.name).toBe('Coder');
    expect(body.agents[0]!.project_key).toBe('default');
    expect(body.agents[0]!.model_categories).toEqual([]);
  });

  it('POST /config/prompts validates name and prompt', async () => {
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts',
      payload: { name: 'n', prompt: '' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /config/prompts rejects name that slugifies to empty', async () => {
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts',
      payload: { name: '!!!', prompt: 'body' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /config/prompts creates prompt when slug is free', async () => {
    mockSystemPromptFindOne.mockResolvedValueOnce(null);
    mockSystemPromptCreate.mockResolvedValue({
      _id: 'p1',
      name: 'Hello',
      slug: 'hello',
      prompt: 'text',
      prompt_type: 'processing',
      category: 'fast',
      is_default: false,
      save_to_seed: false
    });
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts',
      payload: { name: 'Hello', prompt: 'text', prompt_type: 'processing', category: 'fast' }
    });
    expect(res.statusCode).toBe(200);
    expect(mockSystemPromptCreate).toHaveBeenCalled();
  });

  it('POST /config/prompts returns 409 when slug already exists', async () => {
    mockSystemPromptFindOne.mockResolvedValueOnce({ _id: 'existing', slug: 'hello' });
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts',
      payload: { name: 'Hello', prompt: 'text', usage_type: 'file processor', category: 'fast' }
    });
    expect(res.statusCode).toBe(409);
    expect(mockSystemPromptCreate).not.toHaveBeenCalled();
  });

  it('PUT /config/prompts/:id returns 404 when missing', async () => {
    mockSystemPromptFindById.mockResolvedValue(null);
    const res = await fastify!.inject({
      method: 'PUT',
      url: '/config/prompts/507f1f77bcf86cd799439011',
      payload: { name: 'x' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /config/prompts/:id/restore-default returns 404 when missing', async () => {
    mockSystemPromptFindById.mockResolvedValue(null);
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts/507f1f77bcf86cd799439011/restore-default'
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /config/personas validates required fields', async () => {
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/personas',
      payload: { name: '', description: '', prompt: '' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /config/personas/:id returns 404 when missing', async () => {
    mockPersonaFindById.mockResolvedValue(null);
    const res = await fastify!.inject({
      method: 'PUT',
      url: '/config/personas/507f1f77bcf86cd799439011',
      payload: { name: 'x' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /config/personas/:id/restore-default returns 404 when missing', async () => {
    mockPersonaFindById.mockResolvedValue(null);
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/personas/507f1f77bcf86cd799439011/restore-default'
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /config/agents validates name', async () => {
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/agents',
      payload: { name: '' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /config/agents returns 404 when explicit projectKey not found', async () => {
    projectFindOneDoc = null;
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/agents',
      payload: {
        projectKey: 'missing',
        name: 'A',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f'
      }
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /config/agents returns 404 when no project exists and projectKey omitted', async () => {
    projectFindOneDoc = null;
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/agents',
      payload: {
        name: 'A',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f'
      }
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /config/agents returns model_categories and resolves persona_names', async () => {
    projectFindOneDoc = { _id: '507f1f77bcf86cd799439011', key: 'default' };
    const pid = '507f1f77bcf86cd799439013';
    const gpid = '507f1f77bcf86cd799439099';
    mockAgentLean.mockResolvedValue([
      {
        _id: 'a1',
        name: 'Coder',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        model_categories: ['fast', 'Vision'],
        persona_ids: [pid],
        global_prompt_id: gpid,
        tools: { file_watch: true, db_read_write: false, web_search: false, run_shell: false },
        save_to_seed: false
      }
    ]);
    mockPersonaLeanByIds.mockResolvedValue([{ _id: pid, name: 'Dev' }]);
    mockSystemPromptGpInLean.mockResolvedValue([{ _id: gpid, name: 'Prelude' }]);
    const res = await fastify!.inject({ method: 'GET', url: '/config/agents?projectKey=default' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      agents: Array<{
        model_categories: string[];
        persona_names: string[];
        global_prompt_id: string | null;
        global_prompt_name: string | null;
      }>;
    };
    expect(body.agents[0]!.model_categories).toEqual(['fast', 'Vision']);
    expect(body.agents[0]!.persona_names).toEqual(['Dev']);
    expect(body.agents[0]!.global_prompt_id).toBe(gpid);
    expect(body.agents[0]!.global_prompt_name).toBe('Prelude');
  });

  it('POST /config/prompts with is_default runs updateMany on other prompts', async () => {
    mockSystemPromptFindOne.mockResolvedValueOnce(null);
    mockSystemPromptCreate.mockResolvedValue({
      _id: 'pdef',
      name: 'Def',
      slug: 'def',
      prompt: 'x',
      prompt_type: 'processing',
      category: 'fast',
      is_default: true,
      save_to_seed: false
    });
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts',
      payload: { name: 'Def', prompt: 'body', usage_type: 'file processor', is_default: true }
    });
    expect(res.statusCode).toBe(200);
    expect(mockSystemPromptUpdateMany).toHaveBeenCalled();
  });

  it('PUT /config/prompts/:id updates fields and saves', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    mockSystemPromptFindById.mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      name: 'Old',
      slug: 'old',
      prompt: 'p',
      prompt_type: 'processing',
      category: 'fast',
      is_default: false,
      save_to_seed: false,
      save
    });
    mockSystemPromptFindOne.mockResolvedValueOnce(null);
    const res = await fastify!.inject({
      method: 'PUT',
      url: '/config/prompts/507f1f77bcf86cd799439011',
      payload: { name: 'NewName', prompt: 'np' }
    });
    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalled();
  });

  it('PUT /config/prompts/:id returns 409 when new name slug collides with another prompt', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    mockSystemPromptFindById.mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      name: 'Old',
      slug: 'old',
      prompt: 'p',
      prompt_type: 'processing',
      category: 'fast',
      is_default: false,
      save_to_seed: false,
      save
    });
    mockSystemPromptFindOne.mockResolvedValueOnce({ _id: 'other', slug: 'taken-name' });
    const res = await fastify!.inject({
      method: 'PUT',
      url: '/config/prompts/507f1f77bcf86cd799439011',
      payload: { name: 'Taken Name', prompt: 'np' }
    });
    expect(res.statusCode).toBe(409);
    expect(save).not.toHaveBeenCalled();
  });

  it('POST /config/prompts/:id/restore-default uses seed baseline when present', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify([{ slug: 'hello', name: 'Hello', prompt: 'from-seed', prompt_type: 'processing', category: 'fast' }])
    );
    const save = jest.fn().mockResolvedValue(undefined);
    mockSystemPromptFindById.mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      name: 'Hello',
      slug: 'hello',
      prompt: 'edited',
      prompt_type: 'processing',
      category: 'fast',
      seed_baseline_prompt: 'fallback',
      save
    });
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/prompts/507f1f77bcf86cd799439011/restore-default'
    });
    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalled();
  });

  it('POST /config/personas creates when name is unique', async () => {
    mockPersonaFindOne.mockResolvedValue(null);
    mockPersonaCreate.mockResolvedValue({
      _id: 'per1',
      name: 'P1',
      description: 'd',
      prompt: 'pr',
      save_to_seed: false
    });
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/personas',
      payload: { name: 'P1', description: 'd', prompt: 'pr' }
    });
    expect(res.statusCode).toBe(200);
    expect(mockPersonaCreate).toHaveBeenCalled();
  });

  it('POST /config/personas returns 409 when name exists', async () => {
    mockPersonaFindOne.mockResolvedValue({ _id: 'x' });
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/personas',
      payload: { name: 'Dup', description: 'd', prompt: 'p' }
    });
    expect(res.statusCode).toBe(409);
  });

  it('PUT /config/personas/:id updates and saves', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    mockPersonaFindById.mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      name: 'Orig',
      description: 'd0',
      prompt: 'p0',
      save_to_seed: false,
      save
    });
    const res = await fastify!.inject({
      method: 'PUT',
      url: '/config/personas/507f1f77bcf86cd799439011',
      payload: { description: 'd1' }
    });
    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalled();
  });

  it('POST /config/agents creates agent when project exists', async () => {
    projectFindOneDoc = { _id: '507f1f77bcf86cd799439011', key: 'default' };
    mockAgentFindOne.mockResolvedValue(null);
    mockLLMFindOne.mockResolvedValue(null);
    const gpOid = '507f1f77bcf86cd799439099';
    mockSystemPromptCountDocuments.mockResolvedValue(1);
    mockSystemPromptFindById.mockResolvedValue({ slug: 'audit-prelude', name: 'Audit prelude' });
    const created = {
      _id: 'ag1',
      name: 'Bot',
      description: 'd',
      system_prompt: 's',
      tool_name: 'f',
      project_id: '507f1f77bcf86cd799439011',
      model_categories: [],
      persona_ids: [],
      global_prompt_id: gpOid,
      tools: { file_watch: false, db_read_write: false, web_search: false, run_shell: false },
      save_to_seed: false,
      toObject: () => ({ name: 'Bot' }),
      save: jest.fn()
    };
    mockAgentCreate.mockResolvedValue(created);
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/agents',
      payload: {
        projectKey: 'default',
        name: 'Bot',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        model_categories: [],
        persona_names: [],
        global_prompt_id: gpOid
      }
    });
    expect(res.statusCode).toBe(200);
    expect(mockAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Bot',
        model_categories: [],
        seed_baseline_model_categories: [],
        seed_baseline_global_prompt_slug: 'audit-prelude',
        tools: {
          file_watch: true,
          db_read_write: true,
          web_search: true,
          run_shell: true
        },
        seed_baseline_tools: {
          file_watch: true,
          db_read_write: true,
          web_search: true,
          run_shell: true
        }
      })
    );
    const createdArg = mockAgentCreate.mock.calls[0]![0] as { global_prompt_id?: { toString: () => string } };
    expect(String(createdArg.global_prompt_id)).toBe(gpOid);
  });

  it('POST /config/agents returns 400 when global_prompt_id not found', async () => {
    projectFindOneDoc = { _id: '507f1f77bcf86cd799439011', key: 'default' };
    mockAgentFindOne.mockResolvedValue(null);
    mockSystemPromptCountDocuments.mockResolvedValue(0);
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/agents',
      payload: {
        projectKey: 'default',
        name: 'Bot',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        global_prompt_id: '507f1f77bcf86cd799439099'
      }
    });
    expect(res.statusCode).toBe(400);
    expect(mockAgentCreate).not.toHaveBeenCalled();
  });

  it('POST /config/agents creates agent when projectKey omitted and default project exists', async () => {
    projectFindOneDoc = { _id: '507f1f77bcf86cd799439011', key: 'default' };
    mockAgentFindOne.mockResolvedValue(null);
    mockLLMFindOne.mockResolvedValue(null);
    const created = {
      _id: 'ag2',
      name: 'GlobalBot',
      description: 'd',
      system_prompt: 's',
      tool_name: 'f',
      project_id: '507f1f77bcf86cd799439011',
      model_categories: [],
      persona_ids: [],
      tools: { file_watch: false, db_read_write: false, web_search: false, run_shell: false },
      save_to_seed: false,
      toObject: () => ({ name: 'GlobalBot' }),
      save: jest.fn()
    };
    mockAgentCreate.mockResolvedValue(created);
    const res = await fastify!.inject({
      method: 'POST',
      url: '/config/agents',
      payload: {
        name: 'GlobalBot',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        model_categories: [],
        persona_names: []
      }
    });
    expect(res.statusCode).toBe(200);
    expect(mockAgentCreate).toHaveBeenCalled();
  });

  it('PUT /config/agents/:id updates when project resolves', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    mockAgentFindById.mockResolvedValue({
      _id: '507f1f77bcf86cd799439014',
      name: 'Bot',
      description: 'd',
      system_prompt: 's',
      tool_name: 'f',
      model_categories: ['fast'],
      project_id: '507f1f77bcf86cd799439011',
      persona_ids: [],
      tools: { file_watch: true, db_read_write: false, web_search: false, run_shell: false },
      save_to_seed: false,
      toObject: () => ({}),
      save
    });
    mockProjectFindById.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', key: 'default' });
    const res = await fastify!.inject({
      method: 'PUT',
      url: '/config/agents/507f1f77bcf86cd799439014',
      payload: { tool_name: 'new' }
    });
    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalled();
  });
});
