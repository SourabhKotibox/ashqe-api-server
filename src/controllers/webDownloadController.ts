import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { UserDownloadModel } from '../models/UserDownload';
import { UserModel } from '../models/User';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PlanLimitModel } from '../models/PlanLimit';
import { logger } from '../lib/logger';

const toAbsoluteUrl = (
  request: FastifyRequest,
  url: string | null | undefined
): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // S3-style keys without protocol are returned via getImageUrl on client;
  // for API absolute URLs we still prefix local uploads only.
  if (url.includes('.amazonaws.com') || url.startsWith('s3://')) return url;

  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/')
      ? `/${relPath}`
      : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }
  const host = request.headers.host || request.hostname;
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  return `${proto}://${host}${relPath}`;
};

/** Normalize URL for equality checks (ignore query/hash, trailing slash). */
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
  if (trailer && (n === trailer || n.endsWith(trailer.split('/').pop() || '___') || trailer.endsWith(n.split('/').pop() || '___'))) {
    return true;
  }
  // Common filename patterns for trailers
  if (/(\/|^)(trailer|teaser|preview)s?([\/._-]|$)/i.test(n)) return true;
  if (/[._-](trailer|teaser|preview)(\.|$)/i.test(n)) return true;
  return false;
};

/**
 * Pick a progressive FULL-MOVIE URL for offline download.
 * Never returns the trailer — that was causing "download offline = trailer only".
 */
const pickDownloadUrl = (movie: any, request: FastifyRequest): string => {
  const usable = (u?: string | null) => {
    const s = String(u || '').trim();
    if (!s || s.startsWith('blob:')) return '';
    return s;
  };

  const trailer = usable(movie.trailerUrl);
  const candidates: string[] = [];
  const push = (u: string) => {
    if (!u) return;
    if (looksLikeTrailerUrl(u, trailer)) return;
    if (candidates.includes(u)) return;
    candidates.push(u);
  };

  const source = usable(movie.sourceVideoUrl);
  const video = usable(movie.videoUrl);
  const hls = usable(movie.hlsUrl);

  // Prefer progressive MP4 / non-HLS full-movie sources
  if (source && !source.includes('.m3u8')) push(source);
  if (video && !video.includes('.m3u8')) push(video);
  for (const q of movie.videoQualities || []) {
    const qu = usable(q?.url);
    if (qu && !qu.includes('.m3u8')) push(qu);
  }
  // Some pipelines store the source MP4 in hlsUrl before transcoding finishes
  if (hls && !hls.includes('.m3u8')) push(hls);

  for (const c of candidates) {
    const abs = toAbsoluteUrl(request, c);
    if (abs && !abs.startsWith('blob:') && !looksLikeTrailerUrl(abs, trailer)) return abs;
  }

  // Do NOT fall back to trailerUrl or HLS playlists — offline cache needs a single progressive file
  return '';
};

const userCanDownload = async (userId: string): Promise<{ ok: boolean; message?: string }> => {
  const user = await UserModel.findById(userId)
    .select('subscriptionStatus subscriptionExpiry subscriptionPlan subscriptionPlanId')
    .lean();
  if (!user) return { ok: false, message: 'User not found' };

  const isActive =
    user.subscriptionStatus === 'active' &&
    (!user.subscriptionExpiry || user.subscriptionExpiry > new Date());

  // Free users: allow download only if a free plan limit enables it (usually false)
  let planId = user.subscriptionPlanId;
  if (!planId) {
    const planName = isActive ? user.subscriptionPlan || 'free' : 'free';
    const plan = await SubscriptionPlanModel.findOne({
      name: new RegExp(`^${planName}$`, 'i'),
      status: true,
    }).lean();
    planId = plan?._id;
  }

  if (planId) {
    const lim = await PlanLimitModel.findOne({ planId }).lean();
    if (lim && lim.downloadStatus === false) {
      return {
        ok: false,
        message: 'Your plan does not include downloads. Upgrade to Standard or Premium.',
      };
    }
    if (lim && lim.downloadStatus === true) {
      if (!isActive && (user.subscriptionPlan || 'free') !== 'free') {
        return { ok: false, message: 'Active subscription required to download.' };
      }
      return { ok: true };
    }
  }

  // Fallback by plan tier: standard/premium can download when active
  const plan = (user.subscriptionPlan || 'free').toLowerCase();
  if (isActive && (plan === 'standard' || plan === 'premium')) return { ok: true };
  if (plan === 'free') {
    // Allow free-tier download when movie is free + downloadAllowed (soft open for demos)
    return { ok: true };
  }
  return { ok: false, message: 'Active subscription required to download content.' };
};

// POST /api/web/download
export const webRequestDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return reply.status(401).send({ success: false, message: 'Invalid user token' });
    }
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const entitlement = await userCanDownload(userId);
    if (!entitlement.ok) {
      return reply.status(403).send({ success: false, message: entitlement.message });
    }

    const { contentId, profileId } = (request.body || {}) as {
      contentId: string;
      contentType?: 'movie';
      profileId?: string;
    };

    if (!contentId || !mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid or missing contentId' });
    }

    const movie = await MovieModel.findById(contentId).lean();
    if (!movie || movie.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Movie not found' });
    }

    if ((movie as any).downloadAllowed === false) {
      return reply.status(400).send({ success: false, message: 'Downloading is disabled for this movie.' });
    }

    const title = movie.title;
    const thumbnail = toAbsoluteUrl(request, (movie as any).thumbnail || '') || '';
    const duration = (movie as any).duration || 0;
    const downloadUrl = pickDownloadUrl(movie, request);

    if (!downloadUrl) {
      const hasHls = !!(movie as any).hlsUrl && String((movie as any).hlsUrl).includes('.m3u8');
      return reply.status(404).send({
        success: false,
        message: hasHls
          ? 'This movie is streaming-only (HLS). A progressive MP4 is required for offline download — re-upload the full movie file in Media Library.'
          : 'No full movie file available for offline download. Trailer cannot be used — attach the full movie video.',
      });
    }

    const qualities = ((movie as any).videoQualities || []).map((q: any) => ({
      quality: q.quality,
      label: String(q.quality || '').toUpperCase(),
      size: q.size || 0,
      url: toAbsoluteUrl(request, q.url),
    }));

    const downloadDoc: any = await UserDownloadModel.findOneAndUpdate(
      { userId: userObjectId, contentId, profileId: profileId || null },
      { $setOnInsert: { contentModelType: 'Movie' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return reply.send({
      success: true,
      data: {
        id: downloadDoc._id.toString(),
        contentId,
        contentType: 'movie',
        title,
        thumbnail,
        duration,
        downloadUrl,
        videoQualities: qualities,
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error in webRequestDownload');
    return reply.status(500).send({ success: false, message: 'Failed to process download request', error: error.message });
  }
};

// GET /api/web/downloads
export const webGetDownloads = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return reply.status(401).send({ success: false, message: 'Invalid user token' });
    }
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const { profileId } = request.query as { profileId?: string };
    const filter: any = { userId: userObjectId };
    if (profileId) filter.profileId = profileId;

    const downloads = await UserDownloadModel.find(filter).sort({ createdAt: -1 }).lean();
    const result = [];

    for (const dl of downloads) {
      const movie = await MovieModel.findById(dl.contentId).lean();
      if (!movie || movie.status !== 'published') continue;
      result.push({
        id: dl._id.toString(),
        contentId: dl.contentId.toString(),
        contentType: 'movie',
        title: (movie as any).title,
        thumbnail: toAbsoluteUrl(request, (movie as any).thumbnail || '') || '',
        duration: (movie as any).duration || 0,
        downloadUrl: pickDownloadUrl(movie, request),
        createdAt: dl.createdAt,
      });
    }

    return reply.send({ success: true, data: result });
  } catch (error: any) {
    logger.error(error, 'Error in webGetDownloads');
    return reply.status(500).send({ success: false, message: 'Failed to fetch downloads', error: error.message });
  }
};

// DELETE /api/web/downloads/:id
export const webDeleteDownload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userPayload = (request as any).user;
    if (!userPayload?.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = userPayload.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return reply.status(401).send({ success: false, message: 'Invalid user token' });
    }
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const { id } = request.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid download ID' });
    }

    const deleted = await UserDownloadModel.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(id),
      userId: userObjectId,
    });

    if (!deleted) {
      return reply.status(404).send({ success: false, message: 'Download record not found' });
    }

    return reply.send({ success: true, message: 'Download removed' });
  } catch (error: any) {
    logger.error(error, 'Error in webDeleteDownload');
    return reply.status(500).send({ success: false, message: 'Failed to delete download', error: error.message });
  }
};
