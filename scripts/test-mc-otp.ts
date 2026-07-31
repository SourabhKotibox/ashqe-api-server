/**
 * Diagnose Message Central OTP config + optionally send a test OTP.
 *
 *   npx tsx scripts/test-mc-otp.ts
 *   npx tsx scripts/test-mc-otp.ts 9876543210
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';
import { loadMcConfig, messageCentral } from '../src/services/messageCentralService';

async function main() {
  const phone = (process.argv[2] || '').replace(/\D/g, '').slice(-10);

  await mongoose.connect(ensureMongoDbName(process.env.MONGODB_URI!));
  const cfg = await loadMcConfig();

  console.log('—— Message Central config ——');
  console.log('enabled     :', cfg.enabled);
  console.log('customerId  :', cfg.customerId || '(empty)');
  console.log('authToken   :', cfg.authToken ? `${cfg.authToken.slice(0, 12)}… (${cfg.authToken.length} chars)` : '(empty)');
  console.log('email       :', cfg.email || '(empty)');
  console.log('password    :', cfg.password ? '(set)' : '(empty)');
  console.log('baseUrl     :', cfg.baseUrl);
  console.log('countryCode :', cfg.countryCode);
  console.log('otpLength   :', cfg.otpLength);
  console.log('flowType    :', cfg.flowType);

  if (!cfg.enabled || !cfg.customerId || (!cfg.authToken && !cfg.password)) {
    console.log('\n❌ Not ready. In Admin → Settings → SMS / OTP:');
    console.log('   1. Enable Message Central');
    console.log('   2. Paste Customer ID');
    console.log('   3. Paste a FRESH Auth Token, OR set Email + Password (recommended)');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!phone) {
    console.log('\nConfig looks present. Re-run with a phone to send a real OTP:');
    console.log('  npx tsx scripts/test-mc-otp.ts 98XXXXXXXX');
    await mongoose.disconnect();
    return;
  }

  console.log(`\nSending OTP to ${phone}…`);
  const result = await messageCentral.sendOtp(phone);
  console.log(result);

  await mongoose.disconnect();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
