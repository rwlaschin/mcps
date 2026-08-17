// Project Registry logic (mapping paths to IDs)
import { connectToDatabase } from './db';
import { randomBytes } from 'crypto';

export class ProjectManager {
  async registerProject(root_path: string, name?: string): Promise<string> {
    const db = await connectToDatabase();
    const project_key = 'VAULT-' + randomBytes(4).toString('hex').toUpperCase();
    const doc = {
      project_key,
      root_path,
      name: name ?? null,
      exclude_patterns: [],
      last_sync: null
    };
    await db.collection('registry').insertOne(doc);
    return project_key;
  }
}
