import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { UserLikeModel } from '../models/UserLike';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { logger } from '../lib/logger';

// How many extra items to fetch per page to survive deduplication filtering
const FETCH_MULTIPLIER = 4;

// Helper: try to extract userId from JWT (optional auth — no error if missing/invalid)
const getOptionalUserId = (request: FastifyRequest): string | null => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const server = request.server as any;
    const decoded = server.jwt.verify(token) as any;
    return decoded?.id || null;
  } catch {
    return null;
  }
};

import { buildShareUrl } from '../lib/config';

// Helper to convert relative URLs to absolute URLs
const toAbsoluteUrl = (request: FastifyRequest, url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  
  let relPath = url;
  if (!relPath.startsWith('/uploads/')) {
    relPath = relPath.startsWith('uploads/') ? `/${relPath}` : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
  }
  
  const baseUrl = `${request.protocol}://${request.hostname}`;
  return `${baseUrl}${relPath}`;
};

// Helper function to map movie items for the explore feed
const mapContentItem = (
  request: FastifyRequest,
  item: any,
  likeCount = 0,
  isLikedByUser = false,
) => ({
  id: item._id.toString(),
  title: item.title,
  description: item.description,
  shortDescription: item.shortDescription,
  thumbnail: toAbsoluteUrl(request, item.thumbnail),
  bannerImage: toAbsoluteUrl(request, item.bannerImage),
  type: 'movie',
  genres: (item.genres || []).map((g: any) => g.name || g),
  genresText: (item.genres || []).map((g: any) => g.name || g).join(' & '),
  languages: (item.languages || []).map((l: any) => l.name || l),
  views: item.views || 0,
  likeCount,
  isLikedByUser,
  shares: item.shares || 0,
  shareUrl: buildShareUrl(item._id.toString()),
  featured: item.featured,
  trending: item.trending,
  isNewContent: item.isNewContent,
  rating: item.rating,
  year: item.year,
  duration: item.duration,
  status: item.status,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  videoUrl: toAbsoluteUrl(request, item.hlsUrl) || null,
  trailerUrl: toAbsoluteUrl(request, item.trailerUrl) || null,
  contentPlan: item.plan || 'free',
});

// Get explore page data (infinite scroll, movies only)
export const getExplore = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      offset?: string;
      limit?: string;
      sort?: 'new' | 'trending' | 'views' | 'featured';
      // Comma-separated contentIds already seen — frontend passes these for dedup across sessions
      seenIds?: string;
    };

    const offset = Math.max(0, Number(query.offset || 0));
    const limit = Math.min(10, Math.max(1, Number(query.limit || 5)));
    const sort = query.sort || 'new';

    // Parse already-seen IDs sent by the client (dedup across scroll sessions)
    const seenIds = query.seenIds
      ? query.seenIds.split(',').map(id => id.trim()).filter(Boolean)
      : [];

    // Optional auth — used for isLikedByUser
    const userId = getOptionalUserId(request);

    let sortBy: any = {};
    let filter: any = { status: 'published' };

    // Exclude content IDs the client has already seen
    if (seenIds.length > 0) {
      const mongoose = await import('mongoose');
      const seenObjectIds = seenIds
        .filter(id => mongoose.default.Types.ObjectId.isValid(id))
        .map(id => new mongoose.default.Types.ObjectId(id));
      if (seenObjectIds.length > 0) {
        filter._id = { $nin: seenObjectIds };
      }
    }

    switch (sort) {
      case 'new':       sortBy = { createdAt: -1 }; break;
      case 'trending':  sortBy = { trending: -1, views: -1 }; break;
      case 'views':     sortBy = { views: -1 }; break;
      case 'featured':
        sortBy = { featured: -1, views: -1 };
        filter = { ...filter, featured: true };
        break;
      default:          sortBy = { createdAt: -1 };
    }

    // Get user's preferred language (defaulting to Hindi if skipped/not set)
    let preferredLanguage = 'Hindi';
    if (userId) {
      const user = await UserModel.findById(userId).select('preferredLanguage languageSelectionSkipped').lean();
      if (user) {
        if (user.preferredLanguage) {
          preferredLanguage = user.preferredLanguage;
        } else if (user.languageSelectionSkipped) {
          preferredLanguage = 'Hindi';
        }
      }
    }

    // Lookup corresponding Language document ObjectId
    let targetLanguageId: any = null;
    if (preferredLanguage) {
      const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
      if (langDoc) {
        targetLanguageId = langDoc._id;
      }
    }

    // ── Fetch a larger batch to allow for deduplication ──────────────────────
    const fetchLimit = limit * FETCH_MULTIPLIER;

    const langFilter = { ...filter };
    if (targetLanguageId) {
      langFilter.languages = targetLanguageId;
    }
    const rawContents: any[] = await MovieModel.find(langFilter)
      .sort(sortBy)
      .skip(offset)
      .limit(fetchLimit)
      .populate('languages', 'name')
      .populate('genres', 'name')
      .lean();

    logger.info(
      { offset, limit, fetchLimit, raw: rawContents.length },
      'Explore API raw fetch',
    );

    // ── Deduplicate: remove items with same thumbnail OR same videoUrl ────────
    const seenThumbnails = new Set<string>();
    const seenVideoUrls = new Set<string>();
    const uniqueContents: any[] = [];

    for (const content of rawContents) {
      const thumbnail = content.thumbnail || '';
      const videoUrl = content.hlsUrl || '';

      // Mark as seen
      if (thumbnail) seenThumbnails.add(thumbnail);
      if (videoUrl) seenVideoUrls.add(videoUrl);

      uniqueContents.push(content);

      // Stop once we have enough unique items
      if (uniqueContents.length >= limit) break;
    }

    // ── Fetch like status for unique items ────────────────────────────────────
    const uniqueIds = uniqueContents.map(c => c._id);
    const likedContentIdSet = new Set<string>();

    if (userId && uniqueIds.length > 0) {
      const userLikes = await UserLikeModel.find({
        userId,
        contentId: { $in: uniqueIds },
      })
        .select('contentId')
        .lean();
      userLikes.forEach(l => likedContentIdSet.add(l.contentId.toString()));
    }

    // ── Map to response ───────────────────────────────────────────────────────
    const items = uniqueContents.map(content => {
      const cid = content._id.toString();
      const likeCount: number = content.likes || 0;
      const isLikedByUser: boolean = likedContentIdSet.has(cid);
      return mapContentItem(request, content, likeCount, isLikedByUser);
    });

    // nextOffset moves forward by the full raw fetch batch size (not just unique count)
    // This ensures the next page never repeats items from this batch
    const nextOffset = offset + rawContents.length;
    const hasMore = rawContents.length === fetchLimit; // more items exist in DB

    reply.send({
      success: true,
      data: {
        items,
        // Tell the client which IDs were shown (use these as seenIds next call)
        returnedIds: items.map(i => i.id),
        nextOffset,
        hasMore,
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error fetching explore data');
    reply.status(500).send({
      success: false,
      message: 'Failed to fetch explore data',
      error: error.message,
    });
  }
};
