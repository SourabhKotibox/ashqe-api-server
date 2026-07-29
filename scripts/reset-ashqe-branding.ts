/**
 * Force Ashqe branding into the Settings document.
 * Run on the server after switching MONGODB_URI to /ashqe:
 *   npx tsx scripts/reset-ashqe-branding.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { SettingsModel } from '../src/models/Settings';
import { ensureMongoDbName } from '../src/lib/mongodb';

const ASHQE_BRANDING = {
  platformName: 'Ashqe',
  copyrightText: '© 2026 Ashqe. All Rights Reserved.',
  siteDescription: 'Ashqe — stream premium movies and series.',
  logoUrl: '/logo.png',
  darkLogoUrl: '/logo.png',
  lightLogoUrl: '/logo.png',
  faviconUrl: '/favicon.png',
  loginTitle: 'Welcome Back',
  loginSubtitle: 'Ashqe Admin Console',
  loginButtonText: 'Sign In',
  mailFrom: 'info@ashqe.app',
  mailFromName: 'Ashqe',
  primaryColor: '#FF8C38',
  colorTheme: 'orange',
  metaTitle: 'Ashqe',
  metaDescription: 'Ashqe streaming platform',
  canonicalUrl: 'https://ashqe.app',
};

async function main() {
  const raw = process.env.MONGODB_URI;
  if (!raw) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  const uri = ensureMongoDbName(raw);
  await mongoose.connect(uri);
  console.log('Connected to DB:', mongoose.connection.name);

  const settings = await SettingsModel.findOneAndUpdate(
    {},
    { $set: ASHQE_BRANDING },
    { upsert: true, new: true }
  );

  console.log('Updated branding:', {
    platformName: settings?.platformName,
    primaryColor: settings?.primaryColor,
    logoUrl: settings?.logoUrl,
    copyrightText: settings?.copyrightText,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
