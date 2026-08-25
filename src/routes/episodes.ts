import { requirePermission } from '../middlewares/rbac';
import type { FastifyPluginAsync } from 'fastify';
import {
  getAllEpisodes,
  getEpisodeById,
  createEpisode,
  updateEpisode,
  deleteEpisode,
  getSeasons,
  toggleEpisodeLock,
} from '../controllers/episodeController';

const episodes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { onRequest: [requirePermission('tvShows', 'canView')] }, getAllEpisodes);
  fastify.post('/', { onRequest: [requirePermission('tvShows', 'canCreate')] }, createEpisode);
  fastify.get('/seasons', { onRequest: [requirePermission('tvShows', 'canView')] }, getSeasons);
  fastify.get('/:id', { onRequest: [requirePermission('tvShows', 'canView')] }, getEpisodeById);
  fastify.put('/:id', { onRequest: [requirePermission('tvShows', 'canEdit')] }, updateEpisode);
  fastify.delete('/:id', { onRequest: [requirePermission('tvShows', 'canDelete')] }, deleteEpisode);
  fastify.patch('/:id/lock', { onRequest: [requirePermission('tvShows', 'canEdit')] }, toggleEpisodeLock);
};

export default episodes;
