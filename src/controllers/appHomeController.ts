import type { FastifyReply, FastifyRequest } from 'fastify';
import { BannerModel } from '../models/Banner';
import { MovieModel } from '../models/Movie';
import { SectionModel } from '../models/Section';
import { UserLikeModel } from '../models/UserLike';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { UserWatchProgressModel } from '../models/UserWatchProgress';
import { AppSettingModel } from '../models/AppSetting';
import { logger } from '../lib/logger';
import mongoose from 'mongoose';

// Base URL for the backend API (used for smart share links)
import { buildShareUrl } from '../lib/config';

// ── URL Resolver ─────────────────────────────────────────────────────────────
// Converts any stored path/key to a proper full URL:
// - Already full URL (https://...) → returned as-is
// - Local relative path → full server URL
const buildUrlResolver = (request: FastifyRequest) =>
  (url: string | null | undefined): string | null => {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    let relPath = url;
    if (!relPath.startsWith('/uploads/')) {
      relPath = relPath.startsWith('uploads/') ? `/${relPath}` : `/uploads/${relPath.startsWith('/') ? relPath.slice(1) : relPath}`;
    }
    return `${request.protocol}://${request.hostname}${relPath}`;
  };

// Helper: try to extract userId from JWT (optional auth — no error if missing/invalid)
const getAuthData = (request: FastifyRequest): { userId: string | null; profileId: string | null; userPlan: string } => {
  let userId = null;
  let profileId = (request.headers['x-profile-id'] as string) || null;
  let userPlan = 'free';
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const server = request.server as any;
      const decoded = server.jwt.verify(authHeader.slice(7)) as any;
      userId = decoded?.id || null;
      userPlan = decoded?.plan || 'free';
    }
  } catch {}
  return { userId, profileId, userPlan };
};

// Helper function to map movie items — resolveUrl converts all image/video paths to full URLs
const mapContentItem = (
  item: any,
  resolveUrl: (url: string | null | undefined) => string | null,
  likeCount = 0,
  isLikedByUser = false,
) => ({
  id: item._id.toString(),
  title: item.title,
  description: item.description,
  shortDescription: item.shortDescription,
  thumbnail: resolveUrl(item.thumbnail),
  bannerImage: resolveUrl(item.bannerImage),
  posterImage: resolveUrl(item.posterImage),
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
  videoUrl: resolveUrl(item.hlsUrl || null),
  trailerUrl: resolveUrl(item.trailerUrl || null),
  contentPlan: item.planRequired || item.plan || 'free',
});

const populateBannersContent = async (banners: any[]) => {
  const contentIds = banners.map((b) => b.contentId).filter(Boolean);
  if (contentIds.length === 0) return banners;

  const movies = await MovieModel.find({ _id: { $in: contentIds } })
    .populate('languages', 'name')
    .populate('genres', 'name')
    .lean();

  // Create a map for quick lookups
  const contentMap = new Map();
  for (const movie of movies) {
    contentMap.set(movie._id.toString(), { ...movie, type: 'movie' });
  }

  // Assign populated content back to banner
  for (const banner of banners) {
    if (banner.contentId) {
      banner.contentId = contentMap.get(banner.contentId.toString()) || null;
    }
  }

  return banners;
};

// Helper function to map banner — resolveUrl converts all image paths to full URLs
const mapBanner = (
  banner: any,
  resolveUrl: (url: string | null | undefined) => string | null,
  likeCount = 0,
  isLikedByUser = false,
) => {
  const content = banner.contentId;
  const thumbnail = resolveUrl(content?.thumbnail || banner.imageUrl);
  return {
    id: banner._id.toString(),
    title: banner.title,
    subtitle: banner.subtitle,
    description: banner.description,
    thumbnail,
    imageUrl: resolveUrl(banner.imageUrl),
    mobileImageUrl: resolveUrl(banner.mobileImageUrl),
    ctaText: banner.ctaText,
    ctaLink: banner.ctaLink,
    contentId: banner.contentId?._id?.toString(),
    content: content ? mapContentItem(content, resolveUrl, likeCount, isLikedByUser) : undefined,
    type: banner.type,
    contentType: banner.contentType,
    position: banner.position,
    isActive: banner.isActive,
    targetPlatforms: banner.targetPlatforms || [],
    startDate: banner.startDate,
    endDate: banner.endDate,
  };
};

// Helper function: Fallback sections (only if no sections in DB)
const getFallbackSections = () => [
  { key: 'featured', title: 'Featured', category: 'Featured', filter: { featured: true }, sortBy: { createdAt: -1 }, limit: 10, layout: 'horizontal' },
  { key: 'top-movies', title: 'Top Movies', category: 'Top Rated', sortBy: { views: -1 }, limit: 10, layout: 'vertical' },
  { key: 'just-launched', title: 'Just Launched', category: 'Recently Added', filter: { isNewContent: true }, sortBy: { createdAt: -1 }, limit: 10, layout: 'horizontal' },
  { key: 'trending-movies', title: 'Trending Movies', category: 'Trending', filter: { trending: true }, sortBy: { views: -1 }, limit: 10, layout: 'vertical' },
];

// Get home page data — sections/layout only (banners are separate via GET /api/app/banners)
export const getHomePage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      platform?: 'web' | 'mobile' | 'tv';
      limit?: string;
    };

    const { userId, profileId } = getAuthData(request);

    // Build URL resolver (local storage)
    const resolveUrl = buildUrlResolver(request);

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
    let targetLanguageId: mongoose.Types.ObjectId | null = null;
    if (preferredLanguage) {
      const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
      if (langDoc) {
        targetLanguageId = langDoc._id as mongoose.Types.ObjectId;
      }
    }

    // Get sections from database, or fallback to default
    const dbSections = await SectionModel.find({
      contentType: { $in: ['movie', 'mixed'] as any[] }, isActive: true })
      .select('key title category contentType sortBy limit position isActive layout showViewAll itemType filter contentSelection manualContentIds')
      .sort({ position: 1 })
      .lean();
    const sectionsToFetch = dbSections.length > 0 ? dbSections : getFallbackSections();

    // Fetch content for each section
    const sectionPromises = sectionsToFetch.map(async (section) => {
      let content: any[] = [];
      const manualIds = (section as any).manualContentIds || [];
      const hasManual = manualIds.length > 0;

      const buildFilter = (base: any) => {
        const sectionFilter = { ...(section.filter || {}) };

        // Legacy mediaType filter — movies only now
        if (sectionFilter.mediaType) {
          if (sectionFilter.mediaType === 'series') return null;
          delete sectionFilter.mediaType;
        }

        const manualBase = { status: 'published' };
        if ((section as any).contentSelection === 'manual') {
          return hasManual ? { ...manualBase, _id: { $in: manualIds } } : null;
        } else if ((section as any).contentSelection === 'mixed' && hasManual) {
          return {
            $or: [
              { ...base, ...sectionFilter },
              { ...manualBase, _id: { $in: manualIds } }
            ]
          };
        } else {
          return { ...base, ...sectionFilter };
        }
      };

      const baseMovieFilter: any = { status: 'published' };
      if (targetLanguageId) {
        baseMovieFilter.languages = targetLanguageId;
      }

      const filterMovie = buildFilter(baseMovieFilter);

      if (filterMovie) {
        content = await MovieModel.find(filterMovie)
          .sort(section.sortBy)
          .limit(section.limit)
          .populate('languages', 'name')
          .populate('genres', 'name')
          .lean();
      }

      if (content.length === 0) {
        return null;
      }

      return { ...section, content };
    });

    const sectionsWithContent = await Promise.all(sectionPromises);

    // ── Fetch Continue Watching Progress ──────────────────────────────────────
    const watchProgressList: any[] = [];
    if (userId) {
      const queryParams: any = {
        userId,
        contentModelType: 'Movie',
      };
      if (profileId) {
        queryParams.profileId = profileId;
      }
      const rawProgressList = await UserWatchProgressModel.find(queryParams)
        .sort({ lastWatchedAt: -1 })
        .limit(50) // Fetch more to allow for deduplication
        .lean();

      // Deduplicate by contentId, keeping the most recent
      const seenContentIds = new Set();
      for (const progress of rawProgressList) {
        if (!progress.contentId) continue;
        const cid = progress.contentId.toString();
        if (!seenContentIds.has(cid)) {
          watchProgressList.push(progress);
          seenContentIds.add(cid);
        }
        if (watchProgressList.length >= 10) break;
      }
    }

    const validSections = sectionsWithContent.filter((s): s is NonNullable<typeof s> => s !== null);

    // ── Aggregate Data (Likes) ────────────────────────────────────────────────

    // Collect all content IDs from sections and watch progress
    const allContentIdsSet = new Set<string>();
    validSections.forEach(s => s.content.forEach((c: any) => allContentIdsSet.add(c._id.toString())));
    watchProgressList.forEach(p => { if (p.contentId) allContentIdsSet.add(p.contentId.toString()); });

    const allContentIds = Array.from(allContentIdsSet).map(id => new mongoose.Types.ObjectId(id));

    // Get user likes
    const likedContentIdSet = new Set<string>();
    if (userId && allContentIds.length > 0) {
      const userLikes = await UserLikeModel.find({
        userId,
        contentId: { $in: allContentIds },
      }).select('contentId').lean();
      userLikes.forEach(l => likedContentIdSet.add(l.contentId.toString()));
    }

    // ── Mapping ───────────────────────────────────────────────────────────────

    // Map sections
    const mappedSections = validSections.map(section => ({
      key: section.key,
      title: section.title,
      category: section.category,
      layout: section.layout || 'horizontal',
      showViewAll: section.showViewAll !== false,
      itemType: section.itemType || 'poster',
      shows: section.content.map((item: any) => {
        const cid = item._id.toString();
        const likeCount = item.likes || 0;
        const isLikedByUser = likedContentIdSet.has(cid);
        return mapContentItem(item, resolveUrl, likeCount, isLikedByUser);
      }),
    }));

    // Map Continue Watching section
    const continueWatchingShows: any[] = [];
    if (watchProgressList.length > 0) {
      const contentIds = watchProgressList.map(p => p.contentId);
      const items = await MovieModel.find({ _id: { $in: contentIds } }).lean();

      const itemsMap = new Map<string, any>();
      items.forEach(item => itemsMap.set(item._id.toString(), item));

      for (const progress of watchProgressList) {
        const item = itemsMap.get(progress.contentId.toString());
        if (!item) continue;

        const cid = item._id.toString();
        const likeCount = item.likes || 0;
        const isLikedByUser = likedContentIdSet.has(cid);

        const mapped: any = mapContentItem(item, resolveUrl, likeCount, isLikedByUser);

        // Inject watch progress detail
        mapped.watchProgress = {
          progressSeconds: progress.progressSeconds,
          durationSeconds: progress.durationSeconds,
          progressPercent: progress.progressPercent,
          lastWatchedAt: progress.lastWatchedAt,
        };

        continueWatchingShows.push(mapped);
      }
    }

    if (continueWatchingShows.length > 0) {
      mappedSections.unshift({
        key: 'continue-watching',
        title: 'Continue Watching',
        category: 'Continue Watching',
        layout: 'horizontal',
        showViewAll: false,
        itemType: 'poster',
        shows: continueWatchingShows,
      });
    }

    // Get Custom Tab Name
    const appSetting = await AppSettingModel.findOne({ key: 'home-tabs-config' }).lean();
    let tabName = 'Movies';
    if (appSetting && appSetting.value && Array.isArray(appSetting.value)) {
      const tabConfig = appSetting.value.find((t: any) => t.id === 'movie');
      if (tabConfig && tabConfig.name) {
        tabName = tabConfig.name;
      }
    }

    return reply.send({
      success: true,
      data: {
        tab: 'movie',
        tabName,
        sections: mappedSections,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting home page data');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.stack });
  }
};

// ── GET App Banners (separate from home layout) ────────────────────────────
export const getAppBanners = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      platform?: 'mobile' | 'web' | 'tv';
      limit?: string;
    };

    const platform = query.platform || 'mobile';
    const limit = Math.min(20, Math.max(1, Number(query.limit || 10)));
    const now = new Date();

    // Build URL resolver (local storage)
    const resolveUrl = buildUrlResolver(request);

    const bannersRaw = await BannerModel.find({
      isActive: true,
      targetPlatforms: platform,
      $and: [
        { $or: [{ startDate: { $exists: false } }, { startDate: { $lte: now } }] },
        { $or: [{ endDate: { $exists: false } }, { endDate: { $gte: now } }] },
      ],
    })
      .sort({ position: 1, createdAt: -1 })
      .limit(limit)
      .lean();

    const banners = await populateBannersContent(bannersRaw);

    const { userId } = getAuthData(request);
    const allContentIds = banners
      .filter(b => b.contentId)
      .map(b => new mongoose.Types.ObjectId((b.contentId as any)._id.toString()));

    // User likes
    const likedContentIdSet = new Set<string>();
    if (userId && allContentIds.length > 0) {
      const userLikes = await UserLikeModel.find({ userId, contentId: { $in: allContentIds } }).select('contentId').lean();
      userLikes.forEach(l => likedContentIdSet.add(l.contentId.toString()));
    }

    const mappedBanners = banners.map(banner => {
      if (!banner.contentId) return mapBanner(banner, resolveUrl);
      const cid = (banner.contentId as any)._id.toString();
      const likeCount = (banner.contentId as any).likes || 0;
      const isLikedByUser = likedContentIdSet.has(cid);
      return mapBanner(banner, resolveUrl, likeCount, isLikedByUser);
    });

    return reply.send({
      success: true,
      data: {
        tab: 'movie',
        banners: mappedBanners,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting app banners');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
