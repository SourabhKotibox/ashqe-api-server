import 'dotenv/config';
import mongoose from 'mongoose';
import { transcodeToHls } from '../src/lib/hlsTranscoder';

/**
 * Re-queue videos stuck in hlsStatus=processing / failed.
 * Usage: npx tsx scratch/reprocess-stuck-hls.ts
 */
async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const stuck = await db
    .collection('mediafiles')
    .find({
      $or: [
        { hlsStatus: 'processing' },
        { hlsStatus: 'pending' },
        { hlsStatus: 'failed' },
      ],
      $and: [
        {
          $or: [
            { fileType: /^video/i },
            { name: /\.(mp4|mkv|mov|webm|m4v)$/i },
          ],
        },
      ],
    })
    .project({ _id: 1, name: 1, hlsStatus: 1, storageType: 1, s3Key: 1 })
    .toArray();

  console.log(`Found ${stuck.length} stuck video(s)`);
  for (const f of stuck) {
    const id = String(f._id);
    const storage = f.storageType === 's3' || f.s3Key ? 's3' : 'local';
    console.log(`Reprocessing ${f.name} (${f.hlsStatus}) → ${id}`);
    await db.collection('mediafiles').updateOne(
      { _id: f._id },
      { $set: { hlsStatus: 'processing', hlsError: null }, $unset: { hlsMasterPlaylistUrl: '', isHls: '' } }
    );
    try {
      await transcodeToHls(id, '', 'https://tataiya.in', storage as 's3' | 'local');
      console.log('  ✓ done', f.name);
    } catch (e: any) {
      console.error('  ✗', f.name, e?.message || e);
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
