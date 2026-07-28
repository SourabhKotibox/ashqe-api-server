import type { FastifyPluginAsync } from 'fastify';
import { webRequestDownload, webGetDownloads, webDeleteDownload } from '../controllers/webDownloadController';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PlanLimitModel } from '../models/PlanLimit';
import { SettingsModel } from '../models/Settings';

const webDownloadRoutes: FastifyPluginAsync = async (fastify) => {
  // Public: list active subscription plans — no auth required
  fastify.get('/subscription-plans', async (_request, reply) => {
    try {
      const plans = await SubscriptionPlanModel.find({ status: true })
        .sort({ level: 1, price: 1 })
        .lean();

      const limits = await PlanLimitModel.find({ planId: { $in: plans.map((p) => p._id) } }).lean();
      const limitsByPlan = new Map(limits.map((l: any) => [l.planId.toString(), l]));
      
      const settings = await SettingsModel.findOne().lean();
      const currencySymbol = settings?.currencySymbol || '₹';

      return reply.send({
        success: true,
        data: plans.map((plan) => {
          const lim: any = limitsByPlan.get(plan._id.toString()) || {};
          return {
            id: plan._id,
            name: plan.name,
            duration: plan.duration,
            durationValue: plan.durationValue,
            price: plan.price,
            discount: plan.discount,
            totalPrice: plan.totalPrice,
            description: plan.description,
            level: plan.level,
            currencySymbol,
            limits: {
              ads: lim.ads ?? (plan.level <= 1),
              adFree: lim.ads === false || (plan.level >= 2 && lim.ads !== true),
              maxDevices: lim.deviceLimitCount || (plan.level >= 3 ? 4 : plan.level >= 2 ? 2 : 1),
              downloadEnabled: lim.downloadStatus ?? plan.level >= 2,
              maxResolution: lim.q4k ? '4K' : lim.q1080p ? '1080p' : lim.q720p ? '720p' : '480p',
              q480p: lim.q480p ?? true,
              q720p: lim.q720p ?? plan.level >= 1,
              q1080p: lim.q1080p ?? plan.level >= 2,
              q4k: lim.q4k ?? plan.level >= 3,
            },
          };
        }),
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // JWT-protected routes scoped so the hook doesn't bleed to the public route above
  fastify.register(async (auth) => {
    auth.addHook('onRequest', async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.send(err);
      }
    });

    // POST /api/web/download
    auth.post('/download', webRequestDownload);

    // GET /api/web/downloads
    auth.get('/downloads', webGetDownloads);

    // DELETE /api/web/downloads/:id
    auth.delete('/downloads/:id', webDeleteDownload);
  });
};

export default webDownloadRoutes;
