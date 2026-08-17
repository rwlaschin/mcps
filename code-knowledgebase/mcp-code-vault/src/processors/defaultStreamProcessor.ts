/**
 * Default processor for streamProjectChunks: reads each path and yields line-based chunks.
 * Handles further filtering (e.g. skip unreadable files). Scanner does not open files.
 */
import * as fs from 'fs';
import type { FileChunk } from '../scanner';

const DEFAULT_CHUNK_LINES = 100;

function* chunkContent(
  filePath: string,
  content: string,
  chunkLines: number
): Generator<FileChunk> {
  const lines = content.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += chunkLines) {
    const end = Math.min(start + chunkLines, lines.length);
    const slice = lines.slice(start, end).join('\n');
    yield { file: filePath, startLine: start + 1, endLine: end, content: slice };
  }
}

export function createDefaultStreamProcessor(options?: {
  chunkLines?: number;
}): (filePath: string) => AsyncGenerator<FileChunk> {
  const chunkLines = options?.chunkLines ?? DEFAULT_CHUNK_LINES;
  return async function* (filePath: string): AsyncGenerator<FileChunk> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
    yield* chunkContent(filePath, content, chunkLines);
  };
}
