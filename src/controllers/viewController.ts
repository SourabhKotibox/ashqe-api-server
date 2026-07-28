import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { UserViewModel } from '../models/UserView';
import { logger } from '../lib/logger';

export const recordView = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    // ── 1. Verify JWT (required for views log unique check) ──────────────────
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

    // ── 2. Parse Params ──────────────────────────────────────────────────────
    const { contentId } = request.params as { contentId: string };

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return reply.status(400).send({ success: false, message: 'Invalid contentId.' });
    }

    // ── 3. Verify Content Exists ─────────────────────────────────────────────
    const content = await MovieModel.findById(contentId).select('views').lean();
    if (!content) {
      return reply.status(404).send({ success: false, message: 'Content not found.' });
    }

    // ── 4. Check & record view ───────────────────────────────────────────────
    const existingView = await UserViewModel.findOne({ userId: userObjectId, contentId });

    if (existingView) {
      // User has already viewed this content. Do NOT increment views.
      const c = await MovieModel.findById(contentId).select('views').lean();
      return reply.send({
        success: true,
        message: 'View already recorded for this user (views count unchanged).',
        data: {
          viewsCount: c?.views ?? 0,
          viewRecorded: false,
        }
      });
    }

    // New view! Create log and increment views count in the DB.
    await UserViewModel.create({
      userId: userObjectId,
      contentId,
      contentModelType: 'Movie'
    });

    const updated = await MovieModel.findByIdAndUpdate(
      contentId,
      { $inc: { views: 1 } },
      { new: true }
    ).select('views').lean();

    logger.info({ userId, contentId }, 'User recorded a new view');

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
