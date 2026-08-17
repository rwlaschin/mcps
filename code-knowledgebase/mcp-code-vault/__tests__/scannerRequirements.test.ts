/**
 * Tests for checkScannerRequirements: scanner only runs when config and DB are valid.
 * Requirements: PORT (when not stdio), MONGO_URL, project exists and has root_path.
 */

const mockFindOne = jest.fn();

function chainResolve(value: unknown) {
  return {
    lean: () => ({ exec: () => Promise.resolve(value) }),
    exec: () => Promise.resolve(value)
  };
}

jest.mock('../src/stdioMode', () => ({
  stdioMode: false
}));

jest.mock('../src/db/mongoose', () => ({
  connectMongoose: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/db/models/Project', () => ({
  Project: {
    findOne: (...args: unknown[]) => mockFindOne(...args)
  }
}));

import { checkScannerRequirements } from '../src/scannerRequirements';
import { MOCK_STATS_PORT } from './testConstants';

const originalEnv = process.env;

describe('checkScannerRequirements', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.PORT = String(MOCK_STATS_PORT);
    process.env.MONGO_URL = 'mongodb://localhost:27017';
    mockFindOne.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws when PORT is missing and not stdio mode', async () => {
    process.env.PORT = '';
    await expect(checkScannerRequirements('my-project')).rejects.toThrow('PORT is required');
  });

  it('throws when PORT is undefined and not stdio mode', async () => {
    delete process.env.PORT;
    await expect(checkScannerRequirements('my-project')).rejects.toThrow('PORT is required');
  });

  it('throws when PORT is not a valid non-negative integer', async () => {
    process.env.PORT = 'abc';
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', root_path: '/path' }));
    await expect(checkScannerRequirements('my-project')).rejects.toThrow(
      'PORT must be a non-negative integer'
    );
  });

  it('throws when PORT is negative', async () => {
    process.env.PORT = '-1';
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', root_path: '/path' }));
    await expect(checkScannerRequirements('my-project')).rejects.toThrow(
      'PORT must be a non-negative integer'
    );
  });

  it('throws when MONGO_URL is missing', async () => {
    delete process.env.MONGO_URL;
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', root_path: '/path' }));
    await expect(checkScannerRequirements('my-project')).rejects.toThrow('MONGO_URL is required');
  });

  it('throws when MONGO_URL is empty', async () => {
    process.env.MONGO_URL = '';
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', root_path: '/path' }));
    await expect(checkScannerRequirements('my-project')).rejects.toThrow('MONGO_URL is required');
  });

  it('throws when project does not exist', async () => {
    mockFindOne.mockReturnValue(chainResolve(null));
    await expect(checkScannerRequirements('unknown-key')).rejects.toThrow(
      /project .* not found|Project not found|root_path/
    );
  });

  it('throws when project exists but has no root_path', async () => {
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', name: 'My Project' }));
    await expect(checkScannerRequirements('my-project')).rejects.toThrow(
      /project .* root_path|root_path|Project .* root/
    );
  });

  it('throws when project exists but root_path is empty string', async () => {
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', root_path: '' }));
    await expect(checkScannerRequirements('my-project')).rejects.toThrow(
      /project .* root_path|root_path|Project .* root/
    );
  });

  it('resolves when PORT, MONGO_URL, and project with root_path are valid', async () => {
    mockFindOne.mockReturnValue(chainResolve({ key: 'my-project', root_path: '/home/repo' }));
    await expect(checkScannerRequirements('my-project')).resolves.toBeUndefined();
  });

  it('queries project by key', async () => {
    mockFindOne.mockReturnValue(chainResolve({ key: 'proj-key', root_path: '/tmp/proj' }));
    await checkScannerRequirements('proj-key');
    expect(mockFindOne).toHaveBeenCalledWith({ key: 'proj-key' });
  });
});
