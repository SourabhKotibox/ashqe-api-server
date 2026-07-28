/**
 * Heal subscription ↔ user sync + Standard plan duration.
 * Usage: npx tsx sync-subscriptions.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI!;

function normalizePlanKey(name?: string | null): string {
  const n = String(name || 'free').toLowerCase();
  if (!n || n === 'free') return 'free';
  if (n.includes('premium') || n.includes('vip')) return 'premium';
  if (n.includes('standard')) return 'standard';
  if (n.includes('basic')) return 'basic';
  return 'standard';
}

async function main() {
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log('db:', db.databaseName);

  // Fix Standard plan: Monthly + 30 was adding 30 months
  await db.collection('subscriptionplans').updateOne(
    { name: { $regex: /^standard$/i } },
    {
      $set: {
        name: 'Standard',
        duration: 'Month',
        durationValue: 1,
        price: 30,
        totalPrice: 30,
        status: true,
        description: 'Full access to Tataiya movies — Standard plan at ₹30/month.',
        updatedAt: new Date(),
      },
    }
  );
  console.log('Fixed Standard plan → 1 Month');

  const now = new Date();
  const activeSubs = await db
    .collection('subscriptions')
    .find({
      status: 'active',
      $or: [{ endDate: { $gte: now } }, { endDate: null }, { endDate: { $exists: false } }],
    })
    .toArray();

  console.log(`Active subscriptions: ${activeSubs.length}`);

  for (const sub of activeSubs) {
    // Fix absurd end dates from Monthly×30 bug ( > 2 years out )
    let endDate = sub.endDate ? new Date(sub.endDate) : null;
    const startDate = sub.startDate ? new Date(sub.startDate) : now;
    if (endDate && endDate.getTime() - startDate.getTime() > 400 * 24 * 60 * 60 * 1000) {
      endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      await db.collection('subscriptions').updateOne(
        { _id: sub._id },
        { $set: { duration: 'Month', durationValue: 1, endDate, updatedAt: new Date() } }
      );
      console.log(`  fixed endDate for sub ${sub._id} → ${endDate.toISOString().slice(0, 10)}`);
    }

    const planKey = normalizePlanKey(sub.plan);
    const result = await db.collection('users').updateOne(
      { _id: sub.userId },
      {
        $set: {
          subscriptionPlan: planKey,
          subscriptionStatus: 'active',
          subscriptionExpiry: endDate || sub.endDate || null,
          subscriptionPlanId: sub.planId || null,
          updatedAt: new Date(),
        },
      }
    );
    console.log(
      `  user ${sub.userId} → ${planKey}/active (matched=${result.matchedCount}, modified=${result.modifiedCount})`
    );
  }

  // Downgrade users with no active subscription but still marked active paid
  const paidActiveUsers = await db
    .collection('users')
    .find({
      subscriptionStatus: 'active',
      subscriptionPlan: { $nin: ['free', null] },
    })
    .project({ _id: 1, subscriptionPlan: 1, email: 1, name: 1 })
    .toArray();

  for (const u of paidActiveUsers) {
    const still = await db.collection('subscriptions').findOne({
      userId: u._id,
      status: 'active',
      $or: [{ endDate: { $gte: now } }, { endDate: null }, { endDate: { $exists: false } }],
    });
    if (!still) {
      await db.collection('users').updateOne(
        { _id: u._id },
        {
          $set: {
            subscriptionPlan: 'free',
            subscriptionStatus: 'inactive',
            subscriptionPlanId: null,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`  cleared stale plan on user ${u.email || u._id}`);
    } else {
      // Ensure lowercase plan key
      const key = normalizePlanKey(u.subscriptionPlan);
      if (u.subscriptionPlan !== key) {
        await db.collection('users').updateOne(
          { _id: u._id },
          { $set: { subscriptionPlan: key, updatedAt: new Date() } }
        );
        console.log(`  normalized plan casing for ${u.email || u._id}: ${u.subscriptionPlan} → ${key}`);
      }
    }
  }

  await mongoose.disconnect();
  console.log('Done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
