/**
 * Force Message Gateway OTP only (disable any leftover ALLOW_STATIC_OTP).
 *   npx tsx scripts/fix-static-otp.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';
import { loadMcConfig } from '../src/services/messageCentralService';

async function main() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    let env = fs.readFileSync(envPath, 'utf8');
    const next = env
      .split('\n')
      .filter((line) => !/^\s*ALLOW_STATIC_OTP\s*=/.test(line))
      .join('\n');
    const out = next + (next.endsWith('\n') ? '' : '\n') + '# Static OTP removed — Message Gateway only\n';
    fs.writeFileSync(envPath, out);
    console.log('✓ Removed ALLOW_STATIC_OTP from .env');
  }

  await mongoose.connect(ensureMongoDbName(process.env.MONGODB_URI!));
  const cfg = await loadMcConfig();
  console.log('\n—— Message Gateway ——');
  console.log('enabled   :', cfg.enabled);
  console.log('customerId:', cfg.customerId || '(empty)');
  console.log(
    'authToken :',
    cfg.authToken ? `set (${cfg.authToken.length} chars)` : '(empty)'
  );

  if (!cfg.customerId || !cfg.authToken) {
    console.log('\n❌ Paste Customer ID + Auth Token, then:');
    console.log(
      `  npx tsx scripts/force-mc-settings.ts --enabled --customer-id 'C-XXX' --auth-token 'eyJ...'`
    );
  } else {
    console.log('\n✓ Ready for real SMS OTP');
  }

  await mongoose.disconnect();
  console.log('\n  pm2 restart ashqe-api --update-env');
  console.log(
    `  curl -sS -X POST https://ashqe.app/api/app/auth/send-otp -H 'Content-Type: application/json' -d '{"mobileNumber":"8306690426"}'`
  );
  console.log('  (must show verificationId — never "Use 1234")');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
