import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { GenreModel } from '../models/Genre';
import { BannerModel } from '../models/Banner';
import { logger } from '../lib/logger';

const S3_PUBLIC_BASE =
  (process.env.AWS_S3_PUBLIC_BASE_URL || 'https://tatiyatv.s3.eu-north-1.amazonaws.com').replace(/\/$/, '');

/** Turn relative media keys / legacy /uploads paths into absolute public URLs */
const resolveMediaUrl = (value?: string | null): string => {
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) {
    const m = value.match(/^https?:\/\/(?:www\.)?tataiya\.in\/uploads\/(media\/.+)$/i);
    if (m) return `${S3_PUBLIC_BASE}/${m[1]}`;
    return value;
  }
  if (value.startsWith('/uploads/')) {
    const key = value.replace(/^\/uploads\//, '');
    if (key.startsWith('media/')) return `${S3_PUBLIC_BASE}/${key}`;
    return value; // local non-media uploads stay relative for nginx
  }
  if (value.startsWith('uploads/')) {
    const key = value.replace(/^uploads\//, '');
    if (key.startsWith('media/')) return `${S3_PUBLIC_BASE}/${key}`;
  }
  // Bare S3 key e.g. media/folder/file.jpg
  if (value.startsWith('media/')) return `${S3_PUBLIC_BASE}/${value}`;
  return value;
};

const formatDuration = (duration: any): string => {
  if (!duration && duration !== 0) return '120m';
  if (typeof duration === 'string' && /[hm]/i.test(duration)) return duration;
  const n = Number(duration);
  if (!Number.isFinite(n) || n <= 0) return '120m';
  // Values > 300 are almost certainly seconds
  if (n > 300) {
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  return `${Math.round(n)}m`;
};


// Standardized mapping for website ContentItem
const mapContentItem = (item: any, isHero = false) => {
  let badge;
  if (item.featured && item.trending) badge = 'EXCLUSIVE';
  else if (item.trending) badge = 'TRENDING';
  else if (item.featured) badge = 'TOP';
  else if (item.isNewContent) badge = 'NEW';
  else if (item.views > 1000) badge = 'HOT';

  return {
    id: item._id.toString(),
    title: item.title,
    poster: resolveMediaUrl(item.posterImage || item.thumbnail || ''),
    backdrop: resolveMediaUrl(item.bannerImage || item.thumbnail || ''),
    type: 'movie',
    contentType: 'movie',
    year: item.year?.toString() || new Date(item.createdAt).getFullYear().toString(),
    createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : undefined,
    duration: formatDuration(item.duration),
    imdbRating: item.imdbRating?.toString() || (item.rating || '8.0'),
    ageRating: item.ageRating ? `${item.ageRating}+` : 'U/A 13+',
    description: item.shortDescription || item.description || '',
    language: item.languages && item.languages.length > 0 ? 'Multi' : 'EN',
    badge,
    genres: (item.genres || []).map((g: any) => g?.name || g),
    trailerUrl: resolveMediaUrl(item.trailerUrl || '') || null,
    hlsUrl: resolveMediaUrl(item.hlsUrl || item.videoUrl || '') || null,
    videoUrl: resolveMediaUrl(item.videoUrl || item.hlsUrl || '') || null,
    planRequired: item.planRequired || 'free',
    isPremium: item.planRequired && item.planRequired !== 'free',
    trending: !!item.trending,
    isNewContent: !!item.isNewContent,
    views: item.views || 0,
  };
};

let homeCacheData: any = null;
let homeCacheTime = 0;
const CACHE_TTL = 120000; // 2 minutes

export const getWebHome = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const now = Date.now();
    if (homeCacheData && (now - homeCacheTime) < CACHE_TTL) {
      return reply.send(homeCacheData);
    }

    // Shared projection to make queries extremely fast
    const selectFields = 'title description shortDescription thumbnail bannerImage posterImage year rating ageRating duration imdbRating createdAt featured trending isNewContent views genres languages trailerUrl hlsUrl videoUrl planRequired';

    // Parallel fetching for genres to use in filtering
    const [actionGenre, dramaGenre] = await Promise.all([
      GenreModel.findOne({ name: { $regex: /action/i } }).select('_id').lean(),
      GenreModel.findOne({ name: { $regex: /drama/i } }).select('_id').lean()
    ]);

    // Construct promises for all data blocks to run perfectly in parallel
    const queries = [
      // 0: Hero Banners from BannerModel (active, target platform: web)
      (async () => {
        const bannersRaw = await BannerModel.find({
          isActive: true,
          targetPlatforms: 'web'
        }).sort({ position: 1, createdAt: -1 }).limit(10).lean();

        const contentIds = bannersRaw.map(b => b.contentId).filter(Boolean);
        const movies = await MovieModel.find({ _id: { $in: contentIds } }).populate('genres', 'name').lean();

        const contentMap = new Map();
        for (const movie of movies) {
          contentMap.set(movie._id.toString(), movie);
        }

        return bannersRaw.map((banner: any) => {
          const content = banner.contentId ? contentMap.get(banner.contentId.toString()) : null;
          const bannerImage = resolveMediaUrl(banner.imageUrl || '');
          if (content) {
            return {
              id: content._id.toString(),
              title: banner.title || content.title,
              poster: bannerImage || resolveMediaUrl(content.posterImage || content.thumbnail || ''),
              backdrop:
                bannerImage ||
                resolveMediaUrl(content.bannerImage || content.thumbnail || ''),
              type: 'movie',
              contentType: 'movie',
              year: content.year?.toString() || new Date(content.createdAt).getFullYear().toString(),
              duration: formatDuration(content.duration),
              imdbRating: content.imdbRating?.toString() || (content.rating || '8.0'),
              ageRating: content.ageRating ? `${content.ageRating}+` : 'U/A 13+',
              description: banner.description || content.shortDescription || content.description || '',
              language: content.languages && content.languages.length > 0 ? 'Multi' : 'EN',
              badge: banner.type?.toUpperCase() || 'EXCLUSIVE',
              genres: (content.genres || []).map((g: any) => g?.name || g),
              trailerUrl: resolveMediaUrl(content.trailerUrl || '') || null,
              hlsUrl: resolveMediaUrl(content.hlsUrl || content.videoUrl || '') || null,
              videoUrl: resolveMediaUrl(content.videoUrl || content.hlsUrl || '') || null,
              planRequired: content.planRequired || 'free',
              isPremium: content.planRequired && content.planRequired !== 'free',
              isBanner: true,
            };
          } else {
            // Banner without linked content
            return {
              id: banner._id.toString(),
              title: banner.title,
              poster: bannerImage,
              backdrop: bannerImage,
              type: 'movie',
              contentType: 'movie',
              year: new Date(banner.createdAt).getFullYear().toString(),
              duration: '120m',
              imdbRating: '8.0',
              ageRating: 'U/A 13+',
              description: banner.description || '',
              language: 'EN',
              badge: banner.type?.toUpperCase() || 'PROMO',
              genres: [],
              ctaLink: banner.ctaLink,
              ctaText: banner.ctaText,
              isBanner: true,
            };
          }
        });
      })(),
      // 1: Trending Now
      MovieModel.find({ status: 'published', trending: true }).sort({ views: -1, createdAt: -1 }).select(selectFields).limit(10).populate('genres', 'name').lean(),
      // 2: New Releases
      MovieModel.find({ status: 'published', isNewContent: true }).sort({ createdAt: -1 }).select(selectFields).limit(10).populate('genres', 'name').lean(),
      // 3: Top Rated Movies
      MovieModel.find({ status: 'published' }).sort({ imdbRating: -1, views: -1 }).select(selectFields).limit(10).populate('genres', 'name').lean(),
      // 4: Action Movies
      actionGenre
        ? MovieModel.find({ status: 'published', genres: actionGenre._id }).sort({ views: -1 }).select(selectFields).limit(10).populate('genres', 'name').lean()
        : Promise.resolve([]),
      // 5: Drama Movies
      dramaGenre
        ? MovieModel.find({ status: 'published', genres: dramaGenre._id }).sort({ views: -1 }).select(selectFields).limit(10).populate('genres', 'name').lean()
        : Promise.resolve([])
    ];

    const results = await Promise.all(queries);

    // Extract results
    let heroContent = (results[0] as any[]).filter(Boolean);
    const trendingRaw = results[1] as any[];
    const newReleasesRaw = results[2] as any[];
    const topRatedRaw = results[3] as any[];
    const actionMoviesRaw = results[4] as any[];
    const dramaMoviesRaw = results[5] as any[];

    // Map raw data into frontend structure (heroContent is already mapped)
    let trendingNow = trendingRaw.map((m: any) => mapContentItem(m));
    let newReleases = newReleasesRaw.map((m: any) => mapContentItem(m));
    const topRated = topRatedRaw.map((m: any) => mapContentItem(m));
    const actionMovies = actionMoviesRaw.map((m: any) => mapContentItem(m));
    const dramaMovies = dramaMoviesRaw.map((m: any) => mapContentItem(m));

    // Fallbacks so New & Hot / Trending never render empty when flags are sparse
    if (newReleases.length === 0 && topRated.length > 0) {
      newReleases = topRated.slice(0, 10).map((m: any, i: number) => ({ ...m, badge: m.badge || 'NEW' }));
    }
    if (trendingNow.length === 0 && topRated.length > 0) {
      trendingNow = topRated.slice(0, 10).map((m: any) => ({ ...m, badge: m.badge || 'TRENDING' }));
    }

    // Keep admin-created banners even if they are image-only (no trailer/video yet).
    // Only fill empty slots with playable movies when there are no banners at all.
    const playablePool = [
      ...topRated,
      ...trendingNow,
      ...newReleases,
    ].filter((m: any) => m.trailerUrl || m.hlsUrl || m.videoUrl);

    const bannerSlides = heroContent.filter((h: any) => h.isBanner || h.poster || h.backdrop);
    const withVideo = heroContent.filter((h: any) => h.trailerUrl || h.hlsUrl || h.videoUrl);

    if (bannerSlides.length > 0) {
      // Prefer banners first; append extra playable movies if needed
      const ids = new Set(bannerSlides.map((h: any) => h.id));
      heroContent = [
        ...bannerSlides,
        ...playablePool.filter((m: any) => !ids.has(m.id)).slice(0, Math.max(0, 8 - bannerSlides.length)),
      ];
    } else if (withVideo.length === 0 && playablePool.length > 0) {
      heroContent = playablePool.slice(0, 8);
    } else if (withVideo.length < 3 && playablePool.length > 0) {
      const ids = new Set(withVideo.map((h: any) => h.id));
      heroContent = [
        ...withVideo,
        ...playablePool.filter((m: any) => !ids.has(m.id)).slice(0, 8 - withVideo.length),
      ];
    } else {
      heroContent = withVideo.length ? withVideo : heroContent;
    }

    const responseData = {
      success: true,
      data: {
        heroContent,
        trendingNow,
        newReleases,
        topRated,
        actionMovies,
        dramaMovies,
      }
    };

    homeCacheData = responseData;
    homeCacheTime = Date.now();

    return reply.send(responseData);

  } catch (error: any) {
    logger.error({ error }, 'Error fetching web home API data');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const getWebAllContent = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const movies = await MovieModel.find({ status: 'published' }).lean();
    return reply.send({ success: true, data: { movies } });
  } catch (error: any) {
    logger.error({ error }, 'Error fetching web all content API data');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
