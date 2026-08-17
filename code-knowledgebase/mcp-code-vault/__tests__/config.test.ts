import { config } from '../src/config';

describe('config', () => {
  it('forces DB_NAME to mcp_code_vault', () => {
    expect(config.DB_NAME).toBe('mcp_code_vault');
  });
});
