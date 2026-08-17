import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearIgnoreMergerCacheForTesting,
  createChokidarIgnored,
  shouldIgnore
} from '../src/utils/ignore-mgr';

describe('ignore-mgr', () => {
  let tmp: string;

  beforeEach(() => {
    clearIgnoreMergerCacheForTesting();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ign-'));
  });

  afterEach(() => {
    clearIgnoreMergerCacheForTesting();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false for ordinary paths when no ignore files exist', () => {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), '');
    expect(shouldIgnore(path.join(tmp, 'src', 'index.ts'), tmp)).toBe(false);
  });

  it('always ignores node_modules and .git (built-in)', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'x.js'), '');
    expect(shouldIgnore(path.join(tmp, 'node_modules', 'pkg', 'x.js'), tmp)).toBe(true);
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.git', 'config'), '');
    expect(shouldIgnore(path.join(tmp, '.git', 'config'), tmp)).toBe(true);
  });

  it('applies root .gitignore', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'dist/\n*.log\n');
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dist', 'x.txt'), '');
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), '');
    expect(shouldIgnore(path.join(tmp, 'dist', 'x.txt'), tmp)).toBe(true);
    expect(shouldIgnore(path.join(tmp, 'src', 'a.ts'), tmp)).toBe(false);
  });

  it('merges other .*ignore files at the same directory', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '# empty\n');
    fs.writeFileSync(path.join(tmp, '.cursorignore'), 'secrets.txt\n');
    fs.writeFileSync(path.join(tmp, 'secrets.txt'), '');
    expect(shouldIgnore(path.join(tmp, 'secrets.txt'), tmp)).toBe(true);
  });

  it('applies nested ignore files relative to their directory', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '');
    fs.mkdirSync(path.join(tmp, 'pkg', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pkg', '.gitignore'), 'sub/\n');
    fs.writeFileSync(path.join(tmp, 'pkg', 'sub', 'file.txt'), '');
    expect(shouldIgnore(path.join(tmp, 'pkg', 'sub', 'file.txt'), tmp)).toBe(true);
  });

  it('treats paths outside project root as ignored', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), '');
    const outside = path.join(tmp, '..', 'outside-no-such-file');
    expect(shouldIgnore(outside, tmp)).toBe(true);
  });

  it('createChokidarIgnored respects directory classification when stats say dir', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'build/\n');
    fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
    const ign = createChokidarIgnored(tmp);
    const buildPath = path.join(tmp, 'build');
    expect(ign(buildPath, { isDirectory: () => true } as fs.Stats)).toBe(true);
  });

  it('createChokidarIgnored uses lstat when stats omitted so build/ still matches', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'build/\n');
    fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
    const ign = createChokidarIgnored(tmp);
    const buildPath = path.join(tmp, 'build');
    expect(ign(buildPath)).toBe(true);
  });
});
