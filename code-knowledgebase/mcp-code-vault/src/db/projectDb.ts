/**
 * Per-project DB accessors and collection helpers.
 * Only two per-project collections: {projectKey}_knowledge_base and {projectKey}_FileProcessor.
 * Uses mongoose.connection.db (native MongoDB driver); caller must ensure connectMongoose() has been called.
 */

import mongoose from 'mongoose';

// --- Collection name helpers ---

export function knowledgeBaseCollectionName(projectKey: string): string {
  return `${projectKey}_knowledge_base`;
}

export function fileProcessorCollectionName(projectKey: string): string {
  return `${projectKey}_FileProcessor`;
}

function getDb() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error('Database not connected; call connectMongoose() first');
  return db;
}

/**
 * Ensures the two per-project collections exist and have required indexes.
 * Creating an index on a collection creates the collection if it does not exist.
 */
export async function ensureProjectCollections(projectKey: string): Promise<void> {
  const db = getDb();

  const knowledgeBase = db.collection(knowledgeBaseCollectionName(projectKey));
  await knowledgeBase.createIndex({ format: 1 });
  await knowledgeBase.createIndex({ level: 1 });

  const fileProcessor = db.collection(fileProcessorCollectionName(projectKey));
  await fileProcessor.createIndex({ path: 1 }, { unique: true });
  await fileProcessor.createIndex({ checksum: 1 });
  await fileProcessor.createIndex({ processedAt: 1 });
  await fileProcessor.createIndex({ path: 'text' });
}

/**
 * Returns true if the project's _knowledge_base collection has at least one document.
 */
export async function hasAnyPaths(projectKey: string): Promise<boolean> {
  const db = getDb();
  const knowledgeBase = db.collection(knowledgeBaseCollectionName(projectKey));
  const count = await knowledgeBase.countDocuments();
  return count > 0;
}

/** Path -> processedAt from FileProcessor. Used to decide which files need processing (missing or mtime > processedAt). */
export async function getFileProcessorProcessedAtMap(projectKey: string): Promise<Map<string, Date>> {
  const db = getDb();
  const col = db.collection(fileProcessorCollectionName(projectKey));
  const docs = await col.find({}, { projection: { path: 1, processedAt: 1 } }).toArray();
  const map = new Map<string, Date>();
  for (const d of docs) {
    const p = (d as { path?: string; processedAt?: Date }).path;
    const at = (d as { path?: string; processedAt?: Date }).processedAt;
    if (p != null && at != null) map.set(p, at instanceof Date ? at : new Date(at));
  }
  return map;
}

/** Path -> checksum from FileProcessor. Used for checksum-based skip decisions. */
export async function getFileProcessorChecksumMap(projectKey: string): Promise<Map<string, string>> {
  const db = getDb();
  const col = db.collection(fileProcessorCollectionName(projectKey));
  const docs = await col.find({}, { projection: { path: 1, checksum: 1 } }).toArray();
  const map = new Map<string, string>();
  for (const d of docs) {
    const p = (d as { path?: string; checksum?: string }).path;
    const checksum = (d as { path?: string; checksum?: string }).checksum;
    if (p != null && checksum != null && checksum !== '') map.set(p, checksum);
  }
  return map;
}
