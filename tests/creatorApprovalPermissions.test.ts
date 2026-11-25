import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'creator-approval-permissions-secret';
process.env.CREATOR_APPLY_IP_LIMIT = '500';
process.env.CREATOR_APPLY_EMAIL_LIMIT = '500';
process.env.CREATOR_CATALOG_CREATES_PER_HOUR = '500';
process.env.CREATOR_CATALOG_MAX_PER_TYPE = '500';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const CREATOR_SECTIONS = [
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
];

const clearedPermissions = () => ({
  users: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  movies: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  tvShows: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  genres: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  actors: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  directors: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  languages: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  countries: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  categories: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  mediaLibrary: { canView: false, canUpload: false, canDelete: false },
  banners: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  promotions: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  influencers: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  ads: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  pages: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  faqs: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  subscriptions: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  subscriptionPlans: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  planLimits: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  notifications: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  notificationTemplates: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  settings: { canView: false, canCreate: false, canEdit: false, canDelete: false },
  reviews: { canView: false, canCreate: false, canEdit: false, canDelete: false },
});

const applyBody = (email: string) => ({
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
});

describe('Creator approval section pack', { concurrency: 1, timeout: 180000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let syncCreatorCatalogPermissions: () => Promise<{ matched: number; modified: number }>;
  let adminToken = '';
  let creatorToken = '';
  let creatorId = '';
  let otherToken = '';

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

  const assertCreatorPayload = (user: any) => {
    assert.equal(user.role, 'influencer');
    assert.deepEqual(user.sections, CREATOR_SECTIONS);
    const perms = user.modulePermissions;
    for (const moduleName of ['movies', 'tvShows'] as const) {
      assert.equal(perms[moduleName].canView, true, moduleName);
      assert.equal(perms[moduleName].canCreate, true, moduleName);
      assert.equal(perms[moduleName].canEdit, true, moduleName);
      assert.equal(perms[moduleName].canDelete, false, moduleName);
    }
    assert.equal(perms.mediaLibrary.canView, true);
    assert.equal(perms.mediaLibrary.canUpload, true);
    assert.equal(perms.mediaLibrary.canDelete, false);
    for (const moduleName of ['languages', 'genres', 'actors', 'directors', 'countries'] as const) {
      assert.equal(perms[moduleName].canView, true, moduleName);
      assert.equal(perms[moduleName].canCreate, true, moduleName);
      assert.equal(perms[moduleName].canEdit, true, moduleName);
      assert.equal(perms[moduleName].canDelete, true, moduleName);
    }
    for (const moduleName of ['users', 'settings', 'influencers', 'banners', 'subscriptions'] as const) {
      assert.equal(perms[moduleName].canView, false, moduleName);
      assert.equal(perms[moduleName].canCreate, false, moduleName);
      assert.equal(perms[moduleName].canDelete, false, moduleName);
    }
  };

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = await import('mongoose');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    ({ syncCreatorCatalogPermissions } = await import('../src/lib/creatorAccess.ts'));
    app = (await import('../src/app.ts')).default;
    await app.ready();

    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    await AdminUserModel.create({
      email: 'approver@ashqe.test',
      name: 'Approver',
      passwordHash: await bcrypt.hash('AdminPass123!', 8),
      role: 'superadmin',
      isActive: true,
      modulePermissions: clearedPermissions(),
    });
    await AdminUserModel.create({
      email: 'editor@ashqe.test',
      name: 'Editor',
      passwordHash: await bcrypt.hash('EditorPass123!', 8),
      role: 'moderator',
      isActive: true,
      modulePermissions: clearedPermissions(),
    });
    await AdminUserModel.create({
      email: 'staff-admin@ashqe.test',
      name: 'Staff Admin',
      passwordHash: await bcrypt.hash('StaffPass123!', 8),
      role: 'admin',
      isActive: true,
      modulePermissions: clearedPermissions(),
    });

    adminToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'approver@ashqe.test',
      password: 'AdminPass123!',
    }))).accessToken;
    assert.ok(adminToken);
  });

  after(async () => {
    if (app) await app.close();
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  test('approving an application grants every creator section with no manual assignment', async () => {
    const applied = await call('POST', '/api/public/creator/apply', undefined, applyBody('asha-sections@ashqe.test'));
    assert.equal(applied.statusCode, 201, applied.body);
    const applicationId = (await bodyOf(applied)).data.applicationId;

    const approved = await call('POST', `/api/admin/creator-applications/${applicationId}/approve`, adminToken, {});
    assert.equal(approved.statusCode, 200, approved.body);
    const approvedBody = await bodyOf(approved);
    assert.equal(approvedBody.data.adminUser.role, 'influencer');
    assertCreatorPayload(approvedBody.data.adminUser);
    creatorId = approvedBody.data.adminUser.id;
    const temporaryPassword = approvedBody.data.temporaryPassword;

    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    const stored = await AdminUserModel.findById(creatorId).lean();
    assert.equal(stored?.role, 'influencer');
    assert.equal(stored?.modulePermissions?.movies?.canCreate, true);
    assert.equal(stored?.modulePermissions?.countries?.canView, true);
    assert.equal(stored?.modulePermissions?.users?.canView, false);

    const login = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'asha-sections@ashqe.test',
      password: temporaryPassword,
    }));
    creatorToken = login.accessToken;
    const me = await bodyOf(await call('GET', '/api/auth/me', creatorToken));
    assertCreatorPayload(me.user);

    assert.equal((await call('GET', '/api/movies', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/tv-shows', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/media/folders', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/actors', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/directors', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/crews', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/users', creatorToken)).statusCode, 403);
    assert.equal((await call('GET', '/api/dashboard/stats', creatorToken)).statusCode, 403);
    assert.equal((await call('PUT', '/api/settings', creatorToken, { platformName: 'Nope' })).statusCode, 403);
  });

  test('cleared stored permissions and a role-form save still leave the creator pack in place', async () => {
    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    await AdminUserModel.updateOne({ _id: creatorId }, { $set: { modulePermissions: clearedPermissions() } });
    const cleared = await AdminUserModel.findById(creatorId).lean();
    assert.equal(cleared?.modulePermissions?.movies?.canCreate, false);
    assert.equal(cleared?.modulePermissions?.genres?.canView, false);

    const me = await bodyOf(await call('GET', '/api/auth/me', creatorToken));
    assertCreatorPayload(me.user);

    const genre = await call('POST', '/api/genres', creatorToken, { name: 'Creator Folk' });
    assert.equal(genre.statusCode, 201, genre.body);
    const genreId = (await bodyOf(genre)).data.id || (await bodyOf(genre)).data._id;

    const saved = await call('PUT', `/api/admin-users/${creatorId}`, adminToken, {
      modulePermissions: clearedPermissions(),
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assertCreatorPayload((await bodyOf(saved)).data);

    const persisted = await AdminUserModel.findById(creatorId).lean();
    assert.equal(persisted?.modulePermissions?.movies?.canCreate, true);
    assert.equal(persisted?.modulePermissions?.mediaLibrary?.canUpload, true);
    assert.equal(persisted?.modulePermissions?.countries?.canDelete, true);
    assert.equal(persisted?.modulePermissions?.settings?.canView, false);
    assert.equal(persisted?.modulePermissions?.users?.canView, false);

    const otherApplied = await call('POST', '/api/public/creator/apply', undefined, applyBody('other-sections@ashqe.test'));
    const otherId = (await bodyOf(otherApplied)).data.applicationId;
    const otherApproved = await call('POST', `/api/admin/creator-applications/${otherId}/approve`, adminToken, {});
    assert.equal(otherApproved.statusCode, 200, otherApproved.body);
    otherToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'other-sections@ashqe.test',
      password: (await bodyOf(otherApproved)).data.temporaryPassword,
    }))).accessToken;

    const stolen = await call('DELETE', `/api/genres/item/${genreId}`, otherToken);
    assert.equal(stolen.statusCode, 403, stolen.body);
    const own = await call('DELETE', `/api/genres/item/${genreId}`, creatorToken);
    assert.equal(own.statusCode, 200, own.body);
  });

  test('startup sync persists the pack for a cleared creator and does not grant other roles', async () => {
    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    await AdminUserModel.updateOne({ _id: creatorId }, { $set: { modulePermissions: clearedPermissions() } });

    const moderator = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'editor@ashqe.test',
      password: 'EditorPass123!',
    }));
    const staff = await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'staff-admin@ashqe.test',
      password: 'StaffPass123!',
    }));

    const moderatorMe = await bodyOf(await call('GET', '/api/auth/me', moderator.accessToken));
    assert.equal(moderatorMe.user.role, 'moderator');
    assert.deepEqual(moderatorMe.user.sections, ['dashboard']);
    assert.equal(moderatorMe.user.modulePermissions.movies.canView, false);
    assert.equal(moderatorMe.user.modulePermissions.movies.canCreate, false);
    assert.equal(moderatorMe.user.modulePermissions.genres.canCreate, false);
    assert.equal(moderatorMe.user.modulePermissions.mediaLibrary.canUpload, false);
    assert.equal((await call('GET', '/api/movies', moderator.accessToken)).statusCode, 403);
    assert.equal((await call('GET', '/api/crews', moderator.accessToken)).statusCode, 403);
    assert.equal((await call('POST', '/api/genres', moderator.accessToken, { name: 'Not Allowed' })).statusCode, 403);
    assert.equal((await call('POST', '/api/countries', moderator.accessToken, { name: 'Not Allowed', code: 'NA' })).statusCode, 403);

    const staffMe = await bodyOf(await call('GET', '/api/auth/me', staff.accessToken));
    assert.equal(staffMe.user.role, 'admin');
    assert.equal(staffMe.user.modulePermissions.movies.canCreate, false);
    assert.equal(staffMe.user.modulePermissions.tvShows.canCreate, false);
    assert.equal(staffMe.user.sections.includes('movies'), false);
    assert.equal((await call('POST', '/api/movies', staff.accessToken, { title: 'Staff Movie' })).statusCode, 403);

    const synced = await syncCreatorCatalogPermissions();
    assert.equal(synced.matched, 1);
    assert.equal(synced.modified, 1);
    const again = await syncCreatorCatalogPermissions();
    assert.equal(again.matched, 0);
    assert.equal(again.modified, 0);

    const restored = await AdminUserModel.findById(creatorId).lean();
    assert.equal(restored?.modulePermissions?.movies?.canCreate, true);
    assert.equal(restored?.modulePermissions?.tvShows?.canEdit, true);
    assert.equal(restored?.modulePermissions?.mediaLibrary?.canUpload, true);
    assert.equal(restored?.modulePermissions?.languages?.canDelete, true);
    assert.equal(restored?.modulePermissions?.directors?.canCreate, true);
    assert.equal(restored?.modulePermissions?.users?.canView, false);
    assert.equal(restored?.modulePermissions?.settings?.canEdit, false);

    const moderatorAfter = await AdminUserModel.findOne({ email: 'editor@ashqe.test' }).lean();
    assert.equal(moderatorAfter?.modulePermissions?.movies?.canView, false);
    assert.equal(moderatorAfter?.modulePermissions?.genres?.canCreate, false);
    const staffAfter = await AdminUserModel.findOne({ email: 'staff-admin@ashqe.test' }).lean();
    assert.equal(staffAfter?.modulePermissions?.movies?.canCreate, false);
  });
});
