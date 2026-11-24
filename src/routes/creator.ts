import type { FastifyPluginAsync } from 'fastify';
import { authenticateAndAttach, requireCreatorReviewer } from '../middlewares/rbac';
import {
  applyAsCreator,
  approveCreatorApplication,
  getCreatorApplication,
  getCreatorApplicationStatus,
  listCreatorApplications,
  rejectCreatorApplication,
} from '../controllers/creatorApplicationController';
import { getCreatorDashboard } from '../controllers/creatorDashboardController';

/**
 * Creator / influencer module.
 * Intentionally separate from the Partner (affiliate/reseller) routes.
 */
const creatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/public/creator/apply', applyAsCreator);
  fastify.get('/public/creator/status', getCreatorApplicationStatus);

  const view = { onRequest: [requireCreatorReviewer('canView')] };
  const edit = { onRequest: [requireCreatorReviewer('canEdit')] };
  fastify.get('/admin/creator-applications', view, listCreatorApplications);
  fastify.get('/admin/creator-applications/:id', view, getCreatorApplication);
  fastify.post('/admin/creator-applications/:id/approve', edit, approveCreatorApplication);
  fastify.post('/admin/creator-applications/:id/reject', edit, rejectCreatorApplication);

  fastify.get('/creator/dashboard', { onRequest: [authenticateAndAttach] }, getCreatorDashboard);
};

export default creatorRoutes;
