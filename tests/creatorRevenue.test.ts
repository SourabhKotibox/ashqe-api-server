import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  REVENUE_LIMITS,
  addIstDays,
  amountInrFromPaise,
  amountPaiseFromUnits,
  buildDailySeries,
  dailyCapSeconds,
  decidePlaybackCredit,
  earningUnitsFor,
  inclusiveDayCount,
  istDateKey,
  isSameParty,
  normalizeRateInr,
  presentMoney,
  resolveRevenuePeriod,
  sessionCapSeconds,
} from '../src/lib/creatorRevenue.ts';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'creator-revenue-test-secret';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

describe('creator revenue math and rules', () => {
  test('one watch hour at Rs 5 is Rs 5, and later rates do not change that sum', () => {
    const firstHour = earningUnitsFor(3600, 5);
    const secondHour = earningUnitsFor(3600, 10);
    assert.equal(amountPaiseFromUnits(firstHour), 500);
    assert.equal(amountInrFromPaise(500), 5);
    assert.equal(presentMoney(1800, earningUnitsFor(1800, 5)).amountInr, 2.5);
    assert.equal(amountPaiseFromUnits(earningUnitsFor(1, 5)), 0);
    assert.equal(amountPaiseFromUnits(earningUnitsFor(7, 5)), 1);
    assert.equal(amountPaiseFromUnits(firstHour + secondHour), 1500);
    assert.equal(amountInrFromPaise(1500), 15);
  });

  test('rate values are rupees with at most two decimal places', () => {
    assert.equal(normalizeRateInr(5), 5);
    assert.equal(normalizeRateInr('5.50'), 5.5);
    assert.equal(normalizeRateInr(0), 0);
    assert.equal(normalizeRateInr(5.555), null);
    assert.equal(normalizeRateInr(-1), null);
    assert.equal(normalizeRateInr(100_001), null);
  });

  test('playback credits ignore seeks, anchor the first progress save, and honor caps', () => {
    assert.deepEqual(
      decidePlaybackCredit({
        playedSeconds: 100,
        wallElapsedSeconds: null,
        anchorWithoutWall: false,
        sessionCreditedSeconds: 0,
        dayCreditedSeconds: 0,
        sessionCap: 3600,
        dailyCap: 7200,
      }),
      { creditedSeconds: REVENUE_LIMITS.maxEventSeconds, reason: 'credited' }
    );
    assert.equal(
      decidePlaybackCredit({
        playedSeconds: 30,
        wallElapsedSeconds: null,
        anchorWithoutWall: true,
        sessionCreditedSeconds: 0,
        dayCreditedSeconds: 0,
        sessionCap: 3600,
        dailyCap: 7200,
      }).reason,
      'anchor'
    );
    assert.equal(
      decidePlaybackCredit({
        playedSeconds: 45,
        wallElapsedSeconds: 10,
        anchorWithoutWall: false,
        sessionCreditedSeconds: 0,
        dayCreditedSeconds: 0,
        sessionCap: 3600,
        dailyCap: 7200,
      }).reason,
      'impossible_delta'
    );
    assert.deepEqual(
      decidePlaybackCredit({
        playedSeconds: 45,
        wallElapsedSeconds: 45,
        anchorWithoutWall: false,
        sessionCreditedSeconds: 50,
        dayCreditedSeconds: 0,
        sessionCap: 60,
        dailyCap: 7200,
      }),
      { creditedSeconds: 10, reason: 'credited' }
    );
    assert.equal(
      decidePlaybackCredit({
        playedSeconds: 45,
        wallElapsedSeconds: 45,
        anchorWithoutWall: false,
        sessionCreditedSeconds: 60,
        dayCreditedSeconds: 0,
        sessionCap: 60,
        dailyCap: 7200,
      }).reason,
      'session_cap'
    );
    assert.deepEqual(
      decidePlaybackCredit({
        playedSeconds: 45,
        wallElapsedSeconds: 45,
        anchorWithoutWall: false,
        sessionCreditedSeconds: 0,
        dayCreditedSeconds: 100,
        sessionCap: 3600,
        dailyCap: 110,
      }),
      { creditedSeconds: 10, reason: 'credited' }
    );
    assert.equal(
      decidePlaybackCredit({
        playedSeconds: 0,
        wallElapsedSeconds: 10,
        anchorWithoutWall: false,
        sessionCreditedSeconds: 0,
        dayCreditedSeconds: 0,
        sessionCap: 3600,
        dailyCap: 7200,
      }).reason,
      'non_positive'
    );
  });

  test('caps follow catalog duration and reject the creator matching their own viewer', () => {
    assert.equal(sessionCapSeconds(60), 60);
    assert.equal(sessionCapSeconds(null), REVENUE_LIMITS.sessionCapFallbackSeconds);
    assert.equal(sessionCapSeconds(13 * 3600), REVENUE_LIMITS.sessionCapFallbackSeconds);
    assert.equal(dailyCapSeconds(60), REVENUE_LIMITS.dailyFloorSeconds);
    assert.equal(dailyCapSeconds(3600), 3 * 3600);
    assert.equal(dailyCapSeconds(undefined), REVENUE_LIMITS.dailyCeilingSeconds);
    assert.equal(isSameParty({ email: 'A@Ashqe.test' }, { email: 'a@ashqe.test' }), true);
    assert.equal(isSameParty({ phone: '+91 98765 43210' }, { phone: '9876543210' }), true);
    assert.equal(isSameParty({ email: 'viewer@ashqe.test', phone: '1111111111' }, { email: 'creator@ashqe.test', phone: '2222222222' }), false);
  });

  test('periods use Asia/Kolkata and charts keep empty days', () => {
    const justAfterMidnight = resolveRevenuePeriod({ period: 'today', now: new Date('2026-01-15T18:31:00Z') });
    assert.equal(justAfterMidnight.ok, true);
    if (justAfterMidnight.ok) {
      assert.equal(justAfterMidnight.period.from, '2026-01-16');
      assert.equal(justAfterMidnight.period.to, '2026-01-16');
    }
    const previousEvening = resolveRevenuePeriod({ period: '7d', now: new Date('2026-01-15T18:29:00Z') });
    assert.equal(previousEvening.ok, true);
    if (previousEvening.ok) {
      assert.equal(previousEvening.period.from, '2026-01-09');
      assert.equal(previousEvening.period.to, '2026-01-15');
      assert.equal(inclusiveDayCount(previousEvening.period.from!, previousEvening.period.to!), 7);
    }
    assert.equal(addIstDays('2026-01-15', -6), '2026-01-09');
    const custom = resolveRevenuePeriod({ period: 'custom', from: '2026-02-02', to: '2026-02-01' });
    assert.equal(custom.ok, false);
    const missing = resolveRevenuePeriod({ period: 'custom' });
    assert.equal(missing.ok, false);
    const tooLong = resolveRevenuePeriod({ period: 'custom', from: '2024-01-01', to: '2026-01-01' });
    assert.equal(tooLong.ok, false);
    const all = resolveRevenuePeriod({ period: 'all' });
    assert.equal(all.ok && all.period.from, null);

    const points = buildDailySeries(
      [{ day: '2026-01-02', watchSeconds: 3600, earningUnits: earningUnitsFor(3600, 5) }],
      { key: 'custom', from: '2026-01-01', to: '2026-01-03', timezone: 'Asia/Kolkata' }
    );
    assert.deepEqual(points.map((point) => point.date), ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.equal(points[1].amountInr, 5);
    assert.equal(points[0].watchSeconds, 0);
  });
});

describe('creator revenue ledger and API', { concurrency: 1, timeout: 300000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let recordCreatorPlayback: typeof import('../src/lib/creatorRevenueLedger.ts').recordCreatorPlayback;
  let setWatchHourRate: typeof import('../src/lib/creatorRevenueLedger.ts').setWatchHourRate;
  let setCreatorWatchHourRate: typeof import('../src/lib/creatorRevenueLedger.ts').setCreatorWatchHourRate;
  let MovieModel: typeof import('../src/models/Movie.ts').MovieModel;
  let TVShowModel: typeof import('../src/models/TVShow.ts').TVShowModel;
  let EpisodeModel: typeof import('../src/models/Episode.ts').EpisodeModel;
  let UserModel: typeof import('../src/models/User.ts').UserModel;
  let AdminUserModel: typeof import('../src/models/AdminUser.ts').AdminUserModel;
  let CreatorRevenueDailyModel: typeof import('../src/models/CreatorRevenueDaily.ts').CreatorRevenueDailyModel;
  let CreatorWatchCreditModel: typeof import('../src/models/CreatorWatchCredit.ts').CreatorWatchCreditModel;
  let CreatorWatchCursorModel: typeof import('../src/models/CreatorWatchCursor.ts').CreatorWatchCursorModel;
  let CreatorWatchViewerDayModel: typeof import('../src/models/CreatorWatchViewerDay.ts').CreatorWatchViewerDayModel;

  let adminToken = '';
  let adminId = '';
  let staffAdminToken = '';
  let moderatorToken = '';
  let moderatorId = '';
  let creatorAToken = '';
  let creatorAId = '';
  let creatorBToken = '';
  let creatorBId = '';
  let viewerId = '';
  let viewerToken = '';
  let selfViewerToken = '';
  let phoneViewerToken = '';

  const call = (method: string, url: string, token?: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const bodyOf = async (res: any) => {
    const text = typeof res.body === 'string' ? res.body : res.payload;
    return text ? JSON.parse(text) : {};
  };

  const userToken = (id: string, name: string) =>
    jwt.sign({ id, name, role: 'user' }, process.env.JWT_SECRET || 'creator-revenue-test-secret');

  const play = async (input: {
    viewerId: string;
    contentId: string;
    episodeId?: string;
    sessionId: string;
    seconds: number;
    start: Date;
    played?: number;
  }) => {
    const step = input.played || REVENUE_LIMITS.maxEventSeconds;
    let now = input.start;
    let credited = 0;
    const events = Math.ceil(input.seconds / step);
    for (let i = 0; i < events; i += 1) {
      const playedSeconds = Math.min(step, input.seconds - i * step);
      const result = await recordCreatorPlayback({
        source: 'heartbeat',
        viewerUserId: input.viewerId,
        contentId: input.contentId,
        episodeId: input.episodeId,
        sessionId: input.sessionId,
        clientEventId: `${input.sessionId}-${i}-${now.getTime()}`,
        playedSeconds,
        positionSeconds: (i + 1) * playedSeconds,
        now,
      });
      credited += result.creditedSeconds;
      now = new Date(now.getTime() + playedSeconds * 1000);
    }
    return credited;
  };

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = await import('mongoose');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    app = (await import('../src/app.ts')).default;
    await app.ready();
    ({ recordCreatorPlayback, setWatchHourRate, setCreatorWatchHourRate } = await import('../src/lib/creatorRevenueLedger.ts'));
    ({ MovieModel } = await import('../src/models/Movie.ts'));
    ({ TVShowModel } = await import('../src/models/TVShow.ts'));
    ({ EpisodeModel } = await import('../src/models/Episode.ts'));
    ({ UserModel } = await import('../src/models/User.ts'));
    ({ AdminUserModel } = await import('../src/models/AdminUser.ts'));
    ({ CreatorRevenueDailyModel } = await import('../src/models/CreatorRevenueDaily.ts'));
    ({ CreatorWatchCreditModel } = await import('../src/models/CreatorWatchCredit.ts'));
    ({ CreatorWatchCursorModel } = await import('../src/models/CreatorWatchCursor.ts'));
    ({ CreatorWatchViewerDayModel } = await import('../src/models/CreatorWatchViewerDay.ts'));
    await Promise.all([
      CreatorRevenueDailyModel.syncIndexes(),
      CreatorWatchCreditModel.syncIndexes(),
      CreatorWatchCursorModel.syncIndexes(),
      CreatorWatchViewerDayModel.syncIndexes(),
      (await import('../src/models/CreatorRevenueRate.ts')).CreatorRevenueRateModel.syncIndexes(),
    ]);

    const passwordHash = await bcrypt.hash('AdminPass123!', 8);
    const superadmin = await AdminUserModel.create({
      email: 'revenue-admin@ashqe.test',
      name: 'Revenue Admin',
      passwordHash,
      role: 'superadmin',
      isActive: true,
    });
    adminId = superadmin._id.toString();
    const staff = await AdminUserModel.create({
      email: 'revenue-staff@ashqe.test',
      name: 'Staff Admin',
      passwordHash,
      role: 'admin',
      isActive: true,
    });
    const moderator = await AdminUserModel.create({
      email: 'revenue-mod@ashqe.test',
      name: 'Moderator',
      passwordHash,
      role: 'moderator',
      isActive: true,
    });
    moderatorId = moderator._id.toString();
    const creatorA = await AdminUserModel.create({
      email: 'creator-a@ashqe.test',
      name: 'Creator A',
      phone: '9000000001',
      passwordHash,
      role: 'influencer',
      isActive: true,
    });
    creatorAId = creatorA._id.toString();
    const creatorB = await AdminUserModel.create({
      email: 'creator-b@ashqe.test',
      name: 'Creator B',
      phone: '9000000002',
      passwordHash,
      role: 'influencer',
      isActive: true,
    });
    creatorBId = creatorB._id.toString();

    const login = async (email: string) => {
      const res = await bodyOf(await call('POST', '/api/auth/login', undefined, { email, password: 'AdminPass123!' }));
      assert.equal(typeof res.accessToken, 'string');
      return res.accessToken as string;
    };
    adminToken = await login('revenue-admin@ashqe.test');
    staffAdminToken = await login('revenue-staff@ashqe.test');
    moderatorToken = await login('revenue-mod@ashqe.test');
    creatorAToken = await login('creator-a@ashqe.test');
    creatorBToken = await login('creator-b@ashqe.test');

    const viewer = await UserModel.create({ email: 'viewer@ashqe.test', name: 'Viewer', phone: '9111111111' });
    const selfViewer = await UserModel.create({ email: 'creator-a@ashqe.test', name: 'Creator As Viewer', phone: '8222222222' });
    const phoneViewer = await UserModel.create({ email: 'other-phone@ashqe.test', name: 'Phone Match', phone: '+91 90000 00002' });
    viewerId = viewer._id.toString();
    viewerToken = userToken(viewerId, 'Viewer');
    selfViewerToken = userToken(selfViewer._id.toString(), 'Self');
    phoneViewerToken = userToken(phoneViewer._id.toString(), 'Phone');
    void staff;
  });

  after(async () => {
    if (app) await app.close();
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  test('heartbeat, progress, and caps reject inflated watch time', async () => {
    const movie = await MovieModel.create({
      title: 'Cap Film',
      status: 'published',
      createdBy: creatorAId,
      duration: 60,
    });
    const movieId = movie._id.toString();

    const first = await bodyOf(await call('POST', '/api/app/watch/heartbeat', viewerToken, {
      contentId: movieId,
      sessionId: 'session-cap-1',
      clientEventId: 'event-cap-1',
      playedSeconds: 100,
      positionSeconds: 100,
      durationSeconds: 60,
    }));
    assert.equal(first.success, true);
    assert.equal(first.data.creditedSeconds, REVENUE_LIMITS.maxEventSeconds);
    assert.equal(first.data.duplicate, false);

    const duplicate = await bodyOf(await call('POST', '/api/app/watch/heartbeat', viewerToken, {
      contentId: movieId,
      sessionId: 'session-cap-1',
      clientEventId: 'event-cap-1',
      playedSeconds: 100,
      positionSeconds: 100,
    }));
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.creditedSeconds, REVENUE_LIMITS.maxEventSeconds);

    const capCursor = await CreatorWatchCursorModel.findOne({ sessionId: 'session-cap-1' }).lean();
    const capStart = new Date(capCursor!.lastEventAt).getTime();
    const impossible = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: movieId,
      sessionId: 'session-cap-1',
      clientEventId: 'event-cap-fast',
      playedSeconds: 45,
      positionSeconds: 145,
      now: new Date(capStart + 1000),
    });
    assert.equal(impossible.reason, 'impossible_delta');
    assert.equal(impossible.creditedSeconds, 0);

    const room = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: movieId,
      sessionId: 'session-cap-1',
      clientEventId: 'event-cap-room',
      playedSeconds: 45,
      positionSeconds: 60,
      now: new Date(capStart + 60_000),
    });
    assert.equal(room.creditedSeconds, 60 - REVENUE_LIMITS.maxEventSeconds);
    const blocked = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: movieId,
      sessionId: 'session-cap-1',
      clientEventId: 'event-cap-blocked',
      playedSeconds: 30,
      positionSeconds: 60,
      now: new Date(capStart + 120_000),
    });
    assert.equal(blocked.reason, 'session_cap');

    const dailyMovie = await MovieModel.create({
      title: 'Daily Cap Film',
      status: 'published',
      createdBy: creatorAId,
      duration: 3600,
    });
    const dailyWhen = new Date('2026-05-05T06:00:00.000Z');
    await CreatorWatchViewerDayModel.create({
      viewerUserId: viewerId,
      contentId: dailyMovie._id,
      day: istDateKey(dailyWhen),
      creditedSeconds: dailyCapSeconds(3600) - 10,
    });
    const partialDay = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: dailyMovie._id.toString(),
      sessionId: 'session-daily-1',
      clientEventId: 'event-daily-1',
      playedSeconds: 45,
      positionSeconds: 45,
      now: dailyWhen,
    });
    assert.equal(partialDay.creditedSeconds, 10);
    const dayBlocked = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: dailyMovie._id.toString(),
      sessionId: 'session-daily-2',
      clientEventId: 'event-daily-2',
      playedSeconds: 45,
      positionSeconds: 45,
      now: new Date(dailyWhen.getTime() + 60_000),
    });
    assert.equal(dayBlocked.reason, 'daily_cap');

    const progressMovie = await MovieModel.create({
      title: 'Progress Film',
      status: 'published',
      createdBy: creatorAId,
      duration: 7200,
    });
    const progressId = progressMovie._id.toString();
    const anchor = await bodyOf(await call('POST', '/api/app/watch/progress', viewerToken, {
      contentId: progressId,
      progressSeconds: 25,
      durationSeconds: 7200,
    }));
    assert.equal(anchor.revenue.reason, 'anchor');
    assert.equal(anchor.revenue.creditedSeconds, 0);

    await CreatorWatchCursorModel.updateOne(
      { viewerUserId: viewerId, contentId: progressMovie._id, sessionId: 'progress:default' },
      { $set: { lastEventAt: new Date(Date.now() - 20_000) } }
    );
    const forward = await bodyOf(await call('POST', '/api/app/watch/progress', viewerToken, {
      contentId: progressId,
      progressSeconds: 45,
      durationSeconds: 7200,
    }));
    assert.equal(forward.revenue.creditedSeconds, 20);
    assert.equal(forward.revenue.reason, 'credited');

    await CreatorWatchCursorModel.updateOne(
      { viewerUserId: viewerId, contentId: progressMovie._id, sessionId: 'progress:default' },
      { $set: { lastEventAt: new Date(Date.now() - 1000), lastPositionSeconds: 45 } }
    );
    const seek = await bodyOf(await call('POST', '/api/app/watch/progress', viewerToken, {
      contentId: progressId,
      progressSeconds: 4000,
      durationSeconds: 7200,
    }));
    assert.equal(seek.revenue.reason, 'impossible_delta');
    assert.equal(seek.revenue.creditedSeconds, 0);

    await CreatorWatchCursorModel.updateOne(
      { viewerUserId: viewerId, contentId: progressMovie._id, sessionId: 'progress:default' },
      { $set: { lastEventAt: new Date(Date.now() - 5000), lastPositionSeconds: 4000, creditedSeconds: 20 } }
    );
    const rewind = await bodyOf(await call('POST', '/api/app/watch/progress', viewerToken, {
      contentId: progressId,
      progressSeconds: 10,
      durationSeconds: 7200,
    }));
    assert.equal(rewind.revenue.reason, 'rewind');

    const heartbeat = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: progressId,
      sessionId: 'session-progress-live',
      clientEventId: 'event-progress-live',
      playedSeconds: 15,
      positionSeconds: 15,
    });
    assert.equal(heartbeat.creditedSeconds, 15);
    const suppressed = await recordCreatorPlayback({
      source: 'progress',
      viewerUserId: viewerId,
      contentId: progressId,
      positionSeconds: 40,
      now: new Date(Date.now() + 20_000),
    });
    assert.equal(suppressed.reason, 'heartbeat_active');
    assert.equal(suppressed.creditedSeconds, 0);
  });

  test('only a published creator-owned title earns, and episodes pay the series owner', async () => {
    const owned = await MovieModel.create({ title: 'Owned', status: 'published', createdBy: creatorAId, duration: 3600 });
    const other = await MovieModel.create({ title: 'Other', status: 'published', createdBy: creatorBId, duration: 3600 });
    const draft = await MovieModel.create({ title: 'Draft', status: 'draft', createdBy: creatorAId, duration: 3600 });
    const staff = await AdminUserModel.findOne({ role: 'superadmin' });
    const staffMovie = await MovieModel.create({ title: 'Staff Film', status: 'published', createdBy: staff!._id, duration: 3600 });
    const orphan = await MovieModel.create({ title: 'Orphan', status: 'published', duration: 3600 });
    const show = await TVShowModel.create({ title: 'Owned Show', status: 'published', createdBy: creatorAId });
    const episode = await EpisodeModel.create({
      tvShowId: show._id,
      season: 1,
      episode: 1,
      title: 'Pilot',
      duration: 1800,
      createdBy: creatorBId,
    });

    const ownedCredit = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: owned._id.toString(),
      sessionId: 'session-owned',
      clientEventId: 'event-owned',
      playedSeconds: 30,
      positionSeconds: 30,
    });
    assert.equal(ownedCredit.creditedSeconds, 30);

    const otherCredit = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: other._id.toString(),
      sessionId: 'session-other',
      clientEventId: 'event-other',
      playedSeconds: 30,
      positionSeconds: 30,
    });
    assert.equal(otherCredit.creditedSeconds, 30);

    assert.equal((await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: draft._id.toString(),
      sessionId: 'session-draft',
      clientEventId: 'event-draft',
      playedSeconds: 30,
      positionSeconds: 30,
    })).reason, 'not_published');
    assert.equal(await CreatorRevenueDailyModel.countDocuments({ titleId: draft._id }), 0);

    assert.equal((await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: staffMovie._id.toString(),
      sessionId: 'session-staff',
      clientEventId: 'event-staff',
      playedSeconds: 30,
      positionSeconds: 30,
    })).reason, 'not_creator');
    assert.equal((await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: orphan._id.toString(),
      sessionId: 'session-orphan',
      clientEventId: 'event-orphan',
      playedSeconds: 30,
      positionSeconds: 30,
    })).reason, 'no_owner');

    const episodeCredit = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: show._id.toString(),
      episodeId: episode._id.toString(),
      sessionId: 'session-episode',
      clientEventId: 'event-episode',
      playedSeconds: 30,
      positionSeconds: 30,
    });
    assert.equal(episodeCredit.creditedSeconds, 30);
    const episodeDaily = await CreatorRevenueDailyModel.findOne({ episodeId: episode._id }).lean();
    assert.equal(String(episodeDaily?.creatorId), creatorAId);
    assert.equal(episodeDaily?.titleType, 'series');

    const self = await bodyOf(await call('POST', '/api/app/watch/heartbeat', selfViewerToken, {
      contentId: owned._id.toString(),
      sessionId: 'session-self',
      clientEventId: 'event-self',
      playedSeconds: 20,
      positionSeconds: 20,
    }));
    assert.equal(self.data.reason, 'self_view');
    assert.equal(self.data.creditedSeconds, 0);
    const phone = await bodyOf(await call('POST', '/api/app/watch/heartbeat', phoneViewerToken, {
      contentId: other._id.toString(),
      sessionId: 'session-phone',
      clientEventId: 'event-phone',
      playedSeconds: 20,
      positionSeconds: 20,
    }));
    assert.equal(phone.data.reason, 'self_view');

    const summaryA = await bodyOf(await call('GET', `/api/creator/revenue/summary?period=all&creatorId=${creatorBId}`, creatorAToken));
    assert.equal(summaryA.success, true);
    const summaryB = await bodyOf(await call('GET', '/api/creator/revenue/summary?period=all', creatorBToken));
    assert.ok(summaryA.data.watchSeconds > 0);
    assert.ok(summaryB.data.watchSeconds > 0);
    assert.ok(summaryA.data.watchSeconds !== summaryB.data.watchSeconds);
    const titlesA = await bodyOf(await call('GET', '/api/creator/revenue/titles?period=all', creatorAToken));
    const titles = titlesA.data.items.map((item: { title: string }) => item.title);
    assert.equal(titles.includes('Owned'), true);
    assert.equal(titles.includes('Owned Show'), true);
    assert.equal(titles.includes('Other'), false);
    const showRow = titlesA.data.items.find((item: { title: string }) => item.title === 'Owned Show');
    assert.equal(showRow.episodes.length, 1);
    assert.equal(showRow.episodes[0].title, 'Pilot');
    assert.equal(showRow.episodes[0].season, 1);
    assert.equal(showRow.episodes[0].episode, 1);

    const series = await bodyOf(await call('GET', '/api/creator/revenue/timeseries?period=today', creatorAToken));
    assert.equal(series.data.points.length, 1);
    assert.equal(series.data.timezone, 'Asia/Kolkata');
    assert.ok(series.data.points[0].watchSeconds > 0);
  });

  test('permissions keep creators on their own data and limit rate changes to superadmin or creatorRevenue.canEdit', async () => {
    const noToken = await call('GET', '/api/admin/creator-revenue/overview');
    assert.equal(noToken.statusCode, 401);
    const creatorOverview = await call('GET', '/api/admin/creator-revenue/overview', creatorAToken);
    assert.equal(creatorOverview.statusCode, 403);
    const creatorRate = await call('PUT', '/api/admin/creator-revenue/rate', creatorAToken, { rateInrPerHour: 9 });
    assert.equal(creatorRate.statusCode, 403);
    const modView = await call('GET', '/api/admin/creator-revenue/rate', moderatorToken);
    assert.equal(modView.statusCode, 403);

    await AdminUserModel.updateOne(
      { _id: moderatorId },
      { $set: { 'modulePermissions.creatorRevenue.canView': true } }
    );
    const modAllowed = await call('GET', '/api/admin/creator-revenue/rate', moderatorToken);
    assert.equal(modAllowed.statusCode, 200);
    const modEdit = await call('PUT', '/api/admin/creator-revenue/rate', moderatorToken, { rateInrPerHour: 6 });
    assert.equal(modEdit.statusCode, 403);

    await AdminUserModel.updateOne(
      { _id: moderatorId },
      { $set: { 'modulePermissions.creatorRevenue.canEdit': true } }
    );
    const modUpdated = await bodyOf(await call('PUT', '/api/admin/creator-revenue/rate', moderatorToken, {
      rateInrPerHour: 6,
      note: 'Moderator adjustment',
    }));
    assert.equal(modUpdated.success, true);
    assert.equal(modUpdated.data.scope, 'default');
    assert.equal(modUpdated.data.rateInrPerHour, 6);
    assert.equal(modUpdated.data.currency, 'INR');
    assert.match(modUpdated.data.ratePolicy, /does not rewrite/i);

    const staffDefault = await call('PUT', '/api/admin/creator-revenue/rate', staffAdminToken, { rateInrPerHour: 8 });
    assert.equal(staffDefault.statusCode, 403);
    const staffCreatorRate = await call('PUT', `/api/admin/creator-revenue/creators/${creatorAId}/rate`, staffAdminToken, { rateInrPerHour: 8 });
    assert.equal(staffCreatorRate.statusCode, 403);
    const creatorOwnRate = await call('PUT', `/api/admin/creator-revenue/creators/${creatorAId}/rate`, creatorAToken, { rateInrPerHour: 9 });
    assert.equal(creatorOwnRate.statusCode, 403);
    const badRate = await call('PUT', '/api/admin/creator-revenue/rate', adminToken, { rateInrPerHour: 5.555 });
    assert.equal(badRate.statusCode, 400);
    const missingCreator = await call('PUT', `/api/admin/creator-revenue/creators/${adminId}/rate`, adminToken, { rateInrPerHour: 4 });
    assert.equal(missingCreator.statusCode, 404);

    const creatorRateSet = await bodyOf(await call('PUT', `/api/admin/creator-revenue/creators/${creatorAId}/rate`, adminToken, {
      rateInrPerHour: 11,
      note: 'A only',
    }));
    assert.equal(creatorRateSet.success, true);
    assert.equal(creatorRateSet.data.scope, 'creator');
    assert.equal(creatorRateSet.data.creatorId, creatorAId);
    assert.equal(creatorRateSet.data.rateInrPerHour, 11);
    assert.equal(creatorRateSet.data.source, 'override');
    assert.equal(creatorRateSet.data.defaultRate.rateInrPerHour, 6);
    assert.equal(creatorRateSet.data.history[0].rateInrPerHour, 11);
    assert.equal(creatorRateSet.data.history[0].note, 'A only');

    const summaryARate = await bodyOf(await call('GET', '/api/creator/revenue/summary?period=all', creatorAToken));
    assert.equal(summaryARate.data.rate.rateInrPerHour, 11);
    assert.equal(summaryARate.data.rate.source, 'override');
    const summaryBRate = await bodyOf(await call('GET', '/api/creator/revenue/summary?period=all', creatorBToken));
    assert.equal(summaryBRate.data.rate.rateInrPerHour, 6);
    assert.equal(summaryBRate.data.rate.source, 'default');

    await AdminUserModel.updateOne(
      { _id: creatorAId },
      { $set: { 'modulePermissions.creatorRevenue.canView': true, 'modulePermissions.creatorRevenue.canEdit': true } }
    );
    const stillBlocked = await call('GET', '/api/admin/creator-revenue/overview?period=all', creatorAToken);
    assert.equal(stillBlocked.statusCode, 403);

    const overview = await bodyOf(await call('GET', '/api/admin/creator-revenue/overview?period=all', adminToken));
    assert.equal(overview.success, true);
    const ids = overview.data.creators.map((row: { creatorId: string }) => row.creatorId);
    assert.equal(ids.includes(creatorAId), true);
    assert.equal(ids.includes(creatorBId), true);
    const onlyA = await bodyOf(await call('GET', `/api/admin/creator-revenue/overview?period=all&creatorId=${creatorAId}`, adminToken));
    assert.equal(onlyA.data.creators.length, 1);
    assert.equal(onlyA.data.creators[0].creatorId, creatorAId);
    assert.equal(onlyA.data.creators[0].rateInrPerHour, 11);
    assert.equal(onlyA.data.creators[0].rateSource, 'override');
    assert.equal(onlyA.data.totals.creatorCount, 1);
    const creatorBRow = overview.data.creators.find((row: { creatorId: string }) => row.creatorId === creatorBId);
    assert.equal(creatorBRow.rateInrPerHour, 6);
    assert.equal(creatorBRow.rateSource, 'default');

    const badPeriod = await call('GET', '/api/creator/revenue/summary?period=custom', creatorAToken);
    assert.equal(badPeriod.statusCode, 400);
    const missing = await call('POST', '/api/app/watch/heartbeat', viewerToken, {
      contentId: 'not-an-id',
      sessionId: 'session-bad',
      clientEventId: 'event-bad',
      playedSeconds: 10,
      positionSeconds: 10,
    });
    assert.equal(missing.statusCode, 400);
  });

  test('a rate change values new watch time only and leaves locked days payable later', async () => {
    const movie = await MovieModel.create({
      title: 'Rate Film',
      status: 'published',
      createdBy: creatorAId,
      duration: 8000,
    });
    const movieId = movie._id.toString();
    const january = new Date('2026-01-15T04:30:00.000Z');
    const creditedJanuary = await play({
      viewerId,
      contentId: movieId,
      sessionId: 'session-rate-hour',
      seconds: 3600,
      start: january,
    });
    assert.equal(creditedJanuary, 3600);

    await setCreatorWatchHourRate({
      creatorId: creatorAId,
      rateInrPerHour: 10,
      setBy: adminId,
      now: new Date('2026-06-01T00:00:00.000Z'),
      note: 'Raised to Rs 10',
    });
    const august = new Date('2026-08-01T04:30:00.000Z');
    const creditedAugust = await play({
      viewerId,
      contentId: movieId,
      sessionId: 'session-rate-hour',
      seconds: 3600,
      start: august,
    });
    assert.equal(creditedAugust, 3600);

    const januaryDaily = await CreatorRevenueDailyModel.findOne({ titleId: movie._id, day: '2026-01-15' }).lean();
    const augustDaily = await CreatorRevenueDailyModel.findOne({ titleId: movie._id, day: '2026-08-01' }).lean();
    assert.equal(januaryDaily?.watchSeconds, 3600);
    assert.equal(januaryDaily?.earningUnits, earningUnitsFor(3600, 5));
    assert.equal(amountPaiseFromUnits(januaryDaily!.earningUnits), 500);
    assert.equal(augustDaily?.earningUnits, earningUnitsFor(3600, 10));
    assert.equal(amountPaiseFromUnits(augustDaily!.earningUnits), 1000);
    const januaryCredit = await CreatorWatchCreditModel.findOne({ contentId: movie._id, day: '2026-01-15' }).lean();
    assert.equal(januaryCredit?.rateInrPerHour, 5);

    const defaultMovie = await MovieModel.create({
      title: 'Default Rate Film',
      status: 'published',
      createdBy: creatorBId,
      duration: 3600,
    });
    const defaultAugust = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: defaultMovie._id.toString(),
      sessionId: 'session-default-august',
      clientEventId: 'event-default-august',
      playedSeconds: 45,
      positionSeconds: 45,
      now: august,
    });
    assert.equal(defaultAugust.creditedSeconds, 45);
    const defaultAugustCredit = await CreatorWatchCreditModel.findOne({ idempotencyKey: `hb:${viewerId}:event-default-august` }).lean();
    assert.equal(defaultAugustCredit?.rateInrPerHour, 5);

    await setWatchHourRate({
      rateInrPerHour: 9,
      setBy: adminId,
      now: new Date('2026-08-15T00:00:00.000Z'),
      note: 'Default raised',
    });
    const januaryStill = await CreatorRevenueDailyModel.findOne({ titleId: movie._id, day: '2026-01-15' }).lean();
    const augustStill = await CreatorRevenueDailyModel.findOne({ titleId: movie._id, day: '2026-08-01' }).lean();
    assert.equal(januaryStill?.earningUnits, januaryDaily?.earningUnits);
    assert.equal(augustStill?.earningUnits, augustDaily?.earningUnits);

    await setCreatorWatchHourRate({
      creatorId: creatorAId,
      rateInrPerHour: 12,
      setBy: adminId,
      now: new Date('2026-09-01T00:00:00.000Z'),
      note: 'Raised to Rs 12',
    });
    const januaryAfter = await CreatorRevenueDailyModel.findOne({ titleId: movie._id, day: '2026-01-15' }).lean();
    const augustAfter = await CreatorRevenueDailyModel.findOne({ titleId: movie._id, day: '2026-08-01' }).lean();
    assert.equal(januaryAfter?.earningUnits, januaryDaily?.earningUnits);
    assert.equal(augustAfter?.earningUnits, augustDaily?.earningUnits);
    assert.equal(januaryCredit && (await CreatorWatchCreditModel.findById(januaryCredit._id).lean())?.rateInrPerHour, 5);

    const september = new Date('2026-09-15T04:30:00.000Z');
    await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: movieId,
      sessionId: 'session-rate-september',
      clientEventId: 'event-rate-september-a',
      playedSeconds: 45,
      positionSeconds: 45,
      now: september,
    });
    await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: defaultMovie._id.toString(),
      sessionId: 'session-default-september',
      clientEventId: 'event-default-september',
      playedSeconds: 45,
      positionSeconds: 45,
      now: september,
    });
    const septemberA = await CreatorWatchCreditModel.findOne({ idempotencyKey: `hb:${viewerId}:event-rate-september-a` }).lean();
    const septemberB = await CreatorWatchCreditModel.findOne({ idempotencyKey: `hb:${viewerId}:event-default-september` }).lean();
    assert.equal(septemberA?.rateInrPerHour, 12);
    assert.equal(septemberB?.rateInrPerHour, 9);

    await CreatorRevenueDailyModel.updateOne(
      { _id: januaryDaily!._id },
      { $set: { payoutId: adminId, paidAt: new Date('2026-02-01T00:00:00.000Z') } }
    );
    const supplement = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: movieId,
      sessionId: 'session-rate-supplement',
      clientEventId: 'event-rate-supplement',
      playedSeconds: 45,
      positionSeconds: 45,
      now: new Date('2026-01-15T06:00:00.000Z'),
    });
    assert.equal(supplement.creditedSeconds, 45);
    const generations = await CreatorRevenueDailyModel.find({ titleId: movie._id, day: '2026-01-15' }).sort({ generation: 1 }).lean();
    assert.equal(generations.length, 2);
    assert.equal(generations[0].generation, 0);
    assert.equal(generations[0].watchSeconds, 3600);
    assert.equal(String(generations[0].payoutId), adminId);
    assert.equal(generations[1].generation, 1);
    assert.equal(generations[1].supplement, true);
    assert.equal(generations[1].watchSeconds, 45);
    assert.equal(generations[1].payoutId, null);

    await setCreatorWatchHourRate({
      creatorId: creatorAId,
      rateInrPerHour: 0,
      setBy: adminId,
      now: new Date('2026-10-01T00:00:00.000Z'),
      note: 'Pause earnings',
    });
    const pausedCredit = await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: movieId,
      sessionId: 'session-rate-paused-2',
      clientEventId: 'event-rate-paused-2',
      playedSeconds: 45,
      positionSeconds: 45,
      now: new Date('2026-10-03T04:30:00.000Z'),
    });
    assert.equal(pausedCredit.creditedSeconds, 45);
    const zeroRate = await CreatorWatchCreditModel.findOne({ idempotencyKey: `hb:${viewerId}:event-rate-paused-2` }).lean();
    assert.equal(zeroRate?.rateInrPerHour, 0);
    assert.equal(zeroRate?.earningUnits, 0);
    await recordCreatorPlayback({
      source: 'heartbeat',
      viewerUserId: viewerId,
      contentId: defaultMovie._id.toString(),
      sessionId: 'session-default-october',
      clientEventId: 'event-default-october',
      playedSeconds: 45,
      positionSeconds: 45,
      now: new Date('2026-10-03T04:30:00.000Z'),
    });
    const defaultOctober = await CreatorWatchCreditModel.findOne({ idempotencyKey: `hb:${viewerId}:event-default-october` }).lean();
    assert.equal(defaultOctober?.rateInrPerHour, 9);
    assert.equal(defaultOctober?.earningUnits, earningUnitsFor(45, 9));
  });
});
