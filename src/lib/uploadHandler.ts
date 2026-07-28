import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { FastifyRequest } from 'fastify';
import { MediaFileModel } from '../models/MediaFile';
import { MediaFolderModel } from '../models/MediaFolder';
import { Types } from 'mongoose';
import { uploadToS3, deleteFromS3, isS3Configured } from './s3';
import { transcodeToHls } from './hlsTranscoder';
import { logger } from './logger';
import { ensureVttSubtitle, isSubtitleFile } from './subtitleConverter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_ROOT = path.join(__dirname, '../../uploads');

export const UPLOAD_TYPES = {
  IMAGE: {
    name: 'image',
    allowedExts: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'],
    defaultDir: ''
  },
  VIDEO: {
    name: 'video',
    allowedExts: ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv'],
    defaultDir: 'videos'
  },
  DOCUMENT: {
    name: 'document',
    allowedExts: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'],
    defaultDir: 'documents'
  },
  CATEGORY_THUMBNAIL: {
    name: 'category-thumbnail',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'categories'
  },
  CATEGORY_BANNER: {
    name: 'category-banner',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'categories'
  },
  CATEGORY_ICON: {
    name: 'category-icon',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp', '.svg'],
    defaultDir: 'categories'
  },
  GENRE: {
    name: 'genre',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'genres'
  },
  ACTOR: {
    name: 'actor',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'actors'
  },
  DIRECTOR: {
    name: 'director',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'directors'
  },
  LANGUAGE: {
    name: 'language',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp', '.svg'],
    defaultDir: 'languages'
  },
  MEDIA_LIBRARY: {
    name: 'media-library',
    allowedExts: [
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp',
      '.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.m4v',
      '.srt', '.vtt', '.ass', '.ssa',
    ],
    defaultDir: 'media'
  },
  BANNER: {
    name: 'banner',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'banners'
  },
  PROMOTION: {
    name: 'promotion',
    allowedExts: ['.jpg', '.jpeg', '.png', '.webp'],
    defaultDir: 'promotions'
  }
} as const;

export type UploadType = keyof typeof UPLOAD_TYPES;

export interface UploadedFileInfo {
  originalName: string;
  fileName: string;
  filePath: string;
  url: string;
  fileSize: number;
  mimeType: string;
  uploadType: UploadType;
  storageType?: 'local' | 's3';
  s3Key?: string;
  mediaFileId?: string;
  isHls?: boolean;
  hlsStatus?: string;
  hlsMasterPlaylistUrl?: string;
  hlsMasterPlaylistPath?: string;
  hlsQualities?: any[];
  duration?: number;
}

export const ensureUploadDir = (dirPath: string) => {
  const fullPath = path.join(UPLOADS_ROOT, dirPath);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
};

export const generateUniqueFileName = (originalName: string): string => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 10);
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${timestamp}-${randomString}${baseName ? `-${baseName}` : ''}${ext}`;
};

export const validateFileType = (fileName: string, uploadType: UploadType): boolean => {
  const typeConfig = UPLOAD_TYPES[uploadType];
  const ext = path.extname(fileName).toLowerCase();
  return (typeConfig.allowedExts as readonly string[]).includes(ext);
};

// Helper to check if a file is a video based on file extension or mimetype
const isVideoFile = (fileName: string, mimeType: string): boolean => {
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.m4v', '.mpeg', '.mpg'];
  const ext = path.extname(fileName).toLowerCase();
  return videoExtensions.includes(ext) || mimeType.startsWith('video/');
};

export const saveFileFromPart = async (
  part: any,
  request: FastifyRequest,
  uploadType: UploadType,
  customDir?: string,
  options?: {
    trackInMediaLibrary?: boolean;
    source?: string;
    sourceId?: string;
    folderId?: string;
    contentName?: string;
    contentType?: string;
  }
): Promise<UploadedFileInfo> => {
  const typeConfig = UPLOAD_TYPES[uploadType];
  const targetDir = customDir || typeConfig.defaultDir;
  const useS3 = await isS3Configured();

  if (!validateFileType(part.filename, uploadType)) {
    throw new Error(
      `Invalid file type for ${typeConfig.name}. Allowed types: ${typeConfig.allowedExts.join(', ')}`
    );
  }

  let resolvedFolderId = options?.folderId;
  if (!resolvedFolderId && typeConfig.defaultDir) {
    try {
      const folderMatch = await MediaFolderModel.findOne({ name: { $regex: new RegExp(`^${typeConfig.defaultDir}$`, 'i') } });
      if (folderMatch) resolvedFolderId = folderMatch._id.toString();
    } catch (error) {
      console.error('Error resolving folder ID:', error);
    }
  }

  const fileName = generateUniqueFileName(part.filename);
  const s3Key = targetDir ? `${targetDir}/${fileName}` : fileName;
  const protocol = request.protocol;
  const host = request.headers.host;
  const baseUrl = `${protocol}://${host}`;

  // ── S3 path ─────────────────────────────────────────────────────────────
  if (useS3) {
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let buffer = Buffer.concat(chunks);
    let finalKey = s3Key;
    let mimeType = part.mimetype || 'application/octet-stream';
    let displayName = part.filename;

    // Convert SRT → VTT in memory when needed
    if (isSubtitleFile(part.filename, mimeType) && path.extname(part.filename).toLowerCase() === '.srt') {
      const { srtToVtt } = await import('./subtitleConverter');
      buffer = Buffer.from(srtToVtt(buffer.toString('utf8')), 'utf8');
      finalKey = s3Key.replace(/\.srt$/i, '.vtt');
      mimeType = 'text/vtt';
      displayName = path.basename(finalKey);
    }

    // Compress movie covers / images → WebP (same look, less space)
    if (!isVideoFile(part.filename, mimeType)) {
      const { optimizeImageBuffer, inferPreset, isOptimizableImage } = await import('./imageOptimizer');
      if (isOptimizableImage(part.filename, mimeType)) {
        const optimized = await optimizeImageBuffer(
          buffer,
          part.filename,
          mimeType,
          inferPreset(part.filename, options?.source, uploadType)
        );
        if (!optimized.skipped) {
          buffer = optimized.buffer;
          mimeType = optimized.mimeType;
          finalKey = finalKey.replace(/\.[^.]+$/, '') + optimized.extension;
          displayName = path.basename(finalKey);
        }
      }
    }

    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const existingFile = await MediaFileModel.findOne({
      $or: [{ contentHash }, { name: part.filename, fileSize: buffer.length }],
    });

    if (existingFile) {
      return {
        originalName: existingFile.name,
        fileName: path.basename(existingFile.filePath || existingFile.url),
        filePath: existingFile.filePath || existingFile.url,
        url: existingFile.url,
        fileSize: existingFile.fileSize,
        mimeType: existingFile.fileType,
        uploadType,
        storageType: (existingFile.storageType as 'local' | 's3') || 's3',
        s3Key: (existingFile as any).s3Key,
        mediaFileId: existingFile._id.toString(),
        isHls: !!existingFile.isHls,
        hlsStatus: existingFile.hlsStatus,
        hlsMasterPlaylistUrl: existingFile.hlsMasterPlaylistUrl,
        hlsMasterPlaylistPath: existingFile.hlsMasterPlaylistPath,
        hlsQualities: existingFile.hlsQualities,
        duration: existingFile.duration,
      };
    }

    const publicUrl = await uploadToS3(finalKey, buffer, mimeType);
    const isVid = isVideoFile(part.filename, part.mimetype || '');

    const fileInfo: UploadedFileInfo = {
      originalName: displayName,
      fileName: path.basename(finalKey),
      filePath: finalKey,
      url: publicUrl,
      fileSize: buffer.length,
      mimeType,
      uploadType,
      storageType: 's3',
      s3Key: finalKey,
    };

    if (options?.trackInMediaLibrary !== false) {
      try {
        const createPayload: Record<string, any> = {
          name: displayName,
          url: publicUrl,
          filePath: finalKey,
          fileSize: buffer.length,
          fileType: mimeType,
          folder: resolvedFolderId ? new Types.ObjectId(resolvedFolderId) : undefined,
          source: options?.source || uploadType.toLowerCase(),
          sourceId: options?.sourceId ? new Types.ObjectId(options.sourceId) : undefined,
          contentHash,
          contentName: options?.contentName,
          contentType: options?.contentType,
          storageType: 's3',
          s3Key: finalKey,
        };
        if (isVid) createPayload.hlsStatus = 'processing';

        const mediaFile = await MediaFileModel.create(createPayload);
        fileInfo.mediaFileId = mediaFile._id.toString();
        fileInfo.hlsStatus = mediaFile.hlsStatus;
        fileInfo.isHls = false;

        if (isVid) {
          transcodeToHls(mediaFile._id.toString(), '', baseUrl, 's3').catch((err) => {
            logger.error({ err, mediaFileId: mediaFile._id }, 'Failed to transcode video to HLS (S3)');
          });
        }
      } catch (error) {
        console.error('Failed to track file in media library:', error);
      }
    }

    return fileInfo;
  }

  // ── Local path ──────────────────────────────────────────────────────────
  ensureUploadDir(targetDir);
  const relativeFilePath = path.join(targetDir, fileName);
  const fullFilePath = path.join(UPLOADS_ROOT, relativeFilePath);

  return new Promise(async (resolve, reject) => {
    const writeStream = fs.createWriteStream(fullFilePath);
    part.file.pipe(writeStream);

    writeStream.on('finish', async () => {
      try {
        const stats = fs.statSync(fullFilePath);
        const computeFileHash = (filePath: string): Promise<string> =>
          new Promise((res, rej) => {
            const h = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (chunk) => h.update(chunk));
            stream.on('end', () => res(h.digest('hex')));
            stream.on('error', rej);
          });

        const contentHash = await computeFileHash(fullFilePath).catch(() => '');

        const existingFile = await MediaFileModel.findOne({
          $or: [{ contentHash }, { name: part.filename, fileSize: stats.size }],
        });

        if (existingFile) {
          fs.unlinkSync(fullFilePath);
          return resolve({
            originalName: existingFile.name,
            fileName: path.basename(existingFile.filePath || existingFile.url),
            filePath: existingFile.filePath || existingFile.url,
            url: existingFile.url,
            fileSize: existingFile.fileSize,
            mimeType: existingFile.fileType,
            uploadType,
            storageType: (existingFile.storageType as 'local' | 's3') || 'local',
            s3Key: (existingFile as any).s3Key,
            mediaFileId: existingFile._id.toString(),
            isHls: !!existingFile.isHls,
            hlsStatus: existingFile.hlsStatus,
            hlsMasterPlaylistUrl: existingFile.hlsMasterPlaylistUrl,
            hlsMasterPlaylistPath: existingFile.hlsMasterPlaylistPath,
            hlsQualities: existingFile.hlsQualities,
            duration: existingFile.duration,
          });
        }

        let finalRelative = relativeFilePath.replace(/\\/g, '/');
        let finalAbs = fullFilePath;
        if (isSubtitleFile(part.filename, part.mimetype || '')) {
          const vttRel = ensureVttSubtitle(fullFilePath, finalRelative);
          if (vttRel !== finalRelative) {
            finalRelative = vttRel;
            finalAbs = path.join(UPLOADS_ROOT, vttRel);
          }
        }

        let mimeType = finalRelative.endsWith('.vtt')
          ? 'text/vtt'
          : (part.mimetype || 'application/octet-stream');

        // Compress images on local storage path too
        if (!isVideoFile(part.filename, part.mimetype || '')) {
          const { optimizeImageBuffer, inferPreset, isOptimizableImage } = await import('./imageOptimizer');
          if (isOptimizableImage(part.filename, part.mimetype)) {
            const inputBuf = fs.readFileSync(finalAbs);
            const optimized = await optimizeImageBuffer(
              inputBuf,
              part.filename,
              part.mimetype,
              inferPreset(part.filename, options?.source, uploadType)
            );
            if (!optimized.skipped) {
              const newRel = finalRelative.replace(/\.[^.]+$/, '') + optimized.extension;
              const newAbs = path.join(UPLOADS_ROOT, newRel);
              fs.writeFileSync(newAbs, optimized.buffer);
              if (newAbs !== finalAbs && fs.existsSync(finalAbs)) {
                try { fs.unlinkSync(finalAbs); } catch { /* ignore */ }
              }
              finalRelative = newRel.replace(/\\/g, '/');
              finalAbs = newAbs;
              mimeType = optimized.mimeType;
            }
          }
        }

        const fileInfo: UploadedFileInfo = {
          originalName: part.filename,
          fileName: path.basename(finalRelative),
          filePath: `/uploads/${finalRelative}`,
          url: `${baseUrl}/uploads/${finalRelative}`,
          fileSize: fs.existsSync(finalAbs) ? fs.statSync(finalAbs).size : stats.size,
          mimeType,
          uploadType,
          storageType: 'local',
        };

        if (options?.trackInMediaLibrary !== false) {
          try {
            const isVid = isVideoFile(part.filename, part.mimetype || '');
            const createPayload: Record<string, any> = {
              name: path.basename(finalRelative),
              url: fileInfo.url,
              filePath: fileInfo.filePath,
              fileSize: fileInfo.fileSize,
              fileType: fileInfo.mimeType,
              folder: resolvedFolderId ? new Types.ObjectId(resolvedFolderId) : undefined,
              source: options?.source || uploadType.toLowerCase(),
              sourceId: options?.sourceId ? new Types.ObjectId(options.sourceId) : undefined,
              contentHash,
              contentName: options?.contentName,
              contentType: options?.contentType,
              storageType: 'local',
            };
            if (isVid) createPayload.hlsStatus = 'processing';

            const mediaFile = await MediaFileModel.create(createPayload);
            fileInfo.mediaFileId = mediaFile._id.toString();
            fileInfo.hlsStatus = mediaFile.hlsStatus;
            fileInfo.isHls = false;

            if (isVid) {
              transcodeToHls(mediaFile._id.toString(), fullFilePath, baseUrl, 'local').catch((err) => {
                logger.error({ err, mediaFileId: mediaFile._id }, 'Failed to transcode video to HLS (local)');
              });
            }
          } catch (error) {
            console.error('Failed to track file in media library:', error);
          }
        }

        resolve(fileInfo);
      } catch (err) {
        reject(err);
      }
    });

    writeStream.on('error', reject);
  });
};

export const deleteUploadedFile = async (
  relativeFilePath: string,
  storageType?: 'local' | 's3'
) => {
  if (!relativeFilePath) return;

  const s3Configured = await isS3Configured();
  if (storageType === 's3' || (s3Configured && !relativeFilePath.includes('/uploads/'))) {
    await deleteFromS3(relativeFilePath.replace(/^\/*uploads\//, ''));
  }

  if (storageType !== 's3') {
    const fullPath = path.join(
      UPLOADS_ROOT,
      relativeFilePath.replace(/^\/*uploads\//, '').replace(/^\/+/, '')
    );
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
};

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export default {
  UPLOAD_TYPES,
  ensureUploadDir,
  generateUniqueFileName,
  validateFileType,
  saveFileFromPart,
  deleteUploadedFile,
  formatFileSize
};
