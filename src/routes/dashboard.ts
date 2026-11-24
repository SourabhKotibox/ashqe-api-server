
import type { FastifyPluginAsync } from 'fastify';
import { requireMinRole } from '../middlewares/rbac';
import {
  getDashboardStats,
  getRevenueData,
  getNewSubscribersData,
  getMostWatchedData,
  getTopGenresData,
  getReviews,
  getTransactions,
} from '../controllers/dashboardController';

// Platform analytics. Any staff role at moderator or above (admin, superadmin).
// Influencer accounts are below that line and must not see revenue or the user base.
const staff = { onRequest: [requireMinRole('moderator')] };

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/dashboard/stats', staff, getDashboardStats);
  fastify.get('/dashboard/revenue', staff, getRevenueData);
  fastify.get('/dashboard/new-subscribers', staff, getNewSubscribersData);
  fastify.get('/dashboard/most-watched', staff, getMostWatchedData);
  fastify.get('/dashboard/top-genres', staff, getTopGenresData);
  fastify.get('/dashboard/reviews', staff, getReviews);
  fastify.get('/dashboard/transactions', staff, getTransactions);
};

export default dashboardRoutes;
