import 'dotenv/config';
import mongoose from 'mongoose';

function isBlobUrl(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('blob:');
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  const media = await db.collection('mediafiles').find({ hlsMasterPlaylistUrl: { $exists: true } }).toArray();
  const byS3Key = new Map<string, any>();
  const byUrl = new Map<string, any>();
  for (const m of media) {
    if (m.s3Key) byS3Key.set(m.s3Key, m);
    if (m.url) byUrl.set(m.url, m);
    if (m.hlsMasterPlaylistUrl) byUrl.set(m.hlsMasterPlaylistUrl, m);
  }

  const movies = await db.collection('movies').find({}).toArray();
  for (const movie of movies) {
    const patch: Record<string, any> = {};
    let note = '';

    if (isBlobUrl(movie.hlsUrl)) {
      patch.hlsUrl = null;
      note += 'cleared blob hlsUrl; ';
    }

    // Try match trailer → media HLS
    const trailer = movie.trailerUrl || '';
    let matched =
      (trailer && byS3Key.get(trailer.replace(/^https?:\/\/[^/]+\//, ''))) ||
      (trailer && byUrl.get(trailer)) ||
      null;

    // Also match by filename fragment in s3 key
    if (!matched && trailer) {
      const leaf = trailer.split('/').pop();
      matched = media.find((m) => m.s3Key?.endsWith(leaf) || m.url?.endsWith(leaf)) || null;
    }

    const currentHls = patch.hlsUrl !== undefined ? patch.hlsUrl : movie.hlsUrl;
    if ((!currentHls || isBlobUrl(currentHls)) && matched?.hlsMasterPlaylistUrl && matched.hlsStatus === 'completed') {
      patch.hlsUrl = matched.hlsMasterPlaylistUrl;
      patch.processingStatus = 'ready';
      patch.processingError = null;
      if (!movie.videoUrl && matched.url) patch.videoUrl = matched.url;
      if (!movie.sourceVideoUrl && matched.url) patch.sourceVideoUrl = matched.url;
      note += `linked HLS from media ${matched.name}; `;
    } else if ((!currentHls || isBlobUrl(currentHls)) && matched?.url) {
      patch.videoUrl = matched.url;
      patch.sourceVideoUrl = matched.url;
      patch.processingStatus = matched.hlsStatus === 'processing' ? 'processing' : 'failed';
      note += `linked source MP4 from media ${matched.name} (HLS ${matched.hlsStatus}); `;
    } else if (isBlobUrl(movie.hlsUrl)) {
      patch.processingStatus = 'failed';
      patch.processingError = 'Invalid blob: video URL — re-select video from Media Library';
    }

    if (Object.keys(patch).length) {
      await db.collection('movies').updateOne({ _id: movie._id }, { $set: patch });
      console.log('HEALED', movie.title, note, patch);
    } else {
      console.log('OK', movie.title, { hlsUrl: movie.hlsUrl?.slice?.(0, 80), processingStatus: movie.processingStatus });
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
