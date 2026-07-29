/**
 * Show or change the S3 bucket used for new uploads.
 *
 *   npx tsx scripts/set-s3-bucket.ts              -> show current storage settings
 *   npx tsx scripts/set-s3-bucket.ts ashqe-ott    -> switch uploads to that bucket
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';
import { SettingsModel } from '../src/models/Settings';

async function main() {
  const newBucket = process.argv[2];

  await mongoose.connect(ensureMongoDbName(process.env.MONGODB_URI!));

  if (newBucket) {
    await SettingsModel.updateOne({}, { $set: { awsBucket: newBucket } }, { upsert: true });
  }

  const s = await SettingsModel.findOne().lean<any>();
  console.log('storageDriver :', s?.storageDriver || '(unset)');
  console.log('awsRegion     :', s?.awsRegion || '(unset)');
  console.log('awsBucket     :', s?.awsBucket || '(unset -> falls back to env / ashqe-ott)');
  console.log('awsCdnUrl     :', s?.awsCdnUrl || '(unset)');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
