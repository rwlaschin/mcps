import { calculateMD5 } from '../src/utils/hasher';
import * as fs from 'fs';
import * as path from 'path';

describe('calculateMD5', () => {
  const testFile = path.join(__dirname, 'testfile.txt');

  beforeAll(() => {
    fs.writeFileSync(testFile, 'hello world');
  });

  afterAll(() => {
    fs.unlinkSync(testFile);
  });

  it('returns a 32-character hex string', () => {
    const hash = calculateMD5(testFile);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(32);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('returns same hash for same content', () => {
    const a = calculateMD5(testFile);
    const b = calculateMD5(testFile);
    expect(a).toBe(b);
  });
});
