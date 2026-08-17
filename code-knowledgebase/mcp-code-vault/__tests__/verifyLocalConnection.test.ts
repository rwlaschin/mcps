import { verifyLocalConnection } from '../src/stats/providerDiscovery';

describe('verifyLocalConnection', () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('rejects missing scheme', async () => {
    const r = await verifyLocalConnection({
      apiBaseUrl: '127.0.0.1:11434',
      mode: 'ollama'
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/http:\/\//i);
  });

  it('Ollama mode calls /api/tags', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'llama3:latest' }] })
    }) as unknown as typeof fetch;

    const r = await verifyLocalConnection({
      apiBaseUrl: 'http://127.0.0.1:11434',
      mode: 'ollama',
      modelName: 'llama3'
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelsSample).toContain('llama3:latest');
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags');
  });

  it('OpenAI mode lists models with optional bearer', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'local-model' }] })
    }) as unknown as typeof fetch;

    const r = await verifyLocalConnection({
      apiBaseUrl: 'http://127.0.0.1:1234/v1',
      mode: 'openai',
      accessKey: 'sekret',
      modelName: 'local-model'
    });
    expect(r.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sekret' }
      })
    );
  });
});
