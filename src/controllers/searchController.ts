import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { GenreModel } from '../models/Genre';
import { logger } from '../lib/logger';
import mongoose from 'mongoose';

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
const mapSearchItem = (item: any) => ({
  id: item._id.toString(),
  title: item.title,
  description: item.description,
  shortDescription: item.shortDescription,
  thumbnail: item.thumbnail,
  bannerImage: item.bannerImage,
  posterImage: item.posterImage || item.thumbnail || null,
  type: 'movie',
  contentPlan: item.planRequired || 'free',
  views: item.views || 0,
  rating: item.rating,
  year: item.year,
  duration: item.duration,
  status: item.status,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

export const getRecommendations = async (preferredLanguage: string) => {
  // Resolve language ID for movies
  let targetLanguageId: mongoose.Types.ObjectId | null = null;
  if (preferredLanguage) {
    const langDoc = await LanguageModel.findOne({ name: new RegExp(`^${preferredLanguage}$`, 'i') }).lean();
    if (langDoc) {
      targetLanguageId = langDoc._id as mongoose.Types.ObjectId;
    }
  }

  // Fetch recommended movies (language filtered)
  const movieFilter: any = { status: 'published' };
  if (targetLanguageId) movieFilter.languages = targetLanguageId;
  const recMovies = await MovieModel.find(movieFilter)
    .sort({ views: -1, createdAt: -1 })
    .limit(12)
    .lean();

  const recommendationsList = recMovies.map(m => mapSearchItem(m));

  // Sort recommendations by views to make them look uniform
  recommendationsList.sort((a, b) => b.views - a.views);

  return recommendationsList.slice(0, 12);
};

export const getSearchPage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { q?: string };
    const searchTerm = query.q?.trim() || '';

    const userId = getOptionalUserId(request);

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

    if (!searchTerm) {
      // 1. Initial State: Return Trending Searches & Recommended For You

      // A. Fetch Trending Searches (top viewed/liked movie titles)
      const popularMovies = await MovieModel.find({ status: 'published' })
        .sort({ views: -1, likes: -1 })
        .limit(6)
        .select('title')
        .lean();

      // Extract unique titles for trending searches
      const trendingSearchesSet = new Set<string>();
      popularMovies.forEach(m => trendingSearchesSet.add(m.title));
      const trendingSearches = Array.from(trendingSearchesSet).slice(0, 6);

      const recommendations = await getRecommendations(preferredLanguage);

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

    // 2. Determine type matches
    const isMovieSearch = /movie/i.test(searchTerm);

    // Build query conditions
    const movieQueryOptions: any[] = [
      { title: regex },
      { originalTitle: regex },
      { description: regex },
      { shortDescription: regex },
      { tags: regex }
    ];
    if (genreIds.length > 0) movieQueryOptions.push({ genres: { $in: genreIds } });

    // If explicit type is searched, we don't need text match if they just typed the type.
    if (isMovieSearch) movieQueryOptions.push({}); // Match any movie

    const matchedMovies = await MovieModel.find({
      status: 'published',
      ...(targetLanguageId ? { languages: targetLanguageId } : {}),
      $or: movieQueryOptions
    })
      .limit(20)
      .lean();

    const results = matchedMovies.map(m => mapSearchItem(m));

    // Sort search results by views/popularity
    results.sort((a, b) => b.views - a.views);

    if (results.length === 0) {
      const recommendations = await getRecommendations(preferredLanguage);
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
