import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Types } from 'mongoose';
import { MovieModel } from '../models/Movie';
import { logger } from '../lib/logger';
import { isS3Configured, uploadHlsFolderToS3, getHlsPublicBaseUrl, getS3PublicUrl } from '../lib/s3';

// ─────────────────────────────────────────────────────────────────────────────
// All 7 quality renditions with Netflix-grade bitrate settings
// ─────────────────────────────────────────────────────────────────────────────
export const HLS_QUALITY_LADDER = [
  { name: '144p',  width: 256,  height: 144,  bitrate: '100k',  maxrate: '110k',   bufsize: '150k',   audioBitrate: '48k'  },
  { name: '240p',  width: 426,  height: 240,  bitrate: '400k',  maxrate: '428k',   bufsize: '600k',   audioBitrate: '64k'  },
  { name: '360p',  width: 640,  height: 360,  bitrate: '800k',  maxrate: '856k',   bufsize: '1200k',  audioBitrate: '96k'  },
  { name: '480p',  width: 854,  height: 480,  bitrate: '1400k', maxrate: '1498k',  bufsize: '2100k',  audioBitrate: '128k' },
  { name: '720p',  width: 1280, height: 720,  bitrate: '2800k', maxrate: '2996k',  bufsize: '4200k',  audioBitrate: '128k' },
  { name: '1080p', width: 1920, height: 1080, bitrate: '5000k', maxrate: '5350k',  bufsize: '7500k',  audioBitrate: '192k' },
  { name: '1440p', width: 2560, height: 1440, bitrate: '8000k', maxrate: '8560k',  bufsize: '12000k', audioBitrate: '192k' },
  { name: '2160p', width: 3840, height: 2160, bitrate: '16000k',maxrate: '17120k', bufsize: '24000k', audioBitrate: '192k' },
] as const;

export type QualityName = typeof HLS_QUALITY_LADDER[number]['name'];

// Bandwidth values for master.m3u8 BANDWIDTH attribute (bits/s)
const BANDWIDTH_MAP: Record<QualityName, number> = {
  '144p':  100_000,
  '240p':  400_000,
  '360p':  800_000,
  '480p':  1_400_000,
  '720p':  2_800_000,
  '1080p': 5_000_000,
  '1440p': 8_000_000,
  '2160p': 16_000_000,
};

const RESOLUTION_MAP: Record<QualityName, string> = {
  '144p':  '256x144',
  '240p':  '426x240',
  '360p':  '640x360',
  '480p':  '854x480',
  '720p':  '1280x720',
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '2160p': '3840x2160',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const runCommand = (command: string, args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
};

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export const toLocalUploadPath = (urlPath: string): string | null => {
  if (!urlPath) return null;
  const uploadsRoot = path.join(process.cwd(), 'uploads');
  let relPath = urlPath;
  if (relPath.startsWith('/uploads/')) relPath = relPath.replace('/uploads/', '');
  else if (relPath.startsWith('uploads/')) relPath = relPath.replace('uploads/', '');
  else if (relPath.startsWith('/media/')) relPath = relPath.replace('/', '');
  return path.join(uploadsRoot, relPath);
};

const getFolderSize = (folderPath: string): number => {
  try {
    if (!fs.existsSync(folderPath)) return 0;
    const walk = (dir: string): number => {
      let size = 0;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        size += f.isDirectory() ? walk(fp) : fs.statSync(fp).size;
      }
      return size;
    };
    return walk(folderPath);
  } catch { return 0; }
};

/**
 * Probe source video resolution using ffprobe.
 * Returns { width, height } or null on failure.
 */
const probeResolution = async (inputPath: string): Promise<{ width: number; height: number } | null> => {
  try {
    const output = await runCommand('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      inputPath,
    ]);
    const parts = output.trim().split(',');
    if (parts.length >= 2) {
      const w = parseInt(parts[0], 10);
      const h = parseInt(parts[1], 10);
      if (!isNaN(w) && !isNaN(h)) return { width: w, height: h };
    }
  } catch (err) {
    logger.warn({ err }, 'ffprobe resolution detection failed — will use all qualities');
  }
  return null;
};

/**
 * Filter quality ladder to only include renditions whose height
 * does not exceed the source video's height.
 */
const filterQualitiesByResolution = (
  sourceHeight: number,
  ladder: typeof HLS_QUALITY_LADDER
) => ladder.filter((q) => q.height <= sourceHeight);

// ─────────────────────────────────────────────────────────────────────────────
// Core HLS Transcoder — Single-pass multi-variant FFmpeg (local storage)
// ─────────────────────────────────────────────────────────────────────────────
export const transcodeHlsMultiResolution = async (options: {
  id: string;
  sourceVideoUrl: string;
  startSeconds?: number;
  duration?: number;
}) => {
  const { id, sourceVideoUrl, startSeconds, duration } = options;

  // ── Resolve input path (local file, or remote/S3 URL for ffmpeg) ────────
  let ffmpegInput = sourceVideoUrl;
  const sourceVideoPath = toLocalUploadPath(sourceVideoUrl);
  if (sourceVideoPath && fs.existsSync(sourceVideoPath)) {
    ffmpegInput = sourceVideoPath;
  } else if (sourceVideoUrl.startsWith('http://') || sourceVideoUrl.startsWith('https://')) {
    ffmpegInput = sourceVideoUrl;
  } else if (await isS3Configured()) {
    ffmpegInput = await getS3PublicUrl(sourceVideoUrl);
  } else if (!sourceVideoPath || !fs.existsSync(sourceVideoPath || '')) {
    throw new Error(`Source video not found: ${sourceVideoUrl}`);
  }

  // ── Determine local HLS output folder ──────────────────────────────────
  const uploadsRoot = path.join(process.cwd(), 'uploads');
  const hlsFolder    = path.join(uploadsRoot, 'hls', 'movies', id);
  const localUrlBase = `/uploads/hls/movies/${id}`;

  // Clear any existing HLS files to prevent mixing old and new uploads
  if (fs.existsSync(hlsFolder)) {
    try {
      fs.rmSync(hlsFolder, { recursive: true, force: true });
    } catch (rmErr) {
      logger.warn({ rmErr, hlsFolder }, 'Failed to clear existing HLS folder');
    }
  }
  ensureDir(hlsFolder);

  // ── Detect source resolution & filter quality ladder ───────────────────
  const sourceRes = await probeResolution(ffmpegInput);
  const sourceHeight = sourceRes?.height ?? 2160; // assume max if detection fails
  const qualities = filterQualitiesByResolution(sourceHeight, HLS_QUALITY_LADDER);
  logger.info({ id, sourceHeight, qualityCount: qualities.length }, 'Starting HLS transcoding');

  // ── Build single-pass FFmpeg args ───────────────────────────────────────
  const args: string[] = ['-y'];

  // Input seek (must come before -i for fast seek)
  if (startSeconds !== undefined && startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push('-i', ffmpegInput);
  if (duration !== undefined && duration > 0) {
    args.push('-t', String(duration));
  }

  // Build filter_complex: split video and scale each output stream
  const n = qualities.length;
  const splitOutputs = qualities.map((_, i) => `[temp${i}]`).join('');
  const scaleFilters = qualities.map((q, i) => `[temp${i}]scale=${q.width}:${q.height}[v${i}]`).join(';');
  const filterComplexString = `[0:v]split=${n}${splitOutputs};${scaleFilters}`;
  args.push('-filter_complex', filterComplexString);

  // Map each video stream, then audio
  qualities.forEach((q, i) => {
    args.push(
      `-map`, `[v${i}]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, q.bitrate,
      `-maxrate:v:${i}`, q.maxrate,
      `-bufsize:v:${i}`, q.bufsize,
      `-preset:v:${i}`, 'veryfast',
      `-profile:v:${i}`, 'main',
      `-map`, '0:a:0',
      `-c:a:${i}`, 'aac',
      `-b:a:${i}`, q.audioBitrate,
      `-ar:a:${i}`, '48000',
    );
  });

  // var_stream_map — pairs each video track with audio track
  const streamMap = qualities.map((_, i) => `v:${i},a:${i},name:${qualities[i].name}`).join(' ');
  args.push(
    '-var_stream_map', streamMap,
    '-master_pl_name', 'master.m3u8',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(hlsFolder, '%v/segment_%03d.ts'),
    path.join(hlsFolder, '%v/playlist.m3u8'),
  );

  // ── Run FFmpeg ──────────────────────────────────────────────────────────
  try {
    await runCommand('ffmpeg', args);
  } catch (err: any) {
    logger.error({ err, id }, 'FFmpeg single-pass failed — falling back to sequential');
    // Fallback: process each quality sequentially (avoids OOM on low-RAM servers)
    return transcodeHlsSequential({ startSeconds, duration, qualities, hlsFolder, localUrlBase, ffmpegInput, movieId: id });
  }

  // ── Build master.m3u8 ───────────────────────────────────────────────────
  // FFmpeg creates it automatically, but we rebuild it to ensure correct paths
  writeMasterPlaylist(hlsFolder, qualities);

  const out = await buildLocalHlsOutput({ qualities, hlsFolder, localUrlBase, movieId: id });

  return {
    hlsUrl: out.masterUrl,
    videoQualities: out.renditions,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Sequential fallback (one quality at a time — safer on low-RAM servers)
// ─────────────────────────────────────────────────────────────────────────────
const transcodeHlsSequential = async (opts: {
  startSeconds?: number;
  duration?: number;
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>;
  hlsFolder: string;
  localUrlBase: string;
  ffmpegInput: string;
  movieId: string;
}) => {
  const { startSeconds, duration, qualities, hlsFolder, localUrlBase, ffmpegInput, movieId } = opts;

  for (const q of qualities) {
    const qFolder = path.join(hlsFolder, q.name);
    ensureDir(qFolder);

    const args: string[] = ['-y'];
    if (startSeconds !== undefined && startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push('-i', ffmpegInput);
    if (duration !== undefined && duration > 0) args.push('-t', String(duration));

    args.push(
      '-vf',           `scale=${q.width}:${q.height}`,
      '-c:v',          'libx264',
      '-b:v',          q.bitrate,
      '-maxrate',      q.maxrate,
      '-bufsize',      q.bufsize,
      '-profile:v',    'main',
      '-preset',       'veryfast',
      '-c:a',          'aac',
      '-b:a',          q.audioBitrate,
      '-ar',           '48000',
      '-f',            'hls',
      '-hls_time',     '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(qFolder, 'segment_%03d.ts'),
      path.join(qFolder, 'playlist.m3u8'),
    );

    await runCommand('ffmpeg', args);
    logger.info({ quality: q.name }, 'Sequential quality encoded');
  }

  // Rebuild master.m3u8
  writeMasterPlaylist(hlsFolder, qualities);

  const out = await buildLocalHlsOutput({ qualities, hlsFolder, localUrlBase, movieId });
  return {
    hlsUrl:         out.masterUrl,
    videoQualities: out.renditions,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Master playlist + local output map
// ─────────────────────────────────────────────────────────────────────────────
const writeMasterPlaylist = (
  hlsFolder: string,
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>
) => {
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const q of qualities) {
    const bandwidth  = BANDWIDTH_MAP[q.name as QualityName];
    const resolution = RESOLUTION_MAP[q.name as QualityName];
    masterLines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},NAME="${q.name}"`,
      `${q.name}/playlist.m3u8`,
    );
  }
  fs.writeFileSync(path.join(hlsFolder, 'master.m3u8'), masterLines.join('\n'), 'utf-8');
};

const buildLocalHlsOutput = async (opts: {
  qualities: ReadonlyArray<typeof HLS_QUALITY_LADDER[number]>;
  hlsFolder: string;
  localUrlBase: string;
  movieId: string;
}) => {
  const { qualities, hlsFolder, localUrlBase, movieId } = opts;
  const s3Active = await isS3Configured();

  if (s3Active) {
    const s3Prefix = `hls/movies/${movieId}`;
    await uploadHlsFolderToS3(hlsFolder, s3Prefix);
    const baseUrl = await getHlsPublicBaseUrl();
    const masterUrl = `${baseUrl}/${s3Prefix}/master.m3u8`;
    const renditions = qualities.map((q) => ({
      quality: q.name as QualityName,
      url: `${baseUrl}/${s3Prefix}/${q.name}/playlist.m3u8`,
      size: getFolderSize(path.join(hlsFolder, q.name)),
    }));
    try { fs.rmSync(hlsFolder, { recursive: true, force: true }); } catch { /* ignore */ }
    return { masterUrl, renditions };
  }

  const masterUrl = `${localUrlBase}/master.m3u8`;
  const renditions = qualities.map((q) => ({
    quality: q.name as QualityName,
    url: `${localUrlBase}/${q.name}/playlist.m3u8`,
    size: getFolderSize(path.join(hlsFolder, q.name)),
  }));
  return { masterUrl, renditions };
};

// ─────────────────────────────────────────────────────────────────────────────
// Public processors — Movies
// ─────────────────────────────────────────────────────────────────────────────
export const processMovieHls = async (movieId: Types.ObjectId | string, sourceVideoUrl: string) => {
  try {
    await MovieModel.findByIdAndUpdate(movieId, { processingStatus: 'processing' });

    const result = await transcodeHlsMultiResolution({
      id: movieId.toString(),
      sourceVideoUrl,
    });

    await MovieModel.findByIdAndUpdate(movieId, {
      hlsUrl:          result.hlsUrl,
      videoUrl:        sourceVideoUrl,
      sourceVideoUrl,
      videoQualities:  result.videoQualities,
      status:          'published',
      processingStatus:'ready',
      processingError: null,
    });

    logger.info({ movieId, hlsUrl: result.hlsUrl }, 'Movie HLS processing complete');
  } catch (error: any) {
    logger.error({ error, movieId }, 'Error processing movie HLS');
    await MovieModel.findByIdAndUpdate(movieId, {
      processingStatus: 'failed',
      processingError:  error.message,
    });
  }
};

export const processMovieInBackground = (movieId: Types.ObjectId | string, sourceVideoUrl: string) => {
  setImmediate(async () => {
    await processMovieHls(movieId, sourceVideoUrl);
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect HLS qualities already on disk and sync them to MongoDB
// ─────────────────────────────────────────────────────────────────────────────
export const autoDetectAndSyncQualities = async (
  id: Types.ObjectId | string
): Promise<any> => {
  const doc = await MovieModel.findById(id).lean();
  if (!doc) return null;

  const hlsFolder = path.join(process.cwd(), 'uploads/hls', 'movies', id.toString());
  const masterPlaylistPath = path.join(hlsFolder, 'master.m3u8');

  if (fs.existsSync(masterPlaylistPath)) {
    const validQualities = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];
    const detectedQualities: string[] = [];

    const dirs = fs.readdirSync(hlsFolder, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory() && validQualities.includes(dir.name)) {
        const qualityPlaylistPath = path.join(hlsFolder, dir.name, 'playlist.m3u8');
        if (fs.existsSync(qualityPlaylistPath)) {
          detectedQualities.push(dir.name);
        }
      }
    }

    if (detectedQualities.length > 0) {
      const hlsUrl = `/uploads/hls/movies/${id}/master.m3u8`;
      const videoQualities = detectedQualities.map(q => ({
        quality: q,
        url: `/uploads/hls/movies/${id}/${q}/playlist.m3u8`,
        size: getFolderSize(path.join(hlsFolder, q))
      }));

      // Check if we need to update
      const currentQualitiesStr = JSON.stringify(doc.videoQualities || []);
      const newQualitiesStr = JSON.stringify(videoQualities);
      const hasDiff = currentQualitiesStr !== newQualitiesStr ||
                      doc.processingStatus !== 'ready' ||
                      doc.hlsUrl !== hlsUrl;

      if (hasDiff) {
        logger.info({ id: id.toString(), qualityCount: videoQualities.length }, 'Syncing auto-detected HLS qualities to MongoDB');

        const updateData: any = {
          hlsUrl,
          videoQualities,
          processingStatus: 'ready',
          processingError: null,
        };

        if ((doc as any).status === 'draft' || !(doc as any).status) {
          updateData.status = 'published';
        }

        const updatedDoc = await MovieModel.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean();
        return updatedDoc;
      }
    }
  }
  return doc;
};
