/**
 * Probe video metadata + extract a cover frame for movie auto-fill.
 *
 * Important: never ffprobe remote HTTPS URLs with the static @ffprobe-installer
 * binary — it often SIGSEGVs. Always probe a local file (download a range from S3).
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger';
import {
  isS3Configured,
  uploadToS3,
  getS3PublicUrl,
  downloadS3RangeToFile,
  downloadFromS3ToFile,
} from './s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_DIR = path.join(__dirname, '../../uploads/temp');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export type VideoProbeResult = {
  duration: number;
  width: number;
  height: number;
  codec?: string;
  bitrate?: number;
  fps?: number;
  audioCodec?: string;
  format?: string;
};

export function sanitizeFfmpegError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Unknown error');
  if (/SIGSEGV|signal 11|segmentation/i.test(raw)) {
    return 'Video probe crashed (ffprobe). File may still play as MP4 — retry HLS or enable AWS MediaConvert.';
  }
  // Drop the huge ffprobe version banner from UI toasts
  const firstLine = raw.split('\n').find((l) => l.trim() && !/^ffprobe version/i.test(l.trim())) || raw;
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, 220);
}

export async function probeVideo(input: string): Promise<VideoProbeResult> {
  if (/^https?:\/\//i.test(input)) {
    throw new Error('Remote URL probe disabled — use a local file path (download from S3 first)');
  }
  if (!fs.existsSync(input)) {
    throw new Error(`Probe input not found: ${input}`);
  }

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (err, metadata) => {
      if (err) return reject(err);
      const video = metadata.streams.find((s) => s.codec_type === 'video');
      const audio = metadata.streams.find((s) => s.codec_type === 'audio');
      if (!video) return reject(new Error('No video stream found'));

      let fps = 0;
      const rate = video.avg_frame_rate || video.r_frame_rate;
      if (rate && rate.includes('/')) {
        const [a, b] = rate.split('/').map(Number);
        if (b) fps = Math.round((a / b) * 100) / 100;
      }

      resolve({
        duration: Math.round(metadata.format?.duration || 0),
        width: video.width || 0,
        height: video.height || 0,
        codec: video.codec_name,
        bitrate: metadata.format?.bit_rate
          ? Math.round(Number(metadata.format.bit_rate) / 1000)
          : undefined,
        fps: fps || undefined,
        audioCodec: audio?.codec_name,
        format: metadata.format?.format_name,
      });
    });
  });
}

/**
 * Grab one frame near 10% / 5s mark for poster/thumbnail auto-fill.
 * Returns public URL (S3 or local path).
 */
export async function extractPosterFrame(
  input: string,
  mediaFileId: string,
  durationSeconds = 0
): Promise<string | null> {
  if (/^https?:\/\//i.test(input) || !fs.existsSync(input)) {
    return null;
  }

  const seek =
    durationSeconds > 20
      ? Math.min(30, Math.floor(durationSeconds * 0.1))
      : Math.min(5, Math.max(1, Math.floor(durationSeconds / 3) || 1));
  const outFile = path.join(TEMP_DIR, `poster-${mediaFileId}-${Date.now()}.jpg`);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(input)
        .seekInput(seek)
        .frames(1)
        .outputOptions(['-q:v', '3'])
        .output(outFile)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });

    if (!fs.existsSync(outFile)) return null;

    if (await isS3Configured()) {
      const key = `media/posters/${mediaFileId}-${Date.now()}.jpg`;
      const buf = fs.readFileSync(outFile);
      const url = await uploadToS3(key, buf, 'image/jpeg');
      try {
        fs.unlinkSync(outFile);
      } catch {
        /* ignore */
      }
      return url;
    }

    return `/uploads/temp/${path.basename(outFile)}`;
  } catch (err) {
    logger.warn({ err, mediaFileId }, 'Poster frame extraction failed');
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Resolve a LOCAL file for probing. Downloads a byte-range from S3 when needed.
 * Never returns an https:// URL (static ffprobe SIGSEGVs on those).
 */
export async function resolveProbeInput(opts: {
  localPath?: string;
  s3Key?: string;
  publicUrl?: string;
  mediaFileId?: string;
}): Promise<{ path: string; cleanup?: string }> {
  if (opts.localPath && fs.existsSync(opts.localPath)) {
    return { path: opts.localPath };
  }

  if (opts.s3Key && (await isS3Configured())) {
    const dest = path.join(
      TEMP_DIR,
      `probe-${opts.mediaFileId || 'x'}-${Date.now()}${path.extname(opts.s3Key) || '.mp4'}`
    );
    try {
      await downloadS3RangeToFile(opts.s3Key, dest, 64 * 1024 * 1024);
      return { path: dest, cleanup: dest };
    } catch (rangeErr) {
      logger.warn({ rangeErr, s3Key: opts.s3Key }, 'S3 range probe download failed — trying full object');
      await downloadFromS3ToFile(opts.s3Key, dest);
      return { path: dest, cleanup: dest };
    }
  }

  // Last resort: if only a public URL exists we still refuse HTTPS probe
  if (opts.publicUrl) {
    throw new Error('Cannot probe remote URL safely — S3 key required for local download');
  }
  throw new Error('No probeable video source');
}

export { getS3PublicUrl };
