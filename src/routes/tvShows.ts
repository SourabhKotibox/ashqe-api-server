import type { FastifyPluginAsync } from 'fastify';
import {
  getAllTVShows,
  getTVShowById,
  createTVShow,
  updateTVShow,
  deleteTVShow,
  updateTVShowStatus,
  toggleFeatured,
  toggleTrending,
  getPendingApprovals,
  approveTVShow,
  rejectTVShow,
  submitTVShowForReview,
  getTVShowProcessingStatus,
} from '../controllers/tvShowController';
import { requirePermission } from '../middlewares/rbac';

const tvShows: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { onRequest: [requirePermission('tvShows', 'canView')] }, getAllTVShows);
  fastify.get('/pending-approvals', { onRequest: [requirePermission('tvShows', 'canView')] }, getPendingApprovals);
  fastify.post('/', { onRequest: [requirePermission('tvShows', 'canCreate')] }, createTVShow);
  fastify.post('/item/:id/approve', { onRequest: [requirePermission('tvShows', 'canEdit')] }, approveTVShow);
  fastify.post('/item/:id/reject', { onRequest: [requirePermission('tvShows', 'canEdit')] }, rejectTVShow);
  fastify.post('/item/:id/submit-review', { onRequest: [requirePermission('tvShows', 'canEdit')] }, submitTVShowForReview);
  fastify.get('/:id', { onRequest: [requirePermission('tvShows', 'canView')] }, getTVShowById);
  fastify.put('/:id', { onRequest: [requirePermission('tvShows', 'canEdit')] }, updateTVShow);
  fastify.delete('/:id', { onRequest: [requirePermission('tvShows', 'canDelete')] }, deleteTVShow);
  fastify.patch('/:id/status', { onRequest: [requirePermission('tvShows', 'canEdit')] }, updateTVShowStatus);
  fastify.patch('/:id/featured', { onRequest: [requirePermission('tvShows', 'canEdit')] }, toggleFeatured);
  fastify.patch('/:id/trending', { onRequest: [requirePermission('tvShows', 'canEdit')] }, toggleTrending);
  fastify.get('/:id/processing-status', { onRequest: [requirePermission('tvShows', 'canView')] }, getTVShowProcessingStatus);
};

export default tvShows;
