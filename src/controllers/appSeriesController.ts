import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';
import { UserModel } from '../models/User';
import { UserLikeModel } from '../models/UserLike';
import { UserWishlistModel } from '../models/UserWishlist';
import { logger } from '../lib/logger';
import { buildShareUrl } from '../lib/config';
import { isS3Configured, getS3PublicUrl } from '../lib/s3';

// Helper to convert relative URLs to absolute URLs
const toAbsoluteUrl = (
  request: FastifyRequest,
  url: string | null | undefined,
  s3Active: boolean,
  s3BaseUrl: string
): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  
  const isLocalHls = url.startsWith('hls/') || url.startsWith('/uploads/hls/') || url.includes('/hls/');
  if (s3Active && !isLocalHls) {
    let cleanKey = url;
    if (cleanKey.startsWith('/')) cleanKey = cleanKey.slice(1);
    if (cleanKey.startsWith('uploads/')) cleanKey = cleanKey.replace('uploads/', '');
    if (cleanKey.startsWith('/uploads/')) cleanKey = cleanKey.replace('/uploads/', '');
    return `${s3BaseUrl}/${cleanKey}`;
  }
  
  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/') ? `/${relPath}` : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }
  
  const baseUrl = `${request.protocol}://${request.hostname}`;
  return `${baseUrl}${relPath}`;
};

// Helper: try to extract userId and plan from JWT without throwing
const getOptionalUser = async (request: FastifyRequest): Promise<{ userId: string; userPlan: string } | null> => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const server = request.server as any;
    const decoded = server.jwt.verify(authHeader.slice(7)) as any;
    if (!decoded?.id) return null;

    const user = await UserModel.findById(decoded.id).select('subscriptionPlan subscriptionStatus subscriptionExpiry').lean();
    if (!user) return { userId: decoded.id, userPlan: 'free' };

    const isActive = user.subscriptionStatus === 'active' && (!user.subscriptionExpiry || user.subscriptionExpiry > new Date());
    return { userId: decoded.id, userPlan: isActive ? (user.subscriptionPlan || 'free') : 'free' };
  } catch {
    return null;
  }
};

export const getSeriesDetail = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, message: 'Invalid series ID.' });
    }

    const userInfo = await getOptionalUser(request);
    const userId = userInfo?.userId || null;
    const userPlan = userInfo?.userPlan || 'free';

    const series = await TVShowModel.findById(id)
      .populate('cast.actor', 'name image designation')
      .populate('crew.director', 'name image designation')
      .populate('genres', 'name')
      .populate('languages', 'name')
      .lean();

    if (!series || series.status !== 'published' || false) {
      return reply.status(404).send({ success: false, message: 'Series not found.' });
    }

    let isLikedByUser = false;
    let isWishlisted = false;
    let wishlisted = false;

    if (userId) {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const [likeDoc, wishlistDoc] = await Promise.all([
        UserLikeModel.findOne({ userId: userObjectId, contentId: series._id }).lean(),
        UserWishlistModel.findOne({ userId: userObjectId, contentId: series._id }).lean(),
      ]);
      isLikedByUser = !!likeDoc;
      isWishlisted = !!wishlistDoc;
      wishlisted = !!wishlistDoc;
    }

    const s3Active = await isS3Configured();
    let s3BaseUrl = '';
    if (s3Active) {
      const s3Url = await getS3PublicUrl('');
      s3BaseUrl = s3Url.endsWith('/') ? s3Url.slice(0, -1) : s3Url;
    }

    // Related Series
    let related: any[] = [];
    if (series.genres && series.genres.length > 0) {
      const genreIds = (series.genres as any[]).map((g: any) => g._id || g);
      const relatedSeries = await TVShowModel.find({
        _id: { $ne: series._id },
        status: 'published',
        genres: { $in: genreIds },
      })
        .select('title thumbnail bannerImage duration year rating genres contentType')
        .populate('genres', 'name')
        .limit(10)
        .lean();

      related = relatedSeries.map((r: any) => ({
        id: r._id.toString(),
        title: r.title,
        thumbnail: toAbsoluteUrl(request, r.thumbnail, s3Active, s3BaseUrl) || null,
        bannerImage: toAbsoluteUrl(request, r.bannerImage, s3Active, s3BaseUrl) || null,
        duration: r.duration || null,
        year: r.year || null,
        rating: r.rating || null,
        genres: (r.genres || []).map((g: any) => g?.name || g),
        contentType: r.contentType,
      }));
    }

    // Cast & Crew
    const cast = (series.cast || []).map((c: any) => ({
      id: c.actor?._id?.toString() || null,
      name: c.actor?.name || 'Unknown',
      image: toAbsoluteUrl(request, c.actor?.image, s3Active, s3BaseUrl) || null,
      designation: c.actor?.designation || null,
      role: c.role || 'Actor',
      character: c.character || null,
    }));

    const crew = (series.crew || []).map((c: any) => ({
      id: c.director?._id?.toString() || null,
      name: c.director?.name || 'Unknown',
      image: toAbsoluteUrl(request, c.director?.image, s3Active, s3BaseUrl) || null,
      designation: c.director?.designation || null,
      role: c.role || 'Director',
    }));

    const genreNames = (series.genres as any[]).map((g: any) => g?.name || g);
    const languageNames = (series.languages as any[]).map((l: any) => l?.name || l);

    // Fetch Episodes
    const allEpisodes = await EpisodeModel.find({
      tvShowId: series._id,
    }).sort({ season: 1, episode: 1 }).lean();

    const seasonsMap = new Map<number, any[]>();
    for (const ep of allEpisodes) {
      if (!seasonsMap.has(ep.season)) {
        seasonsMap.set(ep.season, []);
      }
      
      const hours = ep.duration ? Math.floor(ep.duration / 3600) : 0;
      const minutes = ep.duration ? Math.floor((ep.duration % 3600) / 60) : 0;
      const durationStr = ep.duration ? (hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`) : null;
      
      seasonsMap.get(ep.season)!.push({
        id: ep._id.toString(),
        season: ep.season,
        episode: ep.episode,
        title: ep.title,
        description: ep.description || null,
        thumbnail: toAbsoluteUrl(request, ep.thumbnail || series.thumbnail, s3Active, s3BaseUrl) || null,
        duration: ep.duration || null,
        durationFormatted: durationStr,
        isFree: ep.isFree,
        videoUrl: toAbsoluteUrl(request, ep.hlsUrl || ep.sourceVideoUrl, s3Active, s3BaseUrl) || null,
        hlsUrl: toAbsoluteUrl(request, ep.hlsUrl || ep.sourceVideoUrl, s3Active, s3BaseUrl) || null,
      });
    }

    const seasons = Array.from(seasonsMap.keys()).map(s => ({
      seasonNumber: s,
      episodes: seasonsMap.get(s),
    }));

    return reply.send({
      success: true,
      data: {
        id: series._id.toString(),
        title: series.title,
        originalTitle: series.originalTitle || null,
        description: series.description || null,
        shortDescription: series.shortDescription || null,
        thumbnail: toAbsoluteUrl(request, series.thumbnail, s3Active, s3BaseUrl) || null,
        bannerImage: toAbsoluteUrl(request, series.bannerImage, s3Active, s3BaseUrl) || null,
        posterImage: toAbsoluteUrl(request, series.posterImage, s3Active, s3BaseUrl) || null,
        trailerUrl: toAbsoluteUrl(request, series.trailerUrl, s3Active, s3BaseUrl) || null,
        contentType: series.contentType,
        
        isLocked: series.planRequired !== 'free' && userPlan === 'free',

        genres: genreNames,
        genresText: genreNames.join(' & '),
        languages: languageNames,
        year: series.year || null,
        rating: series.rating || null,
        ageRating: series.ageRating || 0,
        imdbRating: series.imdbRating || null,
        planRequired: series.planRequired || 'free',
        contentPlan: series.planRequired || 'free',
        episodeCount: allEpisodes.length,
        isExclusive: series.isExclusive || false,
        featured: series.featured || false,
        trending: series.trending || false,
        releaseDate: series.releaseDate || null,
        country: series.country || null,
        studio: series.studio || null,
        
        views: series.views || 0,
        likeCount: series.likes || 0,
        shares: series.shares || 0,
        
        isLikedByUser,
        isWishlisted,
        wishlisted,
        
        shareUrl: buildShareUrl(series._id.toString()),
        
        cast,
        crew,
        related,
        seasons,
        episodes: Array.from(seasonsMap.values()).flat(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting series detail');
    return reply.status(500).send({ success: false, message: 'Failed to fetch series detail.', error: error.message });
  }
};
