import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tataiya';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  await db.collection('subscriptionplans').updateOne(
    { name: 'Standard' },
    {
      $set: {
        name: 'Standard',
        duration: 'Monthly',
        durationValue: 30,
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

  await db.collection('subscriptionplans').deleteMany({ name: { $ne: 'Standard' } });

  const plans = await db.collection('subscriptionplans').find({}).toArray();
  console.log('Active plans:', plans.map((p) => ({ name: p.name, price: p.price, totalPrice: p.totalPrice })));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
