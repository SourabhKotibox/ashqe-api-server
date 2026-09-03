import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger';
import { resolveContent } from '../lib/contentResolver';

const APP_PACKAGE_NAME = process.env.APP_PACKAGE_NAME || 'com.ashqe.tophills';
const APP_SCHEME = process.env.APP_SCHEME || 'ashqe';
const APP_STORE_ID = process.env.APP_STORE_ID || '123456789';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ashqe.app';

const incrementShareCount = async (contentId: string, contentType?: string) => {
  try {
    const resolved = await resolveContent(contentId, contentType);
    if (!resolved) return 0;
    const updated = await (resolved.model as any).findByIdAndUpdate(
      contentId,
      { $inc: { shares: 1 } },
      { new: true }
    ).select('shares').lean();
    return updated?.shares ?? 0;
  } catch (err) {
    logger.error({ err, contentId }, 'Failed to increment share count');
    return 0;
  }
};

export const handleShareRedirect = async (request: FastifyRequest, reply: FastifyReply) => {
  const { contentId } = request.params as { contentId: string };
  const query = request.query as { contentType?: string };

  await incrementShareCount(contentId, query.contentType);

  const playStoreUrl = `https://play.google.com/store/apps/details?id=${APP_PACKAGE_NAME}&referrer=movie_id%3D${contentId}`;
  const androidIntent = `intent://watch/${contentId}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE_NAME};S.browser_fallback_url=${encodeURIComponent(playStoreUrl)};end`;
  
  const iosScheme = `${APP_SCHEME}://watch/${contentId}`;
  const appStoreLink = `https://apps.apple.com/app/id${APP_STORE_ID}`;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Opening Ashqe...</title>
      <style>
        body { background: #000; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .loader { border: 4px solid #333; border-top: 4px solid #ff0055; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
      <script>
        document.addEventListener("DOMContentLoaded", function() {
          var userAgent = navigator.userAgent || navigator.vendor || window.opera;
          
          if (/android/i.test(userAgent)) {
            window.location.replace("${androidIntent}");
          } 
          else if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
            window.location.replace("${iosScheme}");
            setTimeout(function() {
              window.location.replace("${appStoreLink}");
            }, 2500);
          } 
          else {
            window.location.replace("${FRONTEND_URL}/watch/${contentId}");
          }
        });
      </script>
    </head>
    <body>
      <div class="loader"></div>
    </body>
    </html>
  `;

  return reply.type('text/html').send(html);
};

export const recordShare = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { contentId } = request.params as { contentId: string };
    const body = (request.body as { contentType?: string }) || {};
    const sharesCount = await incrementShareCount(contentId, body.contentType);

    return reply.send({
      success: true,
      message: 'Share recorded successfully.',
      data: {
        sharesCount
      }
    });
  } catch (error: any) {
    logger.error(error, 'Error recording share');
    return reply.status(500).send({
      success: false,
      message: 'Failed to record share.',
      error: error.message
    });
  }
};
