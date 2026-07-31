/**
 * Force-save Message Central credentials into Mongo Settings + .env
 * and print every settings document (to catch duplicates).
 *
 * Interactive-free example:
 *   MC_CUSTOMER_ID='C-XXXX' MC_AUTH_TOKEN='eyJ...' MC_ENABLED=true \
 *     npx tsx scripts/force-mc-settings.ts
 *
 * Or with flags:
 *   npx tsx scripts/force-mc-settings.ts --enabled --customer-id C-XXX --auth-token 'eyJ...'
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';
import { updateEnvFile } from '../src/lib/envUpdater';

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return '';
  return String(process.argv[i + 1] || '').trim();
}

async function main() {
  const enabled =
    process.argv.includes('--enabled') ||
    process.env.MC_ENABLED === 'true' ||
    true;

  const customerId = (flag('customer-id') || process.env.MC_CUSTOMER_ID || '').trim();
  const authToken = (flag('auth-token') || process.env.MC_AUTH_TOKEN || '').replace(/\s+/g, '');
  const email = (flag('email') || process.env.MC_EMAIL || '').trim();
  const password = (flag('password') || process.env.MC_PASSWORD || '').trim();
  const countryCode = (flag('country') || process.env.MC_COUNTRY_CODE || '91').replace(/^\+/, '');

  const uri = ensureMongoDbName(process.env.MONGODB_URI!);
  console.log('Connecting…');
  await mongoose.connect(uri);
  console.log('DB name:', mongoose.connection.name);

  const col = mongoose.connection.db!.collection('settings');
  const before = await col.find({}).project({
    platformName: 1,
    mcEnabled: 1,
    mcCustomerId: 1,
    mcAuthToken: 1,
    mcPassword: 1,
    mcEmail: 1,
  }).toArray();

  console.log(`\nSettings docs BEFORE: ${before.length}`);
  for (const d of before) {
    console.log({
      _id: String(d._id),
      platformName: d.platformName,
      mcEnabled: d.mcEnabled,
      mcCustomerId: d.mcCustomerId || '(empty)',
      mcAuthToken: d.mcAuthToken ? `set (${String(d.mcAuthToken).length} chars)` : '(empty)',
      mcPassword: d.mcPassword ? 'set' : '(empty)',
      mcEmail: d.mcEmail || '(empty)',
    });
  }

  if (!customerId || (!authToken && !password)) {
    console.log('\n❌ Need credentials to write. Example:');
    console.log(`  npx tsx scripts/force-mc-settings.ts --enabled --customer-id 'C-YOURID' --auth-token 'eyJ...'`);
    console.log('Or with email/password:');
    console.log(`  npx tsx scripts/force-mc-settings.ts --enabled --customer-id 'C-YOURID' --email 'you@x.com' --password 'secret'`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const $set: Record<string, any> = {
    mcEnabled: !!enabled,
    mcCustomerId: customerId,
    mcBaseUrl: 'https://cpaas.messagecentral.com',
    mcCountryCode: countryCode,
    mcOtpLength: 4,
    mcFlowType: 'SMS',
    updatedAt: new Date(),
  };
  if (authToken) $set.mcAuthToken = authToken;
  if (email) $set.mcEmail = email;
  if (password) $set.mcPassword = password;

  // Update ALL settings docs so duplicates can't hide the values
  const result = await col.updateMany({}, { $set }, { upsert: true });
  console.log('\nupdateMany:', {
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
  });

  // If collection was empty, upsert with updateMany doesn't insert — handle that
  const count = await col.countDocuments();
  if (count === 0) {
    await col.insertOne({ ...$set, createdAt: new Date() });
    console.log('Inserted new settings document');
  }

  updateEnvFile({
    MC_ENABLED: 'true',
    MC_CUSTOMER_ID: customerId,
    ...(authToken ? { MC_AUTH_TOKEN: authToken } : {}),
    ...(email ? { MC_EMAIL: email } : {}),
    ...(password ? { MC_PASSWORD: password } : {}),
    MC_COUNTRY_CODE: countryCode,
    MC_OTP_LENGTH: '4',
    MC_FLOW_TYPE: 'SMS',
    MC_BASE_URL: 'https://cpaas.messagecentral.com',
  });

  const after = await col.find({}).project({
    mcEnabled: 1,
    mcCustomerId: 1,
    mcAuthToken: 1,
    mcPassword: 1,
    mcEmail: 1,
  }).toArray();

  console.log(`\nSettings docs AFTER: ${after.length}`);
  for (const d of after) {
    console.log({
      _id: String(d._id),
      mcEnabled: d.mcEnabled,
      mcCustomerId: d.mcCustomerId,
      mcAuthToken: d.mcAuthToken ? `set (${String(d.mcAuthToken).length} chars)` : '(empty)',
      mcPassword: d.mcPassword ? 'set' : '(empty)',
      mcEmail: d.mcEmail || '(empty)',
    });
  }

  await mongoose.disconnect();
  console.log('\nDone. Now run:');
  console.log('  pm2 restart ashqe-api --update-env');
  console.log('  npx tsx scripts/test-mc-otp.ts');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
