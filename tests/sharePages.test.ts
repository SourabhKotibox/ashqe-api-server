import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'share-page-test-secret';
process.env.FRONTEND_URL = 'https://ashqe.app';
process.env.AWS_S3_PUBLIC_BASE_URL = 'https://cdn.example.com';
delete process.env.ANDROID_SHA256_FINGERPRINTS;
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.ashqe.tophills';
const FALLBACK_IMAGE = 'https://ashqe.app/opengraph.jpg';
const FILE_FINGERPRINT =
  'E0:F3:91:95:B2:60:A4:87:B1:F3:83:65:4C:F7:02:B3:CC:BB:72:70:55:21:BF:84:E6:53:D9:8F:50:35:B8:90';

const metaContent = (html: string, key: string): string | null => {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const prop = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (prop !== key) continue;
    return tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? null;
  }
  return null;
};

describe('rich share pages and asset links', { concurrency: 1, timeout: 180000 }, () => {
  let mongod: { stop: () => Promise<void> };
  let mongoose: typeof import('mongoose');
  let app: { inject: (opts: any) => Promise<any>; ready: () => Promise<unknown>; close: () => Promise<void> };
  let MovieModel: typeof import('../src/models/Movie.ts').MovieModel;
  let TVShowModel: typeof import('../src/models/TVShow.ts').TVShowModel;
  let MediaFileModel: typeof import('../src/models/MediaFile.ts').MediaFileModel;

  const htmlOf = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    const html = typeof res.body === 'string' ? res.body : String(res.payload || '');
    return { res, html };
  };

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = await import('mongoose');
    mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(mongod.getUri());
    app = (await import('../src/app.ts')).default;
    await app.ready();
    MovieModel = (await import('../src/models/Movie.ts')).MovieModel;
    TVShowModel = (await import('../src/models/TVShow.ts')).TVShowModel;
    MediaFileModel = (await import('../src/models/MediaFile.ts')).MediaFileModel;
  });

  after(async () => {
    await app.close();
    await mongoose.disconnect();
    await mongod.stop();
  });

  test('published movie page has escaped OG tags and does not count a share', async () => {
    const poster = 'https://cdn.example.com/posters/rock.jpg';
    const tail = 'UNIQUE_TAIL_SHOULD_BE_CUT';
    const description = `She said "hello" & <b>ran</b> across the lot. ${'word '.repeat(40)}${tail}`;
    const movie = await MovieModel.create({
      title: 'Rock & Roll <Live>',
      description,
      status: 'published',
      posterImage: poster,
      thumbnail: 'https://cdn.example.com/thumbs/rock.jpg',
      bannerImage: 'https://cdn.example.com/banners/rock.jpg',
      shares: 5,
    });
    await MediaFileModel.create({
      name: 'rock.jpg',
      url: poster,
      filePath: '/uploads/media/posters/rock.jpg',
      fileSize: 1200,
      fileType: 'image/jpeg',
      storageType: 's3',
      width: 800,
      height: 1200,
    });

    const id = movie._id.toString();
    const { res, html } = await htmlOf(`/share/movie/${id}`);

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(String(res.headers['cache-control']), /public/);
    assert.match(String(res.headers['cache-control']), /max-age=300/);

    assert.equal(metaContent(html, 'og:title'), 'Rock &amp; Roll &lt;Live&gt;');
    assert.equal(metaContent(html, 'og:type'), 'video.movie');
    assert.equal(metaContent(html, 'og:site_name'), 'Ashqe');
    assert.equal(metaContent(html, 'og:image'), poster);
    assert.equal(metaContent(html, 'og:image:width'), '800');
    assert.equal(metaContent(html, 'og:image:height'), '1200');
    assert.equal(metaContent(html, 'og:url'), `https://ashqe.app/share/movie/${id}`);
    assert.equal(metaContent(html, 'twitter:card'), 'summary_large_image');
    assert.equal(metaContent(html, 'twitter:title'), 'Rock &amp; Roll &lt;Live&gt;');
    assert.equal(metaContent(html, 'twitter:image'), poster);

    const ogDescription = metaContent(html, 'og:description') || '';
    assert.match(ogDescription, /&quot;hello&quot;/);
    assert.match(ogDescription, /&amp;/);
    assert.match(ogDescription, /&lt;b&gt;ran&lt;\/b&gt;/);
    const decoded = ogDescription
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    assert.equal(decoded.includes(tail), false);
    assert.ok(decoded.length <= 200, `decoded description length ${decoded.length}`);
    assert.match(decoded, /<b>ran<\/b>/);

    assert.match(html, /<img\b[^>]*src="https:\/\/cdn\.example\.com\/posters\/rock\.jpg"/);
    assert.match(html, /Open in Ashqe/);
    assert.match(html, /Get it on Google Play/);
    assert.match(html, /<noscript>/);

    const intent = `intent://ashqe.app/movie/${id}#Intent;scheme=https;package=com.ashqe.tophills;S.browser_fallback_url=${encodeURIComponent(PLAY_STORE)};end`;
    assert.ok(html.includes(intent), 'android intent missing');
    assert.ok(html.includes(`https://ashqe.app/movie/${id}`), 'ios/desktop url missing');
    assert.match(html, /setTimeout/);
    assert.match(html, /Android/);

    const fresh = await MovieModel.findById(id).select('shares').lean();
    assert.equal(fresh?.shares, 5);

    const apiPage = await htmlOf(`/api/share/movie/${id}`);
    assert.equal(apiPage.res.statusCode, 200);
    assert.match(String(apiPage.res.headers['content-type']), /text\/html/);
    assert.equal(metaContent(apiPage.html, 'og:title'), 'Rock &amp; Roll &lt;Live&gt;');
    const afterAlias = await MovieModel.findById(id).select('shares').lean();
    assert.equal(afterAlias?.shares, 5);

    const json = await app.inject({ method: 'GET', url: `/api/share/${id}` });
    assert.equal(json.statusCode, 200);
    assert.match(String(json.headers['content-type']), /application\/json/);
    const payload = JSON.parse(json.body);
    assert.equal(payload.success, true);
    assert.equal(payload.data.contentId, id);
    const afterJson = await MovieModel.findById(id).select('shares').lean();
    assert.equal(afterJson?.shares, 6);
  });

  test('relative /uploads poster becomes an absolute https URL', async () => {
    const movie = await MovieModel.create({
      title: 'Relative Poster',
      description: 'A short synopsis.',
      status: 'published',
      posterImage: '/uploads/media/posters/one.jpg',
      shares: 0,
    });
    const id = movie._id.toString();
    const { res, html } = await htmlOf(`/share/movie/${id}`);
    assert.equal(res.statusCode, 200);
    assert.equal(metaContent(html, 'og:image'), 'https://cdn.example.com/media/posters/one.jpg');
    assert.equal(metaContent(html, 'twitter:image'), 'https://cdn.example.com/media/posters/one.jpg');
    assert.equal(metaContent(html, 'og:image:width'), null);
    assert.equal(metaContent(html, 'og:image:height'), null);
    assert.match(html, /src="https:\/\/cdn\.example\.com\/media\/posters\/one\.jpg"/);

    const httpPoster = await MovieModel.create({
      title: 'Http Poster',
      status: 'published',
      posterImage: 'http://cdn.example.com/plain.jpg',
    });
    const httpPage = await htmlOf(`/share/movie/${httpPoster._id.toString()}`);
    assert.equal(metaContent(httpPage.html, 'og:image'), 'https://cdn.example.com/plain.jpg');

    const thumbOnly = await MovieModel.create({
      title: 'Thumb Only',
      status: 'published',
      posterImage: '   ',
      thumbnail: '/uploads/media/thumbs/two.jpg',
      bannerImage: 'https://cdn.example.com/banner-should-not-win.jpg',
    });
    const thumbPage = await htmlOf(`/share/movie/${thumbOnly._id.toString()}`);
    assert.equal(metaContent(thumbPage.html, 'og:image'), 'https://cdn.example.com/media/thumbs/two.jpg');

    const bannerOnly = await MovieModel.create({
      title: 'Banner Only',
      status: 'published',
      thumbnail: '',
      bannerImage: '/uploads/banners/wide.jpg',
    });
    const bannerPage = await htmlOf(`/share/movie/${bannerOnly._id.toString()}`);
    assert.equal(metaContent(bannerPage.html, 'og:image'), 'https://cdn.example.com/banners/wide.jpg');

    const noArt = await MovieModel.create({
      title: 'No Art',
      status: 'published',
    });
    const fallbackPage = await htmlOf(`/share/movie/${noArt._id.toString()}`);
    assert.equal(metaContent(fallbackPage.html, 'og:image'), FALLBACK_IMAGE);
  });

  test('unpublished and missing titles render generic Ashqe tags with 404', async () => {
    const draft = await MovieModel.create({
      title: 'Secret Draft Title',
      description: 'This synopsis must not leak.',
      status: 'draft',
      posterImage: 'https://cdn.example.com/secret.jpg',
      shares: 3,
    });
    const draftId = draft._id.toString();
    const hidden = await htmlOf(`/share/movie/${draftId}`);
    assert.equal(hidden.res.statusCode, 404);
    assert.match(String(hidden.res.headers['content-type']), /text\/html/);
    assert.match(String(hidden.res.headers['cache-control']), /public/);
    assert.match(String(hidden.res.headers['cache-control']), /max-age=300/);
    assert.equal(metaContent(hidden.html, 'og:title'), 'Ashqe');
    assert.equal(metaContent(hidden.html, 'og:site_name'), 'Ashqe');
    assert.equal(metaContent(hidden.html, 'og:image'), FALLBACK_IMAGE);
    assert.equal(metaContent(hidden.html, 'twitter:card'), 'summary_large_image');
    assert.equal(metaContent(hidden.html, 'twitter:title'), 'Ashqe');
    assert.equal(metaContent(hidden.html, 'twitter:image'), FALLBACK_IMAGE);
    assert.equal(hidden.html.includes('Secret Draft Title'), false);
    assert.equal(hidden.html.includes('must not leak'), false);
    assert.equal(hidden.html.includes('secret.jpg'), false);
    assert.match(hidden.html, /Open in Ashqe/);
    assert.match(hidden.html, /<noscript>/);
    const still = await MovieModel.findById(draftId).select('shares').lean();
    assert.equal(still?.shares, 3);

    const missing = await htmlOf('/share/movie/507f1f77bcf86cd799439011');
    assert.equal(missing.res.statusCode, 404);
    assert.match(String(missing.res.headers['content-type']), /text\/html/);
    assert.equal(metaContent(missing.html, 'og:title'), 'Ashqe');
    assert.equal(metaContent(missing.html, 'og:image'), FALLBACK_IMAGE);

    const bogus = await htmlOf('/share/series/not-a-real-id');
    assert.equal(bogus.res.statusCode, 404);
    assert.equal(metaContent(bogus.html, 'og:title'), 'Ashqe');
    assert.equal(metaContent(bogus.html, 'og:image'), FALLBACK_IMAGE);
  });

  test('series, show, and api aliases render a TV show share page', async () => {
    const show = await TVShowModel.create({
      title: 'North & South',
      description: 'Two families, one valley.',
      status: 'published',
      posterImage: 'https://cdn.example.com/series/north.jpg',
      shares: 1,
    });
    const id = show._id.toString();
    const intent = `intent://ashqe.app/show/${id}#Intent;scheme=https;package=com.ashqe.tophills;S.browser_fallback_url=${encodeURIComponent(PLAY_STORE)};end`;

    for (const url of [`/share/series/${id}`, `/share/show/${id}`, `/api/share/series/${id}`, `/api/share/show/${id}`]) {
      const { res, html } = await htmlOf(url);
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers['content-type']), /text\/html/, url);
      assert.equal(metaContent(html, 'og:title'), 'North &amp; South', url);
      assert.equal(metaContent(html, 'og:type'), 'video.tv_show', url);
      assert.equal(metaContent(html, 'og:image'), 'https://cdn.example.com/series/north.jpg', url);
      assert.equal(metaContent(html, 'og:url'), `https://ashqe.app/share/series/${id}`, url);
      assert.ok(html.includes(intent), url);
      assert.ok(html.includes(`https://ashqe.app/show/${id}`), url);
    }

    const fresh = await TVShowModel.findById(id).select('shares').lean();
    assert.equal(fresh?.shares, 1);
  });

  test('assetlinks.json is application/json and prefers ANDROID_SHA256_FINGERPRINTS', async () => {
    delete process.env.ANDROID_SHA256_FINGERPRINTS;
    const fileRes = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
    assert.equal(fileRes.statusCode, 200);
    assert.match(String(fileRes.headers['content-type']), /^application\/json\b/);
    const fileBody = JSON.parse(fileRes.body);
    assert.equal(fileBody[0].target.package_name, 'com.ashqe.tophills');
    assert.deepEqual(fileBody[0].target.sha256_cert_fingerprints, [FILE_FINGERPRINT]);

    process.env.ANDROID_SHA256_FINGERPRINTS = ' AA:11:22 , BB:33:44 ';
    const envRes = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
    assert.equal(envRes.statusCode, 200);
    assert.match(String(envRes.headers['content-type']), /^application\/json\b/);
    const envBody = JSON.parse(envRes.body);
    assert.equal(envBody[0].target.package_name, 'com.ashqe.tophills');
    assert.deepEqual(envBody[0].target.sha256_cert_fingerprints, ['AA:11:22', 'BB:33:44']);
    assert.equal(envBody[0].relation[0], 'delegate_permission/common.handle_all_urls');
    delete process.env.ANDROID_SHA256_FINGERPRINTS;
  });
});
