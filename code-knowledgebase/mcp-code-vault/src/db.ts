export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
// Mongo Connection & Schema/Index Indexing
import { MongoClient, Db } from 'mongodb';
import * as dotenv from 'dotenv';
import { config } from './config';
dotenv.config({ quiet: true });

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;
  const url = process.env.MONGO_URL;
  if (url === undefined || url === '') throw new Error('MONGO_URL is required');
  client = new MongoClient(url);
  await client.connect();
  db = client.db(config.DB_NAME);
  return db;
}
