/**
 * Grant catalog permissions to existing influencer accounts.
 * Safe to run more than once: it only turns languages, genres, actors,
 * directors, and countries view/create/edit/delete on. Other modules are left alone.
 *
 *   npx tsx scripts/sync-creator-permissions.ts
 *
 * The API also runs this on startup.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { syncCreatorCatalogPermissions } from '../src/lib/creatorAccess';
import { ensureMongoDbName } from '../src/lib/mongodb';

async function main() {
  const raw = process.env.MONGODB_URI;
  if (!raw) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(ensureMongoDbName(raw));
  const result = await syncCreatorCatalogPermissions();
  console.log('Creator catalog permissions synced', result);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
