const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);

jest.mock('mongoose', () => ({
  __esModule: true,
  default: {
    connect: mockConnect,
    disconnect: mockDisconnect,
    models: {},
    model: jest.fn()
  }
}));

jest.mock('../src/db/migrateAgentToolName', () => ({
  migrateAgentFocusToToolName: jest.fn().mockResolvedValue(undefined)
}));

import { connectMongoose, disconnectMongoose } from '../src/db/mongoose';

describe('mongoose', () => {
  beforeEach(() => {
    mockDisconnect.mockClear();
    process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
  });

  describe('connectMongoose', () => {
    it('calls mongoose.connect with a mongo url', async () => {
      await connectMongoose();
      expect(mockConnect).toHaveBeenCalledWith(expect.stringMatching(/^mongodb:\/\//));
    });

    it('returns without calling connect again when already connected', async () => {
      await connectMongoose();
      await connectMongoose();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnectMongoose', () => {
    it('calls mongoose.disconnect when connected', async () => {
      await connectMongoose();
      await disconnectMongoose();
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });
});
