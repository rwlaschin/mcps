/**
 * ES2022 syntax is a requirement.
 * Tests use ??, ?., ! and guard that src does not regress to || for defaults or omit ?. for optional access.
 */
import * as fs from 'fs';
import * as path from 'path';

const srcDir = path.resolve(__dirname, '../src');

function readSourceFiles(dir: string): { rel: string; content: string }[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }) ?? [];
  const out: { rel: string; content: string }[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(srcDir, full);
    if (e.isDirectory()) {
      out.push(...readSourceFiles(full));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push({ rel, content: fs.readFileSync(full, 'utf-8') });
    }
  }
  return out;
}

describe('ES2022+ syntax requirement', () => {
  it('test file uses ?? (nullish coalescing)', () => {
    const a: string | undefined = undefined;
    const b: number | null = null;
    expect(a ?? 'default').toBe('default');
    expect(b ?? 42).toBe(42);
  });

  it('test file uses ?. (optional chaining)', () => {
    const obj: { x?: { y: number } } = {};
    expect(obj?.x?.y).toBeUndefined();
    expect(obj?.x?.y ?? 0).toBe(0);
  });

  it('test file uses ! (non-null assertion) where type is known', () => {
    const s: string | null = 'hello';
    expect(s!.length).toBe(5);
  });

  it('src uses ?? instead of || for default env/values', () => {
    const files = readSourceFiles(srcDir);
    const hasNullish = files.some((f) => /\?\?/.test(f.content));
    const badDefault = files.filter((f) =>
      /process\.env\.\w+\s*\|\|\s*['"`]/.test(f.content)
    );
    expect(hasNullish).toBe(true);
    expect(badDefault.map((f) => f.rel)).toHaveLength(0);
  });

  it('src uses ?. where nullable access is used', () => {
    const files = readSourceFiles(srcDir);
    const hasOptionalChain = files.some((f) => /\?\./.test(f.content));
    expect(hasOptionalChain).toBe(true);
  });
});
