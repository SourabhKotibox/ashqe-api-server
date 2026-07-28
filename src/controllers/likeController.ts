import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { UserLikeModel } from '../models/UserLike';
import { logger } from '../lib/logger';

// POST /api/like/:contentId
// Header: Authorization: Bearer <token>
export const toggleLike = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    // ── 1. Verify JWT (required) ─────────────────────────────────────────────
    let userId: string;
    let userObjectId: mongoose.Types.ObjectId;
    try {
      await request.jwtVerify();
      userId = (request.user as any).id;
      userObjectId = new mongoose.Types.ObjectId(userId);
    } catch {
      return reply.status(401).send({
        success: false,
        message: 'Authentication required. Please login to like content.',
      });
    }

    // ── 2. Parse params ──────────────────────────────────────────────────────
    const { contentId } = request.params as { contentId: string };

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({
        success: false,
        message: 'Invalid contentId.',
      });
    }

    // ── 3. Verify movie exists ───────────────────────────────────────────────
    const movie = await MovieModel.findById(contentId).select('likes').lean();
    if (!movie) {
      return reply.status(404).send({
        success: false,
        message: 'Content not found.',
      });
    }

    // ── 4. Toggle like ───────────────────────────────────────────────────────
    const existingLike = await UserLikeModel.findOne({ userId: userObjectId, contentId });

    if (existingLike) {
      // Already liked → UNLIKE
      await UserLikeModel.deleteOne({ _id: existingLike._id });
      const updated = await MovieModel.findByIdAndUpdate(
        contentId,
        { $inc: { likes: -1 } },
        { new: true }
      ).select('likes').lean();
      const likeCount = Math.max(0, updated?.likes ?? 0);

      logger.info({ userId, contentId }, 'User unliked content');

      return reply.send({
        success: true,
        message: 'Video unliked successfully',
        data: {
          likeCount,
          isLikedByUser: false,
        },
      });
    } else {
      // Not liked → LIKE
      await UserLikeModel.create({ userId: userObjectId, contentId, contentModelType: 'Movie' });
      const updated = await MovieModel.findByIdAndUpdate(
        contentId,
        { $inc: { likes: 1 } },
        { new: true }
      ).select('likes').lean();
      const likeCount = updated?.likes ?? 0;

      logger.info({ userId, contentId }, 'User liked content');

      return reply.send({
        success: true,
        message: 'Video liked successfully',
        data: {
          likeCount,
          isLikedByUser: true,
        },
      });
    }
  } catch (error: any) {
    logger.error(error, 'Error toggling like');
    return reply.status(500).send({
      success: false,
      message: 'Failed to process like.',
      error: error.message,
    });
  }
};
