/**
 * Save Message Central credentials directly into Settings (bypass admin UI).
 *
 *   npx tsx scripts/set-mc-credentials.ts \
 *     --enabled \
 *     --customer-id C-XXXX \
 *     --auth-token 'eyJ...' \
 *     --email you@example.com \
 *     --password 'secret'
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';
import { updateEnvFile } from '../src/lib/envUpdater';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const enabled = process.argv.includes('--enabled') || process.argv.includes('--enable');
  const customerId = (arg('customer-id') || '').trim();
  const authToken = (arg('auth-token') || '').replace(/\s+/g, '').trim();
  const email = (arg('email') || '').trim();
  const password = (arg('password') || '').trim();
  const countryCode = (arg('country') || '91').replace(/^\+/, '');
  const otpLength = Number(arg('otp-length') || 4);

  if (!customerId) {
    console.error('Usage: npx tsx scripts/set-mc-credentials.ts --enabled --customer-id C-XXX --auth-token eyJ... [--email x --password y]');
    process.exit(1);
  }

  await mongoose.connect(ensureMongoDbName(process.env.MONGODB_URI!));
  const $set: Record<string, any> = {
    mcEnabled: enabled || true,
    mcCustomerId: customerId,
    mcBaseUrl: 'https://cpaas.messagecentral.com',
    mcCountryCode: countryCode,
    mcOtpLength: otpLength >= 4 && otpLength <= 8 ? otpLength : 4,
    mcFlowType: 'SMS',
  };
  if (authToken) $set.mcAuthToken = authToken;
  if (email) $set.mcEmail = email;
  if (password) $set.mcPassword = password;

  await mongoose.connection.db!.collection('settings').updateOne(
    {},
    { $set, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  updateEnvFile({
    MC_ENABLED: 'true',
    MC_CUSTOMER_ID: customerId,
    ...(authToken ? { MC_AUTH_TOKEN: authToken } : {}),
    ...(email ? { MC_EMAIL: email } : {}),
    ...(password ? { MC_PASSWORD: password } : {}),
    MC_COUNTRY_CODE: countryCode,
    MC_OTP_LENGTH: String($set.mcOtpLength),
    MC_FLOW_TYPE: 'SMS',
    MC_BASE_URL: 'https://cpaas.messagecentral.com',
  });

  const doc = await mongoose.connection.db!.collection('settings').findOne({}, {
    projection: {
      mcEnabled: 1, mcCustomerId: 1, mcEmail: 1, mcCountryCode: 1,
      mcAuthToken: 1, mcPassword: 1, mcOtpLength: 1,
    },
  });

  console.log('Saved:');
  console.log('  mcEnabled    :', doc?.mcEnabled);
  console.log('  mcCustomerId :', doc?.mcCustomerId);
  console.log('  mcEmail      :', doc?.mcEmail || '(empty)');
  console.log('  mcAuthToken  :', doc?.mcAuthToken ? `set (${String(doc.mcAuthToken).length} chars)` : '(empty)');
  console.log('  mcPassword   :', doc?.mcPassword ? 'set' : '(empty)');
  console.log('  mcCountryCode:', doc?.mcCountryCode);

  await mongoose.disconnect();
  console.log('\nRestart API: pm2 restart ashqe-api --update-env');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
