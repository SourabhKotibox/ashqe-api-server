/**
 * Force-save Message Central credentials using Tataiya field names:
 *   messageCentralEnabled, messageCentralCustomerId, messageCentralAuthToken, …
 *
 *   npx tsx scripts/force-mc-settings.ts --enabled \
 *     --customer-id 'C-XXX' --auth-token 'eyJ...(FULL)...'
 *
 * Migrate legacy mc* → messageCentral* (keeps token if long enough):
 *   npx tsx scripts/force-mc-settings.ts --migrate-legacy
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return '';
  return String(process.argv[i + 1] || '').trim();
}

function summarize(d: any) {
  const token = d.messageCentralAuthToken || d.mcAuthToken || '';
  return {
    _id: String(d._id),
    messageCentralEnabled: !!(d.messageCentralEnabled ?? d.mcEnabled),
    messageCentralCustomerId: d.messageCentralCustomerId || d.mcCustomerId || '(empty)',
    messageCentralAuthToken: token
      ? `set (${String(token).length} chars)`
      : '(empty)',
    messageCentralBaseUrl: d.messageCentralBaseUrl || d.mcBaseUrl || '(default)',
    messageCentralCountryCode: d.messageCentralCountryCode || d.mcCountryCode || '91',
    messageCentralOtpLength: d.messageCentralOtpLength ?? d.mcOtpLength ?? 4,
    messageCentralFlowType: d.messageCentralFlowType || d.mcFlowType || 'SMS',
  };
}

async function main() {
  const migrate = process.argv.includes('--migrate-legacy');
  const enabled = process.argv.includes('--enabled') || true;
  const customerId = (flag('customer-id') || process.env.MC_CUSTOMER_ID || '').trim();
  const authToken = (flag('auth-token') || process.env.MC_AUTH_TOKEN || '').replace(/\s+/g, '');
  const countryCode = (flag('country') || '91').replace(/^\+/, '');

  const uri = ensureMongoDbName(process.env.MONGODB_URI!);
  console.log('Connecting…');
  await mongoose.connect(uri);
  console.log('DB name:', mongoose.connection.name);

  const col = mongoose.connection.db!.collection('settings');
  const before = await col.find({}).toArray();
  console.log(`\nSettings docs BEFORE: ${before.length}`);
  for (const d of before) console.log(summarize(d));

  if (migrate) {
    for (const d of before) {
      const $set: Record<string, any> = { updatedAt: new Date() };
      if (d.mcEnabled !== undefined && d.messageCentralEnabled === undefined) {
        $set.messageCentralEnabled = !!d.mcEnabled;
      }
      if (d.mcCustomerId && !d.messageCentralCustomerId) {
        $set.messageCentralCustomerId = d.mcCustomerId;
      }
      const legacyToken = String(d.mcAuthToken || '').trim();
      if (legacyToken && !d.messageCentralAuthToken) {
        if (legacyToken.length >= 100) {
          $set.messageCentralAuthToken = legacyToken;
        } else {
          console.warn(
            `Skipping truncated legacy token (${legacyToken.length} chars) on ${d._id} — paste a full token`
          );
        }
      }
      if (d.mcBaseUrl && !d.messageCentralBaseUrl) $set.messageCentralBaseUrl = d.mcBaseUrl;
      if (d.mcCountryCode && !d.messageCentralCountryCode) {
        $set.messageCentralCountryCode = d.mcCountryCode;
      }
      if (d.mcOtpLength && !d.messageCentralOtpLength) $set.messageCentralOtpLength = d.mcOtpLength;
      if (d.mcFlowType && !d.messageCentralFlowType) $set.messageCentralFlowType = d.mcFlowType;
      if (d.mcEmail && !d.messageCentralEmail) $set.messageCentralEmail = d.mcEmail;
      if (d.mcPassword && !d.messageCentralPassword) $set.messageCentralPassword = d.mcPassword;

      await col.updateOne(
        { _id: d._id },
        {
          $set,
          $unset: {
            mcEnabled: 1,
            mcCustomerId: 1,
            mcAuthToken: 1,
            mcPassword: 1,
            mcEmail: 1,
            mcBaseUrl: 1,
            mcCountryCode: 1,
            mcOtpLength: 1,
            mcFlowType: 1,
          },
        }
      );
    }
    const after = await col.find({}).toArray();
    console.log(`\nSettings docs AFTER migrate: ${after.length}`);
    for (const d of after) console.log(summarize(d));
    await mongoose.disconnect();
    console.log('\nDone. Restart API and paste a FULL Auth Token if token was truncated.');
    return;
  }

  if (authToken && authToken.length < 100) {
    console.error(
      `\n❌ Auth Token is only ${authToken.length} chars — truncated.\n` +
        `   Paste the FULL token (usually 200–500+ chars, starts with eyJ).`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!customerId || !authToken) {
    console.log('\n❌ Need Customer ID + FULL Auth Token. Example:');
    console.log(
      `  npx tsx scripts/force-mc-settings.ts --enabled --customer-id 'C-YOURID' --auth-token 'eyJ...(full)...'`
    );
    console.log('\nOr migrate legacy mc* fields:');
    console.log(`  npx tsx scripts/force-mc-settings.ts --migrate-legacy`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const $set = {
    messageCentralEnabled: !!enabled,
    messageCentralCustomerId: customerId,
    messageCentralAuthToken: authToken,
    messageCentralEmail: '',
    messageCentralBaseUrl: 'https://cpaas.messagecentral.com',
    messageCentralCountryCode: countryCode,
    messageCentralOtpLength: 4,
    messageCentralFlowType: 'SMS',
    updatedAt: new Date(),
  };
  const $unset = {
    messageCentralPassword: 1,
    mcEnabled: 1,
    mcCustomerId: 1,
    mcAuthToken: 1,
    mcPassword: 1,
    mcEmail: 1,
    mcBaseUrl: 1,
    mcCountryCode: 1,
    mcOtpLength: 1,
    mcFlowType: 1,
  };

  const count = await col.countDocuments();
  if (count === 0) {
    await col.insertOne({ ...$set, createdAt: new Date() });
  } else {
    await col.updateMany({}, { $set, $unset });
  }

  const after = await col.find({}).toArray();
  console.log(`\nSettings docs AFTER: ${after.length}`);
  for (const d of after) console.log(summarize(d));
  console.log(`\n✓ messageCentralAuthToken saved (${authToken.length} chars)`);

  await mongoose.disconnect();
  console.log('\nDone. Now run:');
  console.log('  pm2 restart ashqe-api --update-env');
  console.log('  npx tsx scripts/test-mc-otp.ts 8306690426');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
