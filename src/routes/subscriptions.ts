import { requirePermission } from '../middlewares/rbac';
import { authenticate } from '../middlewares/auth';
import type { FastifyPluginAsync } from 'fastify';
import {
  listSubscriptions,
  getSubscriptionById,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  bulkDeleteSubscriptions,
  createRazorpayOrder,
  verifyRazorpayPayment
} from '../controllers/subscriptionController';
import { getAppPlans } from '../controllers/subscriptionPlanController';

const subscriptionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/subscriptions', { onRequest: [requirePermission('subscriptions', 'canView')] }, listSubscriptions);
  fastify.get('/subscriptions/:id', { onRequest: [requirePermission('subscriptions', 'canView')] }, getSubscriptionById);
  fastify.post('/subscriptions', { onRequest: [requirePermission('subscriptions', 'canCreate')] }, createSubscription);
  fastify.put('/subscriptions/:id', { onRequest: [requirePermission('subscriptions', 'canEdit')] }, updateSubscription);
  fastify.delete('/subscriptions/:id', { onRequest: [requirePermission('subscriptions', 'canDelete')] }, deleteSubscription);
  fastify.post('/subscriptions/bulk-delete', { onRequest: [requirePermission('subscriptions', 'canDelete')] }, bulkDeleteSubscriptions);
  
  // Public — no auth required — mobile app paywall / subscription screen
  fastify.get('/app/plans', getAppPlans);

  // Razorpay — user-facing (any authenticated user, not just admins)
  fastify.post('/app/subscription/razorpay/order', { preHandler: [authenticate] }, createRazorpayOrder);
  fastify.post('/app/subscription/razorpay/verify', { preHandler: [authenticate] }, verifyRazorpayPayment);
};

export default subscriptionRoutes;
