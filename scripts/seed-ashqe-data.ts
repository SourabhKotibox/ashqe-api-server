/**
 * Seed genres, languages, countries, and 4 subscription plans for Ashqe.
 * Run: npx tsx scripts/seed-ashqe-data.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';

async function main() {
  const uri = ensureMongoDbName(process.env.MONGODB_URI!);
  await mongoose.connect(uri);
  console.log('Connected to DB:', mongoose.connection.name);
  const db = mongoose.connection.db!;

  // ─── Genres ───────────────────────────────────────────────
  const genres = [
    'Action', 'Drama', 'Comedy', 'Thriller', 'Romance',
    'Horror', 'Sci-Fi', 'Crime', 'Adventure', 'Mystery',
    'Fantasy', 'Biography', 'Animation', 'Documentary',
    'Musical', 'Family', 'War', 'Historical',
  ];
  for (const name of genres) {
    await db.collection('genres').updateOne(
      { name },
      { $setOnInsert: { name, status: 'published', active: true, createdAt: new Date() } },
      { upsert: true }
    );
  }
  console.log(`Genres: ${genres.length} upserted`);

  // ─── Languages ────────────────────────────────────────────
  const languages = [
    { name: 'Hindi', code: 'hi' },
    { name: 'English', code: 'en' },
    { name: 'Punjabi', code: 'pa' },
    { name: 'Tamil', code: 'ta' },
    { name: 'Telugu', code: 'te' },
    { name: 'Malayalam', code: 'ml' },
    { name: 'Kannada', code: 'kn' },
    { name: 'Bengali', code: 'bn' },
    { name: 'Marathi', code: 'mr' },
    { name: 'Gujarati', code: 'gu' },
    { name: 'Urdu', code: 'ur' },
    { name: 'Bhojpuri', code: 'bh' },
  ];
  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i];
    await db.collection('languages').updateOne(
      { code: lang.code },
      { $setOnInsert: { ...lang, order: i + 1, createdAt: new Date() } },
      { upsert: true }
    );
  }
  console.log(`Languages: ${languages.length} upserted`);

  // ─── Countries ────────────────────────────────────────────
  const countries = [
    { name: 'India', code: 'IN' },
    { name: 'United States', code: 'US' },
    { name: 'United Kingdom', code: 'GB' },
    { name: 'Canada', code: 'CA' },
    { name: 'Australia', code: 'AU' },
    { name: 'Germany', code: 'DE' },
    { name: 'France', code: 'FR' },
    { name: 'Japan', code: 'JP' },
    { name: 'South Korea', code: 'KR' },
    { name: 'UAE', code: 'AE' },
  ];
  for (const c of countries) {
    await db.collection('countries').updateOne(
      { code: c.code },
      { $setOnInsert: { ...c, active: true, createdAt: new Date() } },
      { upsert: true }
    );
  }
  console.log(`Countries: ${countries.length} upserted`);

  // ─── Subscription Plans ───────────────────────────────────
  const plans = [
    {
      name: 'monthly',
      displayName: '1 Month',
      description: 'Full access to Ashqe movies for 1 month.',
      monthlyPrice: 49,
      quarterlyPrice: 0,
      annualPrice: 0,
      price: 49,
      duration: 1,
      durationUnit: 'month',
      currency: 'INR',
      features: {
        videoQuality: 'HD',
        simultaneousScreens: 1,
        downloadAllowed: true,
        maxDownloads: 5,
        adsEnabled: false,
        liveTV: false,
        earlyAccess: false,
        exclusiveContent: true,
        offlineViewing: true,
        dolbyAtmos: false,
        supportPriority: 'standard',
      },
      isActive: true,
      order: 1,
    },
    {
      name: 'quarterly',
      displayName: '3 Months',
      description: 'Full access to Ashqe movies for 3 months.',
      monthlyPrice: 0,
      quarterlyPrice: 139,
      annualPrice: 0,
      price: 139,
      duration: 3,
      durationUnit: 'month',
      currency: 'INR',
      features: {
        videoQuality: 'HD',
        simultaneousScreens: 2,
        downloadAllowed: true,
        maxDownloads: 10,
        adsEnabled: false,
        liveTV: false,
        earlyAccess: false,
        exclusiveContent: true,
        offlineViewing: true,
        dolbyAtmos: false,
        supportPriority: 'standard',
      },
      isActive: true,
      order: 2,
    },
    {
      name: 'half-yearly',
      displayName: '6 Months',
      description: 'Full access to Ashqe movies for 6 months.',
      monthlyPrice: 0,
      quarterlyPrice: 0,
      annualPrice: 0,
      price: 259,
      duration: 6,
      durationUnit: 'month',
      currency: 'INR',
      features: {
        videoQuality: 'Full HD',
        simultaneousScreens: 2,
        downloadAllowed: true,
        maxDownloads: 20,
        adsEnabled: false,
        liveTV: true,
        earlyAccess: true,
        exclusiveContent: true,
        offlineViewing: true,
        dolbyAtmos: false,
        supportPriority: 'priority',
      },
      isActive: true,
      order: 3,
    },
    {
      name: 'annual',
      displayName: '12 Months',
      description: 'Full access to Ashqe movies for 12 months — best value!',
      monthlyPrice: 0,
      quarterlyPrice: 0,
      annualPrice: 499,
      price: 499,
      duration: 12,
      durationUnit: 'month',
      currency: 'INR',
      features: {
        videoQuality: '4K Ultra HD',
        simultaneousScreens: 4,
        downloadAllowed: true,
        maxDownloads: 50,
        adsEnabled: false,
        liveTV: true,
        earlyAccess: true,
        exclusiveContent: true,
        offlineViewing: true,
        dolbyAtmos: true,
        supportPriority: 'priority',
      },
      isActive: true,
      order: 4,
    },
  ];

  // Remove old plans and insert fresh
  await db.collection('subscriptionplans').deleteMany({});
  await db.collection('subscriptionplans').insertMany(
    plans.map((p) => ({ ...p, createdAt: new Date(), updatedAt: new Date() }))
  );
  console.log(`Subscription Plans: ${plans.length} inserted (₹49, ₹139, ₹259, ₹499)`);

  await mongoose.disconnect();
  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
