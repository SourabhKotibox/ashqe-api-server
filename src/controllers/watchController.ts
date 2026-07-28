import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { UserLikeModel } from '../models/UserLike';
import { UserWishlistModel } from '../models/UserWishlist';
import { UserDownloadModel } from '../models/UserDownload';
import { UserModel } from '../models/User';
import { UserWatchProgressModel } from '../models/UserWatchProgress';
import '../models/Actor';
import '../models/Director';
import { logger } from '../lib/logger';

// Plan hierarchy
const PLAN_LEVELS: Record<string, number> = {
  free: 0,
  basic: 1,
  standard: 2,
  premium: 3,
};

import { buildShareUrl } from '../lib/config';

const getOptionalUser = async (request: FastifyRequest): Promise<{ userId: string; userPlan: string; profileId?: string } | null> => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const server = request.server as any;
    const decoded = server.jwt.verify(authHeader.slice(7)) as any;
    if (!decoded?.id) return null;

    const user = await UserModel.findById(decoded.id).select('subscriptionPlan subscriptionStatus subscriptionExpiry').lean();
    if (!user) return null;

    const profileId = request.headers['x-profile-id'] as string | undefined;

    const isActive = user.subscriptionStatus === 'active' && (!user.subscriptionExpiry || user.subscriptionExpiry > new Date());
    return { userId: decoded.id, userPlan: isActive ? (user.subscriptionPlan || 'free') : 'free', profileId };
  } catch {
    return null;
  }
};

const canAccessItem = (isFree: boolean, isLocked: boolean, contentPlanRequired: string, userPlan: string): boolean => {
  if (isFree) return true;
  if (isLocked) {
    const required = String(contentPlanRequired || 'free').toLowerCase();
    if (!required || required === 'free') return true;
    // Any active paid plan unlocks paid content (Standard unlocks premium-tagged titles too)
    const plan = String(userPlan || 'free').toLowerCase();
    return !!plan && plan !== 'free';
  }
  return true;
};

// Helper to convert relative URLs to absolute URLs (local storage)
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

  const baseUrl = `${request.protocol}://${request.hostname}`;
  return `${baseUrl}${relPath}`;
};


// ─────────────────────────────────────────────────────────────────────────────
// Build the quality list returned to Flutter/Web players.
// "Auto" uses master.m3u8 so ExoPlayer/MediaKit does ABR automatically.
// Each named quality links directly to its sub-playlist.
// ─────────────────────────────────────────────────────────────────────────────
export const QUALITY_LABELS: Record<string, string> = {
  '144p':  '144p',
  '240p':  '240p',
  '360p':  '360p',
  '480p':  '480p SD',
  '720p':  '720p HD',
  '1080p': '1080p Full HD',
  '1440p': '2K',
  '2160p': '4K Ultra HD',
};

// Defines the minimum plan required to stream each quality (for future subscription gating)
export const QUALITY_PLAN_GATE: Record<string, string> = {
  '144p':  'free',
  '240p':  'free',
  '360p':  'free',
  '480p':  'free',
  '720p':  'basic',
  '1080p': 'standard',
  '1440p': 'premium',
  '2160p': 'premium',
};

const QUALITY_ORDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

const buildNamedQualities = (
  request: FastifyRequest,
  hlsUrl: string | null,
  qualities: any[] = [],
  userPlan: string = 'free'
) => {
  const autoUrl = toAbsoluteUrl(request, hlsUrl);

  const result: Array<{
    key: string;
    label: string;
    description: string;
    url: string | null;
    requiresPlan: string;
    isLocked: boolean;
  }> = [
    {
      key: 'auto',
      label: 'Auto',
      description: 'Adjusts automatically based on your connection speed',
      url: autoUrl,
      requiresPlan: 'free',
      isLocked: false,
    },
  ];

  // Sort stored qualities in ascending order and add each one
  const sortedQualities = [...qualities].sort(
    (a, b) => QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality)
  );

  for (const q of sortedQualities) {
    if (!q.quality || !q.url) continue;
    const absoluteUrl = toAbsoluteUrl(request, q.url);
    if (!absoluteUrl) continue;
    const requiredPlan = QUALITY_PLAN_GATE[q.quality] || 'free';
    // isLocked: currently always false — flip to real check when subscriptions go live:
    // const isLocked = PLAN_LEVELS[userPlan] < PLAN_LEVELS[requiredPlan];
    const isLocked = false;
    result.push({
      key:          q.quality,
      label:        QUALITY_LABELS[q.quality] || q.quality,
      description:  q.quality === '144p' ? 'Very low quality — for slow connections' :
                    q.quality === '240p' ? 'Low quality — saves data' :
                    q.quality === '360p' ? 'Low quality' :
                    q.quality === '480p' ? 'Standard definition' :
                    q.quality === '720p' ? 'High definition' :
                    q.quality === '1080p' ? 'Full HD — recommended' :
                    q.quality === '1440p' ? '2K — requires fast connection' :
                    q.quality === '2160p' ? '4K Ultra HD — requires very fast connection' :
                    `Stream at ${QUALITY_LABELS[q.quality] || q.quality}`,
      url:          absoluteUrl,
      requiresPlan: requiredPlan,
      isLocked,
    });
  }

  return result;
};

export const getWatchData = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { contentId } = request.params as { contentId: string };

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId.' });
    }

    const userInfo = await getOptionalUser(request);
    const userId = userInfo?.userId || null;
    const userPlan = userInfo?.userPlan || 'free';
    const profileId = userInfo?.profileId || null;

    // Cast userId to ObjectId once for ALL DB lookups
    const userObjectId = userId ? new mongoose.Types.ObjectId(userId) : null;

    // Sync HLS qualities from disk if they exist but are missing in DB
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(contentId);
    } catch (syncErr) {
      logger.warn({ syncErr, contentId }, 'Failed to auto-detect and sync qualities for movie in getWatchData');
    }

    const content: any = await MovieModel.findById(contentId)
      .populate('genres', 'name')
      .populate('cast.actor', 'name image')
      .populate('crew.director', 'name image')
      .lean();

    if (!content || content.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Content not found.' });
    }

    const contentPlan = content.planRequired || 'free';

    // ── Like / Wishlist / Download Status ─────────────────────────────────
    let isLikedByUser = false;
    let isWishlisted = false;
    let isDownloaded = false;
    if (userObjectId) {
      const [likeDoc, wishlistDoc, downloadDoc] = await Promise.all([
        UserLikeModel.findOne({ userId: userObjectId, contentId: content._id }).lean(),
        UserWishlistModel.findOne({ userId: userObjectId, contentId: content._id }).lean(),
        UserDownloadModel.findOne({ userId: userObjectId, contentId: content._id }).lean(),
      ]);
      isLikedByUser = !!likeDoc;
      isWishlisted = !!wishlistDoc;
      isDownloaded = !!downloadDoc;
    }

    // ── Map Cast & Crew ───────────────────────────────────────────────────
    const cast = (content.cast || []).map((c: any) => ({
      id: c.actor?._id?.toString() || null,
      name: c.actor?.name || 'Unknown',
      image: toAbsoluteUrl(request, c.actor?.image) || null,
      role: c.role || 'Actor',
      character: c.character || null,
    }));
    const crew = (content.crew || []).map((c: any) => ({
      id: c.director?._id?.toString() || null,
      name: c.director?.name || 'Unknown',
      image: toAbsoluteUrl(request, c.director?.image) || null,
      role: c.role || 'Director',
    }));

    // ── Fetch Related Content ─────────────────────────────────────────────
    // Simple related logic: Same genre, excluding current item, limit 5
    let relatedContents: any[] = [];
    if (content.genres && content.genres.length > 0) {
      const related = await MovieModel.find({
        _id: { $ne: content._id },
        status: 'published',
        genres: { $in: content.genres },
      }).select('title thumbnail duration type').limit(5).lean();
      relatedContents = related.map(r => ({
        id: r._id.toString(),
        title: r.title,
        thumbnail: toAbsoluteUrl(request, r.thumbnail),
        duration: r.duration,
        type: 'movie',
      }));
    }

    // ── Movie Playback ────────────────────────────────────────────────────
    const isAccessible = canAccessItem(contentPlan === 'free', contentPlan !== 'free', contentPlan, userPlan);

    let watchProgress = null;
    if (userObjectId) {
      const progressDoc = await UserWatchProgressModel.findOne({ userId: userObjectId, contentId: content._id, profileId }).lean();
      if (progressDoc) {
        watchProgress = {
          progressSeconds: progressDoc.progressSeconds,
          durationSeconds: progressDoc.durationSeconds,
          progressPercent: progressDoc.progressPercent,
          lastWatchedAt: progressDoc.lastWatchedAt,
        };
      }
    }

    const currentVideo = {
      id: content._id.toString(),
      title: content.title,
      duration: content.duration || null,
      isFree: contentPlan === 'free',
      isLocked: !isAccessible,
      hlsUrl: isAccessible ? toAbsoluteUrl(request, content.hlsUrl) : null,
      trailerUrl: toAbsoluteUrl(request, content.trailerUrl),
      videoSettings: isAccessible ? buildNamedQualities(request, content.hlsUrl, content.videoQualities) : null,
      watchProgress,
    };

    const hours = content.duration ? Math.floor(content.duration / 3600) : 0;
    const minutes = content.duration ? Math.floor((content.duration % 3600) / 60) : 0;
    const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    const genresText = (content.genres || []).map((g: any) => g.name || g).join(', ');
    const episodeMeta = `HD • ${genresText} • ${durationStr}`;

    // ── Final Output ──────────────────────────────────────────────────────
    return reply.send({
      success: true,
      data: {
        content: {
          id: content._id.toString(),
          title: content.title,
          description: content.description || null,
          shortDescription: content.shortDescription || null,
          thumbnail: toAbsoluteUrl(request, content.thumbnail) || null,
          bannerImage: toAbsoluteUrl(request, content.bannerImage) || null,
          genres: content.genres || [],
          genresText: (content.genres || []).join(' & '),
          languages: content.languages || [],
          type: 'movie',

          episodeMeta,

          year: content.year || null,
          rating: content.rating || null,
          ageRating: content.ageRating || 0,
          planRequired: contentPlan,
          isExclusive: content.isExclusive || false,
          views: content.views || 0,
          likeCount: content.likes || 0,
          isLikedByUser,
          isWishlisted,
          isDownloaded,
          shareUrl: buildShareUrl(content._id.toString()),

          cast,
          crew,
          related: relatedContents,
        },
        currentEpisode: currentVideo,
        playbackSpeeds: [
          { value: 0.75, label: '0.75x' },
          { value: 1.0, label: 'Normal' },
          { value: 1.25, label: '1.25x' },
          { value: 1.5, label: '1.5x' },
          { value: 1.75, label: '1.75x' },
          { value: 2.0, label: '2.0x' }
        ],
        userAccess: {
          isLoggedIn: !!userId,
          userPlan,
          canAccessCurrentEpisode: !currentVideo.isLocked,
        },
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error fetching watch data');
    return reply.status(500).send({
      success: false,
      message: 'Failed to fetch watch data.',
      error: error.message,
    });
  }
};
