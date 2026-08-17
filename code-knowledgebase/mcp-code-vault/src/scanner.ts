// File walker: uses ignore manager, calls out to a processor per path. No file I/O or DB calls in loops.
declare global {
  // eslint-disable-next-line no-var
  var __mcp_watchers: Record<string, any> | undefined;
}

import { createChokidarIgnored, shouldIgnore } from './utils/ignore-mgr';
import { createDefaultScanProcessor } from './processors/defaultScanProcessor';

export { createDefaultStreamProcessor } from './processors/defaultStreamProcessor';

/** One chunk of file content with line range. Produced by the stream processor. */
export interface FileChunk {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** Result from a scan processor for one path. Scanner batches these and writes once. */
export interface ScanResult {
  file: string;
  summary: string;
}

/** Processes one file path; may do further filtering. Returns summary for DB or null to skip. */
export type ScanProcessor = (filePath: string) => Promise<ScanResult | null>;

/** Processes one file path; may do further filtering. Yields chunks (caller may open file). */
export type StreamChunkProcessor = (filePath: string) => AsyncIterable<FileChunk>;

function walkDir(
  projectRoot: string,
  dir: string,
  fs: typeof import('fs'),
  path: typeof import('path')
): string[] {
  const results: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!shouldIgnore(filePath, projectRoot, true)) {
        results.push(...walkDir(projectRoot, filePath, fs, path));
      }
    } else if (!shouldIgnore(filePath, projectRoot, false)) {
      results.push(filePath);
    }
  }
  return results;
}

/** List all file paths under root using the same ignore rules as the scanner. */
export function listFilesUnderRoot(root: string): string[] {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return walkDir(root, root, fs, path);
}

/** Resolve project root. One DB call. */
async function getProjectRoot(projectKey: string): Promise<string> {
  const { connectToDatabase } = await import('./db');
  const db = await connectToDatabase();
  const project = await db.collection('registry').findOne({ project_key: projectKey });
  if (!project?.root_path) throw new Error('Project not found');
  return project.root_path as string;
}

/**
 * Walk project paths and stream back chunks by calling the provided processor per path.
 * Scanner does not open files; the processor handles reading and further filtering.
 * Uses the ignore manager for the walk.
 */
export async function* streamProjectChunks(
  projectKey: string,
  options: { processor: StreamChunkProcessor }
): AsyncGenerator<FileChunk> {
  const root = await getProjectRoot(projectKey);
  const fs = await import('fs');
  const path = await import('path');
  const paths = walkDir(root, root, fs, path);

  for (const filePath of paths) {
    for await (const chunk of options.processor(filePath)) {
      yield chunk;
    }
  }
}

/**
 * Walk project paths and run the provided processor per path. Collects results and
 * performs one bulk write at the end (no DB calls in the loop). Uses the ignore manager.
 * If no processor is passed, uses the default that analyzes files for symbols.
 */
export async function scanProject(
  projectKey: string,
  options?: { processor?: ScanProcessor }
): Promise<{ filesScanned: number; filesUpdated: number; symbolsFound: number }> {
  const root = await getProjectRoot(projectKey);
  const fs = await import('fs');
  const path = await import('path');
  const { connectToDatabase } = await import('./db');
  const database = await connectToDatabase();
  const paths = walkDir(root, root, fs, path);
  const processor = options?.processor ?? createDefaultScanProcessor(projectKey);

  const results: ScanResult[] = [];
  for (const filePath of paths) {
    const result = await processor(filePath);
    if (result) results.push(result);
  }

  if (results.length > 0) {
    const now = new Date();
    await database.collection('symbols').bulkWrite(
      results.map(({ file, summary }) => ({
        updateOne: {
          filter: { project_key: projectKey, file },
          update: { $set: { summary, updated: now } },
          upsert: true
        }
      }))
    );
  }

  let symbolsFound = 0;
  for (const r of results) {
    symbolsFound += (r.summary?.match(/(class |function |interface )/g) ?? []).length;
  }

  // Watcher: one update per change; uses ignore manager
  if (!globalThis.__mcp_watchers) globalThis.__mcp_watchers = {};
  if (!globalThis.__mcp_watchers[projectKey]) {
    const chokidar = (await import('chokidar')).default;
    const watcher = chokidar.watch(root, { ignored: createChokidarIgnored(root) });
    watcher.on('change', async (changedPath: string) => {
      if (shouldIgnore(changedPath, root, false)) return;
      const scanProcessor = options?.processor ?? createDefaultScanProcessor(projectKey);
      const result = await scanProcessor(changedPath);
      if (result) {
        await database.collection('symbols').updateOne(
          { project_key: projectKey, file: changedPath },
          { $set: { summary: result.summary, updated: new Date() } },
          { upsert: true }
        );
      }
    });
    globalThis.__mcp_watchers[projectKey] = watcher;
  }

  return {
    filesScanned: paths.length,
    filesUpdated: results.length,
    symbolsFound
  };
}
