import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { countPendingSubmissions, creatorQuotaConfig, isInfluencerRequest, requestUserId } from '../lib/creatorAccess';
import { logger } from '../lib/logger';

const STATUSES = ['draft', 'processing', 'moderation', 'rejected', 'published'] as const;

const emptyCounts = () => ({
  draft: 0,
  processing: 0,
  moderation: 0,
  rejected: 0,
  published: 0,
  total: 0,
});

const mapRecent = (
  row: { _id: Types.ObjectId; title: string; status: string; views?: number; updatedAt: Date; rejectionReason?: string },
  type: 'movie' | 'tvShow'
) => {
  const item: {
    id: string;
    title: string;
    type: 'movie' | 'tvShow';
    status: string;
    views: number;
    updatedAt: Date;
    rejectionReason?: string;
  } = {
    id: row._id.toString(),
    title: row.title,
    type,
    status: row.status,
    views: row.views || 0,
    updatedAt: row.updatedAt,
  };
  if (row.rejectionReason) item.rejectionReason = row.rejectionReason;
  return item;
};

const summarize = async (model: typeof MovieModel | typeof TVShowModel, userId: Types.ObjectId) => {
  const rows = await model.aggregate([
    { $match: { createdBy: userId } },
    { $group: { _id: '$status', count: { $sum: 1 }, views: { $sum: { $ifNull: ['$views', 0] } } } },
  ]);
  const counts = emptyCounts();
  let views = 0;
  for (const row of rows) {
    views += row.views || 0;
    if (row._id && (STATUSES as readonly string[]).includes(row._id)) {
      (counts as any)[row._id] = row.count;
    }
    counts.total += row.count;
  }
  return { counts, views };
};

/** GET /api/creator/dashboard */
export const getCreatorDashboard = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    if (!isInfluencerRequest(request)) {
      return reply.status(403).send({ success: false, error: 'Creator dashboard is only available to creator accounts' });
    }
    const userId = requestUserId(request);
    if (!Types.ObjectId.isValid(userId)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
    const ownerId = new Types.ObjectId(userId);
    const quotas = creatorQuotaConfig();

    const [movies, tvShows, currentPendingSubmissions, recentMovies, recentShows] = await Promise.all([
      summarize(MovieModel, ownerId),
      summarize(TVShowModel, ownerId),
      countPendingSubmissions(userId),
      MovieModel.find({ createdBy: ownerId })
        .sort({ updatedAt: -1 })
        .limit(8)
        .select('title status views updatedAt createdAt rejectionReason')
        .lean(),
      TVShowModel.find({ createdBy: ownerId })
        .sort({ updatedAt: -1 })
        .limit(8)
        .select('title status views updatedAt createdAt rejectionReason')
        .lean(),
    ]);

    const recentSubmissions = [
      ...recentMovies.map((row) => mapRecent(row, 'movie')),
      ...recentShows.map((row) => mapRecent(row, 'tvShow')),
    ]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8);

    return reply.send({
      success: true,
      data: {
        counts: {
          movies: movies.counts,
          tvShows: tvShows.counts,
        },
        totalViews: movies.views + tvShows.views,
        quotas: {
          maxPendingSubmissions: quotas.maxPendingSubmissions,
          currentPendingSubmissions,
          maxUploadSizeBytes: quotas.maxUploadSizeBytes,
        },
        recentSubmissions,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error building creator dashboard');
    return reply.status(500).send({ success: false, error: error.message });
  }
};
