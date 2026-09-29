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
  
  const resolved = await resolveContent(contentId, query.contentType);
  let resolvedContentType = 'movie';
  let webPath = 'movie';
  if (resolved) {
    if (resolved.type === 'TVShow' || resolved.type === 'Episode') {
      resolvedContentType = 'webseries';
      webPath = 'show';
    }
  }

  const playStoreUrl = `https://play.google.com/store/apps/details?id=${APP_PACKAGE_NAME}&referrer=movie_id%3D${contentId}`;
  const androidIntent = `intent://${resolvedContentType}/${contentId}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE_NAME};S.browser_fallback_url=${encodeURIComponent(playStoreUrl)};end`;
  
  const iosScheme = `${APP_SCHEME}://${resolvedContentType}/${contentId}`;
  const appStoreLink = `https://apps.apple.com/app/id${APP_STORE_ID}`;
  const webUrl = `${FRONTEND_URL}/${webPath}/${contentId}`;

  return reply.send({
    success: true,
    data: {
      contentId,
      contentType: resolvedContentType,
      webUrl,
      androidIntent,
      iosScheme
    }
  });
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
