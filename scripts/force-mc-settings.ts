/**
 * Force-save Message Central credentials into Mongo Settings + .env
 *
 * Auth-token mode (recommended — same as MC console):
 *   npx tsx scripts/force-mc-settings.ts --enabled --customer-id 'C-XXX' --auth-token 'eyJ...(FULL TOKEN)...'
 *
 * Clear bad email/password leftovers:
 *   npx tsx scripts/force-mc-settings.ts --clear-email-password
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
  const clearOnly = process.argv.includes('--clear-email-password');
  const enabled =
    process.argv.includes('--enabled') ||
    process.env.MC_ENABLED === 'true' ||
    true;

  const customerId = (flag('customer-id') || process.env.MC_CUSTOMER_ID || '').trim();
  const authToken = (flag('auth-token') || process.env.MC_AUTH_TOKEN || '').replace(/\s+/g, '');
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

  if (clearOnly) {
    await col.updateMany(
      {},
      { $set: { mcEmail: '', updatedAt: new Date() }, $unset: { mcPassword: 1 } }
    );
    updateEnvFile({ MC_EMAIL: '', MC_PASSWORD: '' });
    console.log('\nCleared mcEmail + mcPassword from all settings docs and .env');
    await mongoose.disconnect();
    console.log('Done. Run: pm2 restart ashqe-api --update-env');
    return;
  }

  if (authToken && authToken.length < 100) {
    console.error(
      `\n❌ Auth Token is only ${authToken.length} chars — that is truncated.\n` +
        `   Paste the FULL token from Message Central (usually 200–500+ chars, starts with eyJ).\n` +
        `   Do NOT paste a short snippet.`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!customerId || !authToken) {
    console.log('\n❌ Need Customer ID + FULL Auth Token. Example:');
    console.log(
      `  npx tsx scripts/force-mc-settings.ts --enabled --customer-id 'C-YOURID' --auth-token 'eyJ...(full)...'`
    );
    console.log('\nOr only clear leftover email/password:');
    console.log(`  npx tsx scripts/force-mc-settings.ts --clear-email-password`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const $set: Record<string, any> = {
    mcEnabled: !!enabled,
    mcCustomerId: customerId,
    mcAuthToken: authToken,
    mcEmail: '',
    mcBaseUrl: 'https://cpaas.messagecentral.com',
    mcCountryCode: countryCode,
    mcOtpLength: 4,
    mcFlowType: 'SMS',
    updatedAt: new Date(),
  };

  // Always drop password when using Auth Token — email/password path is not needed
  const result = await col.updateMany(
    {},
    { $set, $unset: { mcPassword: 1 } },
    { upsert: true }
  );
  console.log('\nupdateMany:', {
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
  });

  const count = await col.countDocuments();
  if (count === 0) {
    await col.insertOne({ ...$set, createdAt: new Date() });
    console.log('Inserted new settings document');
  }

  updateEnvFile({
    MC_ENABLED: 'true',
    MC_CUSTOMER_ID: customerId,
    MC_AUTH_TOKEN: authToken,
    MC_EMAIL: '',
    MC_PASSWORD: '',
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

  if (authToken.length >= 100) {
    console.log(`\n✓ Auth Token saved (${authToken.length} chars) — email/password cleared`);
  }

  await mongoose.disconnect();
  console.log('\nDone. Now run:');
  console.log('  pm2 restart ashqe-api --update-env');
  console.log('  npx tsx scripts/test-mc-otp.ts 8306690426');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
