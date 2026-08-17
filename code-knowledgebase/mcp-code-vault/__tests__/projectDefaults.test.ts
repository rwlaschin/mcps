import * as fs from 'fs';
import {
  readCurrentBranchFromRoot,
  ensureProjectDefaults
} from '../src/db/projectDefaults';

jest.mock('fs');
jest.mock('../src/scannerRequirements', () => ({
  getProjectRoot: jest.fn()
}));
jest.mock('../src/db/projectDb', () => ({
  ensureProjectCollections: jest.fn().mockResolvedValue(undefined)
}));

const mockEnsureProjectCollections = jest.requireMock('../src/db/projectDb').ensureProjectCollections as jest.Mock;

describe('projectDefaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('readCurrentBranchFromRoot', () => {
    it('returns branch name from ref: refs/heads/<name>', () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('ref: refs/heads/main\n');
      expect(readCurrentBranchFromRoot('/some/root')).toBe('main');
    });

    it('returns HEAD when detached or unreadable', () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('abc123\n');
      expect(readCurrentBranchFromRoot('/some/root')).toBe('HEAD');
    });

    it('returns HEAD when readFileSync throws', () => {
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(readCurrentBranchFromRoot('/some/root')).toBe('HEAD');
    });

    it('trims branch name', () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('ref: refs/heads/  develop  \n');
      expect(readCurrentBranchFromRoot('/some/root')).toBe('develop');
    });
  });

  describe('ensureProjectDefaults', () => {
    it('calls ensureProjectCollections with projectKey', async () => {
      await ensureProjectDefaults('my-key');

      expect(mockEnsureProjectCollections).toHaveBeenCalledWith('my-key');
    });
  });
});
