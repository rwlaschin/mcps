import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as any).defineNuxtConfig = (config: any) => config;
});

describe('nuxt.config', () => {
  it('exports nuxt config with devServer', async () => {
    const mod = await import('../nuxt.config');
    const config = mod.default;
    expect(config).toBeDefined();
    expect(config.devServer).toBeDefined();
    expect(config.devServer.port).toBe(2999);
    expect(config.nitro).toBeDefined();
    expect(config.nitro.devProxy).toBeUndefined();
  });
});
