import {
  discoverAnthropicModels,
  discoverGeminiModels,
  discoverGithubModelsCatalog,
  discoverOpenAiCompatibleModels,
  discoverProviderModels,
  GITHUB_MODELS_INFERENCE_BASE,
  normalizeGithubModelsCredentialBaseUrl,
  openAiCompatibleModelsListUrl,
  suggestedCategoryForDiscoveredModel
} from '../src/stats/providerDiscovery';

describe('openAiCompatibleModelsListUrl', () => {
  it('appends /v1/models when base has no version suffix', () => {
    expect(openAiCompatibleModelsListUrl('https://api.example.com')).toBe('https://api.example.com/v1/models');
    expect(openAiCompatibleModelsListUrl('https://api.example.com/')).toBe('https://api.example.com/v1/models');
  });

  it('appends /models when base already ends with /vN', () => {
    expect(openAiCompatibleModelsListUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(openAiCompatibleModelsListUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1/models');
    expect(openAiCompatibleModelsListUrl('https://api.novita.ai/v3/openai/v1')).toBe(
      'https://api.novita.ai/v3/openai/v1/models'
    );
  });
});

describe('discoverOpenAiCompatibleModels', () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('maps OpenAI list response to ProviderModel[]', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4' }, { id: 'gpt-4o' }] })
    }) as unknown as typeof fetch;
    const out = await discoverOpenAiCompatibleModels('https://api.x.com/v1', 'sk');
    expect(out).toEqual([
      { id: 'gpt-4', name: 'gpt-4', label: 'gpt-4', capabilities: [] },
      { id: 'gpt-4o', name: 'gpt-4o', label: 'gpt-4o', capabilities: [] }
    ]);
  });

  it('throws when response not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
    await expect(discoverOpenAiCompatibleModels('https://api.x.com/v1', 'sk')).rejects.toThrow('401');
  });
});

describe('discoverGeminiModels errors', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });
  it('throws when API returns non-OK', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    await expect(discoverGeminiModels('k')).rejects.toThrow('403');
  });
});

describe('discoverAnthropicModels errors', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });
  it('throws when API returns non-OK', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(discoverAnthropicModels('k')).rejects.toThrow('500');
  });
});

describe('suggestedCategoryForDiscoveredModel (openai_compatible)', () => {
  it('reuses OpenAI-style heuristics for custom OpenAI-compatible ids', () => {
    expect(
      suggestedCategoryForDiscoveredModel('openai_compatible', {
        id: 'openai/gpt-4o',
        name: 'openai/gpt-4o',
        label: 'GPT-4o'
      })
    ).toBe('blended');
  });
});

describe('suggestedCategoryForDiscoveredModel (Gemini)', () => {
  const m = (id: string, label: string, description?: string) =>
    suggestedCategoryForDiscoveredModel('gemini', { id, name: id, label, description });

  it('maps flash-lite to fast', () => {
    expect(m('models/gemini-2.0-flash-lite', 'Gemini 2.0 Flash-Lite')).toBe('fast');
  });
  it('maps flash (not lite) to blended', () => {
    expect(m('models/gemini-2.0-flash', 'Gemini 2.0 Flash')).toBe('blended');
  });
  it('maps pro to thinking', () => {
    expect(m('models/gemini-2.5-pro', 'Gemini 2.5 Pro')).toBe('thinking');
  });
  it('prefers thinking over flash when both appear (e.g. flash-thinking)', () => {
    expect(m('models/gemini-2.0-flash-thinking-exp', 'Flash Thinking')).toBe('thinking');
  });
});

describe('discoverGeminiModels', () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('maps Gemini models list including description', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: 'models/flash',
            displayName: 'Flash',
            description: 'Best for large scale processing, low latency.',
            supportedGenerationMethods: ['generateContent']
          }
        ]
      })
    }) as unknown as typeof fetch;
    const out = await discoverGeminiModels('gk');
    expect(out[0]).toMatchObject({
      id: 'models/flash',
      name: 'models/flash',
      label: 'Flash',
      capabilities: ['generateContent'],
      description: 'Best for large scale processing, low latency.'
    });
  });
});

describe('discoverAnthropicModels', () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('maps Anthropic models list', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-3', display_name: 'Claude 3' }]
      })
    }) as unknown as typeof fetch;
    const out = await discoverAnthropicModels('ak');
    expect(out[0]).toMatchObject({ id: 'claude-3', name: 'claude-3', label: 'Claude 3' });
  });
});

describe('normalizeGithubModelsCredentialBaseUrl', () => {
  it('rewrites any models.github.ai URL to the inference root', () => {
    expect(normalizeGithubModelsCredentialBaseUrl('https://models.github.ai/inference/chat/completions')).toBe(
      GITHUB_MODELS_INFERENCE_BASE
    );
    expect(normalizeGithubModelsCredentialBaseUrl('https://models.github.ai/catalog/models')).toBe(
      GITHUB_MODELS_INFERENCE_BASE
    );
  });
  it('leaves other hosts unchanged', () => {
    expect(normalizeGithubModelsCredentialBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
  });
});

describe('discoverGithubModelsCatalog', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('maps catalog array to ProviderModel rows', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'openai/gpt-4.1',
          name: 'GPT-4.1',
          summary: 'General reasoning',
          capabilities: ['chat']
        }
      ]
    }) as unknown as typeof fetch;
    const out = await discoverGithubModelsCatalog('ghp_test');
    expect(out[0]).toMatchObject({
      id: 'openai/gpt-4.1',
      name: 'openai/gpt-4.1',
      label: 'GPT-4.1',
      capabilities: ['chat'],
      description: 'General reasoning'
    });
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toBe('https://models.github.ai/catalog/models');
    const opts = (global.fetch as jest.Mock).mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Bearer ghp_test');
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
  });

  it('throws when catalog HTTP not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
    await expect(discoverGithubModelsCatalog('bad')).rejects.toThrow('401');
  });
});

describe('discoverProviderModels', () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('returns [] when api key empty', async () => {
    expect(await discoverProviderModels('openai', '')).toEqual([]);
  });

  it('throws for openai_compatible without base_url', async () => {
    await expect(discoverProviderModels('openai_compatible', 'k')).rejects.toThrow('base_url');
  });

  it('uses GitHub Models catalog when custom base is models.github.ai', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'xai/grok-2', name: 'Grok 2', capabilities: [] }]
    }) as unknown as typeof fetch;
    const out = await discoverProviderModels('openai_compatible', 'pat', {
      base_url: 'https://models.github.ai/inference/chat/completions'
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('xai/grok-2');
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('catalog/models');
  });

  it('uses preset base for groq', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'mixtral' }] })
    }) as unknown as typeof fetch;
    const out = await discoverProviderModels('groq', 'gk');
    expect(out).toHaveLength(1);
    expect(out[0].suggested_category).toBe('fast');
    expect(global.fetch).toHaveBeenCalled();
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('groq.com');
  });

  it('discovers openai via default API base', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] })
    }) as unknown as typeof fetch;
    const out = await discoverProviderModels('openai', 'sk');
    expect(out).toHaveLength(2);
    expect(out[0].suggested_category).toBe('fast');
    expect(out[1].suggested_category).toBe('blended');
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('openai.com');
  });

  it('returns [] for unknown provider slug', async () => {
    global.fetch = origFetch;
    expect(await discoverProviderModels('totally-unknown-vendor-xyz', 'k')).toEqual([]);
  });

  it('attaches suggested_category for gemini', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash-lite', displayName: 'Lite' },
          { name: 'models/gemini-2.0-flash', displayName: 'Flash' },
          { name: 'models/gemini-2.5-pro', displayName: 'Pro' }
        ]
      })
    }) as unknown as typeof fetch;
    const out = await discoverProviderModels('gemini', 'gk');
    expect(out.map((m) => [m.id, m.suggested_category])).toEqual([
      ['models/gemini-2.0-flash-lite', 'fast'],
      ['models/gemini-2.0-flash', 'blended'],
      ['models/gemini-2.5-pro', 'thinking']
    ]);
  });
});
