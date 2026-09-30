/**
 * Shared runtime configuration
 */
export const API_URL = (process.env.API_URL || 'https://ashqe.app/api').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://ashqe.app').replace(/\/$/, '');

export const buildShareUrl = (itemId: string, contentType: 'movie' | 'show' | 'webseries' = 'movie'): string => {
  const type = ['tvshow', 'webseries', 'drama', 'show'].includes(contentType.toLowerCase()) ? 'webseries' : 'movie';
  return `${FRONTEND_URL}/${type}/${itemId}`;
};
