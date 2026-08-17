import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as any).defineAppConfig = (config: any) => config;
});

describe('app.config', () => {
  it('exports app config with title', async () => {
    const mod = await import('../app.config');
    const config = mod.default;
    expect(config).toBeDefined();
    expect(config.title).toBe('MCP Code Vault - Platform');
  });
});
