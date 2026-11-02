import type { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { authenticate } from '../middlewares/auth';
import { requirePermission } from '../middlewares/rbac';
import {
  applyForPartner,
  getPartnerStatus,
  applyReferralCode,
  validatePartnerCode,
  getPartnerDashboard,
  getPartnerReferrals,
  getPartnerCommissions,
  getPartnerPayouts,
  requestPartnerPayout,
  adminPartnerOverview,
  adminListApplications,
  adminReviewApplication,
  adminListPartners,
  adminGetPartner,
  adminUpdatePartner,
  adminListCommissions,
  adminReverseCommission,
  adminListPayouts,
  adminProcessPayout,
  adminGetPartnerSettings,
  adminUpdatePartnerSettings,
  adminAttributeUser,
} from '../controllers/partnerController';
import { reverseCommissionForPayment } from '../lib/partnerCommission';

/**
 * Partner (affiliate / reseller) program.
 * Admin routes reuse the "subscriptions" RBAC module (superadmin always allowed);
 * this is intentionally separate from Role-Based Access (/admin-users, influencers).
 */
const partnerRoutes: FastifyPluginAsync = async (fastify) => {
  // ── End-user (app + website) ──
  fastify.get('/public/partner/:code', validatePartnerCode);
  fastify.get('/app/partner/status', { preHandler: [authenticate] }, getPartnerStatus);
  fastify.post('/app/partner/apply', { preHandler: [authenticate] }, applyForPartner);
  fastify.post('/app/partner/referral', { preHandler: [authenticate] }, applyReferralCode);
  fastify.get('/app/partner/dashboard', { preHandler: [authenticate] }, getPartnerDashboard);
  fastify.get('/app/partner/referrals', { preHandler: [authenticate] }, getPartnerReferrals);
  fastify.get('/app/partner/commissions', { preHandler: [authenticate] }, getPartnerCommissions);
  fastify.get('/app/partner/payouts', { preHandler: [authenticate] }, getPartnerPayouts);
  fastify.post('/app/partner/payouts', { preHandler: [authenticate] }, requestPartnerPayout);

  // ── Admin ──
  const view = { onRequest: [requirePermission('subscriptions', 'canView')] };
  const edit = { onRequest: [requirePermission('subscriptions', 'canEdit')] };
  fastify.get('/partners/overview', view, adminPartnerOverview);
  fastify.get('/partners/applications', view, adminListApplications);
  fastify.patch('/partners/applications/:id', edit, adminReviewApplication);
  fastify.get('/partners/commissions', view, adminListCommissions);
  fastify.post('/partners/commissions/:id/reverse', edit, adminReverseCommission);
  fastify.get('/partners/payouts', view, adminListPayouts);
  fastify.patch('/partners/payouts/:id', edit, adminProcessPayout);
  fastify.get('/partners/settings', view, adminGetPartnerSettings);
  fastify.put('/partners/settings', edit, adminUpdatePartnerSettings);
  fastify.post('/partners/attribute', edit, adminAttributeUser);
  fastify.get('/partners', view, adminListPartners);
  fastify.get('/partners/:id', view, adminGetPartner);
  fastify.patch('/partners/:id', edit, adminUpdatePartner);

  // ── Razorpay webhook (refunds → commission reversal) ──
  // Scoped raw-body parser so the HMAC is computed over the exact bytes Razorpay signed.
  fastify.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/razorpay/partner', async (request, reply) => {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) return reply.status(503).send({ success: false, error: 'Webhook not configured' });
      const raw = String(request.body || '');
      const sig = String(request.headers['x-razorpay-signature'] || '');
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return reply.status(400).send({ success: false, error: 'Invalid signature' });
      }
      let event: any;
      try { event = JSON.parse(raw); } catch { return reply.status(400).send({ success: false }); }
      if (['refund.processed', 'refund.created', 'payment.dispute.lost'].includes(event?.event)) {
        const paymentId = event?.payload?.refund?.entity?.payment_id || event?.payload?.payment?.entity?.id;
        if (paymentId) await reverseCommissionForPayment(paymentId, `Razorpay ${event.event}`);
      }
      return reply.send({ success: true });
    });
  });
};

export default partnerRoutes;
