/**
 * Requirements gate for the background scanner: scanner only runs when config and DB are valid.
 * Fail-fast for missing PORT/MONGO_URL; scanner additionally
 * needs project to exist and have root_path.
 */

import { stdioMode } from './stdioMode';
import { Project } from './db/models/Project';

/**
 * Returns the project root path for the given projectKey (from Project.root_path).
 * Throws if project not found or root_path is missing.
 */
export async function getProjectRoot(projectKey: string): Promise<string> {
  const project = await Project.findOne({ key: projectKey }).lean().exec();
  if (!project?.root_path || project.root_path.trim() === '') {
    throw new Error(`Project "${projectKey}" not found or has no root_path`);
  }
  return project.root_path.trim();
}

/**
 * Verifies that the scanner can run for the given project: PORT (when not stdio), MONGO_URL,
 * and project with root_path must be valid. Throws with a clear message if any requirement fails.
 */
export async function checkScannerRequirements(projectKey: string): Promise<void> {
  if (!stdioMode) {
    const raw = process.env.PORT;
    if (raw === undefined || raw === '') throw new Error('PORT is required');
    const port = Number(raw);
    if (Number.isNaN(port) || port < 0 || !Number.isInteger(port)) {
      throw new Error('PORT must be a non-negative integer');
    }
  }

  const url = process.env.MONGO_URL;
  if (url === undefined || url === '') throw new Error('MONGO_URL is required');

  await getProjectRoot(projectKey);
}
