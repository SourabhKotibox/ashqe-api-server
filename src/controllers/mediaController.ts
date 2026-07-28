import type { FastifyRequest, FastifyReply } from 'fastify';
import { MediaFolderModel } from '../models/MediaFolder';
import { MediaFileModel } from '../models/MediaFile';
import { Types } from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger';
import uploadHandler from '../lib/uploadHandler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.join(__dirname, '../../uploads');
const mediaUploadDir = path.join(uploadsRoot, 'media');

// Utility functions
const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Seed default folders
export const seedDefaultFolders = async () => {
  // Drop the stale solo `name_1` unique index left over from a previous schema
  // version. The current compound index { name, parentFolder } replaces it.
  try {
    await MediaFolderModel.collection.dropIndex('name_1');
    logger.info('Dropped stale name_1 index from mediafolders');
  } catch {
    // Index doesn't exist — that's fine
  }

  const defaultFolderNames = [
    'Ads',
    'Banner',
    'Cast & Crew',
    'Constant',
    'Genres',
    'Logos',
    'Movie',
    'TV Show',
    'Users',
    'Video',
  ];

  for (const name of defaultFolderNames) {
    const folder = await MediaFolderModel.findOneAndUpdate(
      { name, parentFolder: null },
      { $setOnInsert: { name, parentFolder: null } },
      { upsert: true, new: true }
    );

    // Seed nested subfolders (Images, Videos) for Movie, TV Show, and Short Drama
    if (['Movie', 'TV Show', 'Short Drama'].includes(name) && folder) {
      const subfolders = ['Images', 'Videos'];
      for (const subName of subfolders) {
        await MediaFolderModel.findOneAndUpdate(
          { name: subName, parentFolder: folder._id },
          { $setOnInsert: { name: subName, parentFolder: folder._id } },
          { upsert: true, new: true }
        );
      }
    }
  }
};

// Get all folders
export const getFolders = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { parentFolder?: string };
    let filter: any = { parentFolder: null };

    if (query.parentFolder) {
      if (query.parentFolder === 'all') {
        filter = {};
      } else if (Types.ObjectId.isValid(query.parentFolder)) {
        filter = { parentFolder: new Types.ObjectId(query.parentFolder) };
      }
    }

    const folders = await MediaFolderModel.find(filter).sort({ name: 1 }).lean();
    const foldersWithCount = [];
    for (const folder of folders) {
      const subFolders = await MediaFolderModel.find({ parentFolder: folder._id });
      const subFolderIds = subFolders.map(sf => sf._id);
      const count = await MediaFileModel.countDocuments({
        folder: { $in: [folder._id, ...subFolderIds] }
      });

      foldersWithCount.push({
        _id: folder._id,
        name: folder.name,
        parentFolder: folder.parentFolder,
        count,
      });
    }

    return reply.send({
      success: true,
      data: foldersWithCount,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting folders');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Create folder
export const createFolder = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { name, parentFolder } = request.body as { name: string; parentFolder?: string };
    if (!name) {
      return reply.status(400).send({ success: false, error: 'Folder name is required' });
    }

    const parentId = parentFolder && Types.ObjectId.isValid(parentFolder)
      ? new Types.ObjectId(parentFolder)
      : null;

    const existing = await MediaFolderModel.findOne({ name, parentFolder: parentId });
    if (existing) {
      return reply.status(400).send({ success: false, error: 'Folder already exists at this level' });
    }

    const folder = await MediaFolderModel.create({ name, parentFolder: parentId });
    return reply.status(201).send({
      success: true,
      data: folder,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error creating folder');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Delete folder
export const deleteFolder = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Invalid folder ID' });
    }

    const folder = await MediaFolderModel.findById(id);
    if (!folder) {
      return reply.status(404).send({ success: false, error: 'Folder not found' });
    }

    const files = await MediaFileModel.find({ folder: id });

    // Delete files from storage
    for (const file of files) {
      await uploadHandler.deleteUploadedFile(file.filePath);
    }

    // Delete files from DB
    await MediaFileModel.deleteMany({ folder: id });

    // Delete folder from DB
    await MediaFolderModel.findByIdAndDelete(id);

    // Delete folder from disk
    const folderPath = path.join(mediaUploadDir, id);
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }

    return reply.send({ success: true, message: 'Folder deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting folder');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Helper to ensure local file path has /uploads/ prefix (not for S3 keys)
const ensureUploadPath = (path: string): string => {
  if (!path) return path;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('/uploads/')) return path;
  if (path.startsWith('uploads/')) return `/${path}`;
  if (path.startsWith('/')) return `/uploads${path}`;
  return `/uploads/${path}`;
};

/** Keep S3 absolute URLs; only rewrite local files to this host /uploads/... */
const resolvePublicMediaUrls = (
  file: { url?: string; filePath?: string; storageType?: string; s3Key?: string },
  request: FastifyRequest
) => {
  const isS3 =
    file.storageType === 's3' ||
    !!(file.s3Key) ||
    (typeof file.url === 'string' &&
      /^https?:\/\//i.test(file.url) &&
      !file.url.includes('/uploads/'));

  if (isS3) {
    const s3Url =
      (file.url && /^https?:\/\//i.test(file.url) ? file.url : '') ||
      '';
    return {
      url: s3Url || file.url || file.filePath || '',
      filePath: file.filePath || file.s3Key || file.url || '',
    };
  }

  const normalizedPath = ensureUploadPath(file.filePath || '');
  const protocol = request.protocol;
  const host = request.headers.host;
  return {
    url: `${protocol}://${host}${normalizedPath}`,
    filePath: normalizedPath,
  };
};

// Get files by folder
export const getFilesByFolder = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Invalid folder ID' });
    }

    const folder = await MediaFolderModel.findById(id);
    if (!folder) {
      return reply.status(404).send({ success: false, error: 'Folder not found' });
    }

    const files = await MediaFileModel.find({ folder: id }).sort({ createdAt: -1 }).lean();
    const filesWithSize = files.map((file) => {
      const { url: fileUrl, filePath } = resolvePublicMediaUrls(file as any, request);
      
      return {
        _id: file._id,
        id: file._id.toString(),
        name: file.name,
        url: fileUrl,
        filePath: filePath,
        size: uploadHandler.formatFileSize(file.fileSize),
        fileSize: file.fileSize,
        fileType: file.fileType,
        folder: id,
        source: file.source,
        sourceId: file.sourceId?.toString(),
        storageType: file.storageType,
        isHls: file.isHls,
        hlsMasterPlaylistUrl: file.hlsMasterPlaylistUrl,
        hlsMasterPlaylistPath: file.hlsMasterPlaylistPath,
        hlsQualities: file.hlsQualities,
        hlsStatus: file.hlsStatus,
        hlsError: file.hlsError,
        duration: file.duration,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      };
    });

    return reply.send({
      success: true,
      data: filesWithSize,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting files');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get all media files (with optional filtering)
export const getAllMediaFiles = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      source?: string;
      fileType?: string;
      search?: string;
    };

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
    const skip = (page - 1) * limit;

    // Clear stale HLS status on non-video files (was blocking logo/image UX)
    MediaFileModel.updateMany(
      {
        hlsStatus: { $in: ['pending', 'processing', 'failed'] },
        fileType: { $not: /^video\//i },
        name: { $not: /\.(mp4|webm|mov|mkv|avi|m4v)$/i },
      },
      { $unset: { hlsStatus: 1, hlsError: 1 } }
    ).catch(() => {});

    // Build filter
    const filter: any = {};
    if (query.source) filter.source = query.source;
    if (query.fileType) filter.fileType = new RegExp(query.fileType, 'i');
    if (query.search) filter.name = new RegExp(query.search, 'i');

    const [files, total] = await Promise.all([
      MediaFileModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MediaFileModel.countDocuments(filter)
    ]);

    const filesWithSize = files.map((file) => {
      const { url: fileUrl, filePath } = resolvePublicMediaUrls(file as any, request);
      
      return {
        _id: file._id,
        id: file._id.toString(),
        name: file.name,
        url: fileUrl,
        filePath: filePath,
        size: uploadHandler.formatFileSize(file.fileSize),
        fileSize: file.fileSize,
        fileType: file.fileType,
        folder: file.folder?.toString(),
        source: file.source,
        sourceId: file.sourceId?.toString(),
        storageType: file.storageType,
        isHls: file.isHls,
        hlsMasterPlaylistUrl: file.hlsMasterPlaylistUrl,
        hlsMasterPlaylistPath: file.hlsMasterPlaylistPath,
        hlsQualities: file.hlsQualities,
        hlsStatus: file.hlsStatus,
        hlsError: file.hlsError,
        duration: file.duration,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      };
    });

    return reply.send({
      success: true,
      data: filesWithSize,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error getting all media files');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Upload file to folder
export const uploadFilesToFolder = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Invalid folder ID' });
    }

    const folder = await MediaFolderModel.findById(id);
    if (!folder) {
      return reply.status(404).send({ success: false, error: 'Folder not found' });
    }

    const savedFiles = [];
    let source = 'media-library';

    // Check if this folder has nested subfolders (Images, Videos)
    const subfolders = await MediaFolderModel.find({ parentFolder: folder._id });
    const imagesSubfolder = subfolders.find(sf => sf.name.toLowerCase() === 'images');
    const videosSubfolder = subfolders.find(sf => sf.name.toLowerCase() === 'videos');

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        let targetFolderId = id;
        const isVideo = part.mimetype?.startsWith('video/') || part.filename.match(/\.(mp4|webm|mov|mkv|avi|flv)$/i);
        const isImage = part.mimetype?.startsWith('image/') || part.filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i);

        if (isVideo && videosSubfolder) {
          targetFolderId = videosSubfolder._id.toString();
        } else if (isImage && imagesSubfolder) {
          targetFolderId = imagesSubfolder._id.toString();
        }

        const customDir = `media/${targetFolderId}`;

        const uploadedFile = await uploadHandler.saveFileFromPart(part, request, 'MEDIA_LIBRARY', customDir, {
          trackInMediaLibrary: true,
          source: source,
          folderId: targetFolderId,
        });
        savedFiles.push(uploadedFile);
      } else if (part.type === 'field' && part.fieldname === 'source') {
        source = part.value as string;
      }
    }

    return reply.status(201).send({
      success: true,
      data: savedFiles,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error uploading files');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get single media file (for HLS status polling + movie form auto-fill)
export const getMediaFileById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Invalid file ID' });
    }
    const file = await MediaFileModel.findById(id).lean();
    if (!file) {
      return reply.status(404).send({ success: false, error: 'File not found' });
    }

    const rawName = (file.name || '').replace(/\.[^/.]+$/, '');
    const yearMatch = rawName.match(/(?:^|[.\s_\-(])((?:19|20)\d{2})(?:[.\s_\-)]|$)/);
    const year = yearMatch ? yearMatch[1] : undefined;
    let title = rawName
      .replace(/(?:^|[.\s_-])(?:19|20)\d{2}(?=[.\s_-]|$)/g, ' ')
      .replace(/\b(1080p|720p|480p|2160p|4k|web-?dl|bluray|x264|x265|hevc|aac|hdtv|webrip)\b/gi, ' ')
      .replace(/[._]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const secs = file.duration || 0;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const durationFormatted = secs
      ? [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
      : undefined;

    const slug = title
      ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : undefined;

    return reply.send({
      success: true,
      data: {
        ...file,
        id: file._id.toString(),
        _id: file._id,
        autoFill: {
          title: title || undefined,
          year,
          duration: file.duration,
          durationFormatted,
          ageRating: 18,
          slug,
          metaTitle: title ? `${title} | Tataiya` : undefined,
          posterFrameUrl: (file as any).posterFrameUrl,
          width: (file as any).width,
          height: (file as any).height,
          codec: (file as any).codec,
          bitrate: (file as any).bitrate,
          transcoder: (file as any).transcoder,
        },
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Re-run HLS multi-quality generation for a video in the media library
export const reprocessMediaHls = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Invalid file ID' });
    }
    const file = await MediaFileModel.findById(id);
    if (!file) {
      return reply.status(404).send({ success: false, error: 'File not found' });
    }
    const isVideo = (file.fileType || '').startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name);
    if (!isVideo) {
      return reply.status(400).send({ success: false, error: 'Only video files can be transcoded' });
    }

    const storageType = ((file as any).storageType === 's3' ? 's3' : 'local') as 'local' | 's3';
    const fullPath = path.join(uploadsRoot, (file.filePath || '').replace(/^\/*uploads\//, '').replace(/^\/+/, ''));

    if (storageType === 'local' && !fs.existsSync(fullPath) && !(file as any).s3Key) {
      return reply.status(404).send({ success: false, error: 'Source video file missing on disk' });
    }

    file.hlsStatus = 'processing';
    file.hlsError = undefined;
    await file.save();

    const protocol = request.protocol;
    const host = request.headers.host;
    const baseUrl = `${protocol}://${host}`;

    const { transcodeToHls } = await import('../lib/hlsTranscoder');
    setImmediate(() => {
      transcodeToHls(
        file._id.toString(),
        storageType === 's3' ? '' : fullPath,
        baseUrl,
        storageType
      ).catch((err) => {
        logger.error({ err, id }, 'Failed to reprocess media HLS');
      });
    });

    return reply.send({ success: true, message: 'HLS processing started', data: { id, hlsStatus: 'processing' } });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Delete file
export const deleteFile = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(400).send({ success: false, error: 'Invalid file ID' });
    }

    const file = await MediaFileModel.findById(id);
    if (!file) {
      return reply.status(404).send({ success: false, error: 'File not found' });
    }

    if (file.sourceId && file.contentName) {
      return reply.status(400).send({
        success: false,
        error: `This file is currently in use by "${file.contentName}" (${file.contentType}). Please update or remove that content before deleting this file.`
      });
    }

    // Delete file from storage
    await uploadHandler.deleteUploadedFile(
      (file as any).s3Key || file.filePath,
      ((file as any).storageType === 's3' ? 's3' : 'local') as 'local' | 's3'
    );

    // Delete from DB
    await MediaFileModel.findByIdAndDelete(id);

    return reply.send({ success: true, message: 'File deleted successfully' });
  } catch (error: any) {
    logger.error({ error }, 'Error deleting file');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/**
 * Presign a direct browser → S3 upload (much faster than proxying through the API).
 * Body: { fileName, contentType, folderId?, source? }
 */
export const presignMediaUpload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      fileName?: string;
      contentType?: string;
      folderId?: string;
      source?: string;
    };

    if (!body?.fileName || !body?.contentType) {
      return reply.status(400).send({ success: false, error: 'fileName and contentType are required' });
    }

    const { isS3Configured, generatePresignedUrl } = await import('../lib/s3');
    if (!(await isS3Configured())) {
      return reply.status(400).send({
        success: false,
        error: 'S3 is not configured — use the normal multipart upload',
        code: 'S3_NOT_CONFIGURED',
      });
    }

    let folderId = body.folderId;
    if (folderId && !Types.ObjectId.isValid(folderId)) {
      return reply.status(400).send({ success: false, error: 'Invalid folder ID' });
    }

    if (!folderId) {
      // Resolve/create folder by source name
      const source = (body.source || 'media-library').trim();
      let folder = await MediaFolderModel.findOne({
        name: { $regex: new RegExp(`^${source}$`, 'i') },
        parentFolder: null,
      });
      if (!folder) {
        folder = await MediaFolderModel.create({ name: source, parentFolder: null });
      }
      folderId = folder._id.toString();
    }

    const uniqueName = uploadHandler.generateUniqueFileName(body.fileName);
    const key = `media/${folderId}/${uniqueName}`;
    const signed = await generatePresignedUrl(key, body.contentType, 3600);

    return reply.send({
      success: true,
      data: {
        uploadUrl: signed.uploadUrl,
        publicUrl: signed.publicUrl,
        key,
        folderId,
        fileName: uniqueName,
        originalName: body.fileName,
        contentType: body.contentType,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error presigning media upload');
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/**
 * After browser finishes PUT to S3, register the MediaFile and kick off HLS for videos.
 */
export const confirmS3MediaUpload = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      key?: string;
      publicUrl?: string;
      folderId?: string;
      fileName?: string;
      originalName?: string;
      contentType?: string;
      fileSize?: number;
      source?: string;
    };

    if (!body?.key || !body?.publicUrl || !body?.folderId) {
      return reply.status(400).send({ success: false, error: 'key, publicUrl and folderId are required' });
    }

    const isVideo =
      (body.contentType || '').startsWith('video/') ||
      /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(body.originalName || body.fileName || '');

    const createPayload: Record<string, any> = {
      name: body.originalName || body.fileName || path.basename(body.key),
      url: body.publicUrl,
      filePath: body.key,
      fileSize: Number(body.fileSize) || 0,
      fileType: body.contentType || 'application/octet-stream',
      folder: new Types.ObjectId(body.folderId),
      source: body.source || 'media-library',
      storageType: 's3',
      s3Key: body.key,
    };
    if (isVideo) createPayload.hlsStatus = 'processing';

    const mediaFile = await MediaFileModel.create(createPayload);

    if (isVideo) {
      const { transcodeToHls } = await import('../lib/hlsTranscoder');
      const protocol = request.protocol;
      const host = request.headers.host;
      const baseUrl = `${protocol}://${host}`;
      // Fire-and-forget — never block the upload response on HLS
      setImmediate(() => {
        transcodeToHls(mediaFile._id.toString(), '', baseUrl, 's3').catch((err) => {
          logger.error({ err, mediaFileId: mediaFile._id }, 'Failed to transcode video to HLS after direct S3 upload');
        });
      });
    }

    return reply.status(201).send({
      success: true,
      data: {
        ...mediaFile.toObject(),
        id: mediaFile._id.toString(),
        mediaFileId: mediaFile._id.toString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error confirming S3 media upload');
    return reply.status(500).send({ success: false, error: error.message });
  }
};
