const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockDb = { collection: jest.fn() };

const mockInstance = {
  connect: mockConnect,
  close: mockClose,
  db: jest.fn().mockReturnValue(mockDb)
};

jest.mock('mongodb', () => ({
  MongoClient: jest.fn(() => mockInstance)
}));

import { connectToDatabase, closeDatabase } from '../src/db';

describe('db', () => {
  beforeEach(() => {
    mockConnect.mockClear();
    process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
  });

  it('connectToDatabase returns db and caches on second call', async () => {
    const db1 = await connectToDatabase();
    const db2 = await connectToDatabase();
    expect(db1).toBe(mockDb);
    expect(db2).toBe(db1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('throws when MONGO_URL is missing (fail-fast)', async () => {
    await closeDatabase();
    const origUrl = process.env.MONGO_URL;
    delete process.env.MONGO_URL;
    try {
      await expect(connectToDatabase()).rejects.toThrow('MONGO_URL is required');
    } finally {
      process.env.MONGO_URL = origUrl;
    }
  });

  it('closeDatabase closes client', async () => {
    await connectToDatabase();
    await closeDatabase();
    expect(mockClose).toHaveBeenCalled();
  });
});
