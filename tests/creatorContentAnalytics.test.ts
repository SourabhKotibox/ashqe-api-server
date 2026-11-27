import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { earningUnitsFor } from '../src/lib/creatorRevenue.ts';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'creator-content-analytics-test-secret';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

describe('per-content analytics and creator delete lock', { concurrency: 1, timeout: 180000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let recordCreatorPlayback: typeof import('../src/lib/creatorRevenueLedger.ts').recordCreatorPlayback;
  let setCreatorWatchHourRate: typeof import('../src/lib/creatorRevenueLedger.ts').setCreatorWatchHourRate;
  let MovieModel: typeof import('../src/models/Movie.ts').MovieModel;
  let TVShowModel: typeof import('../src/models/TVShow.ts').TVShowModel;
  let EpisodeModel: typeof import('../src/models/Episode.ts').EpisodeModel;
  let UserModel: typeof import('../src/models/User.ts').UserModel;
  let AdminUserModel: typeof import('../src/models/AdminUser.ts').AdminUserModel;
  let MediaFileModel: typeof import('../src/models/MediaFile.ts').MediaFileModel;
  let MediaFolderModel: typeof import('../src/models/MediaFolder.ts').MediaFolderModel;

  let adminToken = '';
  let staffAdminToken = '';
  let moderatorToken = '';
  let creatorAToken = '';
  let creatorAId = '';
  let creatorBToken = '';
  let creatorBId = '';
  let viewerAId = '';
  let viewerBId = '';

  let hoursMovieId = '';
  let rateMovieId = '';
  let draftMovieId = '';
  let showId = '';
  let episodeId = '';
  let otherMovieId = '';

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

  const play = async (input: {
    viewerId: string;
    contentId: string;
    episodeId?: string;
    sessionId: string;
    seconds: number;
    start: Date;
  }) => {
    const step = 45;
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
        clientEventId: `${input.sessionId}-${i}`,
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
    ({ recordCreatorPlayback, setCreatorWatchHourRate } = await import('../src/lib/creatorRevenueLedger.ts'));
    ({ MovieModel } = await import('../src/models/Movie.ts'));
    ({ TVShowModel } = await import('../src/models/TVShow.ts'));
    ({ EpisodeModel } = await import('../src/models/Episode.ts'));
    ({ UserModel } = await import('../src/models/User.ts'));
    ({ AdminUserModel } = await import('../src/models/AdminUser.ts'));
    ({ MediaFileModel } = await import('../src/models/MediaFile.ts'));
    ({ MediaFolderModel } = await import('../src/models/MediaFolder.ts'));

    const passwordHash = await bcrypt.hash('AdminPass123!', 8);
    const superadmin = await AdminUserModel.create({
      email: 'analytics-admin@ashqe.test',
      name: 'Analytics Super',
      passwordHash,
      role: 'superadmin',
      isActive: true,
    });
    await AdminUserModel.create({
      email: 'analytics-staff@ashqe.test',
      name: 'Analytics Admin',
      passwordHash,
      role: 'admin',
      isActive: true,
      modulePermissions: {
        movies: { canView: true, canCreate: true, canEdit: true, canDelete: true },
        tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: true },
        mediaLibrary: { canView: true, canUpload: true, canDelete: true },
      },
    });
    await AdminUserModel.create({
      email: 'analytics-mod@ashqe.test',
      name: 'Analytics Mod',
      passwordHash,
      role: 'moderator',
      isActive: true,
    });
    const creatorA = await AdminUserModel.create({
      email: 'analytics-creator-a@ashqe.test',
      name: 'Creator A',
      phone: '9000000101',
      passwordHash,
      role: 'influencer',
      isActive: true,
      modulePermissions: {
        movies: { canView: true, canCreate: true, canEdit: true, canDelete: true },
        tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: true },
        mediaLibrary: { canView: true, canUpload: true, canDelete: true },
      },
    });
    creatorAId = creatorA._id.toString();
    const creatorB = await AdminUserModel.create({
      email: 'analytics-creator-b@ashqe.test',
      name: 'Creator B',
      phone: '9000000102',
      passwordHash,
      role: 'influencer',
      isActive: true,
    });
    creatorBId = creatorB._id.toString();

    const login = async (email: string) => {
      const res = await bodyOf(await call('POST', '/api/auth/login', undefined, { email, password: 'AdminPass123!' }));
      assert.equal(typeof res.accessToken, 'string', JSON.stringify(res));
      return res.accessToken as string;
    };
    adminToken = await login('analytics-admin@ashqe.test');
    staffAdminToken = await login('analytics-staff@ashqe.test');
    moderatorToken = await login('analytics-mod@ashqe.test');
    creatorAToken = await login('analytics-creator-a@ashqe.test');
    creatorBToken = await login('analytics-creator-b@ashqe.test');

    const viewerA = await UserModel.create({ email: 'analytics-viewer-a@ashqe.test', name: 'Viewer A', phone: '9111110101' });
    const viewerB = await UserModel.create({ email: 'analytics-viewer-b@ashqe.test', name: 'Viewer B', phone: '9111110102' });
    viewerAId = viewerA._id.toString();
    viewerBId = viewerB._id.toString();

    const hoursMovie = await MovieModel.create({
      title: 'Hours Film',
      status: 'published',
      createdBy: creatorAId,
      duration: 7200,
      posterImage: 'https://cdn.example.com/hours-poster.jpg',
      thumbnail: 'https://cdn.example.com/hours-thumb.jpg',
      hlsUrl: 'https://cdn.example.com/hours.m3u8',
      views: 4,
    });
    hoursMovieId = hoursMovie._id.toString();
    const rateMovie = await MovieModel.create({
      title: 'Rate Film',
      status: 'published',
      createdBy: creatorAId,
      duration: 7200,
      posterImage: 'https://cdn.example.com/rate-poster.jpg',
      thumbnail: '',
      hlsUrl: 'https://cdn.example.com/rate.m3u8',
      views: 1,
    });
    rateMovieId = rateMovie._id.toString();
    const draft = await MovieModel.create({
      title: 'Quiet Draft',
      status: 'draft',
      createdBy: creatorAId,
      duration: 3600,
      thumbnail: 'https://cdn.example.com/draft-thumb.jpg',
      hlsUrl: 'https://cdn.example.com/draft.mp4',
      views: 0,
    });
    draftMovieId = draft._id.toString();
    const show = await TVShowModel.create({
      title: 'Rolled Series',
      status: 'published',
      createdBy: creatorAId,
      posterImage: 'https://cdn.example.com/series-poster.jpg',
      thumbnail: 'https://cdn.example.com/series-thumb.jpg',
      views: 9,
    });
    showId = show._id.toString();
    const episode = await EpisodeModel.create({
      tvShowId: show._id,
      season: 1,
      episode: 2,
      title: 'Second Chapter',
      duration: 1800,
      hlsUrl: 'https://cdn.example.com/episode.m3u8',
      views: 3,
      createdBy: creatorAId,
    });
    episodeId = episode._id.toString();
    const other = await MovieModel.create({
      title: 'Other Creator Film',
      status: 'published',
      createdBy: creatorBId,
      duration: 3600,
      posterImage: 'https://cdn.example.com/other-poster.jpg',
      hlsUrl: 'https://cdn.example.com/other.m3u8',
      views: 2,
    });
    otherMovieId = other._id.toString();
    void superadmin;
  });

  after(async () => {
    if (app) await app.close();
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  test('content analytics breaks watch time and revenue down per movie and series', async () => {
    const january = new Date('2026-01-15T04:30:00.000Z');
    const august = new Date('2026-08-01T04:30:00.000Z');

    assert.equal(await play({
      viewerId: viewerAId,
      contentId: hoursMovieId,
      sessionId: 'session-hours-a',
      seconds: 90,
      start: january,
    }), 90);
    assert.equal(await play({
      viewerId: viewerBId,
      contentId: hoursMovieId,
      sessionId: 'session-hours-b',
      seconds: 45,
      start: new Date(january.getTime() + 60_000),
    }), 45);
    assert.equal(await play({
      viewerId: viewerAId,
      contentId: showId,
      episodeId,
      sessionId: 'session-series-a',
      seconds: 45,
      start: new Date(january.getTime() + 120_000),
    }), 45);

    await setCreatorWatchHourRate({
      creatorId: creatorAId,
      rateInrPerHour: 20,
      setBy: creatorAId,
      now: new Date('2026-07-01T00:00:00.000Z'),
      note: 'Raised',
    });
    assert.equal(await play({
      viewerId: viewerAId,
      contentId: rateMovieId,
      sessionId: 'session-rate-a',
      seconds: 45,
      start: august,
    }), 45);

    const own = await bodyOf(await call('GET', '/api/creator/revenue/content?period=all', creatorAToken));
    assert.equal(own.success, true);
    assert.equal(own.data.period.key, 'all');
    assert.equal(own.data.currency, 'INR');
    assert.equal(own.data.timezone, 'Asia/Kolkata');
    assert.equal(own.data.sort, 'watchHours');
    assert.equal(own.data.order, 'desc');
    assert.equal(own.data.viewsScope, 'lifetime');
    assert.equal(own.data.uniqueViewersScope, 'period');
    assert.match(own.data.revenueNote, /earning units/i);

    const titles = own.data.items.map((item: { title: string }) => item.title);
    assert.deepEqual(titles, ['Hours Film', 'Rate Film', 'Rolled Series', 'Quiet Draft']);
    assert.equal(titles.includes('Other Creator Film'), false);
    assert.equal(titles.includes('Second Chapter'), false);

    const hours = own.data.items.find((item: { title: string }) => item.title === 'Hours Film');
    assert.equal(hours.contentId, hoursMovieId);
    assert.equal(hours.type, 'movie');
    assert.equal(hours.status, 'published');
    assert.equal(hours.poster, 'https://cdn.example.com/hours-poster.jpg');
    assert.equal(hours.thumbnail, 'https://cdn.example.com/hours-thumb.jpg');
    assert.equal(hours.creatorId, creatorAId);
    assert.equal(hours.creatorName, 'Creator A');
    assert.equal(hours.watchSeconds, 135);
    assert.equal(hours.earningUnits, earningUnitsFor(135, 5));
    assert.equal(hours.views, 4);
    assert.equal(hours.uniqueViewers, 2);
    assert.equal(hours.inCatalog, true);
    assert.equal(hours.episodes, undefined);

    const rate = own.data.items.find((item: { title: string }) => item.title === 'Rate Film');
    assert.equal(rate.type, 'movie');
    assert.equal(rate.poster, 'https://cdn.example.com/rate-poster.jpg');
    assert.equal(rate.thumbnail, 'https://cdn.example.com/rate-poster.jpg');
    assert.equal(rate.watchSeconds, 45);
    assert.equal(rate.earningUnits, earningUnitsFor(45, 20));
    assert.equal(rate.uniqueViewers, 1);
    assert.equal(rate.views, 1);
    assert.ok(rate.amountPaise > hours.amountPaise / 3);

    const series = own.data.items.find((item: { title: string }) => item.title === 'Rolled Series');
    assert.equal(series.contentId, showId);
    assert.equal(series.type, 'series');
    assert.equal(series.status, 'published');
    assert.equal(series.poster, 'https://cdn.example.com/series-poster.jpg');
    assert.equal(series.watchSeconds, 45);
    assert.equal(series.earningUnits, earningUnitsFor(45, 5));
    assert.equal(series.views, 9);
    assert.equal(series.uniqueViewers, 1);
    assert.equal(series.episodeCount, 1);
    assert.equal(series.episodes.length, 1);
    assert.equal(series.episodes[0].episodeId, episodeId);
    assert.equal(series.episodes[0].title, 'Second Chapter');
    assert.equal(series.episodes[0].season, 1);
    assert.equal(series.episodes[0].episode, 2);
    assert.equal(series.episodes[0].watchSeconds, 45);
    assert.equal(series.episodes[0].views, 3);
    assert.equal(series.episodes[0].uniqueViewers, 1);

    const draft = own.data.items.find((item: { title: string }) => item.title === 'Quiet Draft');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.watchSeconds, 0);
    assert.equal(draft.amountPaise, 0);
    assert.equal(draft.uniqueViewers, 0);
    assert.equal(draft.poster, 'https://cdn.example.com/draft-thumb.jpg');

    const summedSeconds = own.data.items.reduce((sum: number, item: { watchSeconds: number }) => sum + item.watchSeconds, 0);
    const summedUnits = own.data.items.reduce((sum: number, item: { earningUnits: number }) => sum + item.earningUnits, 0);
    assert.equal(own.data.totals.contentCount, 4);
    assert.equal(own.data.totals.movieCount, 3);
    assert.equal(own.data.totals.seriesCount, 1);
    assert.equal(own.data.totals.watchSeconds, summedSeconds);
    assert.equal(own.data.totals.earningUnits, summedUnits);
    assert.equal(own.data.totals.views, 4 + 1 + 9);
    assert.equal(own.data.totals.uniqueViewers, 2);
    assert.equal(own.pagination.total, 4);

    const summary = await bodyOf(await call('GET', '/api/creator/revenue/summary?period=all', creatorAToken));
    assert.equal(own.data.totals.watchSeconds, summary.data.watchSeconds);
    assert.equal(own.data.totals.amountPaise, summary.data.amountPaise);
    assert.equal(own.data.totals.amountInr, summary.data.amountInr);

    const januaryOnly = await bodyOf(await call(
      'GET',
      '/api/creator/revenue/content?from=2026-01-01&to=2026-01-31',
      creatorAToken
    ));
    assert.equal(januaryOnly.data.period.key, 'custom');
    assert.equal(januaryOnly.data.period.from, '2026-01-01');
    assert.equal(januaryOnly.data.period.to, '2026-01-31');
    const januaryHours = januaryOnly.data.items.find((item: { title: string }) => item.title === 'Hours Film');
    const januaryRate = januaryOnly.data.items.find((item: { title: string }) => item.title === 'Rate Film');
    assert.equal(januaryHours.watchSeconds, 135);
    assert.equal(januaryRate.watchSeconds, 0);
    assert.equal(januaryRate.views, 1);
    assert.equal(januaryOnly.data.totals.watchSeconds, 180);
    const januarySummary = await bodyOf(await call(
      'GET',
      '/api/creator/revenue/summary?period=custom&from=2026-01-01&to=2026-01-31',
      creatorAToken
    ));
    assert.equal(januaryOnly.data.totals.watchSeconds, januarySummary.data.watchSeconds);
    assert.equal(januaryOnly.data.totals.amountPaise, januarySummary.data.amountPaise);

    const byRevenue = await bodyOf(await call(
      'GET',
      '/api/creator/revenue/content?period=all&sort=revenue&order=desc',
      creatorAToken
    ));
    assert.deepEqual(
      byRevenue.data.items.map((item: { title: string }) => item.title),
      ['Rate Film', 'Hours Film', 'Rolled Series', 'Quiet Draft']
    );

    const moviesOnly = await bodyOf(await call(
      'GET',
      '/api/creator/revenue/content?period=all&type=movie&status=published',
      creatorAToken
    ));
    assert.deepEqual(
      moviesOnly.data.items.map((item: { title: string }) => item.title),
      ['Hours Film', 'Rate Film']
    );
    assert.equal(moviesOnly.data.totals.contentCount, 2);
    assert.equal(moviesOnly.data.totals.seriesCount, 0);

    const page = await bodyOf(await call(
      'GET',
      '/api/creator/revenue/content?period=all&page=2&limit=1',
      creatorAToken
    ));
    assert.equal(page.data.items.length, 1);
    assert.equal(page.data.items[0].title, 'Rate Film');
    assert.equal(page.data.totals.contentCount, 4);
    assert.equal(page.pagination.page, 2);
    assert.equal(page.pagination.limit, 1);
    assert.equal(page.pagination.pages, 4);

    const spoof = await bodyOf(await call(
      'GET',
      `/api/creator/revenue/content?period=all&creatorId=${creatorBId}`,
      creatorAToken
    ));
    assert.equal(spoof.data.items.some((item: { title: string }) => item.title === 'Other Creator Film'), false);
    assert.equal(spoof.data.items.some((item: { creatorId: string }) => item.creatorId === creatorBId), false);

    const otherOwn = await bodyOf(await call('GET', '/api/creator/revenue/content?period=all', creatorBToken));
    assert.deepEqual(otherOwn.data.items.map((item: { title: string }) => item.title), ['Other Creator Film']);
    assert.equal(otherOwn.data.totals.watchSeconds, 0);
  });

  test('admins can read one creator or every creator, and other roles cannot', async () => {
    const noToken = await call('GET', '/api/admin/content-analytics?period=all');
    assert.equal(noToken.statusCode, 401);
    const creatorBlocked = await call('GET', '/api/admin/content-analytics?period=all', creatorAToken);
    assert.equal(creatorBlocked.statusCode, 403);
    const creatorScoped = await call('GET', `/api/admin/creators/${creatorAId}/content-analytics?period=all`, creatorAToken);
    assert.equal(creatorScoped.statusCode, 403);
    const modBlocked = await call('GET', '/api/admin/content-analytics?period=all', moderatorToken);
    assert.equal(modBlocked.statusCode, 403);

    const one = await bodyOf(await call(
      'GET',
      `/api/admin/creators/${creatorAId}/content-analytics?period=all`,
      staffAdminToken
    ));
    assert.equal(one.success, true);
    assert.equal(one.data.creatorId, creatorAId);
    assert.equal(one.data.items.every((item: { creatorId: string }) => item.creatorId === creatorAId), true);
    assert.equal(one.data.totals.contentCount, 4);
    const summary = await bodyOf(await call('GET', '/api/creator/revenue/summary?period=all', creatorAToken));
    assert.equal(one.data.totals.watchSeconds, summary.data.watchSeconds);
    assert.equal(one.data.totals.amountPaise, summary.data.amountPaise);

    const all = await bodyOf(await call('GET', '/api/admin/content-analytics?period=all&sort=revenue', adminToken));
    assert.equal(all.success, true);
    const allTitles = all.data.items.map((item: { title: string }) => item.title);
    assert.equal(allTitles.includes('Hours Film'), true);
    assert.equal(allTitles.includes('Other Creator Film'), true);
    assert.equal(all.data.totals.contentCount, 5);
    const other = all.data.items.find((item: { title: string }) => item.title === 'Other Creator Film');
    assert.equal(other.creatorId, creatorBId);
    assert.equal(other.creatorName, 'Creator B');
    assert.equal(other.creatorEmail, 'analytics-creator-b@ashqe.test');

    const filtered = await bodyOf(await call(
      'GET',
      `/api/admin/content-analytics?period=all&creatorId=${creatorBId}`,
      adminToken
    ));
    assert.equal(filtered.data.items.length, 1);
    assert.equal(filtered.data.items[0].contentId, otherMovieId);

    const missing = await call('GET', `/api/admin/creators/${adminToken.slice(0, 8)}/content-analytics`, adminToken);
    assert.equal(missing.statusCode, 400);
    const notCreator = await call(
      'GET',
      `/api/admin/creators/${(await AdminUserModel.findOne({ role: 'superadmin' }).lean())!._id}/content-analytics`,
      adminToken
    );
    assert.equal(notCreator.statusCode, 404);
    const badSort = await call('GET', '/api/creator/revenue/content?period=all&sort=title', creatorAToken);
    assert.equal(badSort.statusCode, 400);
    const badRange = await call('GET', '/api/creator/revenue/content?from=2026-02-02&to=2026-02-01', creatorAToken);
    assert.equal(badRange.statusCode, 400);
  });

  test('a creator cannot delete, unpublish, or strip the video, and an admin still can delete', async () => {
    const me = await bodyOf(await call('GET', '/api/auth/me', creatorAToken));
    assert.equal(me.user.modulePermissions.movies.canDelete, false);
    assert.equal(me.user.modulePermissions.tvShows.canDelete, false);
    assert.equal(me.user.modulePermissions.mediaLibrary.canDelete, false);
    assert.equal(me.user.modulePermissions.movies.canEdit, true);

    const movieDelete = await call('DELETE', `/api/movies/${hoursMovieId}`, creatorAToken);
    assert.equal(movieDelete.statusCode, 403);
    assert.equal((await MovieModel.findById(hoursMovieId).lean())?.title, 'Hours Film');

    await AdminUserModel.updateOne(
      { email: 'analytics-mod@ashqe.test' },
      {
        $set: {
          'modulePermissions.movies.canDelete': true,
          'modulePermissions.tvShows.canDelete': true,
        },
      }
    );
    const moderatorDelete = await call('DELETE', `/api/movies/${hoursMovieId}`, moderatorToken);
    assert.equal(moderatorDelete.statusCode, 403);
    assert.match(String((await bodyOf(moderatorDelete)).error), /admin or super admin/i);
    assert.ok(await MovieModel.findById(hoursMovieId).lean());

    const showDelete = await call('DELETE', `/api/tv-shows/${showId}`, creatorAToken);
    assert.equal(showDelete.statusCode, 403);
    assert.equal(await EpisodeModel.countDocuments({ tvShowId: showId }), 1);

    const episodeDelete = await call('DELETE', `/api/episodes/${episodeId}`, creatorAToken);
    assert.equal(episodeDelete.statusCode, 403);
    assert.ok(await EpisodeModel.findById(episodeId).lean());

    const renamed = await call('PUT', `/api/movies/${hoursMovieId}`, creatorAToken, {
      title: 'Hours Film Revised',
      description: 'Metadata only',
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((await bodyOf(renamed)).data.title, 'Hours Film Revised');
    assert.equal((await MovieModel.findById(hoursMovieId).lean())?.hlsUrl, 'https://cdn.example.com/hours.m3u8');

    const unpublish = await call('PATCH', `/api/movies/${hoursMovieId}/status`, creatorAToken, { status: 'draft' });
    assert.equal(unpublish.statusCode, 403);
    assert.equal((await MovieModel.findById(hoursMovieId).lean())?.status, 'published');

    const withdraw = await call('PUT', `/api/tv-shows/${showId}`, creatorAToken, { status: 'draft' });
    assert.equal(withdraw.statusCode, 403);
    assert.equal((await TVShowModel.findById(showId).lean())?.status, 'published');

    const cleared = await call('PUT', `/api/movies/${hoursMovieId}`, creatorAToken, { hlsUrl: '' });
    assert.equal(cleared.statusCode, 403);
    assert.equal((await MovieModel.findById(hoursMovieId).lean())?.hlsUrl, 'https://cdn.example.com/hours.m3u8');

    const replaced = await call('PUT', `/api/movies/${hoursMovieId}`, creatorAToken, {
      hlsUrl: 'https://cdn.example.com/replacement.m3u8',
    });
    assert.equal(replaced.statusCode, 403);
    assert.equal((await MovieModel.findById(hoursMovieId).lean())?.hlsUrl, 'https://cdn.example.com/hours.m3u8');

    const episodeCleared = await call('PUT', `/api/episodes/${episodeId}`, creatorAToken, { hlsUrl: null });
    assert.equal(episodeCleared.statusCode, 403);
    assert.equal((await EpisodeModel.findById(episodeId).lean())?.hlsUrl, 'https://cdn.example.com/episode.m3u8');

    const draftSwap = await call('PUT', `/api/movies/${draftMovieId}`, creatorAToken, {
      hlsUrl: 'https://cdn.example.com/draft-v2.mp4',
      title: 'Quiet Draft Fixed',
    });
    assert.equal(draftSwap.statusCode, 200, draftSwap.body);
    assert.equal((await MovieModel.findById(draftMovieId).lean())?.hlsUrl, 'https://cdn.example.com/draft-v2.mp4');
    const draftClear = await call('PUT', `/api/movies/${draftMovieId}`, creatorAToken, { hlsUrl: '' });
    assert.equal(draftClear.statusCode, 403);
    assert.equal((await MovieModel.findById(draftMovieId).lean())?.hlsUrl, 'https://cdn.example.com/draft-v2.mp4');

    const videoUrl = 'https://cdn.example.com/library-hours-master.m3u8';
    const media = await MediaFileModel.create({
      name: 'library-hours-master.m3u8',
      url: videoUrl,
      filePath: '/uploads/media/library-hours-master.m3u8',
      fileSize: 1000,
      fileType: 'application/vnd.apple.mpegurl',
      storageType: 'local',
      createdBy: creatorAId,
    });
    await MovieModel.updateOne({ _id: hoursMovieId }, { $set: { hlsUrl: videoUrl } });
    const fileDelete = await call('DELETE', `/api/media/files/${media._id}`, creatorAToken);
    assert.equal(fileDelete.statusCode, 409);
    assert.ok(await MediaFileModel.findById(media._id));
    assert.equal((await MovieModel.findById(hoursMovieId).lean())?.hlsUrl, videoUrl);

    const folder = await MediaFolderModel.create({ name: 'Creator Video Bin' });
    const folderDelete = await call('DELETE', `/api/media/folders/${folder._id}`, creatorAToken);
    assert.equal(folderDelete.statusCode, 403);
    assert.ok(await MediaFolderModel.findById(folder._id));

    const adminEpisode = await call('DELETE', `/api/episodes/${episodeId}`, staffAdminToken);
    assert.equal(adminEpisode.statusCode, 200, adminEpisode.body);
    assert.equal(await EpisodeModel.findById(episodeId).lean(), null);
    assert.ok(await TVShowModel.findById(showId).lean());

    const adminMovie = await call('DELETE', `/api/movies/${rateMovieId}`, adminToken);
    assert.equal(adminMovie.statusCode, 200, adminMovie.body);
    assert.equal(await MovieModel.findById(rateMovieId).lean(), null);

    const adminShow = await call('DELETE', `/api/tv-shows/${showId}`, staffAdminToken);
    assert.equal(adminShow.statusCode, 200, adminShow.body);
    assert.equal(await TVShowModel.findById(showId).lean(), null);
  });
});
