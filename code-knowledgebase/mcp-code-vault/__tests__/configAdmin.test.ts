import type { FastifyReply } from 'fastify';
import { assertDevSeedWriteAllowed, isDevConfigSeedWrites } from '../src/stats/configAdmin';

describe('configAdmin', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('isDevConfigSeedWrites is true when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development';
    expect(isDevConfigSeedWrites()).toBe(true);
    process.env.NODE_ENV = 'test';
    expect(isDevConfigSeedWrites()).toBe(true);
  });

  it('isDevConfigSeedWrites is false in production', () => {
    process.env.NODE_ENV = 'production';
    expect(isDevConfigSeedWrites()).toBe(false);
  });

  it('assertDevSeedWriteAllowed returns true in non-production', () => {
    process.env.NODE_ENV = 'development';
    const reply = { code: jest.fn().mockReturnThis(), send: jest.fn() } as unknown as FastifyReply;
    expect(assertDevSeedWriteAllowed(reply)).toBe(true);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('assertDevSeedWriteAllowed sends 403 in production', () => {
    process.env.NODE_ENV = 'production';
    const reply = { code: jest.fn().mockReturnThis(), send: jest.fn() } as unknown as FastifyReply;
    expect(assertDevSeedWriteAllowed(reply)).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('development')
      })
    );
  });
});
