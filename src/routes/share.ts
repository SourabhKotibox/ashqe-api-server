import type { FastifyPluginAsync } from 'fastify';
import { handleShareRedirect, recordShare } from '../controllers/shareController';
import { renderMovieSharePage, renderSeriesSharePage } from '../controllers/sharePageController';

const shareRoutes: FastifyPluginAsync = async (fastify) => {
  // HTML share pages. Registered at / and /api because the router is mounted twice.
  // These have one more path segment than /share/:contentId, so the JSON share
  // counter route below is unchanged.
  fastify.get('/share/movie/:id', renderMovieSharePage);
  fastify.get('/share/series/:id', renderSeriesSharePage);
  fastify.get('/share/show/:id', renderSeriesSharePage);

  // GET /api/share/:contentId — JSON deep-link payload; increments the share count.
  fastify.get('/share/:contentId', handleShareRedirect);

  // POST /api/share/:contentId
  fastify.post('/share/:contentId', recordShare);
};

export default shareRoutes;
