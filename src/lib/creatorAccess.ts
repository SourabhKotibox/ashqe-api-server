import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';
import { NotificationModel } from '../models/Notification';
import { AdminNotificationModel } from '../models/AdminNotification';
import { AdminUserModel } from '../models/AdminUser';
import { logger } from './logger';

const NONE = { canView: false, canCreate: false, canEdit: false, canDelete: false };
const CATALOG = { canView: true, canCreate: true, canEdit: true, canDelete: true };

/**
 * Catalog modules a creator can list and extend.
 * Edit/delete are granted here and then limited to rows the creator owns.
 * Crew people use the directors module (there is no separate crews key).
 */
export const CREATOR_CATALOG_PERMISSIONS = {
  genres: { ...CATALOG },
  actors: { ...CATALOG },
  directors: { ...CATALOG },
  languages: { ...CATALOG },
  countries: { ...CATALOG },
};

/**
 * Tight default pack for a newly approved creator. Admin-only modules stay off.
 * Anything set to true here is part of the creator section pack: approval stores it,
 * `/api/auth/me` derives it for every influencer, and startup sync persists it.
 */
export const CREATOR_MODULE_PERMISSIONS = {
  users: { ...NONE },
  movies: { canView: true, canCreate: true, canEdit: true, canDelete: false },
  tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: false },
  ...CREATOR_CATALOG_PERMISSIONS,
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
  creatorRevenue: { canView: true, canCreate: false, canEdit: false, canDelete: false },
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

export const creatorCatalogLimits = () => ({
  createsPerHour: num('CREATOR_CATALOG_CREATES_PER_HOUR', 30),
  maxPerType: num('CREATOR_CATALOG_MAX_PER_TYPE', 100),
});

/**
 * Sidebar sections a creator should see. `dashboard` is not a module key:
 * the admin shell shows it for every signed-in account. Crew is not its own
 * module — the admin sidebar gates it on `actors`, and the API gates crew
 * writes on `directors`. The admin sidebar currently gates the Countries item
 * on `languages`; API country writes use `countries`. Both flags are in the pack.
 * `earnings` is the creator's own revenue section (`creatorRevenue.canView`).
 */
export const CREATOR_SIDEBAR_SECTIONS = [
  'dashboard',
  'mediaLibrary',
  'movies',
  'tvShows',
  'languages',
  'genres',
  'actors',
  'directors',
  'crew',
  'countries',
  'earnings',
] as const;

const moduleIsVisible = (permissions: any, moduleName: string) => {
  const entry = permissions?.[moduleName];
  return Boolean(entry?.canView || entry?.canUpload);
};

/**
 * Sections the admin sidebar can render from this account.
 * Influencers always get the creator list, because their pack is derived from
 * the role. Other roles only list sections their stored flags already allow.
 */
export const sidebarSectionsFor = (role: string | undefined, permissions: any): string[] => {
  if (role === 'influencer') return [...CREATOR_SIDEBAR_SECTIONS];

  const sections = ['dashboard'];
  if (moduleIsVisible(permissions, 'mediaLibrary')) sections.push('mediaLibrary');
  if (moduleIsVisible(permissions, 'movies')) sections.push('movies');
  if (moduleIsVisible(permissions, 'tvShows')) sections.push('tvShows');
  if (moduleIsVisible(permissions, 'languages')) sections.push('languages');
  if (moduleIsVisible(permissions, 'genres')) sections.push('genres');
  if (moduleIsVisible(permissions, 'actors')) sections.push('actors');
  if (moduleIsVisible(permissions, 'directors')) sections.push('directors');
  if (moduleIsVisible(permissions, 'actors')) sections.push('crew');
  if (moduleIsVisible(permissions, 'countries') || moduleIsVisible(permissions, 'languages')) {
    sections.push('countries');
  }
  if (moduleIsVisible(permissions, 'creatorRevenue')) sections.push('earnings');
  return sections;
};

/**
 * Force every creator-pack flag that is allowed. Stored grants outside the pack
 * are kept, and a stored `true` is never turned off. A stored `false` on a pack
 * flag is turned back on, so editing a creator in the role UI cannot lock them
 * out of creator sections. Other roles must not be passed through this helper.
 *
 * Content deletion is the exception. `movies.canDelete`, `tvShows.canDelete`,
 * and `mediaLibrary.canDelete` are forced off even when the stored document
 * says true. A creator must not be able to remove a film that is earning.
 * Catalog modules (genres, people, languages, countries) keep their own delete.
 */
export const withCreatorGrants = (stored: any) => {
  const next: Record<string, any> = stored && typeof stored === 'object' ? { ...stored } : {};
  for (const [moduleName, actions] of Object.entries(CREATOR_MODULE_PERMISSIONS)) {
    const current: Record<string, boolean> = { ...(actions as Record<string, boolean>) };
    const existing = next[moduleName];
    if (existing && typeof existing === 'object') {
      for (const [action, value] of Object.entries(existing)) {
        if (typeof value === 'boolean') current[action] = value;
      }
    }
    for (const [action, allowed] of Object.entries(actions as Record<string, boolean>)) {
      if (allowed) current[action] = true;
    }
    next[moduleName] = current;
  }
  next.movies = { ...(next.movies || {}), canDelete: false };
  next.tvShows = { ...(next.tvShows || {}), canDelete: false };
  next.mediaLibrary = { ...(next.mediaLibrary || {}), canDelete: false };
  return next;
};

/** Influencer permissions are the stored document with the creator pack forced on. */
export const permissionsForRole = (role: string | undefined, stored: any) => {
  if (role !== 'influencer') return stored;
  return withCreatorGrants(stored);
};

/**
 * Approval copies CREATOR_MODULE_PERMISSIONS onto the new account. Reads for an
 * influencer also derive that pack from the role, so a missing or cleared
 * document still authorizes creator sections. This sync persists the same true
 * flags for influencer accounts that were created earlier. It only sets pack
 * flags to true, plus the content-delete lock (movies, tvShows, and
 * mediaLibrary canDelete forced false). It does not revoke other modules and
 * does not touch other roles.
 * Idempotent: running it again is a no-op once the flags are already on.
 * Also available as `npx tsx scripts/sync-creator-permissions.ts`.
 * The API runs this on startup.
 */
export const syncCreatorCatalogPermissions = async () => {
  const $set: Record<string, boolean> = {};
  const needsGrant: Record<string, unknown>[] = [];
  for (const [moduleName, actions] of Object.entries(CREATOR_MODULE_PERMISSIONS)) {
    for (const [action, allowed] of Object.entries(actions)) {
      if (!allowed) continue;
      const path = `modulePermissions.${moduleName}.${action}`;
      $set[path] = true;
      needsGrant.push({ [path]: { $ne: true } });
    }
  }
  // Persist the content-delete lock. Reads already force these flags off;
  // writing them keeps a staff editor from looking at a stale `true`.
  for (const moduleName of ['movies', 'tvShows', 'mediaLibrary']) {
    const path = `modulePermissions.${moduleName}.canDelete`;
    $set[path] = false;
    needsGrant.push({ [path]: true });
  }
  const result = await AdminUserModel.updateMany(
    { role: 'influencer', $or: needsGrant },
    { $set }
  );
  return {
    matched: result.matchedCount ?? 0,
    modified: result.modifiedCount ?? 0,
  };
};

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

/**
 * Creators cannot delete movies, series, episodes, or media folders.
 * Seasons are not a separate collection: removing a season means deleting its
 * episodes, and that path is rejected here too.
 *
 * Who can delete a movie, series, or episode: an admin with that module's
 * canDelete flag, or a superadmin. Moderators stay blocked even if canDelete
 * was granted. Influencers cannot, even when the stored document says canDelete.
 *
 * What creators can still do: edit metadata on their own rows, replace the
 * video on a draft or rejected title, upload new files, and delete an
 * unreferenced media file they uploaded (a file that is not attached to a
 * movie, series, episode, or anything else). Referenced files stay blocked
 * by the existing in-use check (409).
 *
 * What creators cannot do, besides DELETE:
 * - move a published title to any other status (unpublish)
 * - pull a title out of moderation back to draft, processing, or rejected
 * - set status to rejected
 * - clear hlsUrl, videoUrl, sourceVideoUrl, hlsS3Prefix, or videoQualities
 *   once a video is stored
 * - replace that video while the title is published or in review
 * Poster, thumbnail, trailer, and description edits stay allowed.
 */
const VIDEO_FIELDS = ['hlsUrl', 'videoUrl', 'sourceVideoUrl', 'hlsS3Prefix'] as const;

const videoText = (value: unknown) => (value == null ? '' : String(value).trim());

const qualityUrls = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => videoText((entry as { url?: unknown })?.url))
    .filter(Boolean)
    .sort();
};

export const denyInfluencerContentDelete = (request: FastifyRequest, reply: FastifyReply): boolean => {
  if (!isInfluencerRequest(request)) return false;
  reply.status(403).send({
    success: false,
    error: 'Creators cannot delete content. Only an admin can remove a movie, series, season, or episode.',
  });
  return true;
};

/** Movies, series, and episodes can be deleted by admin or superadmin only. */
export const denyNonAdminContentDelete = (request: FastifyRequest, reply: FastifyReply): boolean => {
  const role = requestRole(request);
  if (role === 'admin' || role === 'superadmin') return false;
  reply.status(403).send({
    success: false,
    error: 'Only an admin or super admin can delete a movie, series, season, or episode.',
  });
  return true;
};

export const blockInfluencerContentRemoval = (
  request: FastifyRequest,
  reply: FastifyReply,
  body: Record<string, any> | undefined,
  existing: Record<string, any> | null | undefined
): boolean => {
  if (!isInfluencerRequest(request) || !body || !existing) return false;

  if ('status' in body) {
    const next = body.status;
    const previous = existing.status;
    const blankStatus = next == null || next === '';
    if (previous === 'published' && (blankStatus || next !== 'published')) {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot unpublish content.',
      });
      return true;
    }
    if (next === 'rejected') {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot reject their own content.',
      });
      return true;
    }
    if (previous === 'moderation' && next !== 'moderation' && next !== 'published') {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot withdraw content that is already in review.',
      });
      return true;
    }
  }

  const locked = existing.status === 'published' || existing.status === 'moderation';
  for (const field of VIDEO_FIELDS) {
    if (!(field in body)) continue;
    const previous = videoText(existing[field]);
    const next = videoText(body[field]);
    if (previous && !next) {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot remove the video from their content.',
      });
      return true;
    }
    if (locked && previous && next && previous !== next) {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot replace the video on content that is published or in review.',
      });
      return true;
    }
  }

  if ('videoQualities' in body) {
    const previous = qualityUrls(existing.videoQualities);
    const next = qualityUrls(body.videoQualities);
    if (previous.length > 0 && next.length === 0) {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot remove the video from their content.',
      });
      return true;
    }
    if (locked && previous.length > 0 && previous.join('|') !== next.join('|')) {
      reply.status(403).send({
        success: false,
        error: 'Creators cannot replace the video on content that is published or in review.',
      });
      return true;
    }
  }

  return false;
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
