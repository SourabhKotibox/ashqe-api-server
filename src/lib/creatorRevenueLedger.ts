import { Types } from 'mongoose';
import { AdminUserModel } from '../models/AdminUser';
import { CreatorRevenueDailyModel } from '../models/CreatorRevenueDaily';
import { CreatorRevenueRateModel } from '../models/CreatorRevenueRate';
import { CreatorWatchCreditModel } from '../models/CreatorWatchCredit';
import { CreatorWatchCursorModel } from '../models/CreatorWatchCursor';
import { CreatorWatchViewerDayModel } from '../models/CreatorWatchViewerDay';
import { EpisodeModel } from '../models/Episode';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { UserModel } from '../models/User';
import { resolveContent } from './contentResolver';
import { logger } from './logger';
import {
  RATE_POLICY,
  REVENUE_CURRENCY,
  REVENUE_LIMITS,
  REVENUE_TIMEZONE,
  RevenuePeriod,
  buildDailySeries,
  dailyCapSeconds,
  decidePlaybackCredit,
  earningUnitsFor,
  istDateKey,
  isSameParty,
  normalizeRateInr,
  presentMoney,
  ratePaisePerHour,
  sessionCapSeconds,
} from './creatorRevenue';

export class RevenueValidationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'RevenueValidationError';
    this.statusCode = statusCode;
  }
}

export type WatchCreditResult = {
  creditedSeconds: number;
  counted: boolean;
  duplicate: boolean;
  reason: string;
};

export type RecordPlaybackInput = {
  source: 'heartbeat' | 'progress';
  viewerUserId: string;
  contentId: string;
  episodeId?: string | null;
  contentType?: string | null;
  sessionId?: string | null;
  clientEventId?: string | null;
  profileId?: string | null;
  playedSeconds?: number | null;
  positionSeconds?: number | null;
  now?: Date;
};

type Billable = {
  assetId: Types.ObjectId;
  titleId: Types.ObjectId;
  titleType: 'movie' | 'series';
  episodeId: Types.ObjectId | null;
  episodeKey: string;
  creatorId: Types.ObjectId | null;
  published: boolean;
  catalogDuration: number | null;
  title: string;
  episodeTitle?: string;
  season?: number;
  episodeNumber?: number;
};

const zero = (reason: string, duplicate = false): WatchCreditResult => ({
  creditedSeconds: 0,
  counted: false,
  duplicate,
  reason,
});

const isDuplicateKey = (error: unknown): boolean => {
  const err = error as { code?: number; cause?: { code?: number } };
  return err?.code === 11000 || err?.cause?.code === 11000;
};

const asId = (value: unknown): Types.ObjectId | null => {
  if (!value || !Types.ObjectId.isValid(String(value))) return null;
  return new Types.ObjectId(String(value));
};

const presentCredit = (doc: { creditedSeconds?: number; reason?: string }, duplicate: boolean): WatchCreditResult => {
  const creditedSeconds = doc?.creditedSeconds || 0;
  return {
    creditedSeconds,
    counted: creditedSeconds > 0,
    duplicate,
    reason: doc?.reason || 'credited',
  };
};

type RateSource = 'default' | 'override';

type ResolvedRate = {
  rateInrPerHour: number;
  ratePaisePerHour: number;
  effectiveFrom: Date;
  note: string | null;
  source: RateSource;
};

const mapRateHistory = (rows: Array<{
  rateInrPerHour: number;
  effectiveFrom: Date;
  note?: string | null;
  opening?: boolean;
  setBy?: unknown;
}>) => rows.map((row) => {
  const setter = row.setBy as { _id?: Types.ObjectId; name?: string; email?: string } | null;
  return {
    rateInrPerHour: row.rateInrPerHour,
    effectiveFrom: row.effectiveFrom,
    note: row.note || null,
    opening: !!row.opening,
    setBy: setter?._id
      ? { id: String(setter._id), name: setter.name || '', email: setter.email || '' }
      : null,
  };
});

export async function ensureOpeningRate() {
  const existing = await CreatorRevenueRateModel.findOne({ opening: true, creatorId: null }).lean();
  if (existing) return existing;
  try {
    return await CreatorRevenueRateModel.create({
      creatorId: null,
      opening: true,
      rateInrPerHour: REVENUE_LIMITS.openingRateInrPerHour,
      effectiveFrom: new Date(0),
      note: 'Opening default of Rs 5 per watch hour',
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return CreatorRevenueRateModel.findOne({ opening: true, creatorId: null }).lean();
  }
}

async function latestRate(filter: Record<string, unknown>, when: Date) {
  return CreatorRevenueRateModel.findOne({ ...filter, effectiveFrom: { $lte: when } })
    .sort({ effectiveFrom: -1 })
    .lean();
}

function toResolved(row: { rateInrPerHour?: number; effectiveFrom?: Date; note?: string | null } | null, source: RateSource): ResolvedRate {
  const rateInrPerHour = row?.rateInrPerHour ?? REVENUE_LIMITS.openingRateInrPerHour;
  return {
    rateInrPerHour,
    ratePaisePerHour: ratePaisePerHour(rateInrPerHour),
    effectiveFrom: row?.effectiveFrom ?? new Date(0),
    note: row?.note ?? null,
    source,
  };
}

/** Creator override in effect at `when`, otherwise the global default in effect then. */
export async function getRateAt(when: Date, creatorId?: string | Types.ObjectId | null) {
  await ensureOpeningRate();
  const ownerId = creatorId ? asId(creatorId) : null;
  if (ownerId) {
    const override = await latestRate({ creatorId: ownerId }, when);
    if (override) return toResolved(override, 'override');
  }
  const fallback = await latestRate({ creatorId: null }, when);
  return toResolved(fallback, 'default');
}

async function insertRate(input: {
  creatorId: Types.ObjectId | null;
  rateInrPerHour: number;
  note?: string;
  setBy: Types.ObjectId;
  effectiveFrom: Date;
}) {
  let effectiveFrom = input.effectiveFrom;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await CreatorRevenueRateModel.create({
        creatorId: input.creatorId,
        opening: false,
        rateInrPerHour: input.rateInrPerHour,
        effectiveFrom,
        setBy: input.setBy,
        note: input.note,
      });
    } catch (error) {
      if (!isDuplicateKey(error) || attempt === 2) throw error;
      effectiveFrom = new Date(effectiveFrom.getTime() + 1);
    }
  }
  throw new RevenueValidationError('Could not record the rate');
}

function parseRateChange(input: { rateInrPerHour: unknown; note?: string | null; setBy: string; now?: Date }) {
  const rateInrPerHour = normalizeRateInr(input.rateInrPerHour);
  if (rateInrPerHour == null) {
    throw new RevenueValidationError('rateInrPerHour must be a number from 0 to 100000 with at most 2 decimal places');
  }
  const setBy = asId(input.setBy);
  if (!setBy) throw new RevenueValidationError('A signed-in admin is required to set the rate');
  const note = String(input.note || '').trim().slice(0, 240);
  return { rateInrPerHour, setBy, note: note || undefined, effectiveFrom: input.now ?? new Date() };
}

/** Append a global default. Creators who already have an override are unchanged. */
export async function setWatchHourRate(input: {
  rateInrPerHour: unknown;
  note?: string | null;
  setBy: string;
  now?: Date;
}) {
  const change = parseRateChange(input);
  await ensureOpeningRate();
  return insertRate({ ...change, creatorId: null });
}

/** Append this creator's own rate. Later default changes do not apply to them. */
export async function setCreatorWatchHourRate(input: {
  creatorId: string;
  rateInrPerHour: unknown;
  note?: string | null;
  setBy: string;
  now?: Date;
}) {
  const creatorId = asId(input.creatorId);
  if (!creatorId) throw new RevenueValidationError('Invalid creatorId');
  const creator = await AdminUserModel.findById(creatorId).select('role isActive').lean();
  if (!creator || !creator.isActive || creator.role !== 'influencer') {
    throw new RevenueValidationError('Creator not found', 404);
  }
  const change = parseRateChange(input);
  await ensureOpeningRate();
  return insertRate({ ...change, creatorId });
}

export async function getRatePayload() {
  await ensureOpeningRate();
  const now = new Date();
  const current = await getRateAt(now);
  const history = await CreatorRevenueRateModel.find({ creatorId: null })
    .sort({ effectiveFrom: -1 })
    .populate('setBy', 'name email')
    .lean();
  return {
    scope: 'default' as const,
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    rateInrPerHour: current.rateInrPerHour,
    effectiveFrom: current.effectiveFrom,
    ratePolicy: RATE_POLICY,
    history: mapRateHistory(history),
  };
}

export async function getCreatorRatePayload(creatorId: string) {
  const ownerId = asId(creatorId);
  if (!ownerId) throw new RevenueValidationError('Invalid creatorId');
  const creator = await AdminUserModel.findById(ownerId).select('name email role isActive').lean();
  if (!creator || !creator.isActive || creator.role !== 'influencer') {
    throw new RevenueValidationError('Creator not found', 404);
  }
  const now = new Date();
  const [current, fallback, history] = await Promise.all([
    getRateAt(now, ownerId),
    getRateAt(now),
    CreatorRevenueRateModel.find({ creatorId: ownerId }).sort({ effectiveFrom: -1 }).populate('setBy', 'name email').lean(),
  ]);
  return {
    scope: 'creator' as const,
    creatorId: ownerId.toString(),
    name: creator.name,
    email: creator.email,
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    rateInrPerHour: current.rateInrPerHour,
    effectiveFrom: current.effectiveFrom,
    source: current.source,
    defaultRate: {
      rateInrPerHour: fallback.rateInrPerHour,
      effectiveFrom: fallback.effectiveFrom,
    },
    ratePolicy: RATE_POLICY,
    history: mapRateHistory(history),
  };
}

export async function resolveCurrentRates(creatorIds: Types.ObjectId[], now = new Date()) {
  await ensureOpeningRate();
  const [fallback, overrides] = await Promise.all([
    latestRate({ creatorId: null }, now),
    creatorIds.length
      ? CreatorRevenueRateModel.aggregate<{ _id: Types.ObjectId; rateInrPerHour: number; effectiveFrom: Date }>([
        { $match: { creatorId: { $in: creatorIds }, effectiveFrom: { $lte: now } } },
        { $sort: { effectiveFrom: -1 } },
        { $group: { _id: '$creatorId', rateInrPerHour: { $first: '$rateInrPerHour' }, effectiveFrom: { $first: '$effectiveFrom' } } },
      ])
      : Promise.resolve([]),
  ]);
  const byCreator = new Map(overrides.map((row) => [String(row._id), row]));
  const fallbackRate = toResolved(fallback, 'default');
  return (creatorId: string) => {
    const own = byCreator.get(creatorId);
    if (own) {
      return { rateInrPerHour: own.rateInrPerHour, rateEffectiveFrom: own.effectiveFrom, rateSource: 'override' as const };
    }
    return {
      rateInrPerHour: fallbackRate.rateInrPerHour,
      rateEffectiveFrom: fallbackRate.effectiveFrom,
      rateSource: 'default' as const,
    };
  };
}

const catalogDuration = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

async function resolveBillable(input: RecordPlaybackInput): Promise<{ ok: true; billable: Billable } | { ok: false; reason: string }> {
  const episodeId = input.episodeId ? String(input.episodeId) : '';
  const contentId = String(input.contentId || '');
  if (episodeId && !asId(episodeId)) return { ok: false, reason: 'invalid' };
  if (!asId(episodeId || contentId)) return { ok: false, reason: 'invalid' };

  const targetId = episodeId || contentId;
  const hinted = episodeId ? 'episode' : input.contentType;
  const resolved = await resolveContent(targetId, hinted);
  if (!resolved) return { ok: false, reason: 'not_found' };

  if (resolved.type === 'TVShow') return { ok: false, reason: 'episode_required' };

  if (resolved.type === 'Episode') {
    const showId = String(resolved.doc.tvShowId || '');
    if (contentId && contentId !== String(resolved.doc._id) && contentId !== showId) {
      return { ok: false, reason: 'episode_mismatch' };
    }
    const show = asId(showId) ? await TVShowModel.findById(showId).select('title status createdBy').lean() : null;
    if (!show) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      billable: {
        assetId: resolved.doc._id,
        titleId: show._id,
        titleType: 'series',
        episodeId: resolved.doc._id,
        episodeKey: String(resolved.doc._id),
        creatorId: show.createdBy ? asId(show.createdBy) : null,
        published: show.status === 'published',
        catalogDuration: catalogDuration(resolved.doc.duration),
        title: show.title,
        episodeTitle: resolved.doc.title,
        season: resolved.doc.season,
        episodeNumber: resolved.doc.episode,
      },
    };
  }

  return {
    ok: true,
    billable: {
      assetId: resolved.doc._id,
      titleId: resolved.doc._id,
      titleType: 'movie',
      episodeId: null,
      episodeKey: '',
      creatorId: resolved.doc.createdBy ? asId(resolved.doc.createdBy) : null,
      published: resolved.doc.status === 'published',
      catalogDuration: catalogDuration(resolved.doc.duration),
      title: resolved.doc.title,
    },
  };
}

type CursorSnap = {
  lastEventAt: Date;
  lastPositionSeconds: number;
  creditedSeconds: number;
};

async function advanceCursor(
  filter: { viewerUserId: Types.ObjectId; contentId: Types.ObjectId; sessionId: string },
  next: { lastEventAt: Date; lastPositionSeconds: number }
): Promise<{ previous: CursorSnap | null; conflict: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await CreatorWatchCursorModel.findOne(filter).lean();
    if (!existing) {
      try {
        await CreatorWatchCursorModel.create({
          ...filter,
          lastEventAt: next.lastEventAt,
          lastPositionSeconds: next.lastPositionSeconds,
          creditedSeconds: 0,
        });
        return { previous: null, conflict: false };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        continue;
      }
    }
    const updated = await CreatorWatchCursorModel.updateOne(
      { _id: existing._id, lastEventAt: existing.lastEventAt },
      { $set: { lastEventAt: next.lastEventAt, lastPositionSeconds: next.lastPositionSeconds } }
    );
    if (updated.modifiedCount === 1) {
      return {
        previous: {
          lastEventAt: existing.lastEventAt,
          lastPositionSeconds: existing.lastPositionSeconds || 0,
          creditedSeconds: existing.creditedSeconds || 0,
        },
        conflict: false,
      };
    }
  }
  return { previous: null, conflict: true };
}

async function reserveSession(
  filter: { viewerUserId: Types.ObjectId; contentId: Types.ObjectId; sessionId: string },
  credit: number,
  cap: number
) {
  const updated = await CreatorWatchCursorModel.updateOne(
    { ...filter, creditedSeconds: { $lte: cap - credit } },
    { $inc: { creditedSeconds: credit } }
  );
  return updated.modifiedCount === 1;
}

async function releaseSession(
  filter: { viewerUserId: Types.ObjectId; contentId: Types.ObjectId; sessionId: string },
  credit: number
) {
  await CreatorWatchCursorModel.updateOne(filter, { $inc: { creditedSeconds: -credit } });
}

async function reserveDay(viewerUserId: Types.ObjectId, contentId: Types.ObjectId, day: string, credit: number, cap: number) {
  if (credit <= 0 || credit > cap) return false;
  const roomFilter = { viewerUserId, contentId, day, creditedSeconds: { $lte: cap - credit } };
  const updated = await CreatorWatchViewerDayModel.updateOne(roomFilter, { $inc: { creditedSeconds: credit } });
  if (updated.modifiedCount === 1) return true;
  try {
    await CreatorWatchViewerDayModel.create({ viewerUserId, contentId, day, creditedSeconds: credit });
    return true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const again = await CreatorWatchViewerDayModel.updateOne(roomFilter, { $inc: { creditedSeconds: credit } });
  return again.modifiedCount === 1;
}

async function releaseDay(viewerUserId: Types.ObjectId, contentId: Types.ObjectId, day: string, credit: number) {
  await CreatorWatchViewerDayModel.updateOne({ viewerUserId, contentId, day }, { $inc: { creditedSeconds: -credit } });
}

async function accrueDaily(input: {
  creatorId: Types.ObjectId;
  day: string;
  billable: Billable;
  creditedSeconds: number;
  earningUnits: number;
}) {
  const base = {
    creatorId: input.creatorId,
    day: input.day,
    titleId: input.billable.titleId,
    episodeKey: input.billable.episodeKey,
  };
  for (let generation = 0; generation < 8; generation += 1) {
    try {
      const $set: Record<string, unknown> = {
        titleType: input.billable.titleType,
        title: input.billable.title,
        episodeId: input.billable.episodeId,
      };
      if (input.billable.episodeTitle) $set.episodeTitle = input.billable.episodeTitle;
      if (input.billable.season != null) $set.season = input.billable.season;
      if (input.billable.episodeNumber != null) $set.episodeNumber = input.billable.episodeNumber;
      await CreatorRevenueDailyModel.updateOne(
        { ...base, generation, payoutId: null },
        {
          $inc: { watchSeconds: input.creditedSeconds, earningUnits: input.earningUnits },
          $set,
          $setOnInsert: {
            generation,
            payoutId: null,
            supplement: generation > 0,
          },
        },
        { upsert: true }
      );
      return generation;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  throw new Error('Creator revenue day is locked for payout and has no open supplement slot');
}

async function finishAccrual(creditId: Types.ObjectId) {
  const locked = await CreatorWatchCreditModel.findOneAndUpdate(
    { _id: creditId, applied: false },
    { $set: { applied: true } }
  ).lean();
  if (!locked || locked.creditedSeconds <= 0 || !locked.creatorId || !locked.titleId) return;
  const billable: Billable = {
    assetId: locked.contentId,
    titleId: locked.titleId,
    titleType: (locked.titleType || 'movie') as 'movie' | 'series',
    episodeId: locked.episodeId || null,
    episodeKey: locked.episodeId ? String(locked.episodeId) : '',
    creatorId: locked.creatorId,
    published: true,
    catalogDuration: null,
    title: '',
  };
  const saved = await CreatorWatchCreditModel.findById(creditId).lean();
  if (!saved) return;
  const titleRow = saved.titleType === 'series'
    ? await TVShowModel.findById(saved.titleId).select('title').lean()
    : await MovieModel.findById(saved.titleId).select('title').lean();
  let episodeTitle: string | undefined;
  let season: number | undefined;
  let episodeNumber: number | undefined;
  if (saved.episodeId) {
    const episode = await EpisodeModel.findById(saved.episodeId).select('title season episode').lean();
    episodeTitle = episode?.title;
    season = episode?.season;
    episodeNumber = episode?.episode;
  }
  try {
    await accrueDaily({
      creatorId: saved.creatorId as Types.ObjectId,
      day: saved.day,
      billable: {
        ...billable,
        title: titleRow?.title || 'Untitled',
        episodeTitle,
        season,
        episodeNumber,
      },
      creditedSeconds: saved.creditedSeconds,
      earningUnits: saved.earningUnits,
    });
  } catch (error) {
    await CreatorWatchCreditModel.updateOne({ _id: creditId }, { $set: { applied: false } });
    throw error;
  }
}

function progressSessionId(profileId?: string | null) {
  const profile = String(profileId || '').trim() || 'default';
  return `progress:${profile.slice(0, 80)}`;
}

export async function recordCreatorPlayback(input: RecordPlaybackInput): Promise<WatchCreditResult> {
  const now = input.now ?? new Date();
  const viewerUserId = asId(input.viewerUserId);
  if (!viewerUserId) return zero('invalid');

  const sessionId = input.source === 'progress'
    ? progressSessionId(input.profileId)
    : String(input.sessionId || '').trim();
  if (input.source === 'heartbeat') {
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(sessionId) || sessionId.startsWith('progress:')) return zero('invalid');
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(String(input.clientEventId || ''))) return zero('invalid');
  }

  const idempotencyKey = input.source === 'heartbeat'
    ? `hb:${viewerUserId.toString()}:${input.clientEventId}`
    : '';

  if (idempotencyKey) {
    const existing = await CreatorWatchCreditModel.findOne({ idempotencyKey }).lean();
    if (existing) {
      if (!existing.applied && existing.creditedSeconds > 0) await finishAccrual(existing._id);
      return presentCredit(existing, true);
    }
  }

  const resolved = await resolveBillable(input);
  if (resolved.ok === false) return zero(resolved.reason);
  const { billable } = resolved;

  let blockReason = '';
  const creator = billable.creatorId
    ? await AdminUserModel.findById(billable.creatorId).select('role email phone isActive').lean()
    : null;
  if (!billable.published) blockReason = 'not_published';
  else if (!creator) blockReason = 'no_owner';
  else if (creator.role !== 'influencer' || creator.isActive === false) blockReason = 'not_creator';
  else {
    const viewer = await UserModel.findById(viewerUserId).select('email phone').lean();
    if (viewer && isSameParty(viewer, creator)) blockReason = 'self_view';
  }

  const position = Math.max(0, Math.floor(Number(input.positionSeconds ?? 0)));
  const day = istDateKey(now);

  const storeReceipt = async (reason: string, creditedSeconds: number, reserved: boolean) => {
    if (input.source !== 'heartbeat' && creditedSeconds <= 0) return zero(reason);
    const rate = await getRateAt(now, billable.creatorId);
    const earningUnits = earningUnitsFor(creditedSeconds, rate.rateInrPerHour);
    const key = idempotencyKey || `pg:${viewerUserId.toString()}:${billable.assetId.toString()}:${sessionId}:${now.toISOString()}:${position}:${creditedSeconds}`;
    try {
      const created = await CreatorWatchCreditModel.create({
        idempotencyKey: key,
        source: input.source,
        viewerUserId,
        creatorId: billable.creatorId,
        contentId: billable.assetId,
        titleId: billable.titleId,
        titleType: billable.titleType,
        episodeId: billable.episodeId,
        sessionId,
        profileId: input.profileId || null,
        day,
        watchedAt: now,
        creditedSeconds,
        rateInrPerHour: rate.rateInrPerHour,
        ratePaisePerHour: rate.ratePaisePerHour,
        earningUnits,
        reason,
        applied: false,
      });
      if (creditedSeconds > 0) await finishAccrual(created._id);
      else await CreatorWatchCreditModel.updateOne({ _id: created._id }, { $set: { applied: true } });
      return presentCredit(created, false);
    } catch (error) {
      if (!isDuplicateKey(error)) {
        if (reserved && creditedSeconds > 0) {
          await releaseSession({ viewerUserId, contentId: billable.assetId, sessionId }, creditedSeconds);
          await releaseDay(viewerUserId, billable.assetId, day, creditedSeconds);
        }
        throw error;
      }
      if (reserved && creditedSeconds > 0) {
        await releaseSession({ viewerUserId, contentId: billable.assetId, sessionId }, creditedSeconds);
        await releaseDay(viewerUserId, billable.assetId, day, creditedSeconds);
      }
      const existing = await CreatorWatchCreditModel.findOne({ idempotencyKey: key }).lean();
      if (existing && !existing.applied && existing.creditedSeconds > 0) await finishAccrual(existing._id);
      return presentCredit(existing || { creditedSeconds: 0, reason }, true);
    }
  };

  if (blockReason) return storeReceipt(blockReason, 0, false);

  if (input.source === 'progress') {
    const heartbeatActive = await CreatorWatchCursorModel.exists({
      viewerUserId,
      contentId: billable.assetId,
      sessionId: { $not: /^progress:/ },
    });
    if (heartbeatActive) return zero('heartbeat_active');
  }

  const cursorFilter = { viewerUserId, contentId: billable.assetId, sessionId };
  const advanced = await advanceCursor(cursorFilter, { lastEventAt: now, lastPositionSeconds: position });
  if (advanced.conflict) return zero('conflict');

  let sessionCredited = advanced.previous?.creditedSeconds ?? 0;
  let played = 0;
  let wall: number | null = null;
  const anchorWithoutWall = input.source === 'progress';

  if (!advanced.previous) {
    if (input.source === 'progress') return zero('anchor');
    played = Math.floor(Number(input.playedSeconds ?? 0));
  } else {
    wall = (now.getTime() - new Date(advanced.previous.lastEventAt).getTime()) / 1000;
    const gap = wall > REVENUE_LIMITS.sessionGapSeconds;
    if (gap) {
      sessionCredited = 0;
      await CreatorWatchCursorModel.updateOne(cursorFilter, { $set: { creditedSeconds: 0 } });
    }
    if (input.source === 'progress' && position + 5 < advanced.previous.lastPositionSeconds) {
      await CreatorWatchCursorModel.updateOne(cursorFilter, { $set: { creditedSeconds: 0 } });
      return zero('rewind');
    }
    if (input.source === 'progress') {
      played = Math.max(0, position - Math.floor(advanced.previous.lastPositionSeconds));
    } else {
      played = Math.floor(Number(input.playedSeconds ?? 0));
    }
  }

  const dayDoc = await CreatorWatchViewerDayModel.findOne({
    viewerUserId,
    contentId: billable.assetId,
    day,
  }).lean();
  const decision = decidePlaybackCredit({
    playedSeconds: played,
    wallElapsedSeconds: wall,
    anchorWithoutWall,
    sessionCreditedSeconds: sessionCredited,
    dayCreditedSeconds: dayDoc?.creditedSeconds || 0,
    sessionCap: sessionCapSeconds(billable.catalogDuration),
    dailyCap: dailyCapSeconds(billable.catalogDuration),
  });

  let creditedSeconds = decision.creditedSeconds;
  let reason = decision.reason;
  let reserved = false;
  if (creditedSeconds > 0) {
    const sessionOk = await reserveSession(
      cursorFilter,
      creditedSeconds,
      sessionCapSeconds(billable.catalogDuration)
    );
    if (!sessionOk) {
      creditedSeconds = 0;
      reason = 'session_cap';
    } else {
      const dayOk = await reserveDay(
        viewerUserId,
        billable.assetId,
        day,
        creditedSeconds,
        dailyCapSeconds(billable.catalogDuration)
      );
      if (!dayOk) {
        await releaseSession(cursorFilter, creditedSeconds);
        creditedSeconds = 0;
        reason = 'daily_cap';
      } else {
        reserved = true;
      }
    }
  }

  return storeReceipt(reason, creditedSeconds, reserved);
}

type DailyGroup = {
  _id: {
    creatorId?: Types.ObjectId;
    titleId: Types.ObjectId;
    titleType: 'movie' | 'series';
    episodeKey: string;
  };
  watchSeconds: number;
  earningUnits: number;
  title?: string;
  episodeTitle?: string;
  season?: number;
  episodeNumber?: number;
  episodeId?: Types.ObjectId | null;
};

function dayMatch(period: RevenuePeriod) {
  if (!period.from || !period.to) return {};
  return { day: { $gte: period.from, $lte: period.to } };
}

function nestTitles(rows: DailyGroup[]) {
  const titles = new Map<string, {
    titleId: string;
    titleType: 'movie' | 'series';
    title: string;
    watchSeconds: number;
    earningUnits: number;
    episodes: Array<{
      episodeId: string;
      season: number | null;
      episode: number | null;
      title: string;
      watchSeconds: number;
      earningUnits: number;
    }>;
  }>();

  for (const row of rows) {
    const titleId = String(row._id.titleId);
    let title = titles.get(titleId);
    if (!title) {
      title = {
        titleId,
        titleType: row._id.titleType,
        title: row.title || 'Untitled',
        watchSeconds: 0,
        earningUnits: 0,
        episodes: [],
      };
      titles.set(titleId, title);
    }
    if (row.title) title.title = row.title;
    title.watchSeconds += row.watchSeconds || 0;
    title.earningUnits += row.earningUnits || 0;
    if (row._id.episodeKey) {
      title.episodes.push({
        episodeId: row.episodeId ? String(row.episodeId) : row._id.episodeKey,
        season: row.season ?? null,
        episode: row.episodeNumber ?? null,
        title: row.episodeTitle || 'Episode',
        watchSeconds: row.watchSeconds || 0,
        earningUnits: row.earningUnits || 0,
      });
    }
  }

  return [...titles.values()]
    .map((title) => {
      const episodes = title.episodes
        .sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0))
        .map((episode) => ({
          episodeId: episode.episodeId,
          season: episode.season,
          episode: episode.episode,
          title: episode.title,
          ...presentMoney(episode.watchSeconds, episode.earningUnits),
        }));
      return {
        titleId: title.titleId,
        titleType: title.titleType,
        title: title.title,
        ...presentMoney(title.watchSeconds, title.earningUnits),
        ...(title.titleType === 'series' ? { episodes } : {}),
      };
    })
    .sort((a, b) => b.watchSeconds - a.watchSeconds || a.title.localeCompare(b.title));
}

async function groupedTitles(match: Record<string, unknown>) {
  return CreatorRevenueDailyModel.aggregate<DailyGroup>([
    { $match: match },
    {
      $group: {
        _id: {
          creatorId: '$creatorId',
          titleId: '$titleId',
          titleType: '$titleType',
          episodeKey: '$episodeKey',
        },
        watchSeconds: { $sum: '$watchSeconds' },
        earningUnits: { $sum: '$earningUnits' },
        title: { $last: '$title' },
        episodeTitle: { $last: '$episodeTitle' },
        season: { $last: '$season' },
        episodeNumber: { $last: '$episodeNumber' },
        episodeId: { $last: '$episodeId' },
      },
    },
  ]);
}

export async function creatorRevenueSummary(creatorId: string, period: RevenuePeriod) {
  const ownerId = asId(creatorId);
  if (!ownerId) throw new RevenueValidationError('Invalid creator');
  const match = { creatorId: ownerId, ...dayMatch(period) };
  const [totals, titleIds, rate] = await Promise.all([
    CreatorRevenueDailyModel.aggregate<{ watchSeconds: number; earningUnits: number }>([
      { $match: match },
      { $group: { _id: null, watchSeconds: { $sum: '$watchSeconds' }, earningUnits: { $sum: '$earningUnits' } } },
    ]),
    CreatorRevenueDailyModel.distinct('titleId', match),
    getRateAt(new Date(), ownerId),
  ]);
  const row = totals[0] || { watchSeconds: 0, earningUnits: 0 };
  return {
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    period,
    rate: {
      currency: REVENUE_CURRENCY,
      rateInrPerHour: rate.rateInrPerHour,
      effectiveFrom: rate.effectiveFrom,
      source: rate.source,
    },
    ratePolicy: RATE_POLICY,
    ...presentMoney(row.watchSeconds || 0, row.earningUnits || 0),
    titleCount: titleIds.length,
  };
}

export async function creatorRevenueTitles(creatorId: string, period: RevenuePeriod, page: number, limit: number) {
  const ownerId = asId(creatorId);
  if (!ownerId) throw new RevenueValidationError('Invalid creator');
  const titles = nestTitles(await groupedTitles({ creatorId: ownerId, ...dayMatch(period) }));
  const skip = (page - 1) * limit;
  return {
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    period,
    items: titles.slice(skip, skip + limit),
    pagination: {
      total: titles.length,
      page,
      limit,
      pages: Math.ceil(titles.length / limit) || 0,
    },
  };
}

export async function creatorRevenueSeries(creatorId: string, period: RevenuePeriod) {
  const ownerId = asId(creatorId);
  if (!ownerId) throw new RevenueValidationError('Invalid creator');
  const rows = await CreatorRevenueDailyModel.aggregate<{ _id: string; watchSeconds: number; earningUnits: number }>([
    { $match: { creatorId: ownerId, ...dayMatch(period) } },
    { $group: { _id: '$day', watchSeconds: { $sum: '$watchSeconds' }, earningUnits: { $sum: '$earningUnits' } } },
    { $sort: { _id: 1 } },
  ]);
  return {
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    period,
    points: buildDailySeries(
      rows.map((row) => ({ day: row._id, watchSeconds: row.watchSeconds, earningUnits: row.earningUnits })),
      period
    ),
  };
}

export async function adminRevenueOverview(input: {
  period: RevenuePeriod;
  creatorId?: string | null;
  page: number;
  limit: number;
}) {
  const match: Record<string, unknown> = { ...dayMatch(input.period) };
  if (input.creatorId) {
    const creatorId = asId(input.creatorId);
    if (!creatorId) throw new RevenueValidationError('Invalid creatorId');
    match.creatorId = creatorId;
  }
  const creators = await CreatorRevenueDailyModel.aggregate<{
    _id: Types.ObjectId;
    watchSeconds: number;
    earningUnits: number;
  }>([
    { $match: match },
    { $group: { _id: '$creatorId', watchSeconds: { $sum: '$watchSeconds' }, earningUnits: { $sum: '$earningUnits' } } },
    { $sort: { earningUnits: -1, _id: 1 } },
  ]);
  const totals = creators.reduce(
    (sum, row) => {
      sum.watchSeconds += row.watchSeconds || 0;
      sum.earningUnits += row.earningUnits || 0;
      return sum;
    },
    { watchSeconds: 0, earningUnits: 0 }
  );
  const skip = (input.page - 1) * input.limit;
  const pageRows = creators.slice(skip, skip + input.limit);
  const pageIds = pageRows.map((row) => row._id);
  const [titleRows, users, rateFor] = await Promise.all([
    pageIds.length ? groupedTitles({ ...match, creatorId: { $in: pageIds } }) : Promise.resolve([]),
    pageIds.length
      ? AdminUserModel.find({ _id: { $in: pageIds } }).select('name email').lean()
      : Promise.resolve([]),
    resolveCurrentRates(pageIds),
  ]);
  const titlesByCreator = new Map<string, DailyGroup[]>();
  for (const row of titleRows) {
    const id = String(row._id.creatorId);
    const list = titlesByCreator.get(id) || [];
    list.push(row);
    titlesByCreator.set(id, list);
  }
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  return {
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    period: input.period,
    totals: {
      ...presentMoney(totals.watchSeconds, totals.earningUnits),
      creatorCount: creators.length,
    },
    creators: pageRows.map((row) => {
      const user = usersById.get(String(row._id));
      return {
        creatorId: String(row._id),
        name: user?.name || 'Unknown',
        email: user?.email || '',
        ...rateFor(String(row._id)),
        ...presentMoney(row.watchSeconds || 0, row.earningUnits || 0),
        titles: nestTitles(titlesByCreator.get(String(row._id)) || []),
      };
    }),
    pagination: {
      total: creators.length,
      page: input.page,
      limit: input.limit,
      pages: Math.ceil(creators.length / input.limit) || 0,
    },
  };
}

export function logRevenueFailure(error: unknown, message: string) {
  logger.error({ error }, message);
}
