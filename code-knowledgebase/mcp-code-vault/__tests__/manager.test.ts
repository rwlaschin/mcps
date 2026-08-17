const mockInsertOne = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/db', () => ({
  connectToDatabase: jest.fn().mockResolvedValue({
    collection: jest.fn().mockReturnValue({ insertOne: mockInsertOne })
  })
}));

import { ProjectManager } from '../src/manager';

describe('ProjectManager', () => {
  beforeEach(() => {
    mockInsertOne.mockClear();
  });

  it('registerProject returns a key starting with VAULT- and 8 hex chars', async () => {
    const mgr = new ProjectManager();
    const key = await mgr.registerProject('/tmp', 'MyProject');
    expect(key).toMatch(/^VAULT-[A-F0-9]{8}$/);
  });

  it('registerProject calls insertOne with project doc', async () => {
    const mgr = new ProjectManager();
    await mgr.registerProject('/path', 'Name');
    expect(mockInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        root_path: '/path',
        name: 'Name',
        exclude_patterns: [],
        last_sync: null
      })
    );
  });
});
