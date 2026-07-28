import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/triple-mindes';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const plans = await db.collection('subscriptionplans').find({ status: true }).toArray();
  const byName = Object.fromEntries(plans.map((p) => [String(p.name).toLowerCase(), p]));

  const limitDefs: Record<string, any> = {
    basic: {
      videoCast: false,
      ads: true,
      deviceLimit: true,
      deviceLimitCount: 1,
      downloadStatus: false,
      downloadLimitCount: 0,
      profileLimit: true,
      profileLimitCount: 1,
      q480p: true,
      q720p: true,
      q1080p: false,
      q1440p: false,
      q2k: false,
      q4k: false,
    },
    standard: {
      videoCast: true,
      ads: false,
      deviceLimit: true,
      deviceLimitCount: 2,
      downloadStatus: true,
      downloadLimitCount: 20,
      profileLimit: true,
      profileLimitCount: 2,
      q480p: true,
      q720p: true,
      q1080p: true,
      q1440p: false,
      q2k: false,
      q4k: false,
    },
    premium: {
      videoCast: true,
      ads: false,
      deviceLimit: true,
      deviceLimitCount: 4,
      downloadStatus: true,
      downloadLimitCount: 20,
      profileLimit: true,
      profileLimitCount: 4,
      q480p: true,
      q720p: true,
      q1080p: true,
      q1440p: true,
      q2k: true,
      q4k: true,
    },
  };

  for (const [key, limits] of Object.entries(limitDefs)) {
    const matches = plans.filter((p) => {
      const n = String(p.name).toLowerCase();
      return n === key || n.startsWith(key) || n.includes(key);
    });
    for (const plan of matches) {
      await db.collection('planlimits').updateOne(
        { planId: plan._id },
        { $set: { ...limits, planId: plan._id, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    }
  }

  // Ensure mix of free + premium movies for plan gating demos
  const movies = await db
    .collection('movies')
    .find({ status: 'published' })
    .project({ _id: 1 })
    .sort({ createdAt: -1 })
    .toArray();

  for (let i = 0; i < movies.length; i++) {
    const planRequired = i % 3 === 0 ? 'premium' : i % 3 === 1 ? 'basic' : 'free';
    await db.collection('movies').updateOne(
      { _id: movies[i]._id },
      { $set: { planRequired } }
    );
  }

  console.log(`Plan limits seeded for ${Object.keys(limitDefs).length} tiers`);
  console.log(`Updated planRequired on ${movies.length} movies`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
