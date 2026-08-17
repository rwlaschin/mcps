/** Build a chain that matches Mongoose Query.lean().exec() returning the given result. */
function chainLean(result: unknown) {
  return {
    lean: () => ({
      exec: () => Promise.resolve(result)
    })
  };
}

jest.mock('../src/db/models/Project', () => {
  const findOne = jest.fn();
  const create = jest.fn();
  const updateOne = jest.fn();
  return {
    Project: {
      findOne: (...args: unknown[]) => findOne(...args),
      create: (...args: unknown[]) => create(...args),
      updateOne: (...args: unknown[]) => updateOne(...args)
    },
    __mocks: { findOne, create, updateOne }
  };
});

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), child: jest.fn(() => ({ info: jest.fn() })) }
}));

import { ensureProjectFromConfig } from '../src/db/ensureProject';

const { __mocks: mocks } = require('../src/db/models/Project') as {
  __mocks: { findOne: jest.Mock; create: jest.Mock; updateOne: jest.Mock };
};

describe('ensureProjectFromConfig', () => {
  beforeEach(() => {
    mocks.findOne.mockReset();
    mocks.create.mockReset();
    mocks.updateOne.mockReset();
  });

  it('returns "created" and creates project when none exists', async () => {
    mocks.findOne.mockImplementation(() => chainLean(null));

    mocks.create.mockResolvedValue(undefined);

    const result = await ensureProjectFromConfig('my-project', '/path/to/root');

    expect(result).toBe('created');
    expect(mocks.findOne).toHaveBeenCalledWith({ key: 'my-project' });
    expect(mocks.create).toHaveBeenCalledWith({
      name: 'my-project',
      key: 'my-project',
      root_path: '/path/to/root'
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('returns "updated" and updates root_path when project exists with different root_path', async () => {
    mocks.findOne.mockImplementation(() =>
      chainLean({ key: 'my-project', name: 'my-project', root_path: '/old/path' })
    );
    mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await ensureProjectFromConfig('my-project', '/new/path');

    expect(result).toBe('updated');
    expect(mocks.findOne).toHaveBeenCalledWith({ key: 'my-project' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { key: 'my-project' },
      { $set: { root_path: '/new/path' } }
    );
  });

  it('returns "unchanged" when project exists with same root_path', async () => {
    mocks.findOne.mockImplementation(() =>
      chainLean({ key: 'my-project', name: 'my-project', root_path: '/same/path' })
    );

    const result = await ensureProjectFromConfig('my-project', '/same/path');

    expect(result).toBe('unchanged');
    expect(mocks.findOne).toHaveBeenCalledWith({ key: 'my-project' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });
});
