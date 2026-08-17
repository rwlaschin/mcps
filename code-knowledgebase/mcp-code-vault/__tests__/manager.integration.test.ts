import { ProjectManager } from '../src/manager';
import { connectToDatabase, closeDatabase } from '../src/db';

describe('ProjectManager Integration', () => {
  let db: any;

  beforeAll(async () => {
    db = await connectToDatabase();
  });

  afterAll(async () => {
    // Clean up test data and close DB connection
    if (db) {
      await db.collection('registry').deleteMany({ root_path: '/tmp', name: 'TestProject' });
    }
    await closeDatabase();
  });

  it('should register a project and store it in MongoDB', async () => {
    const mgr = new ProjectManager();
    const projectKey = await mgr.registerProject('/tmp', 'TestProject');
    expect(typeof projectKey).toBe('string');
    expect(projectKey.length).toBeGreaterThan(0);
    const found = await db.collection('registry').findOne({ project_key: projectKey });
    expect(found).toBeTruthy();
    expect(found.root_path).toBe('/tmp');
    expect(found.name).toBe('TestProject');
  });
});
