import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserWishlistModel } from '../models/UserWishlist';
import { MovieModel } from '../models/Movie';
import { UserModel } from '../models/User';
import { logger } from '../lib/logger';

export const toggleWishlist = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = (request.params || {}) as { contentId?: string };
    const body = (request.body || {}) as { contentId?: string; contentType?: string; type?: string; profileId?: string };

    const contentId = body.contentId || params.contentId;
    const rawType = body.contentType || body.type;
    const profileId = body.profileId || null;

    if (!contentId) {
      return reply.status(400).send({ success: false, message: 'contentId is required' });
    }

    if (!rawType) {
      return reply.status(400).send({ success: false, message: 'type or contentType is required' });
    }

    const contentModelType = 'Movie';

    // Fallback or explicit auth extraction
    const user = (request as any).user;
    if (!user || !user.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = user.id;
    // Cast userId string to ObjectId for all DB queries
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // Verify content exists
    const content = await MovieModel.findById(contentId).select('_id');
    if (!content) {
      return reply.status(404).send({ success: false, message: 'Content not found' });
    }

    const existingWishlist = await UserWishlistModel.findOne({ userId: userObjectId, contentId, profileId });

    if (existingWishlist) {
      // Remove from wishlist
      await UserWishlistModel.deleteOne({ _id: existingWishlist._id });
      await UserModel.findByIdAndUpdate(userObjectId, { $inc: { watchlistCount: -1 } });

      return reply.send({
        success: true,
        message: 'Removed from wishlist',
        isWishlisted: false,
        data: {
          id: existingWishlist._id.toString(),
          type: rawType
        }
      });
    } else {
      // Add to wishlist
      const newWishlist = await UserWishlistModel.create({
        userId: userObjectId,
        contentId,
        contentModelType,
        profileId,
      });
      await UserModel.findByIdAndUpdate(userObjectId, { $inc: { watchlistCount: 1 } });
      
      return reply.send({
        success: true,
        message: 'Added to wishlist',
        isWishlisted: true,
        data: {
          id: newWishlist._id.toString(),
          type: rawType
        }
      });
    }
  } catch (error: any) {
    logger.error({ error }, 'Error toggling wishlist');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const getWishlist = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = (request as any).user;
    if (!user || !user.id) {
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const userId = user.id;
    // Cast userId string to ObjectId for all DB queries
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const query = request.query as { page?: string; limit?: string; profileId?: string };
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;
    const profileId = query.profileId || null;

    const [wishlistItems, total] = await Promise.all([
      UserWishlistModel.find({ userId: userObjectId, profileId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      UserWishlistModel.countDocuments({ userId: userObjectId, profileId }),
    ]);

    // Fetch actual content for the wishlist items
    const selectFields = 'title description shortDescription thumbnail bannerImage posterImage year rating ageRating duration imdbRating type createdAt';

    const movieIds = wishlistItems.map(i => i.contentId);

    const movies = movieIds.length > 0
      ? await MovieModel.find({ _id: { $in: movieIds } }).select(selectFields).lean()
      : [];

    const movieMap = new Map(movies.map(m => [m._id.toString(), m]));

    const mappedItems = wishlistItems.map(item => {
      const c: any = movieMap.get(item.contentId.toString());
      if (!c) return null;

      return {
        id: c._id.toString(),
        contentId: item.contentId.toString(),
        title: c.title,
        poster: c.posterImage || c.thumbnail || '',
        backdrop: c.bannerImage || c.thumbnail || '',
        type: 'movie',
        contentType: 'movie',
        year: c.year?.toString() || new Date(c.createdAt).getFullYear().toString(),
        duration: c.duration ? `${c.duration}m` : '120m',
        imdbRating: c.imdbRating?.toString() || (c.rating || '8.0'),
        ageRating: c.ageRating ? `${c.ageRating}+` : 'U/A 13+',
        description: c.shortDescription || c.description || '',
        language: c.languages && c.languages.length > 0 ? 'Multi' : 'EN',
        genres: (c.genres || []).map((g: any) => g?.name || g),
        addedAt: item.createdAt
      };
    }).filter(Boolean);

    return reply.send({
      success: true,
      data: {
        items: mappedItems,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });

  } catch (error: any) {
    logger.error({ error }, 'Error fetching wishlist');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
