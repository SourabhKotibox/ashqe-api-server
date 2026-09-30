import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../middlewares/rbac';
import { getSettings, updateSettings, updateSmsSettings, uploadSettingsLogos, getEmailStatus, testEmail, getAppVersion } from '../controllers/settingsController';

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/settings', getSettings);
  fastify.put('/settings', { onRequest: [requirePermission('settings', 'canEdit')] }, updateSettings);
  fastify.put('/settings/sms-otp', { onRequest: [requirePermission('settings', 'canEdit')] }, updateSmsSettings);
  fastify.post('/settings/upload-logos', { onRequest: [requirePermission('settings', 'canEdit')] }, uploadSettingsLogos);
  fastify.get('/settings/email-status', { onRequest: [requirePermission('settings', 'canView')] }, getEmailStatus);
  fastify.post('/settings/test-email', { onRequest: [requirePermission('settings', 'canEdit')] }, testEmail);
  fastify.get('/settings/app-version', getAppVersion);
};

export default settingsRoutes;
