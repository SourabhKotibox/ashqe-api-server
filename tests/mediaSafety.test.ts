import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'media-safety-test-secret';
process.env.STORAGE_DRIVER = 'local';
process.env.CREATOR_CATALOG_CREATES_PER_HOUR = '500';
process.env.CREATOR_CATALOG_MAX_PER_TYPE = '500';
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_S3_ACCESS_KEY_ID;
delete process.env.AWS_S3_SECRET_ACCESS_KEY;
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const uploadsRoot = path.join(process.cwd(), 'uploads');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('shared media deletion and duplicate articles', { concurrency: 1, timeout: 180000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let adminToken = '';
  let creatorToken = '';
  let otherToken = '';
  let creatorId = '';
  let otherId = '';
  const writtenFiles: string[] = [];

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

  const writeUpload = (name: string) => {
    const relative = path.join('media', name);
    const absolute = path.join(uploadsRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, png);
    writtenFiles.push(absolute);
    return {
      absolute,
      filePath: `/uploads/media/${name}`,
      url: `http://localhost/uploads/media/${name}`,
    };
  };

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = await import('mongoose');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    app = (await import('../src/app.ts')).default;
    await app.ready();

    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    const passwordHash = await bcrypt.hash('AdminPass123!', 8);
    await AdminUserModel.create({
      email: 'media-admin@ashqe.test',
      name: 'Media Admin',
      passwordHash,
      role: 'superadmin',
      isActive: true,
    });
    const creatorPerms = {
      movies: { canView: true, canCreate: true, canEdit: true, canDelete: false },
      tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: false },
      actors: { canView: true, canCreate: true, canEdit: true, canDelete: true },
      directors: { canView: true, canCreate: true, canEdit: true, canDelete: true },
      mediaLibrary: { canView: true, canUpload: true, canDelete: false },
    };
    const creator = await AdminUserModel.create({
      email: 'media-creator@ashqe.test',
      name: 'Media Creator',
      passwordHash: await bcrypt.hash('CreatorPass123!', 8),
      role: 'influencer',
      isActive: true,
      mustChangePassword: false,
      modulePermissions: creatorPerms,
    });
    creatorId = creator._id.toString();
    const other = await AdminUserModel.create({
      email: 'media-other@ashqe.test',
      name: 'Other Creator',
      passwordHash: await bcrypt.hash('OtherPass123!', 8),
      role: 'influencer',
      isActive: true,
      mustChangePassword: false,
      modulePermissions: creatorPerms,
    });
    otherId = other._id.toString();

    adminToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'media-admin@ashqe.test',
      password: 'AdminPass123!',
    }))).accessToken;
    creatorToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'media-creator@ashqe.test',
      password: 'CreatorPass123!',
    }))).accessToken;
    otherToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'media-other@ashqe.test',
      password: 'OtherPass123!',
    }))).accessToken;
    assert.ok(adminToken && creatorToken && otherToken);
  });

  after(async () => {
    for (const file of writtenFiles) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    if (app) await app.close();
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  test('duplicate catalog names use an before vowel sounds', async () => {
    const { duplicateNameMessage } = await import('../src/lib/catalogAccess.ts');
    assert.equal(duplicateNameMessage('actor'), 'An actor with this name already exists');
    assert.equal(duplicateNameMessage('item'), 'An item with this name already exists');
    assert.equal(duplicateNameMessage('director'), 'A director with this name already exists');
    assert.equal(duplicateNameMessage('crew member'), 'A crew member with this name already exists');
    assert.equal(duplicateNameMessage('language'), 'A language with this name already exists');

    const first = await call('POST', '/api/actors', adminToken, { name: 'Article Actor', designation: 'Lead' });
    assert.equal(first.statusCode, 201, first.body);
    const duplicate = await call('POST', '/api/actors', adminToken, { name: 'article actor', designation: 'Lead' });
    assert.equal(duplicate.statusCode, 409);
    const payload = await bodyOf(duplicate);
    assert.equal(payload.error, 'An actor with this name already exists');
    assert.equal(payload.message, 'An actor with this name already exists');

    const crew = await call('POST', '/api/crews', adminToken, { name: 'Article Crew', designation: 'Editor' });
    assert.equal(crew.statusCode, 201, crew.body);
    const crewDup = await bodyOf(await call('POST', '/api/crews', adminToken, { name: 'Article Crew', designation: 'Editor' }));
    assert.equal(crewDup.error, 'A crew member with this name already exists');
  });

  test('content-hash dedup stays inside the same owner', async () => {
    const { saveFileFromPart } = await import('../src/lib/uploadHandler.ts');
    const { MediaFileModel } = await import('../src/models/MediaFile.ts');
    const request = { protocol: 'http', headers: { host: 'localhost' } } as any;
    const bytes = Buffer.concat([png, Buffer.from('owner-dedup')]);

    const upload = (createdBy: string) => saveFileFromPart({
      filename: 'same-thumb.png',
      mimetype: 'image/png',
      file: Readable.from([bytes]),
    }, request, 'MEDIA_LIBRARY', 'media/dedup', {
      trackInMediaLibrary: true,
      source: 'media-library',
      createdBy,
    });

    const first = await upload(creatorId);
    const secondOwner = await upload(otherId);
    const sameOwner = await upload(creatorId);

    assert.ok(first.mediaFileId);
    assert.ok(secondOwner.mediaFileId);
    assert.notEqual(secondOwner.mediaFileId, first.mediaFileId);
    assert.equal(sameOwner.mediaFileId, first.mediaFileId);

    const docs = await MediaFileModel.find({ _id: { $in: [first.mediaFileId, secondOwner.mediaFileId] } }).lean();
    assert.equal(docs.length, 2);
    assert.equal(String(docs.find((doc) => String(doc._id) === first.mediaFileId)?.createdBy), creatorId);
    assert.equal(String(docs.find((doc) => String(doc._id) === secondOwner.mediaFileId)?.createdBy), otherId);
    assert.notEqual(docs[0].filePath, docs[1].filePath);
  });

  test('deleting referenced media is blocked and unreferenced media you own can be removed', async () => {
    const { MediaFileModel } = await import('../src/models/MediaFile.ts');
    const { MovieModel } = await import('../src/models/Movie.ts');
    const { EpisodeModel } = await import('../src/models/Episode.ts');
    const { TVShowModel } = await import('../src/models/TVShow.ts');
    const { ActorModel } = await import('../src/models/Actor.ts');
    const { SettingsModel } = await import('../src/models/Settings.ts');

    const sharedName = `${Date.now()}-abcd1234-shared.png`;
    const shared = writeUpload(sharedName);
    const sharedFile = await MediaFileModel.create({
      name: sharedName,
      url: shared.url,
      filePath: shared.filePath,
      fileSize: png.length,
      fileType: 'image/png',
      storageType: 'local',
      contentHash: crypto.createHash('sha256').update(png).digest('hex'),
      createdBy: creatorId,
    });

    const movie = await MovieModel.create({
      title: 'Uses shared thumb',
      thumbnail: shared.url,
      createdBy: otherId,
    });
    const show = await TVShowModel.create({ title: 'Uses shared poster', posterImage: shared.filePath, createdBy: creatorId });
    await EpisodeModel.create({
      tvShowId: show._id,
      season: 1,
      episode: 1,
      title: 'Pilot',
      thumbnail: shared.filePath,
      createdBy: creatorId,
    });
    await ActorModel.create({ name: 'Shared Face', designation: 'Actor', image: shared.filePath, createdBy: creatorId });
    await SettingsModel.create({ logoUrl: shared.url, platformName: 'Ashqe' });

    const blocked = await call('DELETE', `/api/media/files/${sharedFile._id}`, creatorToken);
    assert.equal(blocked.statusCode, 409, blocked.body);
    const blockedBody = await bodyOf(blocked);
    assert.match(blockedBody.error, /This file is in use by [1-9]\d* items?/);
    assert.equal(fs.existsSync(shared.absolute), true);
    assert.ok(await MediaFileModel.findById(sharedFile._id));

    const adminBlocked = await call('DELETE', `/api/media/files/${sharedFile._id}`, adminToken);
    assert.equal(adminBlocked.statusCode, 409, adminBlocked.body);
    assert.equal(fs.existsSync(shared.absolute), true);

    await MovieModel.deleteMany({ _id: movie._id });
    await EpisodeModel.deleteMany({ tvShowId: show._id });
    await TVShowModel.deleteMany({ _id: show._id });
    await ActorModel.deleteMany({ image: shared.filePath });
    await SettingsModel.deleteMany({ logoUrl: shared.url });

    const removed = await call('DELETE', `/api/media/files/${sharedFile._id}`, creatorToken);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await MediaFileModel.findById(sharedFile._id), null);
    assert.equal(fs.existsSync(shared.absolute), false);
  });

  test('a creator cannot delete another user\'s media', async () => {
    const { MediaFileModel } = await import('../src/models/MediaFile.ts');
    const name = `${Date.now()}-abcd1234-private.png`;
    const stored = writeUpload(name);
    const foreign = await MediaFileModel.create({
      name,
      url: stored.url,
      filePath: stored.filePath,
      fileSize: png.length,
      fileType: 'image/png',
      storageType: 'local',
      createdBy: otherId,
    });

    const denied = await call('DELETE', `/api/media/files/${foreign._id}`, creatorToken);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.match((await bodyOf(denied)).error, /only delete media you uploaded/i);
    assert.ok(await MediaFileModel.findById(foreign._id));
    assert.equal(fs.existsSync(stored.absolute), true);

    const gone = await call('DELETE', `/api/media/files/${foreign._id}`, otherToken);
    assert.equal(gone.statusCode, 200, gone.body);
    assert.equal(await MediaFileModel.findById(foreign._id), null);
    assert.equal(fs.existsSync(stored.absolute), false);
  });

  test('deleting a title or actor does not remove storage still used elsewhere', async () => {
    const { MediaFileModel } = await import('../src/models/MediaFile.ts');
    const { MovieModel } = await import('../src/models/Movie.ts');
    const name = `${Date.now()}-abcd1234-cascade.png`;
    const stored = writeUpload(name);
    const media = await MediaFileModel.create({
      name,
      url: stored.url,
      filePath: stored.filePath,
      fileSize: png.length,
      fileType: 'image/png',
      storageType: 'local',
      createdBy: creatorId,
    });
    const movie = await MovieModel.create({
      title: 'Cascade thumb',
      thumbnail: stored.filePath,
      bannerImage: stored.url,
      createdBy: creatorId,
    });
    const actor = await call('POST', '/api/actors', adminToken, {
      name: `Cascade Face ${Date.now()}`,
      designation: 'Lead',
      image: stored.filePath,
    });
    assert.equal(actor.statusCode, 201, actor.body);
    const actorId = (await bodyOf(actor)).data.id;

    const actorDelete = await call('DELETE', `/api/actors/item/${actorId}`, adminToken);
    assert.equal(actorDelete.statusCode, 200, actorDelete.body);
    assert.equal(fs.existsSync(stored.absolute), true);
    assert.ok(await MediaFileModel.findById(media._id));

    const movieDelete = await call('DELETE', `/api/movies/${movie._id}`, adminToken);
    assert.equal(movieDelete.statusCode, 200, movieDelete.body);
    assert.equal(fs.existsSync(stored.absolute), true, 'library object must survive title deletion');
    assert.ok(await MediaFileModel.findById(media._id));

    const stillBlocked = await call('DELETE', `/api/media/files/${media._id}`, creatorToken);
    assert.equal(stillBlocked.statusCode, 200, stillBlocked.body);
    assert.equal(fs.existsSync(stored.absolute), false);
  });
});
