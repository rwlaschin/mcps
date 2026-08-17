/**
 * Project defaults: ensure the two per-project collections exist.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ensureProjectCollections } from './projectDb';

/**
 * Reads the current branch name from .git/HEAD under the given project root.
 * Returns branch name (e.g. "main") or "HEAD" if detached / unreadable.
 */
export function readCurrentBranchFromRoot(projectRoot: string): string {
  const headPath = path.join(projectRoot, '.git', 'HEAD');
  try {
    const content = fs.readFileSync(headPath, 'utf8').trim();
    const match = content.match(/^ref: refs\/heads\/(.+)$/);
    return match ? match[1].trim() : 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * Ensures the two per-project collections (_knowledge_base and _FileProcessor) exist with indexes.
 */
export async function ensureProjectDefaults(projectKey: string): Promise<void> {
  await ensureProjectCollections(projectKey);
}
