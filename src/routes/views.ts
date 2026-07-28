import type { FastifyPluginAsync } from 'fastify';
import { recordView } from '../controllers/viewController';

const viewsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/views/:contentId
  // Body: { contentType: 'movie' }
  // Header: Authorization: Bearer <token>
  fastify.post('/views/:contentId', recordView);
};

export default viewsRoutes;
