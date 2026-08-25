import type { FastifyRequest, FastifyReply } from 'fastify';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';
import { SectionModel } from '../models/Section';
import { logger } from '../lib/logger';
import { sendApprovalEmail, sendRejectionEmail } from '../lib/email';

const syncSections = async (contentIdStr: string, sections: string[] | undefined) => {
  await SectionModel.updateMany(
    { manualContentIds: contentIdStr },
    { $pull: { manualContentIds: contentIdStr } }
  );
  if (sections && Array.isArray(sections) && sections.length > 0) {
    await SectionModel.updateMany(
      { _id: { $in: sections } },
      { $addToSet: { manualContentIds: contentIdStr } }
    );
  }
};

// Get all tvShows with pagination and filtering
export const getAllTVShows = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      search?: string;
      status?: string;
      genre?: string;
      category?: string;
      language?: string;
      featured?: string;
      trending?: string;
      year?: string;
    };

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    const filter: any = {};

    if (query.status) filter.status = query.status;
    if (query.featured === 'true') filter.featured = true;
    if (query.trending === 'true') filter.trending = true;
    if (query.year) filter.year = Number(query.year);
    if (query.genre) filter.genres = query.genre;
    if (query.category) filter.categories = query.category;
    if (query.language) filter.languages = query.language;

    if (query.search) {
      filter.$or = [
        { title: new RegExp(query.search, 'i') },
        { description: new RegExp(query.search, 'i') },
        { tags: new RegExp(query.search, 'i') },
      ];
    }

    const [tvShows, total] = await Promise.all([
      TVShowModel.find(filter)
        .populate('genres', 'name image')
        .populate('categories', 'name thumbnail')
        .populate('languages', 'name')
        .populate('subtitleLanguages', 'name')
        .populate('audioLanguages', 'name')
        .populate('cast.actor', 'name image')
        .populate('crew.director', 'name')
        .populate('subtitles.language', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      TVShowModel.countDocuments(filter),
    ]);

    const tvShowsWithId = tvShows.map((tvShow) => ({
      ...tvShow,
        episodeCount,
      id: tvShow._id?.toString(),
    }));

    return reply.send({
      success: true,
      data: tvShowsWithId,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting all tvShows');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get single tvShow by ID
export const getTVShowById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    // Sync HLS qualities from disk if they exist but are missing in DB
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id);
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities for tvShow');
    }

    const episodeCount = await EpisodeModel.countDocuments({ tvShowId: id });
    const tvShow = await TVShowModel.findById(id)
      .populate('genres', 'name image')
      .populate('categories', 'name thumbnail bannerImage')
      .populate('languages', 'name')
      .populate('subtitleLanguages', 'name')
      .populate('audioLanguages', 'name')
      .populate('cast.actor', 'name image designation')
      .populate('crew.director', 'name designation')
      .populate('subtitles.language', 'name code')
      .lean();

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    return reply.send({
      success: true,
      data: {
        ...tvShow,
        id: tvShow._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting tvShow by ID');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Create new tvShow
export const createTVShow = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as any;

    // Reject ephemeral browser blob: URLs (they only work in the tab that created them)
    const blobFields = ['hlsUrl', 'videoUrl', 'sourceVideoUrl', 'trailerUrl', 'thumbnail', 'posterImage', 'bannerImage'] as const;
    for (const field of blobFields) {
      if (typeof body[field] === 'string' && body[field].startsWith('blob:')) {
        return reply.status(400).send({
          success: false,
          error: `Invalid ${field}: browser blob URLs cannot be saved. Wait for upload to finish and select the file from Media Library.`,
        });
      }
    }

    // Check if the uploaded video is a raw MP4 or local media file
    const isLocalPath = body.hlsUrl && !body.hlsUrl.startsWith('http://') && !body.hlsUrl.startsWith('https://');
    const isRawLocalVideo = isLocalPath && !body.hlsUrl.endsWith('.m3u8');
    if (isRawLocalVideo) {
      body.processingStatus = 'queued';
    } else {
      body.processingStatus = 'ready';
    }

    // Keep full-tvShow progressive source separate from trailer (offline downloads use this)
    const mainVideo = typeof body.hlsUrl === 'string' ? body.hlsUrl.trim() : '';
    const trailer = typeof body.trailerUrl === 'string' ? body.trailerUrl.trim() : '';
    if (mainVideo && !mainVideo.startsWith('blob:') && mainVideo !== trailer && !mainVideo.includes('.m3u8')) {
      body.sourceVideoUrl = mainVideo;
      body.videoUrl = mainVideo;
    }
    // Never allow videoUrl/sourceVideoUrl to silently equal trailer
    if (trailer && body.videoUrl === trailer) delete body.videoUrl;
    if (trailer && body.sourceVideoUrl === trailer) delete body.sourceVideoUrl;

    const tvShow = await TVShowModel.create(body);
    await syncSections(tvShow._id.toString(), body.sections);

    // Trigger push notification to all users
    try {
      const { NotificationModel } = await import('../models/Notification');
      await NotificationModel.create({
        title: 'New TVShow Added! 🍿',
        body: `Watch ${tvShow.title} now on the app!`,
        type: 'content_release',
        targetAudience: 'all',
        contentId: tvShow._id,
        status: 'sent',
        metrics: { targetCount: 0, sentCount: 1, openedCount: 0, clickedCount: 0 },
        sentAt: new Date(),
        priority: 'high'
      });
    } catch (notifErr) {
      logger.error({ notifErr }, 'Error sending new tvShow notification');
    }

    if (isRawLocalVideo) {
      import('../services/videoProcessor').then(({ processTVShowInBackground }) => {
        processTVShowInBackground(tvShow._id, body.hlsUrl);
      });
    }

    return reply.status(201).send({
      success: true,
      data: {
        ...tvShow.toObject(),
        id: tvShow._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error creating tvShow');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Update tvShow
export const updateTVShow = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const blobFields = ['hlsUrl', 'videoUrl', 'sourceVideoUrl', 'trailerUrl', 'thumbnail', 'posterImage', 'bannerImage'] as const;
    for (const field of blobFields) {
      if (typeof body[field] === 'string' && body[field].startsWith('blob:')) {
        return reply.status(400).send({
          success: false,
          error: `Invalid ${field}: browser blob URLs cannot be saved. Wait for upload to finish and select the file from Media Library.`,
        });
      }
    }

    const existingTVShow = await TVShowModel.findById(id).lean();
    if (!existingTVShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    // Check if the hlsUrl has changed to a new raw MP4
    const isLocalPath = body.hlsUrl && !body.hlsUrl.startsWith('http://') && !body.hlsUrl.startsWith('https://');
    const isRawLocalVideo = isLocalPath && !body.hlsUrl.endsWith('.m3u8') && body.hlsUrl !== (existingTVShow as any).hlsUrl;
    if (isRawLocalVideo) {
      body.processingStatus = 'queued';
    } else if (body.hlsUrl) {
      body.processingStatus = 'ready';
    }

    // Keep full-tvShow progressive source separate from trailer
    const mainVideo = typeof body.hlsUrl === 'string' ? body.hlsUrl.trim() : '';
    const trailer = typeof body.trailerUrl === 'string' ? body.trailerUrl.trim() : String((existingTVShow as any).trailerUrl || '');
    if (mainVideo && !mainVideo.startsWith('blob:') && mainVideo !== trailer && !mainVideo.includes('.m3u8')) {
      body.sourceVideoUrl = mainVideo;
      body.videoUrl = mainVideo;
    }
    if (trailer && body.videoUrl === trailer) delete body.videoUrl;
    if (trailer && body.sourceVideoUrl === trailer) delete body.sourceVideoUrl;

    const tvShow = await TVShowModel.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    if (body.sections !== undefined) {
      await syncSections(id, body.sections);
    }

    if (isRawLocalVideo) {
      import('../services/videoProcessor').then(({ processTVShowInBackground }) => {
        processTVShowInBackground(tvShow._id, body.hlsUrl);
      });
    }

    // Sync HLS qualities from disk if they exist but were not submitted/saved properly in update form
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id);
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities during tvShow update');
    }

    const updatedTVShow = await TVShowModel.findById(id)
      .populate('genres', 'name image')
      .populate('categories', 'name thumbnail')
      .populate('languages', 'name')
      .populate('subtitleLanguages', 'name')
      .populate('audioLanguages', 'name')
      .populate('cast.actor', 'name image')
      .populate('crew.director', 'name')
      .populate('subtitles.language', 'name code')
      .lean();

    return reply.send({
      success: true,
      data: {
        ...updatedTVShow,
        id: updatedTVShow?._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating tvShow');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Approve tvShow
export const approveTVShow = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const currentUser = (request as any).user;

    const tvShow = await TVShowModel.findByIdAndUpdate(
      id,
      {
        status: 'published',
        approvedBy: currentUser?.id,
        approvedAt: new Date(),
        rejectionReason: undefined,
      },
      { new: true }
    ).populate('createdBy', 'name email');

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    // Send approval email to creator
    if (tvShow.createdBy) {
      const creator = tvShow.createdBy as any;
      if (creator.email) {
        await sendApprovalEmail(
          creator.email,
          creator.name || 'User',
          'TVShow',
          tvShow.title
        );
      }
    }

    return reply.send({ success: true, data: tvShow });
  } catch (error: any) {
    logger.error({ error }, 'Error approving tvShow');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Reject tvShow
export const rejectTVShow = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };
    const currentUser = (request as any).user;

    const tvShow = await TVShowModel.findByIdAndUpdate(
      id,
      {
        status: 'rejected',
        rejectedBy: currentUser?.id,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
      { new: true }
    ).populate('createdBy', 'name email');

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    // Send rejection email to creator
    if (tvShow.createdBy) {
      const creator = tvShow.createdBy as any;
      if (creator.email) {
        await sendRejectionEmail(
          creator.email,
          creator.name || 'User',
          'TVShow',
          tvShow.title,
          reason || 'No reason provided'
        );
      }
    }

    return reply.send({ success: true, data: tvShow });
  } catch (error: any) {
    logger.error({ error }, 'Error rejecting tvShow');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get pending approvals
export const getPendingApprovals = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      type?: string;
    };

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    const filter: any = { status: 'moderation' };

    const [tvShows, total] = await Promise.all([
      TVShowModel.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      TVShowModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: tvShows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting pending approvals');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get tvShow by ID
export const deleteTVShow = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const tvShow = await TVShowModel.findByIdAndDelete(id);
    if (tvShow) await EpisodeModel.deleteMany({ tvShowId: id });

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    await syncSections(id, []);

    return reply.send({ success: true, message: 'TVShow deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting tvShow');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Update tvShow status
export const updateTVShowStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const { status, rejectionReason } = request.body as {
      status: 'published' | 'draft' | 'processing' | 'moderation' | 'rejected';
      rejectionReason?: string;
    };

    const updateData: any = { status };
    if (rejectionReason && status === 'rejected') {
      updateData.rejectionReason = rejectionReason;
    }

    const tvShow = await TVShowModel.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).lean();

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    return reply.send({
      success: true,
      data: {
        ...tvShow,
        id: tvShow._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating tvShow status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Toggle featured status
export const toggleFeatured = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const tvShow = await TVShowModel.findById(id).lean();

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    const updatedTVShow = await TVShowModel.findByIdAndUpdate(
      id,
      { $set: { featured: !tvShow.featured } },
      { new: true }
    ).lean();

    return reply.send({
      success: true,
      data: {
        ...updatedTVShow,
        id: updatedTVShow._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error toggling featured status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Toggle trending status
export const toggleTrending = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const tvShow = await TVShowModel.findById(id).lean();

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    const updatedTVShow = await TVShowModel.findByIdAndUpdate(
      id,
      { $set: { trending: !tvShow.trending } },
      { new: true }
    ).lean();

    return reply.send({
      success: true,
      data: {
        ...updatedTVShow,
        id: updatedTVShow._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error toggling trending status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get tvShow HLS processing status — lightweight polling endpoint for admin panel
export const getTVShowProcessingStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const tvShow = await TVShowModel.findById(id)
      .select('processingStatus processingError hlsUrl videoQualities status title')
      .lean();

    if (!tvShow) {
      return reply.status(404).send({ success: false, error: 'TVShow not found' });
    }

    const qualities = (tvShow.videoQualities || []).map((q: any) => ({
      quality: q.quality,
      url:     q.url,
      size:    q.size,
    }));

    return reply.send({
      success: true,
      data: {
        id:               tvShow._id?.toString(),
        title:            tvShow.title,
        status:           tvShow.status,
        processingStatus: tvShow.processingStatus || 'queued',
        processingError:  tvShow.processingError || null,
        hlsUrl:           tvShow.hlsUrl || null,
        availableQualities: qualities,
        qualityCount:     qualities.length,
        isReady:          tvShow.processingStatus === 'ready',
        isFailed:         tvShow.processingStatus === 'failed',
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting tvShow processing status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};
