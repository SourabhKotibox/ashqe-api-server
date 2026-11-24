import { requireAnyPermission, requirePermission } from '../middlewares/rbac';
import type { FastifyPluginAsync } from 'fastify';
import {
  getFolders,
  createFolder,
  deleteFolder,
  getFilesByFolder,
  getAllMediaFiles,
  uploadFilesToFolder,
  deleteFile,
  getMediaFileById,
  reprocessMediaHls,
  seedDefaultFolders,
  presignMediaUpload,
  confirmS3MediaUpload,
} from '../controllers/mediaController';

const media: FastifyPluginAsync = async (fastify) => {
  // Seed default folders on startup
  seedDefaultFolders().catch((err) => console.error('Error seeding media folders:', err));

  // Folder routes
  fastify.get('/folders', { onRequest: [requirePermission('mediaLibrary', 'canView')] }, getFolders);
  fastify.post('/folders', { onRequest: [requirePermission('mediaLibrary', 'canCreate')] }, createFolder);
  fastify.delete('/folders/:id', { onRequest: [requirePermission('mediaLibrary', 'canDelete')] }, deleteFolder);

  // File routes
  fastify.get('/folders/:id/files', { onRequest: [requirePermission('mediaLibrary', 'canView')] }, getFilesByFolder);
  fastify.get('/files/all', { onRequest: [requirePermission('mediaLibrary', 'canView')] }, getAllMediaFiles);
  fastify.get('/files/:id', { onRequest: [requirePermission('mediaLibrary', 'canView')] }, getMediaFileById);
  fastify.post('/files/:id/reprocess-hls', { onRequest: [requirePermission('mediaLibrary', 'canCreate')] }, reprocessMediaHls);
  // mediaLibrary stores canUpload (there is no canCreate). Creators granted canUpload must be able to upload.
  fastify.post('/folders/:id/files', { onRequest: [requirePermission('mediaLibrary', 'canUpload')] }, uploadFilesToFolder);
  fastify.post('/presign', { onRequest: [requirePermission('mediaLibrary', 'canUpload')] }, presignMediaUpload);
  fastify.post('/confirm-s3', { onRequest: [requirePermission('mediaLibrary', 'canUpload')] }, confirmS3MediaUpload);
  // Creators upload with canUpload and may delete only their own unreferenced files.
  // Staff with canDelete can delete any unreferenced file. The handler enforces both.
  fastify.delete('/files/:id', { onRequest: [requireAnyPermission([
    ['mediaLibrary', 'canDelete'],
    ['mediaLibrary', 'canUpload'],
  ])] }, deleteFile);
};

export default media;
