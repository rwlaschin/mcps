import { describe, it, expect } from 'vitest';
import { APP_TITLE } from '../../lib/constants';

describe('constants', () => {
  it('APP_TITLE is set', () => {
    expect(APP_TITLE).toBe('MCP Code Vault - Platform');
  });
});
