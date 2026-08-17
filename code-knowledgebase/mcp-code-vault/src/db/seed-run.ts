/**
 * Standalone script to run seed once. Use when DB is empty and you want to seed
 * without starting the full server. Run from project root: npm run seed
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });
dotenv.config({ quiet: true });

import { connectMongoose, disconnectMongoose } from './mongoose';
import { runSeed, ensurePromptsFromSeed } from './seed';

async function main() {
  await connectMongoose();
  await runSeed();
  const promptsSeed = await ensurePromptsFromSeed();
  await disconnectMongoose();
  console.log('Seed completed (or skipped if DB already had data). Prompts seed:', promptsSeed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
