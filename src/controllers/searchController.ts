import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { GenreModel } from '../models/Genre';
import { logger } from '../lib/logger';
import mongoose from 'mongoose';
import {
  isContentLocked,
  resolveEffectiveUserPlan,
} from '../lib/subscriptionAccess';

// Helper: try to extract userId from JWT (optional auth)
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

// Unified item mapper
const mapSearchItem = (item: any, userPlan = 'free', type = 'movie') => {
  const contentPlan = item.planRequired || 'free';
  return {
    id: item._id.toString(),
    title: item.title,
    description: item.description,
    shortDescription: item.shortDescription,
    thumbnail: item.thumbnail,
    bannerImage: item.bannerImage,
    posterImage: item.posterImage || item.thumbnail || null,
    type: type,
    contentPlan,
    planRequired: contentPlan,
    isLocked: isContentLocked(contentPlan, userPlan),
    views: item.views || 0,
    rating: item.rating,
    year: item.year,
    duration: item.duration,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

export const getRecommendations = async (preferredLanguage: string, userPlan = 'free') => {
  // Resolve language ID for movies
  let targetLanguageId: mongoose.Types.ObjectId | null = null;
  if (preferredLanguage) {
    const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
    if (langDoc) {
      targetLanguageId = langDoc._id as mongoose.Types.ObjectId;
    }
  }

  // Fetch recommended movies and shows (language filtered)
  const filter: any = { status: 'published' };
  if (targetLanguageId) filter.languages = targetLanguageId;

  const [recMovies, recShows] = await Promise.all([
    MovieModel.find(filter).sort({ views: -1, createdAt: -1 }).limit(12).lean(),
    TVShowModel.find(filter).sort({ views: -1, createdAt: -1 }).limit(12).lean(),
  ]);

  const recommendationsList = [
    ...recMovies.map(m => mapSearchItem(m, userPlan, 'movie')),
    ...recShows.map(s => mapSearchItem(s, userPlan, 'tvShow'))
  ];

  // Sort recommendations by views to make them look uniform
  recommendationsList.sort((a, b) => b.views - a.views);

  return recommendationsList.slice(0, 12);
};

export const getSearchPage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { q?: string };
    const searchTerm = query.q?.trim() || '';

    const userId = getOptionalUserId(request);

    // Get user's preferred language + REAL active plan
    let preferredLanguage = 'Hindi';
    let userPlan = 'free';
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

    if (!searchTerm) {
      // 1. Initial State: Return Trending Searches & Recommended For You

      // A. Fetch Trending Searches (top viewed/liked movie and show titles)
      const [popularMovies, popularShows] = await Promise.all([
        MovieModel.find({ status: 'published' })
          .sort({ views: -1, likes: -1 })
          .limit(6)
          .select('title views likes')
          .lean(),
        TVShowModel.find({ status: 'published' })
          .sort({ views: -1, likes: -1 })
          .limit(6)
          .select('title views likes')
          .lean()
      ]);

      const allPopular = [...popularMovies, ...popularShows].sort((a: any, b: any) => {
        return (b.views || 0) - (a.views || 0);
      });

      // Extract unique titles for trending searches
      const trendingSearchesSet = new Set<string>();
      allPopular.forEach(m => trendingSearchesSet.add(m.title));
      const trendingSearches = Array.from(trendingSearchesSet).slice(0, 6);

      const recommendations = await getRecommendations(preferredLanguage, userPlan);

      return reply.send({
        success: true,
        data: {
          isQueryEmpty: true,
          trendingSearches,
          recommendations,
        }
      });
    }

    let targetLanguageId: mongoose.Types.ObjectId | null = null;
    if (preferredLanguage) {
      const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
      if (langDoc) {
        targetLanguageId = langDoc._id as mongoose.Types.ObjectId;
      }
    }

    // 2. Active Query State: Perform Search

    const regex = new RegExp(searchTerm, 'i');

    // 1. Check for genre matches
    const matchedGenres = await GenreModel.find({ name: regex }).select('_id').lean();
    const genreIds = matchedGenres.map(g => g._id);

    // Build query conditions
    const queryOptions: any[] = [
      { title: regex },
      { originalTitle: regex },
      { description: regex },
      { shortDescription: regex },
      { tags: regex }
    ];
    if (genreIds.length > 0) queryOptions.push({ genres: { $in: genreIds } });

    const baseFilter = {
      status: 'published',
      ...(targetLanguageId ? { languages: targetLanguageId } : {}),
      $or: queryOptions
    };

    const isMovieSearch = /movie/i.test(searchTerm);
    const isShowSearch = /show|series/i.test(searchTerm);

    // If explicit type is searched, match any item of that type
    const movieFilter = isMovieSearch ? { ...baseFilter, $or: [{}] } : baseFilter;
    const showFilter = isShowSearch ? { ...baseFilter, $or: [{}] } : baseFilter;

    let matchedMovies: any[] = [];
    let matchedShows: any[] = [];

    if (!isShowSearch) {
      matchedMovies = await MovieModel.find(movieFilter).limit(20).lean();
    }
    if (!isMovieSearch) {
      matchedShows = await TVShowModel.find(showFilter).limit(20).lean();
    }

    const results = [
      ...matchedMovies.map(m => mapSearchItem(m, userPlan, 'movie')),
      ...matchedShows.map(s => mapSearchItem(s, userPlan, 'tvShow'))
    ];

    // Sort search results by views/popularity
    results.sort((a, b) => b.views - a.views);

    if (results.length === 0) {
      const recommendations = await getRecommendations(preferredLanguage, userPlan);
      return reply.send({
        success: true,
        data: {
          isQueryEmpty: false,
          results: [],
          message: 'No match found',
          recommendations
        }
      });
    }

    return reply.send({
      success: true,
      data: {
        isQueryEmpty: false,
        results
      }
    });

  } catch (error: any) {
    logger.error({ error }, 'Error during search operation');
    return reply.status(500).send({
      success: false,
      message: 'Failed to process search request',
      error: error.message
    });
  }
};
