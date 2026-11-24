import type { FastifyRequest, FastifyReply } from 'fastify';
import { MovieModel } from '../models/Movie';
import { SectionModel } from '../models/Section';
import { logger } from '../lib/logger';
import { sendApprovalEmail, sendRejectionEmail } from '../lib/email';
import {
  assignCreatedBy,
  blockInfluencerEditorial,
  denyInfluencerModerationAction,
  enforceCreatorSubmissionQuota,
  isInfluencerRequest,
  movieNotReadyReason,
  notifyAdminsOfSubmission,
  notifyIfNewlyPublished,
  ownershipClause,
} from '../lib/creatorAccess';
import { normalizeContentReferences } from '../lib/contentReferences';

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

// Get all movies with pagination and filtering
export const getAllMovies = async (request: FastifyRequest, reply: FastifyReply) => {
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

    Object.assign(filter, ownershipClause(request));

    const [movies, total] = await Promise.all([
      MovieModel.find(filter)
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
      MovieModel.countDocuments(filter),
    ]);

    const moviesWithId = movies.map((movie) => ({
      ...movie,
      id: movie._id?.toString(),
    }));

    return reply.send({
      success: true,
      data: moviesWithId,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting all movies');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get single movie by ID
export const getMovieById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const owned = await MovieModel.findOne({ _id: id, ...ownershipClause(request) }).select('_id createdBy').lean();
    if (!owned) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    // Sync HLS qualities from disk if they exist but are missing in DB
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id);
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities for movie');
    }

    const movie = await MovieModel.findById(id)
      .populate('genres', 'name image')
      .populate('categories', 'name thumbnail bannerImage')
      .populate('languages', 'name')
      .populate('subtitleLanguages', 'name')
      .populate('audioLanguages', 'name')
      .populate('cast.actor', 'name image designation')
      .populate('crew.director', 'name designation')
      .populate('subtitles.language', 'name code')
      .lean();

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    return reply.send({
      success: true,
      data: {
        ...movie,
        id: movie._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting movie by ID');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Create new movie
export const createMovie = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as any;

    if (blockInfluencerEditorial(request, reply, body)) return;
    if (isInfluencerRequest(request) && body?.status === 'moderation') {
      return reply.status(400).send({
        success: false,
        error: 'Save the title first, then submit it for review once the video is ready.',
      });
    }
    if (!(await enforceCreatorSubmissionQuota(request, reply))) return;

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

    const referenceError = await normalizeContentReferences(body);
    if (referenceError) return reply.status(400).send({ success: false, error: referenceError });

    // Check if the uploaded video is a raw MP4 or local media file
    const isLocalPath = body.hlsUrl && !body.hlsUrl.startsWith('http://') && !body.hlsUrl.startsWith('https://');
    const isRawLocalVideo = isLocalPath && !body.hlsUrl.endsWith('.m3u8');
    if (isRawLocalVideo) {
      body.processingStatus = 'queued';
    } else {
      body.processingStatus = 'ready';
    }

    // Keep full-movie progressive source separate from trailer (offline downloads use this)
    const mainVideo = typeof body.hlsUrl === 'string' ? body.hlsUrl.trim() : '';
    const trailer = typeof body.trailerUrl === 'string' ? body.trailerUrl.trim() : '';
    if (mainVideo && !mainVideo.startsWith('blob:') && mainVideo !== trailer && !mainVideo.includes('.m3u8')) {
      body.sourceVideoUrl = mainVideo;
      body.videoUrl = mainVideo;
    }
    // Never allow videoUrl/sourceVideoUrl to silently equal trailer
    if (trailer && body.videoUrl === trailer) delete body.videoUrl;
    if (trailer && body.sourceVideoUrl === trailer) delete body.sourceVideoUrl;

    body.createdBy = assignCreatedBy(request, body);
    if (isInfluencerRequest(request)) {
      body.status = isRawLocalVideo ? 'processing' : 'draft';
      body.featured = false;
      body.trending = false;
    }

    const movie = await MovieModel.create(body);
    await syncSections(movie._id.toString(), body.sections);

    await notifyIfNewlyPublished('movie', movie._id, movie.title, undefined, movie.status);

    if (isRawLocalVideo) {
      import('../services/videoProcessor').then(({ processMovieInBackground }) => {
        processMovieInBackground(movie._id, body.hlsUrl);
      });
    }

    return reply.status(201).send({
      success: true,
      data: {
        ...movie.toObject(),
        id: movie._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error creating movie');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Update movie
export const updateMovie = async (request: FastifyRequest, reply: FastifyReply) => {
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

    const existingMovie = await MovieModel.findOne({ _id: id, ...ownershipClause(request) }).lean();
    if (!existingMovie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    if (blockInfluencerEditorial(request, reply, body)) return;
    if (isInfluencerRequest(request) && body.status === 'moderation') {
      const merged = { ...existingMovie, ...body };
      if (body.copyrightAttested !== true) {
        return reply.status(400).send({ success: false, error: 'Copyright attestation is required before submitting for review' });
      }
      const blocked = movieNotReadyReason(merged);
      if (blocked) return reply.status(400).send({ success: false, error: blocked });
      body.copyrightAttested = true;
      body.copyrightAttestedAt = new Date();
      body.submittedAt = new Date();
    }
    delete body.createdBy;
    if (isInfluencerRequest(request)) {
      delete body.approvedBy;
      delete body.approvedAt;
      delete body.rejectedBy;
      delete body.featured;
      delete body.trending;
    }

    const referenceError = await normalizeContentReferences(body);
    if (referenceError) return reply.status(400).send({ success: false, error: referenceError });

    // Check if the hlsUrl has changed to a new raw MP4
    const isLocalPath = body.hlsUrl && !body.hlsUrl.startsWith('http://') && !body.hlsUrl.startsWith('https://');
    const isRawLocalVideo = isLocalPath && !body.hlsUrl.endsWith('.m3u8') && body.hlsUrl !== (existingMovie as any).hlsUrl;
    if (isRawLocalVideo) {
      body.processingStatus = 'queued';
    } else if (body.hlsUrl) {
      body.processingStatus = 'ready';
    }

    // Keep full-movie progressive source separate from trailer
    const mainVideo = typeof body.hlsUrl === 'string' ? body.hlsUrl.trim() : '';
    const trailer = typeof body.trailerUrl === 'string' ? body.trailerUrl.trim() : String((existingMovie as any).trailerUrl || '');
    if (mainVideo && !mainVideo.startsWith('blob:') && mainVideo !== trailer && !mainVideo.includes('.m3u8')) {
      body.sourceVideoUrl = mainVideo;
      body.videoUrl = mainVideo;
    }
    if (trailer && body.videoUrl === trailer) delete body.videoUrl;
    if (trailer && body.sourceVideoUrl === trailer) delete body.sourceVideoUrl;

    const movie = await MovieModel.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    if (body.sections !== undefined) {
      await syncSections(id, body.sections);
    }

    await notifyIfNewlyPublished('movie', movie._id, movie.title, (existingMovie as any).status, movie.status);
    if (isInfluencerRequest(request) && body.status === 'moderation' && (existingMovie as any).status !== 'moderation') {
      await notifyAdminsOfSubmission('Movie', movie.title);
    }

    if (isRawLocalVideo) {
      import('../services/videoProcessor').then(({ processMovieInBackground }) => {
        processMovieInBackground(movie._id, body.hlsUrl);
      });
    }

    // Sync HLS qualities from disk if they exist but were not submitted/saved properly in update form
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id);
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities during movie update');
    }

    const updatedMovie = await MovieModel.findById(id)
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
        ...updatedMovie,
        id: updatedMovie?._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating movie');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Approve movie
export const approveMovie = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (denyInfluencerModerationAction(request, reply)) return;
    const currentUser = (request as any).user;
    const existing = await MovieModel.findById(id).select('status title').lean();
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    const movie = await MovieModel.findByIdAndUpdate(
      id,
      {
        status: 'published',
        approvedBy: currentUser?.id,
        approvedAt: new Date(),
        rejectionReason: undefined,
      },
      { new: true }
    ).populate('createdBy', 'name email');

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    await notifyIfNewlyPublished('movie', movie._id, movie.title, (existing as any).status, 'published');

    // Send approval email to creator
    if (movie.createdBy) {
      const creator = movie.createdBy as any;
      if (creator.email) {
        await sendApprovalEmail(
          creator.email,
          creator.name || 'User',
          'Movie',
          movie.title
        );
      }
    }

    return reply.send({ success: true, data: movie });
  } catch (error: any) {
    logger.error({ error }, 'Error approving movie');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Reject movie
export const rejectMovie = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (denyInfluencerModerationAction(request, reply)) return;
    const body = (request.body || {}) as { reason?: string; rejectionReason?: string };
    const reason = body.rejectionReason || body.reason;
    const currentUser = (request as any).user;

    const movie = await MovieModel.findByIdAndUpdate(
      id,
      {
        status: 'rejected',
        rejectedBy: currentUser?.id,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
      { new: true }
    ).populate('createdBy', 'name email');

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    // Send rejection email to creator
    if (movie.createdBy) {
      const creator = movie.createdBy as any;
      if (creator.email) {
        await sendRejectionEmail(
          creator.email,
          creator.name || 'User',
          'Movie',
          movie.title,
          reason || 'No reason provided'
        );
      }
    }

    return reply.send({ success: true, data: movie });
  } catch (error: any) {
    logger.error({ error }, 'Error rejecting movie');
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

    const filter: any = { status: 'moderation', ...ownershipClause(request) };

    const [movies, total] = await Promise.all([
      MovieModel.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MovieModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: movies,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting pending approvals');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get movie by ID
export const deleteMovie = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const movie = await MovieModel.findOneAndDelete({ _id: id, ...ownershipClause(request) });

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    await syncSections(id, []);

    return reply.send({ success: true, message: 'Movie deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting movie');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Update movie status
export const updateMovieStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const { status, rejectionReason, copyrightAttested } = request.body as {
      status: 'published' | 'draft' | 'processing' | 'moderation' | 'rejected';
      rejectionReason?: string;
      copyrightAttested?: boolean;
    };

    if (blockInfluencerEditorial(request, reply, { status })) return;

    const existing = await MovieModel.findOne({ _id: id, ...ownershipClause(request) }).lean();
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    const updateData: any = { status };
    if (rejectionReason && status === 'rejected') {
      updateData.rejectionReason = rejectionReason;
    }
    if (isInfluencerRequest(request) && status === 'moderation') {
      if (copyrightAttested !== true) {
        return reply.status(400).send({ success: false, error: 'Copyright attestation is required before submitting for review' });
      }
      const blocked = movieNotReadyReason(existing as any);
      if (blocked) return reply.status(400).send({ success: false, error: blocked });
      updateData.copyrightAttested = true;
      updateData.copyrightAttestedAt = new Date();
      updateData.submittedAt = new Date();
    }

    const movie = await MovieModel.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).lean();

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    await notifyIfNewlyPublished('movie', movie._id, movie.title, (existing as any).status, movie.status);
    if (isInfluencerRequest(request) && status === 'moderation') {
      await notifyAdminsOfSubmission('Movie', movie.title);
    }

    return reply.send({
      success: true,
      data: {
        ...movie,
        id: movie._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating movie status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Toggle featured status
export const toggleFeatured = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    if (denyInfluencerModerationAction(request, reply)) return;
    const { id } = request.params as { id: string };

    const movie = await MovieModel.findById(id).lean();

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    const updatedMovie = await MovieModel.findByIdAndUpdate(
      id,
      { $set: { featured: !movie.featured } },
      { new: true }
    ).lean();

    return reply.send({
      success: true,
      data: {
        ...updatedMovie,
        id: updatedMovie._id?.toString(),
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
    if (denyInfluencerModerationAction(request, reply)) return;
    const { id } = request.params as { id: string };

    const movie = await MovieModel.findById(id).lean();

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    const updatedMovie = await MovieModel.findByIdAndUpdate(
      id,
      { $set: { trending: !movie.trending } },
      { new: true }
    ).lean();

    return reply.send({
      success: true,
      data: {
        ...updatedMovie,
        id: updatedMovie._id?.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error toggling trending status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get movie HLS processing status — lightweight polling endpoint for admin panel
export const submitMovieForReview = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { copyrightAttested?: boolean };
    const movie = await MovieModel.findOne({ _id: id, ...ownershipClause(request) });
    if (!movie) return reply.status(404).send({ success: false, error: 'Movie not found' });
    if (movie.status === 'published') {
      return reply.status(400).send({ success: false, error: 'This title is already published' });
    }
    if (movie.status === 'moderation') {
      return reply.status(400).send({ success: false, error: 'This title is already waiting for review' });
    }
    if (body.copyrightAttested !== true) {
      return reply.status(400).send({ success: false, error: 'Copyright attestation is required before submitting for review' });
    }
    const blocked = movieNotReadyReason(movie);
    if (blocked) return reply.status(400).send({ success: false, error: blocked });

    movie.status = 'moderation';
    movie.copyrightAttested = true;
    movie.copyrightAttestedAt = new Date();
    movie.submittedAt = new Date();
    await movie.save();
    await notifyAdminsOfSubmission('Movie', movie.title);

    return reply.send({
      success: true,
      message: 'Submitted for review',
      data: { ...movie.toObject(), id: movie._id.toString() },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error submitting movie for review');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getMovieProcessingStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (isInfluencerRequest(request)) {
      const owned = await MovieModel.findOne({ _id: id, ...ownershipClause(request) }).select('_id').lean();
      if (!owned) return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    const movie = await MovieModel.findById(id)
      .select('processingStatus processingError hlsUrl videoQualities status title')
      .lean();

    if (!movie) {
      return reply.status(404).send({ success: false, error: 'Movie not found' });
    }

    const qualities = (movie.videoQualities || []).map((q: any) => ({
      quality: q.quality,
      url:     q.url,
      size:    q.size,
    }));

    return reply.send({
      success: true,
      data: {
        id:               movie._id?.toString(),
        title:            movie.title,
        status:           movie.status,
        processingStatus: movie.processingStatus || 'queued',
        processingError:  movie.processingError || null,
        hlsUrl:           movie.hlsUrl || null,
        availableQualities: qualities,
        qualityCount:     qualities.length,
        isReady:          movie.processingStatus === 'ready',
        isFailed:         movie.processingStatus === 'failed',
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting movie processing status');
    return reply.status(500).send({ success: false, error: error.message });
  }
};
