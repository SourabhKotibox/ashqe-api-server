import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MediaFileModel, IHlsQuality } from '../models/MediaFile';
import { logger } from './logger';
import {
  isS3Configured,
  downloadFromS3ToFile,
  uploadHlsFolderToS3,
  getHlsPublicBaseUrl,
  getS3ObjectSize,
} from './s3';
import { probeVideo, extractPosterFrame, resolveProbeInput, sanitizeFfmpegError } from './videoProbe';
import {
  isMediaConvertEnabled,
  startMediaConvertHlsJob,
  waitForMediaConvertJob,
} from './awsMediaConvert';
import { getS3Settings } from './s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_ROOT = path.join(__dirname, '../../uploads');
const TEMP_DIR = path.join(UPLOADS_ROOT, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const QUALITY_PRESETS = [
  { quality: '360p', height: 360, bitrate: 800 },
  { quality: '480p', height: 480, bitrate: 1200 },
  { quality: '720p', height: 720, bitrate: 2500 },
  { quality: '1080p', height: 1080, bitrate: 4500 },
];

/** Keep local EC2 transcodes fast — fewer ladders for big files */
function pickLocalPresets(sourceHeight: number, fileSize = 0) {
  // Very large files: single ladder only (EC2 cannot finish multi-quality in time)
  if (fileSize >= 400 * 1024 * 1024) {
    const h = Math.min(720, Math.max(360, sourceHeight || 720));
    const match = QUALITY_PRESETS.find((p) => p.height === 720) || QUALITY_PRESETS[QUALITY_PRESETS.length - 1];
    return [{ ...match, height: Math.min(match.height, h) }];
  }
  const applicable = QUALITY_PRESETS.filter((p) => p.height <= Math.max(sourceHeight || 720, 360));
  if (applicable.length <= 3) return applicable.length ? applicable : [QUALITY_PRESETS[0]];
  return [
    applicable.find((p) => p.quality === '480p') || applicable[Math.floor(applicable.length / 2)],
    applicable.find((p) => p.quality === '720p') || applicable[applicable.length - 2],
    applicable[applicable.length - 1],
  ].filter(Boolean) as typeof QUALITY_PRESETS;
}

export const getVideoInfo = (filePath: string): Promise<{ duration: number; width: number; height: number }> => {
  return probeVideo(filePath).then((r) => ({
    duration: r.duration,
    width: r.width,
    height: r.height,
  }));
};

/**
 * Probe duration / resolution / codec and extract a poster frame ASAP
 * (before full HLS finishes) so the movie form can auto-fill.
 */
export async function enrichVideoMetadata(mediaFileId: string): Promise<void> {
  const mediaFile = await MediaFileModel.findById(mediaFileId);
  if (!mediaFile) return;

  let cleanup: string | undefined;
  try {
    const s3Key = (mediaFile as any).s3Key as string | undefined;
    const resolved = await resolveProbeInput({
      localPath: mediaFile.filePath?.startsWith('/uploads/')
        ? path.join(UPLOADS_ROOT, mediaFile.filePath.replace(/^\/uploads\//, ''))
        : undefined,
      s3Key,
      publicUrl: mediaFile.url,
      mediaFileId,
    });
    cleanup = resolved.cleanup;

    const info = await probeVideo(resolved.path);
    mediaFile.duration = info.duration;
    (mediaFile as any).width = info.width;
    (mediaFile as any).height = info.height;
    (mediaFile as any).codec = info.codec;
    (mediaFile as any).bitrate = info.bitrate;
    (mediaFile as any).fps = info.fps;

    if (!(mediaFile as any).posterFrameUrl) {
      const poster = await extractPosterFrame(resolved.path, mediaFileId, info.duration);
      if (poster) (mediaFile as any).posterFrameUrl = poster;
    }

    await mediaFile.save();
    logger.info(
      { mediaFileId, duration: info.duration, width: info.width, height: info.height },
      'Video metadata enriched for auto-fill'
    );
  } catch (err) {
    logger.warn({ err: sanitizeFfmpegError(err), mediaFileId }, 'Video metadata enrich failed');
  } finally {
    if (cleanup && fs.existsSync(cleanup)) {
      try {
        fs.unlinkSync(cleanup);
      } catch {
        /* ignore */
      }
    }
  }
}

async function transcodeWithMediaConvert(mediaFile: any): Promise<void> {
  const s3Key = mediaFile.s3Key || mediaFile.filePath;
  if (!s3Key) throw new Error('MediaConvert requires an S3 key');

  mediaFile.transcoder = 'aws';
  mediaFile.hlsStatus = 'processing';
  await mediaFile.save();

  const { jobId, outputPrefix } = await startMediaConvertHlsJob({
    mediaFileId: mediaFile._id.toString(),
    s3Key: String(s3Key).replace(/^\/+/, ''),
    sourceHeight: mediaFile.height || 1080,
  });

  mediaFile.mediaConvertJobId = jobId;
  await mediaFile.save();

  await waitForMediaConvertJob(jobId);

  const settings = await getS3Settings();
  const base =
    settings.cdnUrl ||
    `https://${settings.bucket}.s3.${settings.region}.amazonaws.com`;
  // Destination was s3://bucket/hls/{id}/master → master.m3u8
  const masterUrl = `${base}/${outputPrefix}/master.m3u8`;

  const height = mediaFile.height || 1080;
  const awsQualities = [
    { quality: '360p', height: 360, bitrate: 1000 },
    { quality: '480p', height: 480, bitrate: 1800 },
    { quality: '720p', height: 720, bitrate: 3500 },
    { quality: '1080p', height: 1080, bitrate: 6500 },
  ].filter((q) => q.height <= height);

  const qualities: IHlsQuality[] = (awsQualities.length ? awsQualities : [{ quality: '720p', height: 720, bitrate: 3500 }]).map(
    (q) => ({
      quality: q.quality,
      url: masterUrl,
      filePath: masterUrl,
      bitrate: q.bitrate,
      resolution: `${Math.round((q.height * 16) / 9)}x${q.height}`,
    })
  );

  mediaFile.isHls = true;
  mediaFile.hlsMasterPlaylistUrl = masterUrl;
  mediaFile.hlsMasterPlaylistPath = masterUrl;
  mediaFile.hlsQualities = qualities;
  mediaFile.hlsStatus = 'completed';
  mediaFile.hlsError = undefined;
  await mediaFile.save();

  logger.info({ mediaFileId: mediaFile._id, masterUrl, jobId }, 'AWS MediaConvert HLS complete');
}

async function transcodeLocalFfmpeg(
  mediaFile: any,
  inputFilePath: string,
  storageType: 'local' | 's3'
): Promise<void> {
  let tempDownload: string | null = null;
  try {
    mediaFile.transcoder = 'local';
    mediaFile.hlsStatus = 'processing';
    await mediaFile.save();

    let sourcePath = inputFilePath;
    const useS3 =
      storageType === 's3' || ((await isS3Configured()) && mediaFile.storageType === 's3');

    // Always use a local file for ffmpeg/ffprobe — HTTPS URLs crash static ffprobe (SIGSEGV)
    if (useS3 && mediaFile.s3Key) {
      tempDownload = path.join(
        TEMP_DIR,
        `${mediaFile._id}-${Date.now()}${path.extname(mediaFile.s3Key) || '.mp4'}`
      );
      logger.info({ mediaFileId: mediaFile._id, s3Key: mediaFile.s3Key }, 'Downloading S3 video for local HLS');
      await downloadFromS3ToFile(mediaFile.s3Key, tempDownload);
      sourcePath = tempDownload;
    }

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('Source video file not found for HLS transcoding');
    }

    const info = await probeVideo(sourcePath);
    mediaFile.duration = info.duration;
    mediaFile.width = info.width;
    mediaFile.height = info.height;
    mediaFile.codec = info.codec;
    mediaFile.bitrate = info.bitrate;
    mediaFile.fps = info.fps;
    if (!mediaFile.posterFrameUrl) {
      const poster = await extractPosterFrame(sourcePath, mediaFile._id.toString(), info.duration);
      if (poster) mediaFile.posterFrameUrl = poster;
    }
    await mediaFile.save();

    const applicablePresets = pickLocalPresets(info.height, Number(mediaFile.fileSize) || 0);

    const hlsOutputDir = path.join(UPLOADS_ROOT, 'hls', mediaFile._id.toString());
    if (!fs.existsSync(hlsOutputDir)) fs.mkdirSync(hlsOutputDir, { recursive: true });

    const qualities: IHlsQuality[] = [];
    const CONCURRENCY = 1; // one quality at a time — more stable on small EC2

    const runPreset = async (preset: (typeof QUALITY_PRESETS)[number]) => {
      const outputDir = path.join(hlsOutputDir, preset.quality);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const playlistPath = path.join(outputDir, 'index.m3u8');
      const segmentPattern = path.join(outputDir, 'segment-%03d.ts');

      await new Promise((resolve, reject) => {
        ffmpeg(sourcePath)
          .outputOptions([
            '-preset', 'ultrafast',
            '-threads', '0',
            '-g', '48',
            '-sc_threshold', '0',
            '-keyint_min', '48',
            '-hls_time', '6',
            '-hls_list_size', '0',
            '-hls_segment_filename', segmentPattern,
            '-vf', `scale=-2:${preset.height}`,
            '-b:v', `${preset.bitrate}k`,
            '-maxrate', `${preset.bitrate * 1.5}k`,
            '-bufsize', `${preset.bitrate * 2}k`,
            '-c:a', 'aac',
            '-b:a', '96k',
            '-ac', '2',
          ])
          .output(playlistPath)
          .on('end', () => resolve(null))
          .on('error', (err) => reject(err))
          .run();
      });

      return {
        quality: preset.quality,
        url: `/uploads/hls/${mediaFile._id.toString()}/${preset.quality}/index.m3u8`,
        filePath: `/uploads/hls/${mediaFile._id.toString()}/${preset.quality}/index.m3u8`,
        bitrate: preset.bitrate,
        resolution: `${Math.round(info.width * (preset.height / (info.height || preset.height)))}x${preset.height}`,
      } as IHlsQuality;
    };

    for (let i = 0; i < applicablePresets.length; i += CONCURRENCY) {
      const batch = applicablePresets.slice(i, i + CONCURRENCY);
      qualities.push(...(await Promise.all(batch.map(runPreset))));
    }

    let masterPlaylistContent = '#EXTM3U\n';
    for (const q of qualities) {
      const preset = applicablePresets.find((p) => p.quality === q.quality);
      if (preset) {
        masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bitrate * 1000},RESOLUTION=${q.resolution}\n`;
        masterPlaylistContent += `${q.quality}/index.m3u8\n`;
      }
    }

    const masterPlaylistFsPath = path.join(hlsOutputDir, 'index.m3u8');
    fs.writeFileSync(masterPlaylistFsPath, masterPlaylistContent);

    let masterPlaylistPath = `/uploads/hls/${mediaFile._id.toString()}/index.m3u8`;

    if (useS3 && (await isS3Configured())) {
      const s3Prefix = `hls/${mediaFile._id.toString()}`;
      await uploadHlsFolderToS3(hlsOutputDir, s3Prefix);
      const hlsBase = await getHlsPublicBaseUrl();
      masterPlaylistPath = `${hlsBase}/${s3Prefix}/index.m3u8`;
      for (const q of qualities) {
        q.url = `${hlsBase}/${s3Prefix}/${q.quality}/index.m3u8`;
        q.filePath = q.url;
      }
      try {
        fs.rmSync(hlsOutputDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    mediaFile.isHls = true;
    mediaFile.hlsMasterPlaylistUrl = masterPlaylistPath;
    mediaFile.hlsMasterPlaylistPath = masterPlaylistPath;
    mediaFile.hlsQualities = qualities;
    mediaFile.hlsStatus = 'completed';
    await mediaFile.save();
  } finally {
    if (tempDownload && fs.existsSync(tempDownload)) {
      try {
        fs.unlinkSync(tempDownload);
      } catch {
        /* ignore */
      }
    }
  }
}

export const transcodeToHls = async (
  mediaFileId: string,
  inputFilePath: string,
  _baseUrl: string,
  storageType: 'local' | 's3' = 'local'
): Promise<void> => {
  const mediaFile = await MediaFileModel.findById(mediaFileId);
  if (!mediaFile) throw new Error('Media file not found');

  try {
    // Fast path: metadata + poster for form auto-fill (don't wait for full HLS)
    await enrichVideoMetadata(mediaFileId);
    const refreshed = await MediaFileModel.findById(mediaFileId);
    if (!refreshed) throw new Error('Media file not found');

    const useAws =
      isMediaConvertEnabled() &&
      (await isS3Configured()) &&
      (!!refreshed.s3Key || refreshed.storageType === 's3');

    if (useAws) {
      try {
        await transcodeWithMediaConvert(refreshed);
        return;
      } catch (awsErr) {
        logger.error({ awsErr, mediaFileId }, 'MediaConvert failed — falling back to local ffmpeg');
      }
    }

    let fileSize = Number((refreshed as any).fileSize) || 0;
    // DB may be missing size — check S3 before downloading multi‑GB objects
    if (fileSize < 400 * 1024 * 1024 && refreshed.s3Key && (await isS3Configured())) {
      const s3Size = await getS3ObjectSize(String(refreshed.s3Key));
      if (s3Size > 0) {
        fileSize = s3Size;
        (refreshed as any).fileSize = s3Size;
      }
    }

    // Large local HLS OOMs / hours on small EC2 — mark progressive MP4 ready (playable immediately)
    if (fileSize >= 400 * 1024 * 1024) {
      if (!refreshed.url) throw new Error('No playable URL for large video');
      refreshed.isHls = true;
      refreshed.hlsMasterPlaylistUrl = refreshed.url;
      refreshed.hlsMasterPlaylistPath = refreshed.url;
      refreshed.hlsQualities = [
        {
          quality: 'source',
          url: refreshed.url,
          filePath: refreshed.url,
          bitrate: 0,
          resolution: 'source',
        },
      ];
      refreshed.hlsStatus = 'completed';
      (refreshed as any).transcoder = 'progressive';
      refreshed.hlsError = undefined;
      await refreshed.save();
      logger.info(
        { mediaFileId, fileSize },
        'Large video — progressive MP4 ready (enable AWS MediaConvert for multi-quality HLS)'
      );
      return;
    }

    await transcodeLocalFfmpeg(refreshed, inputFilePath, storageType);
  } catch (error) {
    logger.error({ error: sanitizeFfmpegError(error) }, 'Error transcoding to HLS');
    mediaFile.hlsStatus = 'failed';
    mediaFile.hlsError = sanitizeFfmpegError(error);
    await mediaFile.save();
    throw error;
  }
};

export default {
  getVideoInfo,
  transcodeToHls,
  enrichVideoMetadata,
};
