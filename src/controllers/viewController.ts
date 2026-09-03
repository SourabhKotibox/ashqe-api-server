import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { UserViewModel } from '../models/UserView';
import { TVShowModel } from '../models/TVShow';
import { logger } from '../lib/logger';
import { resolveContent } from '../lib/contentResolver';

export const recordView = async (request: FastifyRequest, reply: FastifyReply) => {
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
        message: 'Authentication required. Please login to watch content.',
      });
    }

    const { contentId } = request.params as { contentId: string };
    const body = (request.body || {}) as { contentType?: string; episodeId?: string };
    const targetId = body.episodeId || contentId;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId.' });
    }

    const resolved = await resolveContent(targetId, body.episodeId ? 'episode' : body.contentType);
    if (!resolved) {
      return reply.status(404).send({ success: false, message: 'Content not found.' });
    }

    const existingView = await UserViewModel.findOne({ userId: userObjectId, contentId: targetId });

    if (existingView) {
      const c = await (resolved.model as any).findById(targetId).select('views').lean();
      return reply.send({
        success: true,
        message: 'View already recorded for this user (views count unchanged).',
        data: {
          viewsCount: c?.views ?? 0,
          viewRecorded: false,
        }
      });
    }

    await UserViewModel.create({
      userId: userObjectId,
      contentId: targetId,
      contentModelType: resolved.type,
    });

    const updated = await (resolved.model as any).findByIdAndUpdate(
      targetId,
      { $inc: { views: 1 } },
      { new: true }
    ).select('views tvShowId').lean();

    // Also increment parent series views when an episode is watched
    if (resolved.type === 'Episode' && updated?.tvShowId) {
      await TVShowModel.findByIdAndUpdate(updated.tvShowId, { $inc: { views: 1 } });
    } else if (resolved.type !== 'Episode' && body.episodeId && mongoose.Types.ObjectId.isValid(contentId) && contentId !== targetId) {
      await TVShowModel.findByIdAndUpdate(contentId, { $inc: { views: 1 } }).catch(() => null);
    }

    logger.info({ userId, contentId: targetId, type: resolved.type }, 'User recorded a new view');

    return reply.send({
      success: true,
      message: 'View recorded successfully.',
      data: {
        viewsCount: updated?.views ?? 0,
        viewRecorded: true,
      }
    });
  } catch (error: any) {
    logger.error(error, 'Error recording view');
    return reply.status(500).send({
      success: false,
      message: 'Failed to record view.',
      error: error.message,
    });
  }
};
