import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isInfluencerRequest, requestUserId } from '../lib/creatorAccess';
import { resolveRevenuePeriod } from '../lib/creatorRevenue';
import {
  RevenueValidationError,
  adminRevenueOverview,
  creatorRevenueSeries,
  creatorRevenueSummary,
  creatorRevenueTitles,
  getCreatorRatePayload,
  getRatePayload,
  logRevenueFailure,
  recordCreatorPlayback,
  setCreatorWatchHourRate,
  setWatchHourRate,
} from '../lib/creatorRevenueLedger';

const periodQuery = z.object({
  period: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  creatorId: z.string().optional(),
});

const heartbeatSchema = z.object({
  contentId: z.string().min(1),
  episodeId: z.string().min(1).optional(),
  contentType: z.string().max(40).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9:_-]{8,80}$/),
  clientEventId: z.string().regex(/^[A-Za-z0-9:_-]{8,80}$/),
  playedSeconds: z.coerce.number().min(0).max(86_400),
  positionSeconds: z.coerce.number().min(0).max(86_400 * 2),
  durationSeconds: z.coerce.number().min(0).max(86_400 * 2).optional(),
  profileId: z.string().max(80).optional(),
});

const rateSchema = z.object({
  rateInrPerHour: z.coerce.number(),
  note: z.string().max(240).optional(),
});

const clampPage = (value: unknown, fallback: number, max: number) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, n);
};

const readPeriod = (query: { period?: string; from?: string; to?: string }) => {
  const resolved = resolveRevenuePeriod({
    period: query.period,
    from: query.from || null,
    to: query.to || null,
  });
  return resolved;
};

const creatorGuard = (request: FastifyRequest, reply: FastifyReply) => {
  if (!isInfluencerRequest(request)) {
    reply.status(403).send({ success: false, error: 'Creator revenue is only available to creator accounts' });
    return '';
  }
  const userId = requestUserId(request);
  if (!userId) {
    reply.status(401).send({ success: false, error: 'Unauthorized' });
    return '';
  }
  return userId;
};

/** POST /api/app/watch/heartbeat */
export const recordWatchHeartbeat = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const role = String((request as any).user?.role || '');
    if (role && role !== 'user') {
      return reply.status(403).send({ success: false, error: 'Watch time can only be recorded by an app account' });
    }
    const parsed = heartbeatSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
    }
    const userId = (request as any).user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized.' });
    const body = parsed.data;
    const result = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: userId,
      contentId: body.contentId,
      episodeId: body.episodeId,
      contentType: body.contentType,
      sessionId: body.sessionId,
      clientEventId: body.clientEventId,
      profileId: body.profileId,
      playedSeconds: body.playedSeconds,
      positionSeconds: body.positionSeconds,
    });
    if (result.reason === 'not_found') {
      return reply.status(404).send({ success: false, message: 'Content not found.' });
    }
    if (result.reason === 'invalid' || result.reason === 'episode_mismatch' || result.reason === 'episode_required') {
      const message = result.reason === 'episode_mismatch'
        ? 'Episode does not belong to this series.'
        : result.reason === 'episode_required'
          ? 'episodeId is required when reporting watch time for a series.'
          : 'Invalid watch report.';
      return reply.status(400).send({ success: false, message });
    }
    return reply.send({ success: true, data: result });
  } catch (error: any) {
    logRevenueFailure(error, 'Error recording watch heartbeat');
    return reply.status(500).send({ success: false, message: 'Failed to record watch time.' });
  }
};

/** GET /api/creator/revenue/summary */
export const getCreatorRevenueSummary = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const creatorId = creatorGuard(request, reply);
    if (!creatorId) return;
    const parsed = periodQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Validation failed' });
    const period = readPeriod(parsed.data);
    if (period.ok === false) return reply.status(400).send({ success: false, error: period.error });
    const data = await creatorRevenueSummary(creatorId, period.period);
    return reply.send({ success: true, data });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error building creator revenue summary');
    return reply.status(500).send({ success: false, error: 'Failed to load revenue summary' });
  }
};

/** GET /api/creator/revenue/titles */
export const getCreatorRevenueTitles = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const creatorId = creatorGuard(request, reply);
    if (!creatorId) return;
    const parsed = periodQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Validation failed' });
    const period = readPeriod(parsed.data);
    if (period.ok === false) return reply.status(400).send({ success: false, error: period.error });
    const page = clampPage(parsed.data.page, 1, 10_000);
    const limit = clampPage(parsed.data.limit, 20, 100);
    const data = await creatorRevenueTitles(creatorId, period.period, page, limit);
    const { pagination, ...rest } = data;
    return reply.send({ success: true, data: rest, pagination });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error building creator revenue titles');
    return reply.status(500).send({ success: false, error: 'Failed to load revenue titles' });
  }
};

/** GET /api/creator/revenue/timeseries */
export const getCreatorRevenueSeries = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const creatorId = creatorGuard(request, reply);
    if (!creatorId) return;
    const parsed = periodQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Validation failed' });
    const period = readPeriod(parsed.data);
    if (period.ok === false) return reply.status(400).send({ success: false, error: period.error });
    const data = await creatorRevenueSeries(creatorId, period.period);
    return reply.send({ success: true, data });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error building creator revenue series');
    return reply.status(500).send({ success: false, error: 'Failed to load revenue series' });
  }
};

/** GET /api/admin/creator-revenue/creators/:creatorId/rate */
export const getCreatorWatchHourRate = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { creatorId } = request.params as { creatorId: string };
    return reply.send({ success: true, data: await getCreatorRatePayload(creatorId) });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error reading a creator watch-hour rate');
    return reply.status(500).send({ success: false, error: 'Failed to load the creator watch-hour rate' });
  }
};

/** PUT /api/admin/creator-revenue/creators/:creatorId/rate */
export const putCreatorWatchHourRate = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { creatorId } = request.params as { creatorId: string };
    const parsed = rateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
    }
    const admin = (request as any).adminUser;
    await setCreatorWatchHourRate({
      creatorId,
      rateInrPerHour: parsed.data.rateInrPerHour,
      note: parsed.data.note,
      setBy: String(admin?._id || admin?.id || ''),
    });
    return reply.send({ success: true, data: await getCreatorRatePayload(creatorId) });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error updating a creator watch-hour rate');
    return reply.status(500).send({ success: false, error: 'Failed to update the creator watch-hour rate' });
  }
};

/** GET /api/admin/creator-revenue/rate — global default */
export const getCreatorRevenueRate = async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.send({ success: true, data: await getRatePayload() });
  } catch (error: any) {
    logRevenueFailure(error, 'Error reading creator revenue rate');
    return reply.status(500).send({ success: false, error: 'Failed to load the watch-hour rate' });
  }
};

/** PUT /api/admin/creator-revenue/rate */
export const putCreatorRevenueRate = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const parsed = rateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
    }
    const admin = (request as any).adminUser;
    await setWatchHourRate({
      rateInrPerHour: parsed.data.rateInrPerHour,
      note: parsed.data.note,
      setBy: String(admin?._id || admin?.id || ''),
    });
    return reply.send({ success: true, data: await getRatePayload() });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error updating creator revenue rate');
    return reply.status(500).send({ success: false, error: 'Failed to update the watch-hour rate' });
  }
};

/** GET /api/admin/creator-revenue/overview */
export const getCreatorRevenueOverview = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const parsed = periodQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Validation failed' });
    const period = readPeriod(parsed.data);
    if (period.ok === false) return reply.status(400).send({ success: false, error: period.error });
    const page = clampPage(parsed.data.page, 1, 10_000);
    const limit = clampPage(parsed.data.limit, 20, 100);
    const data = await adminRevenueOverview({
      period: period.period,
      creatorId: parsed.data.creatorId,
      page,
      limit,
    });
    const { pagination, ...rest } = data;
    return reply.send({ success: true, data: rest, pagination });
  } catch (error: any) {
    if (error instanceof RevenueValidationError) return reply.status(error.statusCode || 400).send({ success: false, error: error.message });
    logRevenueFailure(error, 'Error building creator revenue overview');
    return reply.status(500).send({ success: false, error: 'Failed to load revenue overview' });
  }
};
