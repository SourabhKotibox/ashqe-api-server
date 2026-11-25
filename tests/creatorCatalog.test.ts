import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'creator-catalog-test-secret';
process.env.CREATOR_CATALOG_CREATES_PER_HOUR = '500';
process.env.CREATOR_CATALOG_MAX_PER_TYPE = '500';
process.env.CREATOR_MAX_PENDING_SUBMISSIONS = '20';
process.env.STORAGE_DRIVER = 'local';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const off = { canView: false, canCreate: false, canEdit: false, canDelete: false };
const on = { canView: true, canCreate: true, canEdit: true, canDelete: true };

const oldCreatorPermissions = {
  users: { ...off },
  movies: { canView: true, canCreate: true, canEdit: true, canDelete: false },
  tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: false },
  genres: { ...off },
  actors: { ...off },
  directors: { ...off },
  languages: { ...off },
  countries: { ...off },
  categories: { ...off },
  mediaLibrary: { canView: true, canUpload: true, canDelete: false },
  banners: { ...off },
  promotions: { ...off },
  influencers: { ...off },
  ads: { ...off },
  pages: { ...off },
  faqs: { ...off },
  subscriptions: { ...off },
  subscriptionPlans: { ...off },
  planLimits: { ...off },
  notifications: { ...off },
  notificationTemplates: { ...off },
  settings: { ...off },
  reviews: { ...off },
};

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const imageUpload = () => {
  const boundary = '----AshqeCatalog';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="face.png"\r\nContent-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, png, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

describe('Creator catalog access', { concurrency: 1, timeout: 180000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let syncCreatorCatalogPermissions: () => Promise<{ matched: number; modified: number }>;
  let resetRateLimits: () => void;
  let adminToken = '';
  let staffToken = '';
  let creatorToken = '';
  let otherToken = '';
  let creatorId = '';
  let genreId = '';
  let languageId = '';
  let actorId = '';
  let directorId = '';
  let countryId = '';
  let crewId = '';
  let portraitUrl = '';

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

  const idOf = (payload: any) => String(payload?.data?.id || payload?.data?._id || '');

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = await import('mongoose');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    ({ resetRateLimits } = await import('../src/lib/rateLimit.ts'));
    ({ syncCreatorCatalogPermissions } = await import('../src/lib/creatorAccess.ts'));
    app = (await import('../src/app.ts')).default;
    await app.ready();

    const { AdminUserModel } = await import('../src/models/AdminUser.ts');
    const adminHash = await bcrypt.hash('AdminPass123!', 8);
    await AdminUserModel.create({
      email: 'catalog-admin@ashqe.test',
      name: 'Catalog Admin',
      passwordHash: adminHash,
      role: 'superadmin',
      isActive: true,
    });
    await AdminUserModel.create({
      email: 'catalog-staff@ashqe.test',
      name: 'Catalog Staff',
      passwordHash: await bcrypt.hash('StaffPass123!', 8),
      role: 'moderator',
      isActive: true,
      modulePermissions: {
        settings: { ...on },
        genres: { ...on },
        actors: { ...on },
        directors: { ...on },
        languages: { ...on },
        movies: { ...on },
        tvShows: { ...on },
        mediaLibrary: { canView: true, canUpload: true, canDelete: true },
      },
    });
    const creator = await AdminUserModel.create({
      email: 'catalog-creator@ashqe.test',
      name: 'Catalog Creator',
      passwordHash: await bcrypt.hash('CreatorPass123!', 8),
      role: 'influencer',
      isActive: true,
      mustChangePassword: false,
      modulePermissions: oldCreatorPermissions,
    });
    creatorId = creator._id.toString();
    await AdminUserModel.create({
      email: 'catalog-other@ashqe.test',
      name: 'Other Creator',
      passwordHash: await bcrypt.hash('OtherPass123!', 8),
      role: 'influencer',
      isActive: true,
      modulePermissions: oldCreatorPermissions,
    });

    adminToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'catalog-admin@ashqe.test',
      password: 'AdminPass123!',
    }))).accessToken;
    staffToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'catalog-staff@ashqe.test',
      password: 'StaffPass123!',
    }))).accessToken;
    creatorToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'catalog-creator@ashqe.test',
      password: 'CreatorPass123!',
    }))).accessToken;
    otherToken = (await bodyOf(await call('POST', '/api/auth/login', undefined, {
      email: 'catalog-other@ashqe.test',
      password: 'OtherPass123!',
    }))).accessToken;
    assert.ok(adminToken && staffToken && creatorToken && otherToken);
  });

  after(async () => {
    if (app) await app.close();
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  test('influencer catalog access comes from the role and sync persists the stored flags', async () => {
    assert.equal((await call('GET', '/api/actors', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/languages', creatorToken)).statusCode, 200);
    assert.equal((await call('GET', '/api/countries?limit=10', creatorToken)).statusCode, 200);
    const beforeSync = await bodyOf(await call('GET', '/api/auth/me', creatorToken));
    for (const moduleName of ['genres', 'actors', 'directors', 'languages', 'countries']) {
      assert.equal(beforeSync.user.modulePermissions[moduleName].canCreate, true, moduleName);
    }

    const synced = await syncCreatorCatalogPermissions();
    assert.equal(synced.matched, 2);
    assert.equal(synced.modified, 2);
    const again = await syncCreatorCatalogPermissions();
    assert.equal(again.matched, 0);
    assert.equal(again.modified, 0);

    const me = await bodyOf(await call('GET', '/api/auth/me', creatorToken));
    for (const moduleName of ['genres', 'actors', 'directors', 'languages', 'countries']) {
      const perms = me.user.modulePermissions[moduleName];
      assert.equal(perms.canView, true, moduleName);
      assert.equal(perms.canCreate, true, moduleName);
      assert.equal(perms.canEdit, true, moduleName);
      assert.equal(perms.canDelete, true, moduleName);
    }
    assert.equal(me.user.modulePermissions.users.canView, false);
    assert.equal(me.user.modulePermissions.settings.canCreate, false);
    assert.equal(me.user.modulePermissions.mediaLibrary.canUpload, true);
    assert.equal(me.user.modulePermissions.mediaLibrary.canDelete, false);
  });

  test('influencer can list and create each catalog entity, and duplicates return the existing id', async () => {
    const genre = await call('POST', '/api/genres', creatorToken, { name: 'Coastal Folk', createdBy: 'spoof' });
    assert.equal(genre.statusCode, 201, genre.body);
    genreId = idOf(await bodyOf(genre));
    const { GenreModel } = await import('../src/models/Genre.ts');
    const storedGenre = await GenreModel.findById(genreId).lean();
    assert.equal(String(storedGenre?.createdBy), creatorId);

    const genreDup = await call('POST', '/api/genres', creatorToken, { name: 'coastal folk' });
    assert.equal(genreDup.statusCode, 409);
    assert.equal((await bodyOf(genreDup)).existingId, genreId);

    const adminDup = await call('POST', '/api/genres', adminToken, { name: 'COASTAL FOLK' });
    assert.equal(adminDup.statusCode, 409);
    assert.equal((await bodyOf(adminDup)).existingId, genreId);

    const published = await call('POST', '/api/genres', creatorToken, { name: 'Hidden Folk', status: 'published' });
    assert.equal(published.statusCode, 403);

    const official = await call('POST', '/api/genres', staffToken, { name: 'Official Drama' });
    assert.equal(official.statusCode, 201, official.body);

    const publicList = await bodyOf(await call('GET', '/api/genres?search=Coastal&limit=50'));
    assert.equal(publicList.data.length, 0);
    const creatorList = await bodyOf(await call('GET', '/api/genres?search=Coastal&limit=50', creatorToken));
    assert.equal(creatorList.data.some((row: { name: string }) => row.name === 'Coastal Folk'), true);
    const otherList = await bodyOf(await call('GET', '/api/genres?q=official', otherToken));
    assert.equal(otherList.data.some((row: { name: string }) => row.name === 'Official Drama'), true);

    const language = await call('POST', '/api/languages', creatorToken, { name: 'Malayalam', code: 'ml' });
    assert.equal(language.statusCode, 201, language.body);
    languageId = idOf(await bodyOf(language));
    const languageDup = await call('POST', '/api/languages', creatorToken, { name: 'Other Tongue', code: 'ML' });
    assert.equal(languageDup.statusCode, 409);
    assert.equal((await bodyOf(languageDup)).existingId, languageId);
    const languageSearch = await bodyOf(await call('GET', '/api/languages?search=mala'));
    assert.equal(languageSearch.data.some((row: { name: string }) => row.name === 'Malayalam'), true);

    const actor = await call('POST', '/api/actors', creatorToken, { name: 'Mohanlal', createdBy: creatorId });
    assert.equal(actor.statusCode, 201, actor.body);
    const actorBody = await bodyOf(actor);
    actorId = idOf(actorBody);
    assert.equal(actorBody.data.designation, 'Actor');
    assert.equal(String(actorBody.data.createdBy), creatorId);
    const actorDup = await call('POST', '/api/actors', adminToken, { name: 'mohanlal', designation: 'Lead' });
    assert.equal(actorDup.statusCode, 409);
    const actorSearch = await bodyOf(await call('GET', '/api/actors?search=Mohan&limit=50', otherToken));
    assert.equal(actorSearch.data.some((row: { id: string }) => String(row.id) === actorId), true);

    const director = await call('POST', '/api/directors', creatorToken, { name: 'Adoor', designation: 'Director' });
    assert.equal(director.statusCode, 201, director.body);
    directorId = idOf(await bodyOf(director));
    const starred = await call('POST', '/api/directors', creatorToken, { name: 'Published Director', approvalStatus: 'published' });
    assert.equal(starred.statusCode, 403);

    const country = await call('POST', '/api/countries', creatorToken, { name: 'India', code: 'in' });
    assert.equal(country.statusCode, 201, country.body);
    const countryBody = await bodyOf(country);
    countryId = idOf(countryBody);
    assert.equal(countryBody.data.code, 'IN');
    const countryDup = await call('POST', '/api/countries', creatorToken, { name: 'Bharat', code: 'IN' });
    assert.equal(countryDup.statusCode, 409);
    assert.equal((await bodyOf(countryDup)).existingId, countryId);
    const countrySearch = await bodyOf(await call('GET', '/api/countries?search=ind', creatorToken));
    assert.equal(countrySearch.data.some((row: { name: string }) => row.name === 'India'), true);

    const staffCountry = await call('POST', '/api/countries', staffToken, { name: 'Japan', code: 'jp' });
    assert.equal(staffCountry.statusCode, 201, staffCountry.body);

    const crew = await call('POST', '/api/crews', creatorToken, { name: 'Resul Pookutty' });
    assert.equal(crew.statusCode, 201, crew.body);
    const crewBody = await bodyOf(crew);
    crewId = idOf(crewBody);
    assert.equal(crewBody.data.designation, 'Crew');
    const crewSearch = await bodyOf(await call('GET', '/api/crews?q=pookutty', creatorToken));
    assert.equal(crewSearch.data.some((row: { id: string }) => String(row.id) === crewId), true);
  });

  test('influencers edit and delete only their own rows; staff can still change any row', async () => {
    const renamed = await call('PUT', `/api/genres/item/${genreId}`, creatorToken, { name: 'Coastal Folk Tales' });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((await bodyOf(renamed)).data.name, 'Coastal Folk Tales');

    const { GenreModel } = await import('../src/models/Genre.ts');
    const official = await GenreModel.findOne({ name: 'Official Drama' }).lean();
    assert.ok(official);
    const blocked = await call('PUT', `/api/genres/item/${official!._id}`, creatorToken, { name: 'Hijacked Drama' });
    assert.equal(blocked.statusCode, 403);
    const blockedDelete = await call('DELETE', `/api/genres/item/${official!._id}`, creatorToken);
    assert.equal(blockedDelete.statusCode, 403);
    assert.equal((await GenreModel.findById(official!._id).lean())?.name, 'Official Drama');

    const bulk = await call('POST', '/api/genres/bulk-delete', creatorToken, { ids: [genreId, String(official!._id)] });
    assert.equal(bulk.statusCode, 403);
    assert.equal(await GenreModel.countDocuments({ _id: genreId }), 1);

    const otherEdit = await call('PUT', `/api/actors/item/${actorId}`, otherToken, { name: 'Not Theirs' });
    assert.equal(otherEdit.statusCode, 403);
    const otherDelete = await call('DELETE', `/api/actors/item/${actorId}`, otherToken);
    assert.equal(otherDelete.statusCode, 403);

    const staffEdit = await call('PUT', `/api/genres/item/${genreId}`, staffToken, { description: 'Staff can edit creator rows' });
    assert.equal(staffEdit.statusCode, 200, staffEdit.body);
    const adminLanguage = await call('PUT', `/api/languages/${languageId}`, adminToken, { name: 'Malayalam' });
    assert.equal(adminLanguage.statusCode, 200, adminLanguage.body);

    const legacy = await GenreModel.create({ name: 'Legacy No Owner', active: true });
    const legacyEdit = await call('PUT', `/api/genres/item/${legacy._id}`, creatorToken, { name: 'Legacy Taken' });
    assert.equal(legacyEdit.statusCode, 403);
    const staffLegacy = await call('PUT', `/api/genres/item/${legacy._id}`, staffToken, { description: 'Staff owns the cleanup' });
    assert.equal(staffLegacy.statusCode, 200, staffLegacy.body);

    const ownDelete = await call('DELETE', `/api/crews/${crewId}`, creatorToken);
    assert.equal(ownDelete.statusCode, 200, ownDelete.body);
    const recreated = await call('POST', '/api/crews', creatorToken, { name: 'Resul Pookutty', designation: 'Sound' });
    assert.equal(recreated.statusCode, 201, recreated.body);
    crewId = idOf(await bodyOf(recreated));
  });

  test('profile photos upload through the media library and can be saved on actors and directors', async () => {
    const { MediaFolderModel } = await import('../src/models/MediaFolder.ts');
    const folder = await MediaFolderModel.create({ name: 'Creator Portraits' });
    const folderDenied = await call('POST', '/api/media/folders', creatorToken, { name: 'Nope' });
    assert.equal(folderDenied.statusCode, 403);

    const file = imageUpload();
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/media/folders/${folder._id}/files`,
      headers: {
        authorization: `Bearer ${creatorToken}`,
        'content-type': file.contentType,
      },
      payload: file.payload,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const uploadedBody = await bodyOf(uploaded);
    portraitUrl = uploadedBody.data[0].url;
    assert.match(portraitUrl, /\/uploads\//);
    assert.match(String(uploadedBody.data[0].mimeType), /^image\//);
    const fileId = uploadedBody.data[0].mediaFileId;
    const readable = await bodyOf(await call('GET', `/api/media/files/${fileId}`, creatorToken));
    assert.equal(String(readable.data.createdBy), creatorId);
    assert.equal((await call('DELETE', `/api/media/files/${fileId}`, creatorToken)).statusCode, 200);
    assert.equal((await call('GET', `/api/media/files/${fileId}`, otherToken)).statusCode, 404);

    const actor = await call('POST', '/api/actors', creatorToken, { name: 'Portrait Actor', image: portraitUrl });
    assert.equal(actor.statusCode, 201, actor.body);
    assert.equal((await bodyOf(actor)).data.image, portraitUrl);
    const director = await call('PUT', `/api/directors/item/${directorId}`, creatorToken, { image: portraitUrl });
    assert.equal(director.statusCode, 200, director.body);
    assert.equal((await bodyOf(director)).data.image, portraitUrl);
  });

  test('movie and series saves accept catalog references and reject unknown ids', async () => {
    const movie = await call('POST', '/api/movies', creatorToken, {
      title: 'Creator Coastal',
      genres: [genreId],
      languages: [languageId],
      subtitleLanguages: [languageId],
      cast: [{ actor: actorId, character: 'Lead' }],
      directors: [directorId],
      crewMembers: [{ crew: crewId, role: 'DOP' }],
      countryId,
      status: 'draft',
    });
    assert.equal(movie.statusCode, 201, movie.body);
    const movieBody = await bodyOf(movie);
    assert.equal(movieBody.data.status, 'draft');
    assert.equal(String(movieBody.data.genres[0]), genreId);
    assert.equal(String(movieBody.data.languages[0]), languageId);
    assert.equal(String(movieBody.data.cast[0].actor), actorId);
    assert.equal(movieBody.data.cast[0].character, 'Lead');
    assert.equal(String(movieBody.data.crew[0].director), directorId);
    assert.equal(String(movieBody.data.crewMembers[0].crew), crewId);
    assert.equal(movieBody.data.crewMembers[0].role, 'DOP');
    assert.equal(movieBody.data.country, 'India');
    assert.equal(String(movieBody.data.countryId), countryId);
    const movieId = movieBody.data.id;

    const published = await call('POST', '/api/movies', creatorToken, {
      title: 'Cannot Publish',
      status: 'published',
      genres: [genreId],
    });
    assert.equal(published.statusCode, 403);

    const fakeId = new mongoose.Types.ObjectId().toString();
    const badGenre = await call('POST', '/api/movies', creatorToken, { title: 'Missing genre', genres: [fakeId] });
    assert.equal(badGenre.statusCode, 400);
    assert.match((await bodyOf(badGenre)).error, /Genre not found/);

    const badUpdate = await call('PUT', `/api/movies/${movieId}`, creatorToken, { cast: [{ actor: fakeId }] });
    assert.equal(badUpdate.statusCode, 400);
    assert.match((await bodyOf(badUpdate)).error, /Actor not found/);
    const still = await bodyOf(await call('GET', `/api/movies/${movieId}`, creatorToken));
    assert.equal(still.data.title, 'Creator Coastal');
    assert.equal(String(still.data.cast[0].actor._id || still.data.cast[0].actor), actorId);

    const show = await call('POST', '/api/tv-shows', creatorToken, {
      title: 'Creator Series',
      genres: [genreId],
      languages: [languageId],
      cast: [actorId],
      crew: [directorId],
      crewPeople: [{ person: crewId, role: 'Editor' }],
      country: countryId,
    });
    assert.equal(show.statusCode, 201, show.body);
    const showBody = await bodyOf(show);
    assert.equal(showBody.data.status, 'draft');
    assert.equal(String(showBody.data.cast[0].actor), actorId);
    assert.equal(String(showBody.data.crew[0].director), directorId);
    assert.equal(String(showBody.data.crewMembers[0].crew), crewId);
    assert.equal(showBody.data.crewMembers[0].role, 'Editor');
    assert.equal(showBody.data.country, 'India');
    const showId = showBody.data.id;

    const badShow = await call('PUT', `/api/tv-shows/${showId}`, creatorToken, { languages: [fakeId] });
    assert.equal(badShow.statusCode, 400);
    assert.match((await bodyOf(badShow)).error, /Language not found/);

    const staffMovie = await call('POST', '/api/movies', adminToken, { title: 'Staff Country Text', country: 'India' });
    assert.equal(staffMovie.statusCode, 201, staffMovie.body);
    assert.equal((await bodyOf(staffMovie)).data.country, 'India');
    assert.equal((await bodyOf(staffMovie)).data.countryId, undefined);
  });

  test('catalog limits, platform user routes, and settings stay closed', async () => {
    assert.equal((await call('GET', '/api/users', creatorToken)).statusCode, 403);
    assert.equal((await call('PUT', '/api/settings', creatorToken, { platformName: 'Nope' })).statusCode, 403);
    assert.equal((await call('GET', '/api/users', adminToken)).statusCode, 200);

    resetRateLimits();
    process.env.CREATOR_CATALOG_CREATES_PER_HOUR = '1';
    const first = await call('POST', '/api/languages', creatorToken, { name: 'Tamil', code: 'ta' });
    assert.equal(first.statusCode, 201, first.body);
    const second = await call('POST', '/api/languages', creatorToken, { name: 'Kannada', code: 'kn' });
    assert.equal(second.statusCode, 429);
    assert.match((await bodyOf(second)).error, /Too many new entries/);
    process.env.CREATOR_CATALOG_CREATES_PER_HOUR = '500';
    resetRateLimits();

    process.env.CREATOR_CATALOG_MAX_PER_TYPE = '1';
    const capped = await call('POST', '/api/countries', creatorToken, { name: 'Nepal', code: 'NP' });
    assert.equal(capped.statusCode, 429);
    assert.match((await bodyOf(capped)).error, /at most 1 country/);
    process.env.CREATOR_CATALOG_MAX_PER_TYPE = '500';

    const staffStill = await call('POST', '/api/countries', staffToken, { name: 'Nepal', code: 'NP' });
    assert.equal(staffStill.statusCode, 201, staffStill.body);
  });
});
