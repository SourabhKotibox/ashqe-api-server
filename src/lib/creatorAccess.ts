import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';
import { NotificationModel } from '../models/Notification';
import { AdminNotificationModel } from '../models/AdminNotification';
import { logger } from './logger';

const NONE = { canView: false, canCreate: false, canEdit: false, canDelete: false };

/** Tight default pack for a newly approved creator. Admin-only modules stay off. */
export const CREATOR_MODULE_PERMISSIONS = {
  users: { ...NONE },
  movies: { canView: true, canCreate: true, canEdit: true, canDelete: false },
  tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: false },
  genres: { ...NONE },
  actors: { ...NONE },
  directors: { ...NONE },
  languages: { ...NONE },
  categories: { ...NONE },
  mediaLibrary: { canView: true, canUpload: true, canDelete: false },
  banners: { ...NONE },
  promotions: { ...NONE },
  influencers: { ...NONE },
  ads: { ...NONE },
  pages: { ...NONE },
  faqs: { ...NONE },
  subscriptions: { ...NONE },
  subscriptionPlans: { ...NONE },
  planLimits: { ...NONE },
  notifications: { ...NONE },
  notificationTemplates: { ...NONE },
  settings: { ...NONE },
  reviews: { ...NONE },
};

const PENDING_STATUSES = ['draft', 'processing', 'moderation'] as const;
const NOT_READY = new Set(['queued', 'processing', 'failed']);

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const creatorQuotaConfig = () => ({
  maxUploadSizeBytes: num('CREATOR_MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),
  maxPendingSubmissions: num('CREATOR_MAX_PENDING_SUBMISSIONS', 10),
});

export const requestUserId = (request: FastifyRequest): string => {
  const admin = (request as any).adminUser;
  const jwtUser = (request as any).user;
  return String(admin?._id || admin?.id || jwtUser?.id || '');
};

export const requestRole = (request: FastifyRequest): string => {
  const admin = (request as any).adminUser;
  const jwtUser = (request as any).user;
  return String(admin?.role || jwtUser?.role || '');
};

export const isInfluencerRequest = (request: FastifyRequest): boolean => requestRole(request) === 'influencer';

/** Extra query clause so influencers only see rows they created. */
export const ownershipClause = (request: FastifyRequest): Record<string, unknown> => {
  if (!isInfluencerRequest(request)) return {};
  return { createdBy: requestUserId(request) };
};

export const assignCreatedBy = (request: FastifyRequest, body: Record<string, any> | undefined) => {
  if (body && typeof body === 'object') delete body.createdBy;
  return requestUserId(request);
};

const EDITORIAL_FLAGS = ['featured', 'isFeatured', 'trending', 'isTrending'] as const;

const flagIsOn = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * Block creators from publishing or flipping editorial flags.
 * Returns true when a response has already been sent.
 */
export const blockInfluencerEditorial = (
  request: FastifyRequest,
  reply: FastifyReply,
  body: Record<string, any> | undefined
): boolean => {
  if (!isInfluencerRequest(request) || !body) return false;
  if (body.status === 'published') {
    reply.status(403).send({
      success: false,
      error: 'Creators cannot publish content. Submit it for review instead.',
    });
    return true;
  }
  for (const key of EDITORIAL_FLAGS) {
    if (flagIsOn(body[key])) {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot change featured or trending status.',
      });
      return true;
    }
    if (key in body) delete body[key];
  }
  return false;
};

export const denyInfluencerModerationAction = (request: FastifyRequest, reply: FastifyReply): boolean => {
  if (!isInfluencerRequest(request)) return false;
  reply.status(403).send({
    success: false,
    error: 'Creators cannot approve, reject, or change featured and trending flags.',
  });
  return true;
};

export const countPendingSubmissions = async (userId: string) => {
  const createdBy = userId;
  const [movies, tvShows] = await Promise.all([
    MovieModel.countDocuments({ createdBy, status: { $in: [...PENDING_STATUSES] } }),
    TVShowModel.countDocuments({ createdBy, status: { $in: [...PENDING_STATUSES] } }),
  ]);
  return movies + tvShows;
};

/** Returns false when the reply has already been sent. */
export const enforceCreatorSubmissionQuota = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> => {
  if (!isInfluencerRequest(request)) return true;
  const { maxPendingSubmissions } = creatorQuotaConfig();
  const current = await countPendingSubmissions(requestUserId(request));
  if (current >= maxPendingSubmissions) {
    reply.status(429).send({
      success: false,
      error: `Upload limit reached. You can have at most ${maxPendingSubmissions} active submissions in draft, processing, or review.`,
    });
    return false;
  }
  return true;
};

export const creatorFileTooLargeReason = (fileSize: unknown): string | null => {
  const { maxUploadSizeBytes } = creatorQuotaConfig();
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return 'fileSize is required for creator uploads and must be a positive number of bytes';
  }
  if (size > maxUploadSizeBytes) {
    return `File exceeds the creator upload limit of ${maxUploadSizeBytes} bytes`;
  }
  return null;
};

const hasVideo = (doc: { hlsUrl?: string; videoUrl?: string; sourceVideoUrl?: string } | null | undefined) =>
  Boolean(
    (doc?.hlsUrl && String(doc.hlsUrl).trim()) ||
      (doc?.videoUrl && String(doc.videoUrl).trim()) ||
      (doc?.sourceVideoUrl && String(doc.sourceVideoUrl).trim())
  );

export const movieNotReadyReason = (movie: {
  hlsUrl?: string;
  videoUrl?: string;
  sourceVideoUrl?: string;
  processingStatus?: string;
} | null): string | null => {
  if (!movie || !hasVideo(movie)) return 'Upload a video before submitting for review';
  if (movie.processingStatus && NOT_READY.has(movie.processingStatus)) {
    return 'Video is not ready for review. Processing must finish successfully before submission.';
  }
  return null;
};

export const tvShowNotReadyReason = async (show: any): Promise<string | null> => {
  const episodes = await EpisodeModel.find({ tvShowId: show._id })
    .select('hlsUrl videoUrl sourceVideoUrl processingStatus')
    .lean();
  const showHasVideo = hasVideo(show);
  const episodeHasVideo = episodes.some((episode) => hasVideo(episode as any));
  if (!showHasVideo && episodes.length === 0) {
    return 'Add episodes or upload a video before submitting for review';
  }
  if (!showHasVideo && !episodeHasVideo) {
    return 'Upload a video on the series or its episodes before submitting for review';
  }
  if (show.processingStatus && NOT_READY.has(show.processingStatus)) {
    return 'Video is not ready for review. Processing must finish successfully before submission.';
  }
  if (episodes.some((episode) => episode.processingStatus && NOT_READY.has(episode.processingStatus))) {
    return 'An episode is still processing or failed. Wait until every episode is ready before submitting.';
  }
  return null;
};

export const notifyIfNewlyPublished = async (
  kind: 'movie' | 'webseries',
  contentId: Types.ObjectId | string,
  title: string,
  previousStatus: string | undefined,
  nextStatus: string | undefined
) => {
  if (nextStatus !== 'published' || previousStatus === 'published') return;
  try {
    await NotificationModel.create({
      title: kind === 'movie' ? 'New Movie Added! 🍿' : 'New Web Series Added! 🍿',
      body: `Watch ${title} now on the app!`,
      type: 'content_release',
      targetAudience: 'all',
      contentId,
      status: 'sent',
      metrics: { targetCount: 0, sentCount: 1, openedCount: 0, clickedCount: 0 },
      sentAt: new Date(),
      priority: 'high',
    });
  } catch (err) {
    logger.error({ err }, 'Error sending new content notification');
  }
};

export const notifyAdminsOfSubmission = async (modelName: 'Movie' | 'TVShow', title: string) => {
  try {
    await AdminNotificationModel.create({
      title: 'Content submitted for review',
      message: `${modelName} "${title}" was submitted for moderation`,
      type: 'content_updated',
      modelName,
      action: 'updated',
    });
  } catch (err) {
    logger.error({ err }, 'Error creating moderation notification');
  }
};

export const sameOwner = (doc: { createdBy?: unknown } | null | undefined, userId: string) => {
  if (!doc?.createdBy) return false;
  const raw = doc.createdBy as any;
  const id = raw?._id || raw;
  return String(id) === String(userId);
};

export const isObjectId = (value: unknown) => Types.ObjectId.isValid(String(value || ''));
