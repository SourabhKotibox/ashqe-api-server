/**
 * Shared runtime configuration
 */
export const API_URL = (process.env.API_URL || 'https://ashqe.app/api').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://ashqe.app').replace(/\/$/, '');

export const buildShareUrl = (itemId: string, contentType: 'movie' | 'show' = 'movie'): string => {
  return `${FRONTEND_URL}/${contentType}/${itemId}`;
};
