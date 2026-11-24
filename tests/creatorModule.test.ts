import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'creator-phase1-test-secret';
process.env.CREATOR_APPLY_IP_LIMIT = '500';
process.env.CREATOR_APPLY_EMAIL_LIMIT = '500';
process.env.CREATOR_STATUS_IP_LIMIT = '500';
process.env.CREATOR_STATUS_EMAIL_LIMIT = '500';
process.env.CREATOR_MAX_PENDING_SUBMISSIONS = '4';
process.env.CREATOR_MAX_UPLOAD_BYTES = String(1024 * 1024);
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const applyBody = (email: string, extra: Record<string, unknown> = {}) => ({
  fullName: 'Asha Creator',
  email,
  phone: '9876543210',
  city: 'Kochi',
  state: 'Kerala',
  channelName: 'Asha Films',
  contentTypes: ['movie', 'webseries'],
  sampleLinks: ['https://example.com/reel'],
  portfolioSummary: 'Independent films and a finished web series pilot.',
  copyrightAttested: true,
  ...extra,
});

describe('Creator / influencer module', { concurrency: 1, timeout: 180000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let resetRateLimits: () => void;
  let adminToken = '';
  let creatorToken = '';
  let creatorId = '';
  let temporaryPassword = '';
  let officialMovieId = '';
  let creatorMovieId = '';

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

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = await import('mongoose');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    ({ resetRateLimits } = await import('../src/lib/rateLimit.ts'));
    app = (await import('../src/app.ts')).default;
    await app.ready();

    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    const passwordHash = await bcrypt.hash('AdminPass123!', 8);
    await AdminUserModel.create({
      email: 'reviewer@ashqe.test',
      name: 'Reviewer',
      passwordHash,
      role: 'superadmin',
      isActive: true,
    });
    const login = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'reviewer@ashqe.test',
      password: 'AdminPass123!',
    }));
    adminToken = login.accessToken;
    assert.equal(login.mustChangePassword, false);
  });

  after(async () => {
    if (app) await app.close();
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  test('public apply validates, rejects honeypot and duplicates, and exposes only opaque status', async () => {
    const missing = await call('POST', '/api/public/creator/apply', undefined, { email: 'nope@ashqe.test' });
    assert.equal(missing.statusCode, 400);

    const spam = await call('POST', '/api/public/creator/apply', undefined, applyBody('spam@ashqe.test', { website: 'http://spam.example' }));
    assert.equal(spam.statusCode, 400);
    const spamBody = await bodyOf(spam);
    assert.equal(spamBody.success, false);

    const created = await call('POST', '/api/public/creator/apply', undefined, applyBody('asha@ashqe.test'));
    assert.equal(created.statusCode, 201);
    const createdBody = await bodyOf(created);
    assert.equal(createdBody.success, true);
    assert.equal(createdBody.data.status, 'pending');
    assert.ok(createdBody.data.applicationId);
    assert.ok(createdBody.data.submittedAt);

    const withoutPrefix = await call('POST', '/public/creator/apply', undefined, applyBody('prefix@ashqe.test'));
    assert.equal(withoutPrefix.statusCode, 201);

    const duplicate = await call('POST', '/api/public/creator/apply', undefined, applyBody('asha@ashqe.test'));
    assert.equal(duplicate.statusCode, 409);
    assert.match((await bodyOf(duplicate)).message, /already pending, under review, or approved/i);

    const { CreatorApplicationModel } = await import('../src/models/CreatorApplication.ts');
    const { AdminNotificationModel } = await import('../src/models/AdminNotification.ts');
    const stored = await CreatorApplicationModel.findOne({ email: 'asha@ashqe.test' }).lean();
    assert.equal(stored?.email, 'asha@ashqe.test');
    assert.equal(stored?.copyrightAttested, true);
    assert.ok(stored?.copyrightAttestedAt);
    const notice = await AdminNotificationModel.findOne({ modelName: 'CreatorApplication', title: 'New creator application' }).lean();
    assert.ok(notice);

    const status = await call('GET', '/api/public/creator/status?email=Asha@ashqe.test');
    assert.equal(status.statusCode, 200);
    const statusBody = await bodyOf(status);
    assert.equal(statusBody.data.found, true);
    assert.equal(statusBody.data.status, 'pending');
    assert.ok(statusBody.data.submittedAt);
    const serialized = JSON.stringify(statusBody);
    assert.equal(serialized.includes('9876543210'), false);
    assert.equal(serialized.includes('adminUser'), false);
    assert.equal(serialized.includes('password'), false);

    const missingStatus = await call('GET', '/api/public/creator/status?email=nobody@ashqe.test');
    assert.deepEqual((await bodyOf(missingStatus)).data, { found: false });

    const unauth = await call('GET', '/api/admin/creator-applications');
    assert.equal(unauth.statusCode, 401);
  });

  test('admin approval creates an isolated influencer and rejection emails without SMTP', async () => {
    const listed = await call('GET', '/api/admin/creator-applications?status=pending&search=asha', adminToken);
    assert.equal(listed.statusCode, 200);
    const listedBody = await bodyOf(listed);
    assert.ok(listedBody.pagination.total >= 1);
    assert.ok(listedBody.counts.pending >= 1);
    const applicationId = listedBody.data.find((row: any) => row.email === 'asha@ashqe.test')._id
      || listedBody.data.find((row: any) => row.email === 'asha@ashqe.test').id;

    const detail = await call('GET', `/api/admin/creator-applications/${applicationId}`, adminToken);
    assert.equal(detail.statusCode, 200);
    assert.equal((await bodyOf(detail)).data.email, 'asha@ashqe.test');

    const approved = await call('POST', `/api/admin/creator-applications/${applicationId}/approve`, adminToken, {
      notes: 'Portfolio looks original.',
    });
    assert.equal(approved.statusCode, 200);
    const approvedBody = await bodyOf(approved);
    assert.equal(approvedBody.success, true);
    assert.equal(approvedBody.data.emailSent, false);
    assert.equal(approvedBody.data.adminUser.role, 'influencer');
    assert.equal(approvedBody.data.adminUser.email, 'asha@ashqe.test');
    assert.equal(typeof approvedBody.data.temporaryPassword, 'string');
    assert.ok(approvedBody.data.temporaryPassword.length >= 12);
    temporaryPassword = approvedBody.data.temporaryPassword;

    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    const creator = await AdminUserModel.findOne({ email: 'asha@ashqe.test' });
    assert.ok(creator);
    creatorId = creator!._id.toString();
    assert.equal(creator!.role, 'influencer');
    assert.equal(creator!.isActive, true);
    assert.equal(creator!.mustChangePassword, true);
    assert.equal(creator!.passwordHash === temporaryPassword, false);
    assert.equal(await bcrypt.compare(temporaryPassword, creator!.passwordHash), true);
    const permissions = creator!.toObject().modulePermissions;
    assert.equal(permissions.movies.canView, true);
    assert.equal(permissions.movies.canCreate, true);
    assert.equal(permissions.movies.canEdit, true);
    assert.equal(permissions.movies.canDelete, false);
    assert.equal(permissions.tvShows.canView, true);
    assert.equal(permissions.tvShows.canCreate, true);
    assert.equal(permissions.tvShows.canEdit, true);
    assert.equal(permissions.tvShows.canDelete, false);
    assert.equal(permissions.mediaLibrary.canView, true);
    assert.equal(permissions.mediaLibrary.canUpload, true);
    assert.equal(permissions.mediaLibrary.canDelete, false);
    for (const moduleName of ['users', 'settings', 'influencers', 'subscriptionPlans', 'planLimits'] as const) {
      const perms = (permissions as any)[moduleName];
      assert.equal(perms.canView, false, moduleName);
      assert.equal(perms.canCreate, false, moduleName);
      assert.equal(perms.canDelete, false, moduleName);
    }

    const again = await call('POST', `/api/admin/creator-applications/${applicationId}/approve`, adminToken, {});
    assert.equal(again.statusCode, 409);

    const collisionApply = await call('POST', '/api/public/creator/apply', undefined, applyBody('reviewer@ashqe.test'));
    assert.equal(collisionApply.statusCode, 201);
    const collisionId = (await bodyOf(collisionApply)).data.applicationId;
    const collision = await call('POST', `/api/admin/creator-applications/${collisionId}/approve`, adminToken, {});
    assert.equal(collision.statusCode, 409);

    const rejectedApply = await call('POST', '/api/public/creator/apply', undefined, applyBody('nope@ashqe.test'));
    const rejectedId = (await bodyOf(rejectedApply)).data.applicationId;
    const missingReason = await call('POST', `/api/admin/creator-applications/${rejectedId}/reject`, adminToken, {});
    assert.equal(missingReason.statusCode, 400);
    const rejected = await call('POST', `/api/admin/creator-applications/${rejectedId}/reject`, adminToken, {
      rejectionReason: 'We need a longer sample of original work.',
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal((await bodyOf(rejected)).data.status, 'rejected');
    const rejectedStatus = await call('GET', '/api/public/creator/status?email=nope@ashqe.test');
    const rejectedStatusBody = await bodyOf(rejectedStatus);
    assert.equal(rejectedStatusBody.data.status, 'rejected');
    assert.equal(rejectedStatusBody.data.rejectionReason, 'We need a longer sample of original work.');

    const creatorLoginAttempt = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'asha@ashqe.test',
      password: temporaryPassword,
    }));
    const blocked = await call('GET', '/api/admin/creator-applications', creatorLoginAttempt.accessToken);
    assert.equal(blocked.statusCode, 403);
  });

  test('first login requires a password change and then clears the flag', async () => {
    const login = await call('POST', '/api/auth/login', undefined, {
      email: 'asha@ashqe.test',
      password: temporaryPassword,
    });
    assert.equal(login.statusCode, 200);
    const loginBody = await bodyOf(login);
    assert.equal(loginBody.mustChangePassword, true);
    creatorToken = loginBody.accessToken;

    const me = await call('GET', '/api/auth/me', creatorToken);
    const meBody = await bodyOf(me);
    assert.equal(meBody.user.mustChangePassword, true);
    assert.equal(meBody.user.role, 'influencer');
    assert.equal(meBody.user.modulePermissions.tvShows.canCreate, true);
    assert.equal(meBody.user.modulePermissions.mediaLibrary.canUpload, true);

    const changed = await call('PATCH', '/api/auth/password', creatorToken, {
      currentPassword: temporaryPassword,
      newPassword: 'NewCreatorPass123!',
    });
    assert.equal(changed.statusCode, 200);
    assert.equal((await bodyOf(changed)).mustChangePassword, false);

    const relogin = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'asha@ashqe.test',
      password: 'NewCreatorPass123!',
    }));
    assert.equal(relogin.mustChangePassword, false);
    creatorToken = relogin.accessToken;
    const meAfter = await bodyOf(await call('GET', '/api/auth/me', creatorToken));
    assert.equal(meAfter.user.mustChangePassword, false);
  });

  test('creators cannot see, edit, publish, or feature the official catalog', async () => {
    const { NotificationModel } = await import('../src/models/Notification.ts');
    const beforeCount = await NotificationModel.countDocuments({ title: 'New Movie Added! 🍿' });

    const official = await call('POST', '/api/movies', adminToken, {
      title: 'Official Catalog Film',
      description: 'Studio title',
      status: 'published',
      hlsUrl: 'https://cdn.example.com/official.m3u8',
      createdBy: creatorId,
    });
    assert.equal(official.statusCode, 201);
    const officialBody = await bodyOf(official);
    officialMovieId = officialBody.data.id;
    assert.equal(officialBody.data.status, 'published');
    assert.equal(String(officialBody.data.createdBy), creatorId === '' ? 'no' : (await (async () => {
      const { AdminUserModel } = await import('../src/models/AdminUser.ts');
      const reviewer = await AdminUserModel.findOne({ email: 'reviewer@ashqe.test' }).lean();
      return String(reviewer?._id);
    })()));
    assert.equal(await NotificationModel.countDocuments({ title: 'New Movie Added! 🍿' }), beforeCount + 1);

    const list = await bodyOf(await call('GET', '/api/movies', creatorToken));
    assert.equal(list.data.some((row: any) => row.title === 'Official Catalog Film'), false);

    const read = await call('GET', `/api/movies/${officialMovieId}`, creatorToken);
    assert.equal(read.statusCode, 404);
    const edit = await call('PUT', `/api/movies/${officialMovieId}`, creatorToken, { title: 'Hijacked' });
    assert.equal(edit.statusCode, 404);

    const selfPublish = await call('POST', '/api/movies', creatorToken, {
      title: 'Creator Tries To Publish',
      status: 'published',
      hlsUrl: 'https://cdn.example.com/mine.mp4',
    });
    assert.equal(selfPublish.statusCode, 403);

    const featureOnCreate = await call('POST', '/api/movies', creatorToken, {
      title: 'Creator Tries Featured',
      featured: true,
    });
    assert.equal(featureOnCreate.statusCode, 403);

    const draft = await call('POST', '/api/movies', creatorToken, {
      title: 'Creator Draft',
      description: 'Own film',
      createdBy: officialMovieId,
      hlsUrl: 'https://cdn.example.com/creator-draft.mp4',
    });
    assert.equal(draft.statusCode, 201);
    const draftBody = await bodyOf(draft);
    creatorMovieId = draftBody.data.id;
    assert.equal(draftBody.data.status, 'draft');
    assert.equal(draftBody.data.featured, false);
    assert.equal(draftBody.data.trending, false);
    assert.equal(String(draftBody.data.createdBy), creatorId);
    assert.equal(await NotificationModel.countDocuments({ contentId: creatorMovieId }), 0);

    const ownList = await bodyOf(await call('GET', '/api/movies', creatorToken));
    assert.equal(ownList.data.length, 1);
    assert.equal(ownList.data[0].title, 'Creator Draft');

    const statusPublish = await call('PATCH', `/api/movies/${creatorMovieId}/status`, creatorToken, { status: 'published' });
    assert.equal(statusPublish.statusCode, 403);
    const toggleFeatured = await call('PATCH', `/api/movies/${creatorMovieId}/featured`, creatorToken);
    assert.equal(toggleFeatured.statusCode, 403);
    const toggleTrending = await call('PATCH', `/api/movies/${creatorMovieId}/trending`, creatorToken);
    assert.equal(toggleTrending.statusCode, 403);
    const putFeatured = await call('PUT', `/api/movies/${creatorMovieId}`, creatorToken, { featured: true });
    assert.equal(putFeatured.statusCode, 403);

    const noRights = await call('POST', `/api/movies/item/${creatorMovieId}/submit-review`, creatorToken, {});
    assert.equal(noRights.statusCode, 400);

    const { MovieModel } = await import('../src/models/Movie.ts');
    await MovieModel.updateOne({ _id: creatorMovieId }, { $set: { hlsUrl: '', videoUrl: '', sourceVideoUrl: '', processingStatus: 'ready' } });
    const noVideo = await call('POST', `/api/movies/item/${creatorMovieId}/submit-review`, creatorToken, { copyrightAttested: true });
    assert.equal(noVideo.statusCode, 400);

    await MovieModel.updateOne({ _id: creatorMovieId }, {
      $set: { hlsUrl: 'https://cdn.example.com/creator-draft.mp4', processingStatus: 'processing' },
    });
    const stillProcessing = await call('POST', `/api/movies/item/${creatorMovieId}/submit-review`, creatorToken, { copyrightAttested: true });
    assert.equal(stillProcessing.statusCode, 400);

    await MovieModel.updateOne({ _id: creatorMovieId }, { $set: { processingStatus: 'ready' } });
    const submitted = await call('POST', `/api/movies/item/${creatorMovieId}/submit-review`, creatorToken, { copyrightAttested: true });
    assert.equal(submitted.statusCode, 200);
    const submittedBody = await bodyOf(submitted);
    assert.equal(submittedBody.data.status, 'moderation');
    assert.equal(submittedBody.data.copyrightAttested, true);
    assert.ok(submittedBody.data.copyrightAttestedAt);
    assert.ok(submittedBody.data.submittedAt);

    const { AdminNotificationModel } = await import('../src/models/AdminNotification.ts');
    const reviewNotice = await AdminNotificationModel.findOne({ title: 'Content submitted for review', modelName: 'Movie' }).lean();
    assert.ok(reviewNotice);

    const creatorApprove = await call('POST', `/api/movies/item/${creatorMovieId}/approve`, creatorToken, {});
    assert.equal(creatorApprove.statusCode, 403);

    const published = await call('POST', `/api/movies/item/${creatorMovieId}/approve`, adminToken, {});
    assert.equal(published.statusCode, 200);
    const publishedBody = await bodyOf(published);
    assert.equal(publishedBody.data.status, 'published');
    const creatorInfo = publishedBody.data.createdBy;
    assert.equal(creatorInfo.email || creatorInfo, creatorInfo.email ? 'asha@ashqe.test' : creatorId);
    const release = await NotificationModel.findOne({ contentId: creatorMovieId, title: 'New Movie Added! 🍿' }).lean();
    assert.ok(release);

    const adminList = await bodyOf(await call('GET', '/api/movies', adminToken));
    assert.equal(adminList.data.some((row: any) => row.title === 'Official Catalog Film'), true);
    assert.equal(adminList.data.some((row: any) => row.title === 'Creator Draft'), true);
  });

  test('web series submit, rejection reason, and approval match movie moderation', async () => {
    const { NotificationModel } = await import('../src/models/Notification.ts');
    const show = await call('POST', '/api/tv-shows', creatorToken, { title: 'Creator Series' });
    assert.equal(show.statusCode, 201);
    const showBody = await bodyOf(show);
    assert.equal(showBody.data.status, 'draft');
    assert.equal(String(showBody.data.createdBy), creatorId);
    const showId = showBody.data.id;

    const tooSoon = await call('POST', `/api/tv-shows/item/${showId}/submit-review`, creatorToken, { copyrightAttested: true });
    assert.equal(tooSoon.statusCode, 400);

    const episode = await call('POST', '/api/episodes', creatorToken, {
      tvShowId: showId,
      season: 1,
      episode: 1,
      title: 'Pilot',
      sourceVideoUrl: 'https://cdn.example.com/pilot.mp4',
    });
    assert.equal(episode.statusCode, 201);
    assert.equal((await bodyOf(episode)).data.processingStatus, 'ready');
    assert.equal(String((await bodyOf(episode)).data.createdBy), creatorId);

    const foreignEpisode = await call('POST', '/api/episodes', creatorToken, {
      tvShowId: officialMovieId,
      season: 1,
      episode: 1,
      title: 'Should Fail',
      sourceVideoUrl: 'https://cdn.example.com/nope.mp4',
    });
    assert.equal(foreignEpisode.statusCode, 404);

    const submitted = await call('POST', `/api/tv-shows/item/${showId}/submit-review`, creatorToken, { copyrightAttested: true });
    assert.equal(submitted.statusCode, 200);
    assert.equal((await bodyOf(submitted)).data.status, 'moderation');

    const pending = await bodyOf(await call('GET', '/api/tv-shows/pending-approvals', adminToken));
    const pendingRow = pending.data.find((row: any) => String(row._id) === showId || row.title === 'Creator Series');
    assert.ok(pendingRow);
    assert.equal(pendingRow.createdBy.email, 'asha@ashqe.test');

    const creatorPending = await bodyOf(await call('GET', '/api/tv-shows/pending-approvals', creatorToken));
    assert.equal(creatorPending.data.length, 1);

    const rejected = await call('POST', `/api/tv-shows/item/${showId}/reject`, adminToken, {
      rejectionReason: 'Episode 1 audio is missing.',
    });
    assert.equal(rejected.statusCode, 200);
    const rejectedBody = await bodyOf(rejected);
    assert.equal(rejectedBody.data.status, 'rejected');
    assert.equal(rejectedBody.data.rejectionReason, 'Episode 1 audio is missing.');
    assert.equal(rejectedBody.data.createdBy.email, 'asha@ashqe.test');

    const second = await call('POST', '/api/tv-shows', creatorToken, {
      title: 'Creator Series Two',
      hlsUrl: 'https://cdn.example.com/series.m3u8',
    });
    const secondId = (await bodyOf(second)).data.id;
    const episodeTwo = await call('POST', '/api/episodes', creatorToken, {
      tvShowId: secondId,
      season: 1,
      episode: 1,
      title: 'Episode One',
      sourceVideoUrl: 'https://cdn.example.com/s2e1.mp4',
    });
    assert.equal(episodeTwo.statusCode, 201);
    const submittedTwo = await call('POST', `/api/tv-shows/item/${secondId}/submit-review`, creatorToken, { copyrightAttested: true });
    assert.equal(submittedTwo.statusCode, 200);

    const approved = await call('POST', `/api/tv-shows/item/${secondId}/approve`, adminToken, {});
    assert.equal(approved.statusCode, 200);
    const approvedBody = await bodyOf(approved);
    assert.equal(approvedBody.data.status, 'published');
    assert.equal(approvedBody.data.createdBy.email, 'asha@ashqe.test');
    const release = await NotificationModel.findOne({ contentId: secondId, title: 'New Web Series Added! 🍿' }).lean();
    assert.ok(release);

    const draftShows = await NotificationModel.countDocuments({ title: 'New Web Series Added! 🍿', contentId: showId });
    assert.equal(draftShows, 0);
  });

  test('media presign honors canUpload and creator quotas, and files stay private to the owner', async () => {
    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    const passwordHash = await bcrypt.hash('ModPass123!', 8);
    await AdminUserModel.create({
      email: 'librarian@ashqe.test',
      name: 'Librarian',
      passwordHash,
      role: 'moderator',
      isActive: true,
      modulePermissions: {
        mediaLibrary: { canView: true, canUpload: false, canDelete: false },
        movies: { canView: true, canCreate: false, canEdit: false, canDelete: false },
      },
    });
    const librarian = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'librarian@ashqe.test',
      password: 'ModPass123!',
    }));

    const denied = await call('POST', '/api/media/presign', librarian.accessToken, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: 1000,
    });
    assert.equal(denied.statusCode, 403);
    assert.match((await bodyOf(denied)).error, /canUpload/);

    const oversized = await call('POST', '/api/media/presign', creatorToken, {
      fileName: 'huge.mp4',
      contentType: 'video/mp4',
      fileSize: 50 * 1024 * 1024,
    });
    assert.equal(oversized.statusCode, 400);
    assert.match((await bodyOf(oversized)).error, /upload limit/i);

    const allowed = await call('POST', '/api/media/presign', creatorToken, {
      fileName: 'poster.jpg',
      contentType: 'image/jpeg',
      fileSize: 2048,
    });
    assert.notEqual(allowed.statusCode, 403);
    const allowedBody = await bodyOf(allowed);
    assert.equal(allowedBody.code, 'S3_NOT_CONFIGURED');

    const folderId = new mongoose.Types.ObjectId().toString();
    const confirmed = await call('POST', '/api/media/confirm-s3', creatorToken, {
      key: `media/${folderId}/poster.jpg`,
      publicUrl: 'https://cdn.example.com/poster.jpg',
      folderId,
      fileName: 'poster.jpg',
      originalName: 'poster.jpg',
      contentType: 'image/jpeg',
      fileSize: 2048,
    });
    assert.equal(confirmed.statusCode, 201);
    const fileId = (await bodyOf(confirmed)).data.id;
    assert.equal(String((await bodyOf(confirmed)).data.createdBy), creatorId);

    const list = await bodyOf(await call('GET', '/api/media/files/all', creatorToken));
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, fileId);

    const visibleToAdmin = await call('GET', `/api/media/files/${fileId}`, adminToken);
    assert.equal(visibleToAdmin.statusCode, 200);
    const creatorRead = await call('GET', `/api/media/files/${fileId}`, creatorToken);
    assert.equal(creatorRead.statusCode, 200);

    const otherHash = await bcrypt.hash('OtherPass123!', 8);
    const other = await AdminUserModel.create({
      email: 'other-creator@ashqe.test',
      name: 'Other Creator',
      passwordHash: otherHash,
      role: 'influencer',
      isActive: true,
      mustChangePassword: false,
      modulePermissions: {
        mediaLibrary: { canView: true, canUpload: true, canDelete: false },
        movies: { canView: true, canCreate: true, canEdit: true, canDelete: false },
        tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: false },
      },
    });
    assert.ok(other);
    const otherLogin = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'other-creator@ashqe.test',
      password: 'OtherPass123!',
    }));
    const otherRead = await call('GET', `/api/media/files/${fileId}`, otherLogin.accessToken);
    assert.equal(otherRead.statusCode, 404);
    const otherList = await bodyOf(await call('GET', '/api/media/files/all', otherLogin.accessToken));
    assert.equal(otherList.data.length, 0);

    const tooBigConfirm = await call('POST', '/api/media/confirm-s3', creatorToken, {
      key: `media/${folderId}/big.jpg`,
      publicUrl: 'https://cdn.example.com/big.jpg',
      folderId,
      contentType: 'image/jpeg',
      fileSize: 9 * 1024 * 1024,
    });
    assert.equal(tooBigConfirm.statusCode, 400);
  });

  test('creator dashboard summarizes owned titles and quotas', async () => {
    const dash = await call('GET', '/api/creator/dashboard', creatorToken);
    assert.equal(dash.statusCode, 200);
    const data = (await bodyOf(dash)).data;
    assert.ok(data.counts.movies.total >= 1);
    assert.ok(data.counts.movies.published >= 1);
    assert.ok(data.counts.tvShows.total >= 2);
    assert.equal(typeof data.totalViews, 'number');
    assert.equal(data.quotas.maxUploadSizeBytes, 1024 * 1024);
    assert.equal(typeof data.quotas.currentPendingSubmissions, 'number');
    assert.equal(data.quotas.maxPendingSubmissions, 4);
    assert.ok(Array.isArray(data.recentSubmissions));
    assert.ok(data.recentSubmissions.length >= 1);

    const adminDash = await call('GET', '/api/creator/dashboard', adminToken);
    assert.equal(adminDash.statusCode, 403);
  });

  test('in-flight submission quota returns 429', async () => {
    process.env.CREATOR_MAX_PENDING_SUBMISSIONS = '1';
    const first = await call('POST', '/api/movies', creatorToken, { title: 'Quota Probe' });
    const blocked = first.statusCode === 429
      ? first
      : await call('POST', '/api/movies', creatorToken, { title: 'One Too Many' });
    assert.equal(blocked.statusCode, 429);
    assert.match((await bodyOf(blocked)).error, /at most 1 active submission/i);
    process.env.CREATOR_MAX_PENDING_SUBMISSIONS = '4';
  });

  test('apply rate limit returns 429', async () => {
    resetRateLimits();
    process.env.CREATOR_APPLY_IP_LIMIT = '1';
    const first = await call('POST', '/api/public/creator/apply', undefined, applyBody('rate-limit-one@ashqe.test'));
    assert.equal(first.statusCode, 201);
    const second = await call('POST', '/api/public/creator/apply', undefined, applyBody('rate-limit-two@ashqe.test'));
    assert.equal(second.statusCode, 429);
    process.env.CREATOR_APPLY_IP_LIMIT = '500';
    resetRateLimits();
  });
});
