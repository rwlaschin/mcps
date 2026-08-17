import { logger } from '../src/logger';

describe('logger', () => {
  it('exposes info and fatal methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });
  it('can call info without throwing', () => {
    logger.info({ msg: 'test' });
  });
});
