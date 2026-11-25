/**
 * Persist the creator section pack on existing influencer accounts.
 * Safe to run more than once: it only turns on flags that the creator pack
 * allows (dashboard sections: media library, movies, TV shows, languages,
 * genres, actors, directors, crew via directors, and countries).
 * Other modules and other roles are left alone.
 *
 *   npx tsx scripts/sync-creator-permissions.ts
 *
 * The API also runs this on startup. Reads derive the same pack from the
 * influencer role, so access does not wait on this script.
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
  console.log('Creator permissions synced', result);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
