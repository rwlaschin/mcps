import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultStreamProcessor } from '../src/processors/defaultStreamProcessor';

async function collect(gen: (fp: string) => AsyncIterable<unknown>, fp: string) {
  const out: unknown[] = [];
  for await (const x of gen(fp)) out.push(x);
  return out;
}

describe('createDefaultStreamProcessor', () => {
  it('yields line-based chunks for a readable file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-chunk-'));
    const fp = path.join(dir, 'sample.txt');
    fs.writeFileSync(fp, ['a', 'b', 'c', 'd'].join('\n'));
    const processor = createDefaultStreamProcessor({ chunkLines: 2 });
    const chunks = await collect(processor, fp);
    expect(chunks.length).toBe(2);
    expect((chunks[0] as { startLine: number }).startLine).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('yields nothing when read fails', async () => {
    const processor = createDefaultStreamProcessor();
    const chunks = await collect(processor, path.join(os.tmpdir(), `missing-${Date.now()}.txt`));
    expect(chunks).toEqual([]);
  });
});
