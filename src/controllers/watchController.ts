import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';
import { UserLikeModel } from '../models/UserLike';
import { UserWishlistModel } from '../models/UserWishlist';
import { UserDownloadModel } from '../models/UserDownload';
import { UserWatchProgressModel } from '../models/UserWatchProgress';
import '../models/Actor';
import '../models/Director';
import { logger } from '../lib/logger';
import {
  canAccessContent,
  isQualityLocked,
  requiresSubscription,
  resolveEffectiveUserPlan,
} from '../lib/subscriptionAccess';

import { buildShareUrl } from '../lib/config';

const getOptionalUser = async (request: FastifyRequest): Promise<{ userId: string; userPlan: string; profileId?: string } | null> => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const server = request.server as any;
    const decoded = server.jwt.verify(authHeader.slice(7)) as any;
    if (!decoded?.id) return null;

    const profileId = request.headers['x-profile-id'] as string | undefined;
    const userPlan = await resolveEffectiveUserPlan(decoded.id);
    return { userId: decoded.id, userPlan, profileId };
  } catch {
    return null;
  }
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

// Minimum plan required to stream each quality
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
    const locked = isQualityLocked(requiredPlan, userPlan);
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
      url:          locked ? null : absoluteUrl,
      requiresPlan: requiredPlan,
      isLocked: locked,
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
    const query = request.query as { season?: string; episode?: string; episodeId?: string };

    const populateMeta = (model: any, id: string) =>
      model.findById(id)
        .populate('genres', 'name')
        .populate('cast.actor', 'name image')
        .populate('crew.director', 'name image')
        .lean();

    let content: any = await populateMeta(MovieModel, contentId);
    let isSeries = false;
    let currentEpisodeDoc: any = null;

    if (!content) {
      const episodeById = await EpisodeModel.findById(query.episodeId || contentId).lean();
      let showId = episodeById?.tvShowId?.toString();
      if (!showId) {
        const asShow = await populateMeta(TVShowModel, contentId);
        if (asShow) showId = asShow._id.toString();
      }
      if (showId) {
        content = await populateMeta(TVShowModel, showId);
        isSeries = !!content;
        if (content) {
          if (query.episodeId && mongoose.Types.ObjectId.isValid(query.episodeId)) {
            currentEpisodeDoc = await EpisodeModel.findById(query.episodeId).lean();
          } else if (episodeById && episodeById.tvShowId?.toString() === showId) {
            currentEpisodeDoc = episodeById;
          } else {
            const seasonNum = Math.max(1, Number(query.season || 1));
            const episodeNum = Math.max(1, Number(query.episode || 1));
            currentEpisodeDoc =
              (await EpisodeModel.findOne({ tvShowId: content._id, season: seasonNum, episode: episodeNum }).lean()) ||
              (await EpisodeModel.findOne({ tvShowId: content._id }).sort({ season: 1, episode: 1 }).lean());
          }
        }
      }
    }

    if (!content || content.status !== 'published') {
      return reply.status(404).send({ success: false, message: 'Content not found.' });
    }

    let playbackTarget: any = isSeries ? (currentEpisodeDoc || content) : content;
    const playbackType = isSeries && currentEpisodeDoc ? 'episode' : isSeries ? 'tvShow' : 'movie';

    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      const synced = await autoDetectAndSyncQualities(playbackTarget._id, playbackType);
      if (synced) playbackTarget = synced;
      else {
        const Model = playbackType === 'episode' ? EpisodeModel : playbackType === 'tvShow' ? TVShowModel : MovieModel;
        const refreshed = await Model.findById(playbackTarget._id).lean();
        if (refreshed) playbackTarget = refreshed;
      }
    } catch (syncErr) {
      logger.warn({ syncErr, contentId }, 'Failed to auto-detect and sync qualities in getWatchData');
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
    let relatedContents: any[] = [];
    if (content.genres && content.genres.length > 0) {
      const RelatedModel = isSeries ? TVShowModel : MovieModel;
      const related = await RelatedModel.find({
        _id: { $ne: content._id },
        status: 'published',
        genres: { $in: content.genres },
      }).select('title thumbnail duration type').limit(5).lean();
      relatedContents = related.map(r => ({
        id: r._id.toString(),
        title: r.title,
        thumbnail: toAbsoluteUrl(request, r.thumbnail),
        duration: r.duration,
        type: isSeries ? 'show' : 'movie',
      }));
    }

    // ── Movie Playback ────────────────────────────────────────────────────
    const isAccessible = canAccessContent(contentPlan, userPlan);

    let watchProgress = null;
    const progressTargetId = playbackTarget._id;
    if (userObjectId) {
      const progressDoc = await UserWatchProgressModel.findOne({ userId: userObjectId, contentId: progressTargetId, profileId }).lean();
      if (progressDoc) {
        watchProgress = {
          progressSeconds: progressDoc.progressSeconds,
          durationSeconds: progressDoc.durationSeconds,
          progressPercent: progressDoc.progressPercent,
          lastWatchedAt: progressDoc.lastWatchedAt,
        };
      }
    }

    const playableHls = playbackTarget.hlsUrl || playbackTarget.videoUrl || playbackTarget.sourceVideoUrl || null;
    const currentVideo = {
      id: playbackTarget._id.toString(),
      title: isSeries && currentEpisodeDoc
        ? currentEpisodeDoc.title
        : content.title,
      season: currentEpisodeDoc?.season || null,
      episode: currentEpisodeDoc?.episode || null,
      duration: playbackTarget.duration || content.duration || null,
      isFree: String(contentPlan).toLowerCase() === 'free' || !!currentEpisodeDoc?.isFree,
      isLocked: !isAccessible,
      hlsUrl: isAccessible ? toAbsoluteUrl(request, playableHls) : null,
      trailerUrl: toAbsoluteUrl(request, currentEpisodeDoc?.trailerUrl || content.trailerUrl),
      videoSettings: isAccessible
        ? buildNamedQualities(request, playableHls, playbackTarget.videoQualities || content.videoQualities, userPlan)
        : null,
      watchProgress,
    };

    const hours = content.duration ? Math.floor(content.duration / 3600) : 0;
    const minutes = content.duration ? Math.floor((content.duration % 3600) / 60) : 0;
    const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    const genresText = (content.genres || []).map((g: any) => g.name || g).join(', ');
    const episodeMeta = currentEpisodeDoc
      ? `S${currentEpisodeDoc.season}E${currentEpisodeDoc.episode} • HD • ${genresText}`
      : `HD • ${genresText} • ${durationStr}`;

    let episodes: any[] = [];
    if (isSeries) {
      const allEps = await EpisodeModel.find({ tvShowId: content._id }).sort({ season: 1, episode: 1 }).lean();
      episodes = allEps.map((ep: any) => ({
        id: ep._id.toString(),
        season: ep.season,
        episode: ep.episode,
        title: ep.title,
        duration: ep.duration || null,
        thumbnail: toAbsoluteUrl(request, ep.thumbnail || content.thumbnail),
        isFree: !!ep.isFree,
        hlsUrl: isAccessible ? toAbsoluteUrl(request, ep.hlsUrl || ep.sourceVideoUrl) : null,
      }));
    }

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
          type: isSeries ? 'show' : 'movie',
          contentType: isSeries ? 'tvShow' : 'movie',

          episodeMeta,

          year: content.year || null,
          rating: content.rating || null,
          ageRating: content.ageRating || 0,
          planRequired: contentPlan,
          requiresSubscription: requiresSubscription(contentPlan),
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
          episodes,
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
          hasActiveSubscription: userPlan !== 'free',
          canAccessCurrentEpisode: !currentVideo.isLocked,
          requiresSubscription: requiresSubscription(contentPlan),
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
