const mockUpdateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });

jest.mock('../src/db/models/Agent', () => ({
  Agent: {
    collection: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args)
    }
  }
}));

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn() }
}));

import { migrateAgentFocusToToolName } from '../src/db/migrateAgentToolName';
import { logger } from '../src/logger';

describe('migrateAgentFocusToToolName', () => {
  beforeEach(() => {
    mockUpdateMany.mockClear().mockResolvedValue({ modifiedCount: 0 });
    jest.mocked(logger.info).mockClear();
    jest.mocked(logger.warn).mockClear();
  });

  it('runs two aggregation pipeline updates', async () => {
    await migrateAgentFocusToToolName();
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });

  it('logs info when rows were renamed', async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 2 })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    await migrateAgentFocusToToolName();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_tool_name_migration' })
    );
  });

  it('warns when updateMany throws', async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error('db down'));
    await migrateAgentFocusToToolName();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_tool_name_migration_failed' })
    );
  });
});
