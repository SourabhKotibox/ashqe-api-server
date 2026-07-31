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

  console.log('—— Message Gateway (messageCentral* DB fields) ——');
  console.log('messageCentralEnabled     :', cfg.enabled);
  console.log('messageCentralCustomerId  :', cfg.customerId || '(empty)');
  console.log(
    'messageCentralAuthToken   :',
    cfg.authToken
      ? `${cfg.authToken.slice(0, 12)}… (${cfg.authToken.length} chars)`
      : 'EMPTY / stripped'
  );
  console.log('messageCentralBaseUrl     :', cfg.baseUrl);
  console.log('messageCentralCountryCode :', cfg.countryCode);
  console.log('messageCentralOtpLength   :', cfg.otpLength);
  console.log('messageCentralFlowType    :', cfg.flowType);
  console.log('==== .env MC lines ==== (not required — DB is source of truth)');

  if (!cfg.customerId || (!cfg.authToken && !cfg.password)) {
    console.log('\n❌ Not ready. Admin → Settings → Message Gateway:');
    console.log('   1. Enable OTP gateway');
    console.log('   2. Paste Customer ID');
    console.log('   3. Paste FULL Auth Token (200+ chars), then Save');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!phone) {
    console.log('\nConfig looks present. Re-run with a phone to send a real OTP:');
    console.log('  npx tsx scripts/test-mc-otp.ts 98XXXXXXXX');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n==== live send-otp ====`);
  console.log(`Sending OTP to ${phone}…`);
  const result = await messageCentral.sendOtp(phone);
  console.log(result);

  await mongoose.disconnect();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
