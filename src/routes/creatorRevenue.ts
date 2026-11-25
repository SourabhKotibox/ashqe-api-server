import type { FastifyPluginAsync } from 'fastify';
import {
  getCreatorRevenueOverview,
  getCreatorRevenueRate,
  getCreatorRevenueSeries,
  getCreatorRevenueSummary,
  getCreatorRevenueTitles,
  getCreatorWatchHourRate,
  putCreatorRevenueRate,
  putCreatorWatchHourRate,
} from '../controllers/creatorRevenueController';
import { authenticateAndAttach, requireCreatorRevenueAccess } from '../middlewares/rbac';

/**
 * Creator revenue.
 * Influencer routes always scope to the signed-in creator.
 * Admin view routes are for superadmin, admin, or a staff user granted creatorRevenue.
 * Rate changes are for superadmin or creatorRevenue.canEdit.
 */
const creatorRevenueRoutes: FastifyPluginAsync = async (fastify) => {
  const creator = { onRequest: [authenticateAndAttach] };
  fastify.get('/creator/revenue/summary', creator, getCreatorRevenueSummary);
  fastify.get('/creator/revenue/titles', creator, getCreatorRevenueTitles);
  fastify.get('/creator/revenue/timeseries', creator, getCreatorRevenueSeries);

  const view = { onRequest: [requireCreatorRevenueAccess('canView')] };
  const edit = { onRequest: [requireCreatorRevenueAccess('canEdit')] };
  fastify.get('/admin/creator-revenue/rate', view, getCreatorRevenueRate);
  fastify.put('/admin/creator-revenue/rate', edit, putCreatorRevenueRate);
  fastify.get('/admin/creator-revenue/creators/:creatorId/rate', view, getCreatorWatchHourRate);
  fastify.put('/admin/creator-revenue/creators/:creatorId/rate', edit, putCreatorWatchHourRate);
  fastify.get('/admin/creator-revenue/overview', view, getCreatorRevenueOverview);
};

export default creatorRevenueRoutes;
