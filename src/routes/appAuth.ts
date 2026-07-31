import type { FastifyPluginAsync } from 'fastify';
import {
  sendOtp,
  verifyOtp,
  setPreferredLanguage,
  skipPreferredLanguage,
  registerUser,
  loginUser,
  googleAuth,
  appleAuth,
  logoutUser,
} from '../controllers/appAuthController';

const appAuthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/app/auth/otp-status', async (_request, reply) => {
    const { loadMcConfig } = await import('../services/messageCentralService');
    const cfg = await loadMcConfig();
    const live = !!(cfg.customerId && cfg.authToken);
    return reply.send({
      success: true,
      mode: live ? 'message-gateway' : 'not-configured',
      enabled: cfg.enabled,
      customerIdSet: !!cfg.customerId,
      authTokenSet: !!cfg.authToken,
      authTokenLen: cfg.authToken?.length || 0,
      staticOtp: false,
      build: 'message-gateway-only',
    });
  });
  fastify.post('/app/auth/send-otp', sendOtp);
  fastify.post('/app/auth/verify-otp', verifyOtp);
  // Aliases some mobile builds use
  fastify.post('/auth/send-otp', sendOtp);
  fastify.post('/auth/verify-otp', verifyOtp);
  fastify.post('/app/auth/register', registerUser);
  fastify.post('/app/auth/login', loginUser);
  fastify.post('/app/auth/google', googleAuth);
  fastify.post('/app/auth/apple', appleAuth);
  fastify.post('/app/auth/logout', logoutUser);

  fastify.post('/app/auth/language/:userId', setPreferredLanguage);
  fastify.post('/app/auth/language/:userId/skip', skipPreferredLanguage);

  // Mobile App compatibility routes
  fastify.post('/app/users/:userId/language', setPreferredLanguage);
  fastify.post('/app/users/:userId/language/skip', skipPreferredLanguage);
};

export default appAuthRoutes;
