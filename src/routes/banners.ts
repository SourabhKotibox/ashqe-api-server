import { requirePermission } from '../middlewares/rbac';
import type { FastifyPluginAsync } from 'fastify';
import {
  bulkDeleteBanners,
  createBanner,
  createBannerFromContent,
  deleteBanner,
  getBannerById,
  listBanners,
  updateBanner,
} from '../controllers/bannerController';

const bannersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/banners', { onRequest: [requirePermission('banners', 'canView')] }, listBanners);
  fastify.post('/banners', { onRequest: [requirePermission('banners', 'canCreate')] }, createBanner);
  fastify.post('/banners/from-content', { onRequest: [requirePermission('banners', 'canCreate')] }, createBannerFromContent);
  fastify.get('/banners/item/:bannerId', { onRequest: [requirePermission('banners', 'canView')] }, getBannerById);
  fastify.put('/banners/item/:bannerId', { onRequest: [requirePermission('banners', 'canEdit')] }, updateBanner);
  fastify.delete('/banners/item/:bannerId', { onRequest: [requirePermission('banners', 'canDelete')] }, deleteBanner);
  fastify.post('/banners/bulk-delete', { onRequest: [requirePermission('banners', 'canDelete')] }, bulkDeleteBanners);
};

export default bannersRoutes;
