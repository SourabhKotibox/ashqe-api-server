import type { FastifyPluginAsync } from 'fastify';
import { requireMinRole } from '../middlewares/rbac';
import { getAdminNotifications, markAllNotificationsAsRead } from '../controllers/adminNotificationController';

// Staff inbox. Moderators and above keep the existing admin bell; creators do not.
const staff = { onRequest: [requireMinRole('moderator')] };

const adminNotificationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', staff, getAdminNotifications);
  fastify.patch('/read-all', staff, markAllNotificationsAsRead);
};
export default adminNotificationsRoutes;
