import { requireAnyPermission, authenticateAndAttach } from '../middlewares/rbac';
import type { FastifyPluginAsync } from 'fastify';
import {
  listCountries,
  getCountryById,
  createCountry,
  updateCountry,
  deleteCountry,
} from '../controllers/countryController';

const countriesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all countries with pagination — allow any authenticated user so dropdowns work across forms
  fastify.get('/', { onRequest: [authenticateAndAttach] }, listCountries);

  // Get country by ID — allow any authenticated user
  fastify.get('/:id', { onRequest: [authenticateAndAttach] }, getCountryById);

  // Staff keep settings.*. Creators use countries.* so settings stays closed.
  const countryWrite = (action: 'canCreate' | 'canEdit' | 'canDelete') =>
    requireAnyPermission([['settings', action], ['countries', action]]);

  // Create new country
  fastify.post('/', { onRequest: [countryWrite('canCreate')] }, createCountry);

  // Update country
  fastify.put('/:id', { onRequest: [countryWrite('canEdit')] }, updateCountry);

  // Delete country
  fastify.delete('/:id', { onRequest: [countryWrite('canDelete')] }, deleteCountry);
};

export default countriesRoutes;
