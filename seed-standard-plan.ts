import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tataiya';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log('db:', db.databaseName);

  // Keep only Standard @ ₹30 / month
  await db.collection('subscriptionplans').updateOne(
    { name: 'Standard' },
    {
      $set: {
        name: 'Standard',
        duration: 'Month',
        durationValue: 1,
        price: 30,
        discount: 0,
        totalPrice: 30,
        status: true,
        description: 'Full access to Tataiya movies — Standard plan at ₹30/month.',
        level: 1,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  console.log('Upserted Standard plan @ ₹30 / 1 Month');

  // Disable / remove every other plan
  const result = await db.collection('subscriptionplans').updateMany(
    { name: { $ne: 'Standard' } },
    { $set: { status: false, updatedAt: new Date() } }
  );
  const deleted = await db.collection('subscriptionplans').deleteMany({
    name: { $ne: 'Standard' },
  });

  // Fix banner image URLs that are bare S3 keys
  const s3Base = 'https://tatiyatv.s3.eu-north-1.amazonaws.com/';
  const banners = await db.collection('banners').find({}).toArray();
  let fixedBanners = 0;
  for (const b of banners) {
    const updates: Record<string, any> = {};
    for (const field of ['imageUrl', 'mobileImageUrl', 'thumbnail'] as const) {
      const v = (b as any)[field];
      if (typeof v === 'string' && v && !v.startsWith('http') && !v.startsWith('/')) {
        updates[field] = s3Base + v.replace(/^uploads\//, '');
      } else if (typeof v === 'string' && /^https?:\/\/(?:www\.)?tataiya\.in\/uploads\/(media\/.+)$/i.test(v)) {
        updates[field] = s3Base + v.replace(/^https?:\/\/(?:www\.)?tataiya\.in\/uploads\//i, '');
      }
    }
    if (!Array.isArray(b.targetPlatforms) || b.targetPlatforms.length === 0) {
      updates.targetPlatforms = ['web', 'mobile'];
    }
    if (Object.keys(updates).length) {
      await db.collection('banners').updateOne({ _id: b._id }, { $set: updates });
      fixedBanners++;
    }
  }

  const plans = await db.collection('subscriptionplans').find({}).toArray();
  console.log(
    'plans now:',
    plans.map((p) => ({ name: p.name, price: p.price, totalPrice: p.totalPrice, status: p.status }))
  );
  console.log('other plans disabled:', result.modifiedCount, 'deleted:', deleted.deletedCount);
  console.log('banners fixed:', fixedBanners);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
