import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserModel } from '../models/User';
import { MovieModel } from '../models/Movie';
import { UserDownloadModel } from '../models/UserDownload';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PlanLimitModel } from '../models/PlanLimit';
import { logger } from '../lib/logger';

// Helper to format bytes to MB
const formatSizeMB = (sizeBytes: number): string => {
  return sizeBytes ? `${Math.round(sizeBytes / (1024 * 1024))} MB` : 'N/A';
};

const toAbsoluteUrl = (
  request: FastifyRequest,
  url: string | null | undefined
): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;

  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/') ? `/${relPath}` : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }

  const host = request.headers.host || request.hostname;
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  return `${proto}://${host}${relPath}`;
};

const normalizeMediaUrl = (u: string): string =>
  String(u || '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const looksLikeTrailerUrl = (u: string, trailerUrl?: string | null): boolean => {
  const n = normalizeMediaUrl(u);
  if (!n) return false;
  const trailer = normalizeMediaUrl(trailerUrl || '');
  if (trailer) {
    const tLeaf = trailer.split('/').pop() || '';
    const nLeaf = n.split('/').pop() || '';
    if (n === trailer || (tLeaf && nLeaf && tLeaf === nLeaf)) return true;
  }
  if (/(\/|^)(trailer|teaser|preview)s?([\/._-]|$)/i.test(n)) return true;
  if (/[._-](trailer|teaser|preview)(\.|$)/i.test(n)) return true;
  return false;
};

/** Progressive full-movie URL only — never the trailer. */
const pickDownloadUrl = (movie: any, request: FastifyRequest): string => {
  const usable = (u?: string | null) => {
    const s = String(u || '').trim();
    if (!s || s.startsWith('blob:')) return '';
    return s;
  };

  const trailer = usable(movie.trailerUrl);
  const candidates: string[] = [];
  const push = (u: string) => {
    if (!u || looksLikeTrailerUrl(u, trailer) || candidates.includes(u)) return;
    candidates.push(u);
  };

  const source = usable(movie.sourceVideoUrl);
  const video = usable(movie.videoUrl);
  const hls = usable(movie.hlsUrl);

  if (source && !source.includes('.m3u8')) push(source);
  if (video && !video.includes('.m3u8')) push(video);
  for (const q of movie.videoQualities || []) {
    const qu = usable(q?.url);
    if (qu && !qu.includes('.m3u8')) push(qu);
  }
  if (hls && !hls.includes('.m3u8')) push(hls);

  for (const c of candidates) {
    const abs = toAbsoluteUrl(request, c);
    if (abs && !abs.startsWith('blob:') && !looksLikeTrailerUrl(abs, trailer)) return abs;
  }
  return '';
};

async function resolveDownloadLimits(user: any): Promise<{ allowed: boolean; max: number; reason?: string }> {
  const planName = String(user.subscriptionPlan || 'free');
  const isActive =
    user.subscriptionStatus === 'active' &&
    (!user.subscriptionExpiry || new Date(user.subscriptionExpiry) > new Date()) &&
    planName.toLowerCase() !== 'free';

  if (!isActive) {
    return { allowed: false, max: 0, reason: 'Active subscription required to download content.' };
  }

  const plan = await SubscriptionPlanModel.findOne({
    name: { $regex: new RegExp(`^${planName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  }).lean();

  if (!plan) {
    // Paid active user without matching plan doc — allow a safe default
    return { allowed: true, max: 10 };
  }

  const limits = await PlanLimitModel.findOne({ planId: plan._id }).lean();
  if (!limits) return { allowed: true, max: 10 };
  if (!limits.downloadStatus) {
    return { allowed: false, max: 0, reason: 'Downloads are not included in your plan. Please upgrade.' };
  }
  const max = Math.max(0, Number((limits as any).downloadLimitCount ?? 10));
  return { allowed: true, max };
}

export const requestDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const user = await UserModel.findById(userObjectId)
      .select('subscriptionStatus subscriptionExpiry subscriptionPlan')
      .lean();
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    const limits = await resolveDownloadLimits(user);
    if (!limits.allowed) {
      return reply.status(403).send({ success: false, message: limits.reason || 'Downloads not allowed' });
    }

    const { contentId } = request.body as {
      contentId: string;
      contentType?: 'movie';
    };

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId' });
    }

    const existing = await UserDownloadModel.findOne({ userId: userObjectId, contentId }).lean();
    if (!existing) {
      const count = await UserDownloadModel.countDocuments({ userId: userObjectId });
      if (count >= limits.max) {
        return reply.status(403).send({
          success: false,
          message: `Download limit reached (${limits.max}). Remove an old download or upgrade your plan.`,
          code: 'DOWNLOAD_LIMIT',
          limit: limits.max,
          used: count,
        });
      }
    }

    const movie = await MovieModel.findById(contentId).lean();
    if (!movie || movie.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Movie not found' });
    }

    if (!movie.downloadAllowed) {
      return reply.status(400).send({ success: false, message: 'Downloading is disabled for this movie.' });
    }

    const title = movie.title;
    const thumbnail = toAbsoluteUrl(request, movie.thumbnail || '') || '';
    const duration = movie.duration || 0;
    const downloadUrl = pickDownloadUrl(movie, request);
    if (!downloadUrl) {
      const hasHls = !!(movie as any).hlsUrl && String((movie as any).hlsUrl).includes('.m3u8');
      return reply.status(404).send({
        success: false,
        message: hasHls
          ? 'This movie is streaming-only (HLS). A progressive MP4 is required for offline download — re-upload the full movie file.'
          : 'No full movie file available for offline download. Trailer cannot be used — attach the full movie video.',
      });
    }
    const qualities = (movie.videoQualities || []).map((q: any) => ({
      quality: q.quality,
      label: q.quality.toUpperCase(),
      size: q.size,
      sizeFormatted: formatSizeMB(q.size),
      url: toAbsoluteUrl(request, q.url)
    }));

    const downloadDoc: any = await UserDownloadModel.findOneAndUpdate(
      { userId: userObjectId, contentId },
      { $setOnInsert: { contentModelType: 'Movie' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const used = await UserDownloadModel.countDocuments({ userId: userObjectId });

    return reply.send({
      success: true,
      data: {
        id: downloadDoc._id.toString(),
        userId: userId,
        contentId: contentId,
        contentType: 'movie',
        title: title,
        thumbnail: thumbnail,
        duration: duration,
        downloadUrl: downloadUrl,
        videoQualities: qualities,
        downloadLimit: limits.max,
        downloadUsed: used,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'requestDownload failed');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

export const getDownloadList = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const downloads = await UserDownloadModel.find({ userId: userObjectId }).sort({ createdAt: -1 }).lean();

    const result = [];

    for (const dl of downloads) {
      const movie = await MovieModel.findById(dl.contentId).lean();
      if (!movie || movie.status !== 'published') continue;

      const qualities = (movie.videoQualities || []).map((q: any) => ({
        quality: q.quality,
        label: q.quality.toUpperCase(),
        size: q.size,
        sizeFormatted: formatSizeMB(q.size),
        url: toAbsoluteUrl(request, q.url)
      }));

      result.push({
        id: dl._id.toString(),
        contentId: dl.contentId.toString(),
        contentType: 'movie',
        title: movie.title,
        thumbnail: toAbsoluteUrl(request, movie.thumbnail || '') || '',
        duration: movie.duration || 0,
        downloadUrl: pickDownloadUrl(movie, request),
        videoQualities: qualities,
        status: (dl as any).status || 'pending',
        progress: (dl as any).progress || 0,
        createdAt: dl.createdAt
      });
    }

    return reply.send({
      success: true,
      data: result
    });
  } catch (error: any) {
    logger.error(error, 'Error getting downloads list');
    return reply.status(500).send({ success: false, message: 'Failed to fetch downloads.', error: error.message });
  }
};

export const getDownloadsList = getDownloadList;

export const deleteDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const { id } = request.params as { id: string };

    if (id === 'all') {
      await UserDownloadModel.deleteMany({ userId: userObjectId });
      return reply.send({
        success: true,
        message: 'All downloads deleted successfully'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid download ID' });
    }

    const deleted = await UserDownloadModel.findOneAndDelete({ _id: new mongoose.Types.ObjectId(id), userId: userObjectId });
    if (!deleted) {
      return reply.status(404).send({ success: false, message: 'Download record not found' });
    }

    return reply.send({
      success: true,
      message: 'Download deleted successfully'
    });
  } catch (error: any) {
    logger.error(error, 'Error deleting download');
    return reply.status(500).send({ success: false, message: 'Failed to delete download.', error: error.message });
  }
};

export const removeDownload = deleteDownload;

export const removeAllDownloads = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload || !userPayload.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const result = await UserDownloadModel.deleteMany({ userId: userObjectId });

    return reply.send({
      success: true,
      message: 'All downloads deleted successfully.',
      deletedCount: result.deletedCount
    });
  } catch (error: any) {
    logger.error(error, 'Error removing all downloads');
    return reply.status(500).send({ success: false, message: 'Failed to delete all downloads.', error: error.message });
  }
};
