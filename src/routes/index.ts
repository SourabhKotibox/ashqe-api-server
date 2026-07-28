import type { FastifyPluginAsync } from 'fastify';
import healthRoutes from './health';
import authRoutes from './auth';
import appAuthRoutes from './appAuth';
import usersRoutes from './users';
import languagesRoutes from './languages';
import promotionsRoutes from './promotions';
import bannersRoutes from './banners';
import settingsRoutes from './settings';
import genresRoutes from './genres';
import pagesRoutes from './pages';
import faqsRoutes from './faqs';
import actorsRoutes from './actors';
import directorsRoutes from './directors';
import notificationLogsRoutes from './notificationLogs';
import subscriptionPlansRoutes from './subscriptionPlans';
import planLimitsRoutes from './planLimits';
import subscriptionRoutes from './subscriptions';
import categoriesRoutes from './categories';
import notificationTemplatesRoutes from './notificationTemplates';
import mediaRoutes from './media';
import appSettingsRoutes from './appSettings';
import dashboardRoutes from './dashboard';
import movieRoutes from './movie';
import adminUsersRoutes from './adminUsers';
import sectionsRoutes from './sections';
import countriesRoutes from './countries';
import crewsRoutes from './crews';
import likeRoutes from './like';
import watchRoutes from './watch';
import shareRoutes from './share';
import wishlistRoutes from './wishlist';
import appProfileRoutes from './appProfile';
import downloadRoutes from './download';
import webDownloadRoutes from './webDownload';
import watchProgressRoutes from './watchProgress';
import appNotificationRoutes from './appNotificationRoutes';

import { deleteAppAccount } from '../controllers/appProfileController';
import { getHomePage } from '../controllers/appHomeController';
import { getAppBanners } from '../controllers/appHomeController';
import { getExplore } from '../controllers/exploreController';
import { getSearchPage } from '../controllers/searchController';
import { getWebHome, getWebAllContent } from '../controllers/webHomeController';
import { getWebBrowse } from '../controllers/webBrowseController';
import { getWebDetail } from '../controllers/webDetailController';
import { getMovieDetail } from '../controllers/appMovieController';
import adRoutes from './ad';
import adminNotificationsRoutes from './adminNotifications';
import reviewRoutes from './review';
import viewsRoutes from './views';

const router: FastifyPluginAsync = async (fastify) => {
  fastify.register(viewsRoutes);
  fastify.register(reviewRoutes);
  fastify.register(adminNotificationsRoutes, { prefix: '/admin-notifications' });
  fastify.register(adRoutes);
  fastify.register(healthRoutes);
  fastify.register(authRoutes);
  fastify.register(appAuthRoutes);
  fastify.register(usersRoutes);
  fastify.register(languagesRoutes, { prefix: '/languages' });
  fastify.register(promotionsRoutes);
  fastify.register(bannersRoutes);
  fastify.register(settingsRoutes);
  fastify.register(genresRoutes, { prefix: '/genres' });
  fastify.register(pagesRoutes, { prefix: '/pages' });
  fastify.register(faqsRoutes, { prefix: '/faqs' });
  fastify.register(actorsRoutes, { prefix: '/actors' });
  fastify.register(directorsRoutes, { prefix: '/directors' });
  fastify.register(notificationLogsRoutes, { prefix: '/notification-logs' });
  fastify.register(subscriptionPlansRoutes, { prefix: '/subscription-plans' });
  fastify.register(planLimitsRoutes, { prefix: '/plan-limits' });
  fastify.register(subscriptionRoutes);
  fastify.register(categoriesRoutes, { prefix: '/categories' });
  fastify.register(notificationTemplatesRoutes, { prefix: '/notification-templates' });
  fastify.register(mediaRoutes, { prefix: '/media' });
  fastify.register(appSettingsRoutes, { prefix: '/app-settings' });
  fastify.register(dashboardRoutes);
  fastify.register(movieRoutes, { prefix: '/movies' });
  fastify.register(adminUsersRoutes, { prefix: '/admin-users' });
  fastify.register(sectionsRoutes, { prefix: '/sections' });
  fastify.register(countriesRoutes, { prefix: '/countries' });
  fastify.register(crewsRoutes, { prefix: '/crews' });

  // Like / Unlike route
  fastify.register(likeRoutes);

  // Watch page route (video player + episodes + lock/unlock)
  fastify.register(watchRoutes);

  // Smart Deep Link Share route
  fastify.register(shareRoutes);

  // Wishlist route
  fastify.register(wishlistRoutes, { prefix: '/app' });

  // App Profile / Settings route
  fastify.register(appProfileRoutes, { prefix: '/app' });

  // Download routes (POST /download, GET /downloads, DELETE /downloads/:id)
  fastify.register(downloadRoutes, { prefix: '/app' });

  // Web download routes — separate from app, no subscription gate
  fastify.register(webDownloadRoutes, { prefix: '/web' });

  // DELETE /api/web/account — same handler as app (website end-users)
  fastify.delete('/web/account', deleteAppAccount);

  // Watch progress routes (POST /watch/progress, DELETE /watch/progress/:contentId)
  fastify.register(watchProgressRoutes, { prefix: '/app' });

  // Rewards routes

  // App Notifications routes
  fastify.register(appNotificationRoutes, { prefix: '/app/notifications' });

  // Mobile movie detail page
  fastify.get('/app/movies/:id', getMovieDetail);

  // Home page route for app (layout/sections only — no banners)
  fastify.get('/home', getHomePage);

  // App Banners — separate from home layout
  fastify.get('/app/banners', getAppBanners);
  
  // Explore page (infinite scroll)
  fastify.get('/explore', getExplore);

  // Search page (trending keywords + query results)
  fastify.get('/search', getSearchPage);

  // Web Homepage aggregated data
  fastify.get('/web-home', getWebHome);
  
  // Web all content for dynamic sections
  fastify.get('/web-all-content', getWebAllContent);
  
  // Web Browse paginated data
  fastify.get('/web-browse', getWebBrowse);
  
  // Web Detail page data
  fastify.get('/web-detail/:contentId', getWebDetail);

  // Public notifications (broadcast + recent sent logs)
  fastify.get('/public/notifications', async (request, reply) => {
    try {
      const { NotificationLogModel } = await import('../models/NotificationLog');
      let notifications = await NotificationLogModel.find({
        $or: [
          { type: { $in: ['all', 'broadcast', 'announcement', 'promo', 'system'] } },
          { isHighlight: true },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('title text type createdAt isHighlight')
        .lean();

      // Seed a few defaults if empty so the bell isn't always blank on a new install
      if (!notifications.length) {
        const defaults = [
          {
            type: 'announcement',
            isHighlight: true,
            title: 'Welcome to Tataiya',
            text: 'Stream premium 18+ movies anytime. Subscribe for full access and downloads.',
            userName: 'Tataiya',
            userEmail: 'system@tataiya.in',
          },
          {
            type: 'promo',
            isHighlight: true,
            title: 'Standard plan — ₹30/month',
            text: 'Unlock HD streaming and offline downloads with our Standard plan.',
            userName: 'Tataiya',
            userEmail: 'system@tataiya.in',
          },
        ];
        await NotificationLogModel.insertMany(defaults);
        notifications = await NotificationLogModel.find({})
          .sort({ createdAt: -1 })
          .limit(20)
          .select('title text type createdAt isHighlight')
          .lean();
      }

      return reply.send({ success: true, data: notifications });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

};

export default router;
