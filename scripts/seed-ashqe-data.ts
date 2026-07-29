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
      { $setOnInsert: { ...lang, isActive: true, order: i + 1, createdAt: new Date(), updatedAt: new Date() } },
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

  // ─── Subscription Plans (matches SubscriptionPlan model) ──
  const plans = [
    {
      name: 'Ashqe 1 Month',
      duration: 'Month',
      durationValue: 1,
      price: 49,
      discount: 0,
      totalPrice: 49,
      status: true,
      description: 'Full access to Ashqe movies for 1 month.',
      level: 1,
    },
    {
      name: 'Ashqe 3 Months',
      duration: '3 Months',
      durationValue: 3,
      price: 139,
      discount: 0,
      totalPrice: 139,
      status: true,
      description: 'Full access to Ashqe movies for 3 months.',
      level: 2,
    },
    {
      name: 'Ashqe 6 Months',
      duration: '6 Months',
      durationValue: 6,
      price: 259,
      discount: 0,
      totalPrice: 259,
      status: true,
      description: 'Full access to Ashqe movies for 6 months.',
      level: 3,
    },
    {
      name: 'Ashqe 12 Months',
      duration: '12 Months',
      durationValue: 12,
      price: 499,
      discount: 0,
      totalPrice: 499,
      status: true,
      description: 'Full access to Ashqe movies for 12 months — best value!',
      level: 4,
    },
  ];

  // Remove old plans (including Xoto leftovers) and insert fresh
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
