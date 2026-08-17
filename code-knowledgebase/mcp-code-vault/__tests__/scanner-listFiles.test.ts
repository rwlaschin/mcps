import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listFilesUnderRoot } from '../src/scanner';

describe('listFilesUnderRoot', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-list-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns file paths respecting walk (nested + files only)', () => {
    fs.writeFileSync(path.join(dir, 'root.txt'), 'a');
    const sub = path.join(dir, 'nested');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'inner.ts'), 'b');
    const files = listFilesUnderRoot(dir);
    expect(files.some((f) => f.endsWith('root.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('nested', 'inner.ts')))).toBe(true);
  });
});
