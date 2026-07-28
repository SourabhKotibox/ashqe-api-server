import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { GenreModel } from '../models/Genre';
import { logger } from '../lib/logger';

// Standardized mapping for website ContentItem
const mapContentItem = (item: any) => {
  let badge;
  if (item.featured && item.trending) badge = 'EXCLUSIVE';
  else if (item.trending) badge = 'TRENDING';
  else if (item.featured) badge = 'TOP';
  else if (item.isNewContent) badge = 'NEW';
  else if (item.views > 1000) badge = 'HOT';

  return {
    id: item._id.toString(),
    title: item.title,
    poster: item.posterImage || item.thumbnail || '',
    backdrop: item.bannerImage || item.thumbnail || '',
    type: 'movie',
    contentType: 'movie',
    year: item.year?.toString() || new Date(item.createdAt).getFullYear().toString(),
    duration: item.duration ? `${item.duration}m` : '120m',
    imdbRating: item.imdbRating?.toString() || (item.rating || '8.0'),
    ageRating: item.ageRating ? `${item.ageRating}+` : 'U/A 13+',
    description: item.shortDescription || item.description || '',
    language: item.languages && item.languages.length > 0 ? 'Multi' : 'EN',
    badge,
    genres: (item.genres || []).map((g: any) => g?.name || g),
  };
};

const browseCache = new Map<string, { time: number; data: any }>();
const BROWSE_CACHE_TTL = 30000; // 30 seconds

export const getWebBrowse = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { type?: string; genre?: string; page?: string; limit?: string; search?: string; section?: string };
    
    // Check Cache
    const cacheKey = JSON.stringify(query);
    const now = Date.now();
    if (browseCache.has(cacheKey)) {
      const cached = browseCache.get(cacheKey)!;
      if (now - cached.time < BROWSE_CACHE_TTL) {
        return reply.send(cached.data);
      }
      browseCache.delete(cacheKey); // clear expired
    }

    const genreName = query.genre;
    const searchTerm = query.search?.trim();
    const section = query.section;
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    let filter: any = { status: 'published' };

    if (searchTerm) {
      filter.$or = [
        { title: new RegExp(searchTerm, 'i') },
        { description: new RegExp(searchTerm, 'i') },
        { tags: new RegExp(searchTerm, 'i') },
      ];
    }

    // Handle genre filtering
    if (genreName && genreName.toLowerCase() !== 'all') {
      const genre = await GenreModel.findOne({ name: { $regex: new RegExp(`^${genreName}$`, 'i') } }).select('_id').lean();
      if (genre) {
        filter.genres = genre._id;
      } else {
        return reply.send({
          success: true,
          data: { items: [], pagination: { total: 0, page, limit, totalPages: 0 } },
        });
      }
    }

    let sort: any = { createdAt: -1 };
    if (section === 'trending') {
      sort = { views: -1, createdAt: -1 };
      filter.trending = true;
    } else if (section === 'new') {
      sort = { createdAt: -1 };
      filter.isNewContent = true;
    } else if (section === 'top-rated') {
      sort = { imdbRating: -1, views: -1 };
    }

    const selectFields = 'title description shortDescription thumbnail bannerImage posterImage year rating ageRating duration imdbRating featured trending isNewContent views genres languages createdAt';

    const [rawItems, total] = await Promise.all([
      MovieModel.find(filter).sort(sort).skip(skip).limit(limit).select(selectFields).populate('genres', 'name').lean(),
      MovieModel.countDocuments(filter)
    ]);

    const items = rawItems.map((item: any) => mapContentItem(item));

    const responseData = {
      success: true,
      data: {
        items,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    };

    browseCache.set(cacheKey, { time: Date.now(), data: responseData });

    return reply.send(responseData);

  } catch (error: any) {
    logger.error({ error }, 'Error fetching web browse API data');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
