import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { MediaFileModel } from '../models/MediaFile';
import { getS3PublicUrl } from '../lib/s3';
import { logger } from '../lib/logger';

const ANDROID_PACKAGE = 'com.ashqe.tophills';
const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
const FALLBACK_IMAGE = 'https://ashqe.app/opengraph.jpg';
const GENERIC_TITLE = 'Ashqe';
const GENERIC_DESCRIPTION = 'Watch movies and series on Ashqe.';
const DESCRIPTION_LIMIT = 200;

type ShareKind = 'movie' | 'series';

type ShareDoc = {
  title?: string;
  description?: string;
  shortDescription?: string;
  metaDescription?: string;
  posterImage?: string;
  thumbnail?: string;
  bannerImage?: string;
  status?: string;
};

const frontendOrigin = () => (process.env.FRONTEND_URL || 'https://ashqe.app').replace(/\/$/, '');

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const jsString = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

export const trimShareDescription = (value: string, max = DESCRIPTION_LIMIT): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max - 1).trimEnd();
  return cut.length > 0 ? `${cut}…` : normalized.slice(0, max);
};

const ensureHttps = (url: string): string => {
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`;
  return url;
};

const firstText = (...values: Array<string | null | undefined>): string => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

const firstImage = (...values: Array<string | null | undefined>): string => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || /^data:/i.test(trimmed) || /^blob:/i.test(trimmed)) continue;
    return trimmed;
  }
  return '';
};

/**
 * Absolute https image URL.
 * Uses getS3PublicUrl (Settings CDN, AWS_S3_PUBLIC_BASE_URL, then the bucket URL),
 * the same public-base rules as the rest of the API, including legacy tataiya /uploads links.
 */
export async function resolveShareImageUrl(raw: string): Promise<string> {
  const value = raw.trim();
  if (!value) return FALLBACK_IMAGE;

  const legacy = value.match(/^https?:\/\/(?:www\.)?tataiya\.in\/uploads\/(.+)$/i);
  try {
    if (/^https:\/\//i.test(value) && !legacy) return value;
    if (/^http:\/\//i.test(value) && !legacy) return ensureHttps(value);

    const key = legacy ? legacy[1] : value;
    const absolute = ensureHttps(await getS3PublicUrl(key));
    if (/^https:\/\//i.test(absolute)) return absolute;
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve share image URL');
  }

  const base = (process.env.AWS_S3_PUBLIC_BASE_URL || frontendOrigin()).replace(/\/$/, '');
  const key = (legacy ? legacy[1] : value).replace(/^\/+/, '').replace(/^uploads\//, '');
  return ensureHttps(`${base}/${key}`);
}

async function lookupImageSize(raw: string, absolute: string): Promise<{ width: number; height: number } | null> {
  const candidates = [raw, absolute].map((value) => value.trim()).filter(Boolean);
  if (candidates.length === 0) return null;
  try {
    const file = await MediaFileModel.findOne({
      $or: [{ url: { $in: candidates } }, { filePath: { $in: candidates } }],
    })
      .select('width height')
      .lean();
    const width = Number(file?.width);
    const height = Number(file?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch (err) {
    logger.warn({ err }, 'Failed to look up share image size');
    return null;
  }
}

const metaTag = (attr: 'property' | 'name', key: string, content: string): string =>
  `<meta ${attr}="${escapeHtml(key)}" content="${escapeHtml(content)}">`;

function renderHtml(options: {
  title: string;
  description: string;
  image: string;
  imageSize: { width: number; height: number } | null;
  url: string;
  ogType: string;
  webUrl: string;
  intentUrl: string;
}): string {
  const title = escapeHtml(options.title);
  const description = escapeHtml(options.description);
  const image = escapeHtml(options.image);
  const webUrl = escapeHtml(options.webUrl);
  const playStore = escapeHtml(PLAY_STORE_URL);
  const sizeTags = options.imageSize
    ? `${metaTag('property', 'og:image:width', String(options.imageSize.width))}\n    ${metaTag('property', 'og:image:height', String(options.imageSize.height))}\n    `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    ${metaTag('property', 'og:title', options.title)}
    ${metaTag('property', 'og:description', options.description)}
    ${metaTag('property', 'og:image', options.image)}
    ${sizeTags}${metaTag('property', 'og:url', options.url)}
    ${metaTag('property', 'og:type', options.ogType)}
    ${metaTag('property', 'og:site_name', 'Ashqe')}
    ${metaTag('name', 'twitter:card', 'summary_large_image')}
    ${metaTag('name', 'twitter:title', options.title)}
    ${metaTag('name', 'twitter:image', options.image)}
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0b0b0f;
        color: #f5f5f7;
        font-family: Georgia, "Times New Roman", serif;
      }
      main { width: min(420px, calc(100% - 32px)); text-align: center; padding: 32px 0; }
      img { width: min(280px, 100%); height: auto; border-radius: 12px; background: #17171c; }
      h1 { font-size: 1.6rem; line-height: 1.2; margin: 20px 0 8px; }
      p { margin: 0 0 20px; color: #c8c8d0; font-family: system-ui, sans-serif; font-size: 0.95rem; }
      .actions { display: flex; flex-direction: column; gap: 10px; }
      a.btn {
        display: block;
        text-decoration: none;
        border-radius: 999px;
        padding: 12px 16px;
        font-family: system-ui, sans-serif;
        font-weight: 650;
      }
      a.primary { background: #f4f1ea; color: #111; }
      a.secondary { background: transparent; color: #f4f1ea; border: 1px solid #3a3a44; }
    </style>
  </head>
  <body>
    <main>
      <img src="${image}" alt="${title}">
      <h1>${title}</h1>
      <p>${description}</p>
      <div class="actions">
        <a class="btn primary" href="${webUrl}">Open in Ashqe</a>
        <a class="btn secondary" href="${playStore}">Get it on Google Play</a>
      </div>
      <noscript>
        <p><a href="${webUrl}">Open in Ashqe</a></p>
        <p><a href="${playStore}">Get it on Google Play</a></p>
      </noscript>
    </main>
    <script>
      (function () {
        var isAndroid = /Android/i.test(navigator.userAgent || "");
        var intentUrl = ${jsString(options.intentUrl)};
        var webUrl = ${jsString(options.webUrl)};
        if (isAndroid) {
          window.location.replace(intentUrl);
          return;
        }
        setTimeout(function () {
          window.location.replace(webUrl);
        }, 800);
      })();
    </script>
  </body>
</html>`;
}

function sendHtml(reply: FastifyReply, status: number, html: string) {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'public, max-age=300')
    .send(html);
}

function pageUrls(kind: ShareKind, id: string) {
  const origin = frontendOrigin();
  let host = 'ashqe.app';
  try {
    host = new URL(origin).host || host;
  } catch {
    host = 'ashqe.app';
  }
  const webPath = kind === 'series' ? 'show' : 'movie';
  const sharePath = kind === 'series' ? 'series' : 'movie';
  const safeId = encodeURIComponent(id);
  const webUrl = `${origin}/${webPath}/${safeId}`;
  const shareUrl = `${origin}/share/${sharePath}/${safeId}`;
  const intentUrl = `intent://${host}/${webPath}/${safeId}#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  return { webUrl, shareUrl, intentUrl };
}

async function sendGeneric(reply: FastifyReply, kind: ShareKind, id: string) {
  const { webUrl, shareUrl, intentUrl } = pageUrls(kind, id);
  const html = renderHtml({
    title: GENERIC_TITLE,
    description: GENERIC_DESCRIPTION,
    image: FALLBACK_IMAGE,
    imageSize: null,
    url: shareUrl,
    ogType: 'website',
    webUrl,
    intentUrl,
  });
  return sendHtml(reply, 404, html);
}

/**
 * Public HTML share page. Reads the title and does not increment shares.
 */
export const renderSharePage = (kind: ShareKind) => async (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return sendGeneric(reply, kind, id || '');
    }

    const fields = 'title description shortDescription metaDescription posterImage thumbnail bannerImage status';
    const doc = (kind === 'series'
      ? await TVShowModel.findById(id).select(fields).lean()
      : await MovieModel.findById(id).select(fields).lean()) as ShareDoc | null;

    if (!doc || doc.status !== 'published' || !doc.title) {
      return sendGeneric(reply, kind, id);
    }

    const rawImage = firstImage(doc.posterImage, doc.thumbnail, doc.bannerImage);
    const image = rawImage ? await resolveShareImageUrl(rawImage) : FALLBACK_IMAGE;
    const imageSize = rawImage && image !== FALLBACK_IMAGE ? await lookupImageSize(rawImage, image) : null;
    const description = trimShareDescription(
      firstText(doc.shortDescription, doc.description, doc.metaDescription) || `Watch ${doc.title} on Ashqe.`
    );
    const { webUrl, shareUrl, intentUrl } = pageUrls(kind, id);
    const html = renderHtml({
      title: doc.title,
      description,
      image,
      imageSize,
      url: shareUrl,
      ogType: kind === 'series' ? 'video.tv_show' : 'video.movie',
      webUrl,
      intentUrl,
    });
    return sendHtml(reply, 200, html);
  } catch (err) {
    logger.error({ err, id, kind }, 'Failed to render share page');
    return sendGeneric(reply, kind, id || '');
  }
};

export const renderMovieSharePage = renderSharePage('movie');
export const renderSeriesSharePage = renderSharePage('series');
