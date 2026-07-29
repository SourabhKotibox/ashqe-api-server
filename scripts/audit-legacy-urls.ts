/**
 * Report every document still pointing at a legacy (pre-Ashqe) S3 bucket.
 * Read-only — it changes nothing.
 *
 *   npx tsx scripts/audit-legacy-urls.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';

const LEGACY = /tatiya|tataiya|xoto/i;

function findLegacyStrings(value: any, path = ''): Array<{ path: string; value: string }> {
  if (typeof value === 'string') {
    return LEGACY.test(value) ? [{ path, value }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findLegacyStrings(item, `${path}[${i}]`));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).flatMap(([key, v]) =>
      findLegacyStrings(v, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

async function main() {
  await mongoose.connect(ensureMongoDbName(process.env.MONGODB_URI!));
  const db = mongoose.connection.db!;

  const collections = await db.listCollections().toArray();
  let grandTotal = 0;

  for (const { name } of collections) {
    const docs = await db.collection(name).find({}).toArray();
    const hits = docs
      .map((doc) => ({ id: doc._id, fields: findLegacyStrings(doc) }))
      .filter((d) => d.fields.length > 0);

    if (hits.length === 0) continue;

    console.log(`\n${name} — ${hits.length} document(s)`);
    for (const hit of hits) {
      for (const f of hit.fields) {
        const short = f.value.length > 110 ? `${f.value.slice(0, 110)}…` : f.value;
        console.log(`  ${hit.id}  ${f.path} = ${short}`);
      }
    }
    grandTotal += hits.length;
  }

  console.log(grandTotal === 0 ? '\nNo legacy URLs found.' : `\nTotal: ${grandTotal} document(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
