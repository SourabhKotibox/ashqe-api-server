import type { FastifyRequest, FastifyReply } from 'fastify';
import { EpisodeModel } from '../models/Episode';
import { TVShowModel } from '../models/TVShow';
import { Types } from 'mongoose';
import { logger } from '../lib/logger';
import { isRawLocalVideo } from '../lib/contentResolver';

export const getAllEpisodes = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      tvShowId?: string;
      season?: string;
      TVShowType?: string;
      search?: string;
    };

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.tvShowId) {
      filter.tvShowId = query.tvShowId;
    } else if (query.TVShowType) {
      const tvShowIds = await TVShowModel.find({ TVShowType: query.TVShowType as 'drama' | 'movie' })
        .select('_id')
        .lean()
        .then((contents) => contents.map((c) => c._id));
      filter.tvShowId = { $in: tvShowIds };
    }

    if (query.season) filter.season = Number(query.season);
    if (query.search) {
      filter.$or = [
        { title: new RegExp(query.search, 'i') },
        { description: new RegExp(query.search, 'i') },
      ];
    }

    const [episodes, total] = await Promise.all([
      EpisodeModel.find(filter)
        .populate('tvShowId', 'title thumbnail TVShowType type')
        .populate('subtitleLanguages', 'name code')
        .populate('audioLanguages', 'name code')
        .populate('subtitles.language', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EpisodeModel.countDocuments(filter),
    ]);

    const data = episodes.map((e) => ({
      ...e,
      id: e._id?.toString(),
      showName: (e.tvShowId as any)?.title || '',
      showThumbnail: (e.tvShowId as any)?.thumbnail || '',
    }));

    return reply.send({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting all episodes');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getEpisodeById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    // Sync HLS qualities from disk if they exist but are missing in DB
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id, 'episode');
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities for episode');
    }

    const episode = await EpisodeModel.findById(id)
      .populate('tvShowId', 'title thumbnail TVShowType type')
      .populate('subtitleLanguages', 'name code')
      .populate('audioLanguages', 'name code')
      .populate('subtitles.language', 'name code')
      .lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    return reply.send({
      success: true,
      data: { ...episode, id: episode._id?.toString() },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting episode by ID');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createEpisode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as any;

    // Match movies: transcode local MP4/media files (hlsUrl or sourceVideoUrl) into HLS
    const videoPath = (body.sourceVideoUrl || body.hlsUrl || '').trim();
    const shouldProcessHls = isRawLocalVideo(videoPath);
    if (shouldProcessHls) {
      body.sourceVideoUrl = videoPath;
      body.processingStatus = 'queued';
    } else {
      body.processingStatus = 'ready';
    }

    const episode = await EpisodeModel.create(body);

    if (shouldProcessHls && videoPath) {
      import('../services/videoProcessor').then(({ processEpisodeInBackground }) => {
        processEpisodeInBackground(episode._id as Types.ObjectId, videoPath);
      });
    }

    return reply.status(201).send({
      success: true,
      data: { ...episode.toObject(), id: episode._id?.toString() },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error creating episode');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateEpisode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const existingEpisode = await EpisodeModel.findById(id).lean();
    if (!existingEpisode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    const videoPath = (body.sourceVideoUrl || body.hlsUrl || '').trim();
    const prevPath = String((existingEpisode as any).sourceVideoUrl || (existingEpisode as any).hlsUrl || '');
    const shouldProcessHls = isRawLocalVideo(videoPath) && videoPath !== prevPath;
    if (shouldProcessHls) {
      body.sourceVideoUrl = videoPath;
      body.processingStatus = 'queued';
    } else if (body.sourceVideoUrl || body.hlsUrl) {
      body.processingStatus = 'ready';
    }

    const episode = await EpisodeModel.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    ).lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    if (shouldProcessHls && videoPath) {
      import('../services/videoProcessor').then(({ processEpisodeInBackground }) => {
        processEpisodeInBackground(new Types.ObjectId(id), videoPath);
      });
    }

    // Sync HLS qualities from disk if they exist but were not submitted/saved properly in update form
    try {
      const { autoDetectAndSyncQualities } = await import('../services/videoProcessor');
      await autoDetectAndSyncQualities(id, 'episode');
    } catch (syncErr) {
      logger.warn({ syncErr, id }, 'Failed to auto-detect and sync qualities during episode update');
    }

    const updatedEpisode = await EpisodeModel.findById(id).lean();

    return reply.send({
      success: true,
      data: { ...updatedEpisode, id: updatedEpisode?._id?.toString() },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error updating episode');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteEpisode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };

    const episode = await EpisodeModel.findByIdAndDelete(id);
    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    return reply.send({ success: true, message: 'Episode deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting episode');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const toggleEpisodeLock = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const { isLocked } = request.body as { isLocked: boolean };

    const episode = await EpisodeModel.findByIdAndUpdate(
      id,
      { $set: { isLocked } },
      { new: true }
    ).lean();

    if (!episode) {
      return reply.status(404).send({ success: false, error: 'Episode not found' });
    }

    return reply.send({ success: true, data: { ...episode, id: episode._id?.toString() } });
  } catch (error: any) {
    logger.error({ error }, 'Error toggling episode lock');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getSeasons = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      TVShowType?: string;
      tvShowId?: string;
    };

    const matchFilter: any = {};
    if (query.tvShowId && Types.ObjectId.isValid(query.tvShowId)) {
      matchFilter.tvShowId = new Types.ObjectId(query.tvShowId);
    }

    if (query.TVShowType) {
      const tvShowIds = await TVShowModel.find({ TVShowType: query.TVShowType as 'drama' | 'movie' })
        .select('_id')
        .lean()
        .then((contents) => contents.map((c) => c._id));
      matchFilter.tvShowId = { $in: tvShowIds };
    }

    const seasons = await EpisodeModel.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { tvShowId: '$tvShowId', season: '$season' },
          episodeCount: { $sum: 1 },
          thumbnail: { $first: '$thumbnail' },
        },
      },
      {
        $lookup: {
          from: TVShowModel.collection.name,
          localField: '_id.tvShowId',
          foreignField: '_id',
          as: 'content',
        },
      },
      { $unwind: { path: '$content', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          seasonId: {
            $concat: [{ $toString: '$_id.tvShowId' }, '-', { $toString: '$_id.season' }],
          },
          tvShowId: '$_id.tvShowId',
          season: '$_id.season',
          episodeCount: 1,
          showName: { $ifNull: ['$content.title', 'Unknown Series'] },
          thumbnail: { $ifNull: ['$content.thumbnail', '$thumbnail'] },
          status: { $ifNull: ['$content.status', 'draft'] },
        },
      },
      { $sort: { showName: 1, season: 1 } },
    ]);

    return reply.send({
      success: true,
      data: seasons,
      total: seasons.length,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting seasons');
    return reply.status(500).send({ success: false, error: error.message });
  }
};
