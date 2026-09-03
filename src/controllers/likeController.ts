import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserLikeModel } from '../models/UserLike';
import { logger } from '../lib/logger';
import { resolveContent } from '../lib/contentResolver';

// POST /api/like/:contentId
// Header: Authorization: Bearer <token>
export const toggleLike = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
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

    const { contentId } = request.params as { contentId: string };
    const body = (request.body || {}) as { contentType?: string };

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({
        success: false,
        message: 'Invalid contentId.',
      });
    }

    const resolved = await resolveContent(contentId, body.contentType);
    if (!resolved) {
      return reply.status(404).send({
        success: false,
        message: 'Content not found.',
      });
    }

    const { type, model } = resolved;
    const existingLike = await UserLikeModel.findOne({ userId: userObjectId, contentId });

    if (existingLike) {
      await UserLikeModel.deleteOne({ _id: existingLike._id });
      const updated = await (model as any).findByIdAndUpdate(
        contentId,
        { $inc: { likes: -1 } },
        { new: true }
      ).select('likes').lean();
      const likeCount = Math.max(0, updated?.likes ?? 0);

      logger.info({ userId, contentId, type }, 'User unliked content');

      return reply.send({
        success: true,
        message: 'Video unliked successfully',
        data: {
          likeCount,
          isLikedByUser: false,
        },
      });
    }

    await UserLikeModel.create({ userId: userObjectId, contentId, contentModelType: type });
    const updated = await (model as any).findByIdAndUpdate(
      contentId,
      { $inc: { likes: 1 } },
      { new: true }
    ).select('likes').lean();
    const likeCount = updated?.likes ?? 0;

    logger.info({ userId, contentId, type }, 'User liked content');

    return reply.send({
      success: true,
      message: 'Video liked successfully',
      data: {
        likeCount,
        isLikedByUser: true,
      },
    });
  } catch (error: any) {
    logger.error(error, 'Error toggling like');
    return reply.status(500).send({
      success: false,
      message: 'Failed to process like.',
      error: error.message,
    });
  }
};
