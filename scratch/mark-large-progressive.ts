import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Instantly mark large stuck videos as progressive (playable) — no download/transcode.
 * Usage: npx tsx scratch/mark-large-progressive.ts
 */
const THRESHOLD = 400 * 1024 * 1024; // 400MB

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const col = db.collection('mediafiles');

  const stuck = await col
    .find({
      $or: [{ hlsStatus: 'processing' }, { hlsStatus: 'pending' }, { hlsStatus: 'failed' }],
      $and: [
        {
          $or: [{ fileType: /^video/i }, { name: /\.(mp4|mkv|mov|webm|m4v)$/i }],
        },
      ],
    })
    .toArray();

  console.log(`Found ${stuck.length} stuck video(s)`);
  for (const f of stuck) {
    const size = Number(f.fileSize) || 0;
    const url = f.url;
    if (!url) {
      console.log(`  skip ${f.name} — no url`);
      continue;
    }
    // Large files OR anything still stuck after failed local HLS → progressive source URL
    if (size >= THRESHOLD || size === 0) {
      await col.updateOne(
        { _id: f._id },
        {
          $set: {
            isHls: true,
            hlsStatus: 'completed',
            hlsMasterPlaylistUrl: url,
            hlsMasterPlaylistPath: url,
            transcoder: 'progressive',
            hlsQualities: [
              { quality: 'source', url, filePath: url, bitrate: 0, resolution: 'source' },
            ],
          },
          $unset: { hlsError: '' },
        }
      );
      console.log(`  ✓ ${f.name} → Ready (progressive) size=${size}`);
    } else {
      console.log(`  · ${f.name} is ${Math.round(size / 1024 / 1024)}MB — leave for real HLS`);
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
