import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  console.log('DB:', db.databaseName);

  const subs = await db.collection('subscriptions').find({}).toArray();
  console.log('\n=== SUBSCRIPTIONS ===', subs.length);
  for (const s of subs) {
    console.log({
      id: String(s._id),
      userId: String(s.userId),
      plan: s.plan,
      status: s.status,
      start: s.startDate,
      end: s.endDate,
      duration: s.duration,
      durationValue: s.durationValue,
    });
  }

  const users = await db
    .collection('users')
    .find({})
    .project({
      email: 1,
      name: 1,
      subscriptionPlan: 1,
      subscriptionStatus: 1,
      subscriptionExpiry: 1,
      subscriptionPlanId: 1,
    })
    .toArray();
  console.log('\n=== USERS ===', users.length);
  for (const u of users) {
    console.log({
      id: String(u._id),
      email: u.email,
      name: u.name,
      plan: u.subscriptionPlan,
      status: u.subscriptionStatus,
      expiry: u.subscriptionExpiry,
      planId: u.subscriptionPlanId ? String(u.subscriptionPlanId) : null,
    });
  }

  // Cross-check: each active sub → matching user fields
  console.log('\n=== SYNC CHECK ===');
  const now = new Date();
  for (const s of subs) {
    const u = await db.collection('users').findOne({ _id: s.userId });
    const liveOk =
      s.status === 'active' && (!s.endDate || new Date(s.endDate) >= now);
    console.log({
      subPlan: s.plan,
      subStatus: s.status,
      liveOk,
      userFound: !!u,
      userEmail: u?.email,
      userPlan: u?.subscriptionPlan,
      userStatus: u?.subscriptionStatus,
      userExpiry: u?.subscriptionExpiry,
      MATCH:
        !!u &&
        u.subscriptionStatus === 'active' &&
        String(u.subscriptionPlan || '').toLowerCase() !== 'free' &&
        liveOk,
    });
  }

  const movies = await db
    .collection('movies')
    .find({})
    .project({
      title: 1,
      status: 1,
      hlsUrl: 1,
      processingStatus: 1,
      videoUrl: 1,
      sourceVideoUrl: 1,
      videoQualities: 1,
    })
    .toArray();
  console.log('\n=== MOVIES HLS ===', movies.length);
  for (const m of movies) {
    console.log({
      title: m.title,
      status: m.status,
      processingStatus: m.processingStatus,
      hasHls: !!m.hlsUrl,
      hlsUrl: m.hlsUrl ? String(m.hlsUrl).slice(0, 90) : null,
      hasVideo: !!(m.videoUrl || m.sourceVideoUrl),
      qualities: (m.videoQualities || []).length,
    });
  }

  const media = await db
    .collection('mediafiles')
    .find({
      $or: [{ fileType: /^video/i }, { name: /\.(mp4|mkv|mov|webm)$/i }],
    })
    .project({
      name: 1,
      hlsStatus: 1,
      isHls: 1,
      hlsMasterPlaylistUrl: 1,
      duration: 1,
      fileSize: 1,
    })
    .toArray();
  console.log('\n=== MEDIA VIDEOS ===', media.length);
  for (const f of media) {
    console.log({
      name: f.name,
      hlsStatus: f.hlsStatus,
      isHls: f.isHls,
      hasMaster: !!f.hlsMasterPlaylistUrl,
      duration: f.duration,
      sizeMB: Math.round((f.fileSize || 0) / 1e6),
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
