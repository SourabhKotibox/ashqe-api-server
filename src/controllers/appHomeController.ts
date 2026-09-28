import type { FastifyReply, FastifyRequest } from 'fastify';
import { BannerModel } from '../models/Banner';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';
import { SectionModel } from '../models/Section';
import { UserLikeModel } from '../models/UserLike';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { UserWatchProgressModel } from '../models/UserWatchProgress';
import { AppSettingModel } from '../models/AppSetting';
import { logger } from '../lib/logger';
import mongoose from 'mongoose';
import {
  canAccessContent,
  isContentLocked,
  requiresSubscription,
  resolveEffectiveUserPlan,
} from '../lib/subscriptionAccess';

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
const getAuthData = (request: FastifyRequest): { userId: string | null; profileId: string | null } => {
  let userId = null;
  let profileId = (request.headers['x-profile-id'] as string) || null;
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const server = request.server as any;
      const decoded = server.jwt.verify(authHeader.slice(7)) as any;
      userId = decoded?.id || null;
    }
  } catch {}
  return { userId, profileId };
};

// Helper function to map movie items — resolveUrl converts all image/video paths to full URLs
const mapContentItem = (
  item: any,
  resolveUrl: (url: string | null | undefined) => string | null,
  likeCount = 0,
  isLikedByUser = false,
  userPlan = 'free',
  type: 'movie' | 'show' = 'movie',
) => {
  const contentPlan = item.planRequired || item.plan || 'free';
  const locked = isContentLocked(contentPlan, userPlan);
  const accessible = canAccessContent(contentPlan, userPlan);
  return {
    id: item._id.toString(),
    title: item.title,
    description: item.description,
    shortDescription: item.shortDescription,
    thumbnail: resolveUrl(item.thumbnail),
    bannerImage: resolveUrl(item.bannerImage),
    posterImage: resolveUrl(item.posterImage),
    type,
    contentType: type === 'show' ? 'tvShow' : 'movie',
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
    // Full stream only when user can access; trailer always allowed
    videoUrl: accessible ? resolveUrl(item.hlsUrl || null) : null,
    trailerUrl: resolveUrl(item.trailerUrl || null),
    contentPlan,
    planRequired: contentPlan,
    requiresSubscription: requiresSubscription(contentPlan),
    isLocked: locked,
  };
};

const populateBannersContent = async (banners: any[]) => {
  const contentIds = banners.map((b) => b.contentId).filter(Boolean);
  if (contentIds.length === 0) return banners;

  const movies = await MovieModel.find({ _id: { $in: contentIds } })
    .populate('languages', 'name')
    .populate('genres', 'name')
    .lean();
  const tvShows = await TVShowModel.find({ _id: { $in: contentIds } })
    .populate('languages', 'name')
    .populate('genres', 'name')
    .lean();

  // Create a map for quick lookups
  const contentMap = new Map();
  for (const movie of movies) {
    contentMap.set(movie._id.toString(), { ...movie, type: 'movie' });
  }
  for (const show of tvShows) {
    contentMap.set(show._id.toString(), { ...show, type: 'show' });
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
  userPlan = 'free',
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
    content: content ? mapContentItem(content, resolveUrl, likeCount, isLikedByUser, userPlan, content.type === 'show' ? 'show' : 'movie') : undefined,
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
      tab?: string;
    };

    const requestedTab = query.tab || 'all';

    const { userId, profileId } = getAuthData(request);

    // Build URL resolver (local storage)
    const resolveUrl = buildUrlResolver(request);

    // Resolve REAL active plan from Subscription collection (not stale JWT/user fields)
    let userPlan = 'free';
    // Get user's preferred language (defaulting to Hindi if skipped/not set)
    let preferredLanguage = 'Hindi';
    if (userId) {
      const [plan, user] = await Promise.all([
        resolveEffectiveUserPlan(userId),
        UserModel.findById(userId)
          .select('preferredLanguage languageSelectionSkipped')
          .lean(),
      ]);
      userPlan = plan;
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
    let contentTypes = ['movie', 'mixed', 'webseries', 'tvshow', 'web'];
    if (requestedTab === 'movie') contentTypes = ['movie', 'mixed'];
    else if (requestedTab === 'webseries' || requestedTab === 'tvshow') contentTypes = ['webseries', 'tvshow'];

    const dbSections = await SectionModel.find({
      contentType: { $in: contentTypes as any[] }, isActive: true })
      .select('key title category contentType sortBy limit position isActive layout showViewAll itemType filter contentSelection manualContentIds')
      .sort({ position: 1 })
      .lean();
    const sectionsToFetch = dbSections.length > 0 ? dbSections : getFallbackSections();

    // Fetch content for each section
    const sectionPromises = sectionsToFetch.map(async (section) => {
      let content: any[] = [];
      const manualIds = (section as any).manualContentIds || [];
      const hasManual = manualIds.length > 0;

      const buildFilter = (base: any, restrictToManualOnly = false) => {
        const sectionFilter = { ...(section.filter || {}) };

        // Remove mediaType from filter so it doesn't try to query MongoDB for mediaType field
        delete sectionFilter.mediaType;

        const manualBase = { status: 'published' };
        
        if (restrictToManualOnly) {
          return hasManual ? { ...manualBase, _id: { $in: manualIds } } : null;
        }

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

      let contentMovies: any[] = [];
      let contentShows: any[] = [];

      // Determine if we should fetch movies, shows, or both
      const mediaTypeFilter = section.filter?.mediaType;
      
      let allowDynamicMovies = (!mediaTypeFilter || mediaTypeFilter === 'movie' || mediaTypeFilter === 'mixed');
      let allowDynamicShows = (!mediaTypeFilter || mediaTypeFilter === 'series' || mediaTypeFilter === 'tvshow' || mediaTypeFilter === 'webseries' || mediaTypeFilter === 'mixed');
      
      let allowManualMovies = true;
      let allowManualShows = true;

      if (!mediaTypeFilter) {
          if (section.contentType === 'movie') allowDynamicShows = false;
          if (section.contentType === 'webseries' || section.contentType === 'tvshow') allowDynamicMovies = false;
      }

      // Strictly enforce tab boundaries (prevents accidental manual mixed content)
      if (requestedTab === 'movie') {
          allowDynamicShows = false;
          allowManualShows = false;
      }
      if (requestedTab === 'webseries' || requestedTab === 'tvshow') {
          allowDynamicMovies = false;
          allowManualMovies = false;
      }
      
      const movieFilter = allowManualMovies ? buildFilter(baseMovieFilter, !allowDynamicMovies) : null;
      const showFilter = allowManualShows ? buildFilter(baseMovieFilter, !allowDynamicShows) : null;
      
      if (movieFilter) {
        const rawM = await MovieModel.find(movieFilter)
          .sort(section.sortBy)
          .limit(section.limit)
          .populate('languages', 'name')
          .populate('genres', 'name')
          .lean();
        contentMovies = rawM.map((m: any) => ({ ...m, _type: 'movie' }));
      }
      
      if (showFilter) {
        const rawS = await TVShowModel.find(showFilter)
          .sort(section.sortBy)
          .limit(section.limit)
          .populate('languages', 'name')
          .populate('genres', 'name')
          .lean();
        contentShows = rawS.map((s: any) => ({ ...s, _type: 'show' }));
      }

      // Merge and sort again if necessary, then limit
      content = [...contentMovies, ...contentShows];
      if (section.sortBy) {
        const sortKey = Object.keys(section.sortBy)[0];
        if (sortKey) {
          const dir = section.sortBy[sortKey];
          content.sort((a, b) => {
            if (a[sortKey] < b[sortKey]) return dir === 1 ? -1 : 1;
            if (a[sortKey] > b[sortKey]) return dir === 1 ? 1 : -1;
            return 0;
          });
        }
      }
      content = content.slice(0, section.limit);

      if (content.length === 0) {
        return null;
      }

      return { ...section, content };
    });

    const sectionsWithContent = await Promise.all(sectionPromises);

    // ── Fetch Continue Watching Progress ──────────────────────────────────────
    const watchProgressList: any[] = [];
    if (userId) {
      const queryParams: any = { userId };
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
        return mapContentItem(item, resolveUrl, likeCount, isLikedByUser, userPlan, item._type || 'movie');
      }),
    }));

    // Map Continue Watching section
    const continueWatchingShows: any[] = [];
    if (watchProgressList.length > 0) {
      const movieIds = watchProgressList.filter(p => p.contentModelType === 'Movie').map(p => p.contentId);
      const showIds = watchProgressList.filter(p => p.contentModelType === 'TVShow').map(p => p.contentId);
      const episodeIds = watchProgressList.filter(p => p.contentModelType === 'Episode').map(p => p.contentId);

      const [movies, shows, episodes] = await Promise.all([
        movieIds.length ? MovieModel.find({ _id: { $in: movieIds } }).lean() : Promise.resolve([]),
        showIds.length ? TVShowModel.find({ _id: { $in: showIds } }).lean() : Promise.resolve([]),
        episodeIds.length ? EpisodeModel.find({ _id: { $in: episodeIds } }).lean() : Promise.resolve([]),
      ]);

      const parentShowIds = (episodes as any[]).map((e: any) => e.tvShowId).filter(Boolean);
      const parentShows = parentShowIds.length
        ? await TVShowModel.find({ _id: { $in: parentShowIds } }).lean()
        : [];

      const itemsMap = new Map<string, { item: any; type: 'movie' | 'show'; episode?: any }>();
      (movies as any[]).forEach((item: any) => itemsMap.set(item._id.toString(), { item, type: 'movie' }));
      (shows as any[]).forEach((item: any) => itemsMap.set(item._id.toString(), { item, type: 'show' }));
      const parentMap = new Map((parentShows as any[]).map((s: any) => [s._id.toString(), s]));
      (episodes as any[]).forEach((ep: any) => {
        const parent = parentMap.get(ep.tvShowId?.toString());
        if (parent) itemsMap.set(ep._id.toString(), { item: parent, type: 'show', episode: ep });
      });

      for (const progress of watchProgressList) {
        const entry = itemsMap.get(progress.contentId.toString());
        if (!entry) continue;

        const cid = entry.item._id.toString();
        const likeCount = entry.item.likes || 0;
        const isLikedByUser = likedContentIdSet.has(cid);

        const mapped: any = mapContentItem(entry.item, resolveUrl, likeCount, isLikedByUser, userPlan, entry.type);
        if (entry.episode) {
          mapped.episodeId = entry.episode._id.toString();
          mapped.episodeTitle = entry.episode.title;
          mapped.season = entry.episode.season;
          mapped.episode = entry.episode.episode;
        }

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
    let tabName = requestedTab === 'webseries' || requestedTab === 'tvshow' ? 'Web Series' : (requestedTab === 'all' ? 'Home' : 'Movies');
    if (appSetting && appSetting.value && Array.isArray(appSetting.value)) {
      const configKey = requestedTab === 'all' ? 'movie' : requestedTab;
      const tabConfig = appSetting.value.find((t: any) => t.id === configKey);
      if (tabConfig && tabConfig.name) {
        tabName = requestedTab === 'all' ? 'Home' : tabConfig.name;
      }
    }

    return reply.send({
      success: true,
      data: {
        tab: requestedTab,
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
      tab?: string;
    };

    const requestedTab = query.tab || 'all';
    const platform = query.platform || 'mobile';
    const limit = Math.min(20, Math.max(1, Number(query.limit || 10)));
    const now = new Date();

    // Build URL resolver (local storage)
    const resolveUrl = buildUrlResolver(request);

    let contentTypes = ['movie', 'tvShow'];
    if (requestedTab === 'movie') contentTypes = ['movie'];
    else if (requestedTab === 'webseries' || requestedTab === 'tvshow') contentTypes = ['tvShow'];

    const bannersRaw = await BannerModel.find({
      isActive: true,
      targetPlatforms: platform,
      contentType: { $in: contentTypes },
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
    let userPlan = 'free';
    if (userId) {
      userPlan = await resolveEffectiveUserPlan(userId);
    }
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
      if (!banner.contentId) return mapBanner(banner, resolveUrl, 0, false, userPlan);
      const cid = (banner.contentId as any)._id.toString();
      const likeCount = (banner.contentId as any).likes || 0;
      const isLikedByUser = likedContentIdSet.has(cid);
      return mapBanner(banner, resolveUrl, likeCount, isLikedByUser, userPlan);
    });

    return reply.send({
      success: true,
      data: {
        tab: requestedTab,
        banners: mappedBanners,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting app banners');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
