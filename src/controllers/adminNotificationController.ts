import type { FastifyRequest, FastifyReply } from 'fastify';

export const getAdminNotifications = async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.send({
      success: true,
      data: [],
      unreadCount: 0,
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const markAllNotificationsAsRead = async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.send({ success: true, message: 'Notifications disabled' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};
