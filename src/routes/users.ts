import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../middlewares/rbac';
import {
  listUsers,
  getSingleUser,
  updateSingleUser,
  banSingleUser,
  unbanSingleUser,
  deleteSingleUser
} from '../controllers/usersController';

const view = { onRequest: [requirePermission('users', 'canView')] };
const edit = { onRequest: [requirePermission('users', 'canEdit')] };
const remove = { onRequest: [requirePermission('users', 'canDelete')] };

const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/users', view, listUsers);
  fastify.get('/users/:id', view, getSingleUser);
  fastify.patch('/users/:id', edit, updateSingleUser);
  fastify.post('/users/:id/ban', edit, banSingleUser);
  fastify.post('/users/:id/unban', edit, unbanSingleUser);
  fastify.delete('/users/:id', remove, deleteSingleUser);
};

export default usersRoutes;
