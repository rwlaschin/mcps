/**
 * Ensure the project for the current config exists and matches (key, root_path).
 * Does not store MONGO_URL or any secrets in the database.
 */

import { Project } from './models/Project';
import { logger } from '../logger';

export type EnsureProjectResult = 'created' | 'updated' | 'unchanged';

/**
 * Ensures a Project document exists for the given key with the given root_path.
 * If missing: creates it. If present: updates root_path to match config when different.
 * Logs one critical event only. Returns what action was taken for stream/UI.
 */
export async function ensureProjectFromConfig(
  projectKey: string,
  rootPath: string
): Promise<EnsureProjectResult> {
  const existing = await Project.findOne({ key: projectKey }).lean().exec();
  if (!existing) {
    await Project.create({ name: projectKey, key: projectKey, root_path: rootPath });
    logger.info({ event: 'project_created', projectKey, root_path: rootPath });
    return 'created';
  }
  if (existing.root_path !== rootPath) {
    await Project.updateOne({ key: projectKey }, { $set: { root_path: rootPath } });
    logger.info({ event: 'project_updated', projectKey, root_path: rootPath });
    return 'updated';
  }
  return 'unchanged';
}
