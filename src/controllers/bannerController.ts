import type { FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BannerModel } from '../models/Banner';
import { MovieModel } from '../models/Movie';
import uploadHandler from '../lib/uploadHandler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.join(__dirname, '../../uploads');

type BannerMultipartData = {
  title?: string;
  subtitle?: string;
  description?: string;
  genres?: string[];
  languages?: string[];
  targetPlatforms?: Array<'web' | 'mobile' | 'tv'>;
  position?: number;
  isActive?: boolean;
  ctaText?: string;
  ctaLink?: string;
  startDate?: Date;
  endDate?: Date;
  thumbnail?: string;
  contentId?: string;
};

const parseList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 'yes';
};

const parseDate = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const parsePlatforms = (value: unknown): Array<'web' | 'mobile' | 'tv'> => {
  const allowed = new Set(['web', 'mobile', 'tv']);
  return parseList(value).filter((platform): platform is 'web' | 'mobile' | 'tv' => allowed.has(platform));
};

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const ensureDefaultBannerImage = () => {
  const folder = path.join(uploadsRoot, 'banners');
  const fileName = 'default-video-banner.svg';
  const filePath = path.join(folder, fileName);
  ensureDir(folder);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#0b1217"/>
  <rect x="64" y="64" width="1152" height="592" rx="28" fill="#141d23" stroke="#2a343c" stroke-width="4"/>
  <circle cx="640" cy="360" r="92" fill="#e50914"/>
  <path d="M615 312v96l84-48z" fill="#fff"/>
  <text x="640" y="515" text-anchor="middle" fill="#d7dde2" font-family="Arial, sans-serif" font-size="42" font-weight="700">Video Upload</text>
</svg>`
    );
  }

  return `/uploads/banners/${fileName}`;
};

const mapContent = (content: any) => ({
  id: content._id.toString(),
  title: content.title,
  subtitle: content.shortDescription,
  description: content.description,
  thumbnail: content.thumbnail,
  bannerImage: content.bannerImage,
  genres: content.genres,
  languages: content.languages,
  views: content.views,
  likes: content.likes,
  shares: content.shares,
  status: content.status,
  createdAt: content.createdAt,
  updatedAt: content.updatedAt,
  contentType: 'movie',
  hlsUrl: content.hlsUrl,
  videoUrl: content.videoUrl,
});

const populateBannersContent = async (banners: any[]) => {
  const contentIds = banners.map((b) => b.contentId).filter(Boolean);
  if (contentIds.length === 0) return banners;

  const movies = await MovieModel.find({ _id: { $in: contentIds } }).lean();

  // Create a map for quick lookups
  const contentMap = new Map();
  for (const movie of movies) {
    contentMap.set(movie._id.toString(), { ...movie, contentType: 'movie' });
  }

  // Assign populated content back to banner
  for (const banner of banners) {
    if (banner.contentId) {
      banner.contentId = contentMap.get(banner.contentId.toString()) || null;
    }
  }

  return banners;
};

const resequenceBanners = async (movedBannerId?: string, targetPosition?: number) => {
  try {
    const banners = await BannerModel.find().sort({ position: 1, updatedAt: -1 });
    let currentPos = 1;
    for (const banner of banners) {
      if (movedBannerId && banner._id.toString() === movedBannerId) {
        continue;
      }
      if (targetPosition !== undefined && currentPos === targetPosition) {
        currentPos++;
      }
      if (banner.position !== currentPos) {
        banner.position = currentPos;
        await BannerModel.updateOne({ _id: banner._id }, { $set: { position: currentPos } });
      }
      currentPos++;
    }
  } catch (error) {
    console.error('Error resequencing banners:', error);
  }
};

const mapBanner = (banner: any) => {
  const content = banner.contentId;
  const thumbnail = content?.thumbnail || banner.imageUrl;
  return {
    id: banner._id.toString(),
    title: banner.title,
    subtitle: banner.subtitle,
    description: banner.description,
    thumbnail,
    imageUrl: thumbnail,
    ctaText: banner.ctaText,
    ctaLink: banner.ctaLink,
    position: banner.position,
    isActive: banner.isActive,
    type: banner.type,
    targetPlatforms: banner.targetPlatforms || [],
    startDate: banner.startDate,
    endDate: banner.endDate,
    content: content ? mapContent(content) : undefined,
  };
};

const readBannerMultipart = async (request: FastifyRequest): Promise<BannerMultipartData & { thumbnailFilePath?: string }> => {
  const data: BannerMultipartData & { thumbnailFilePath?: string } = {};

  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'title') data.title = part.value as string;
      if (part.fieldname === 'subtitle') data.subtitle = part.value as string;
      if (part.fieldname === 'description') data.description = part.value as string;
      if (part.fieldname === 'genres') data.genres = parseList(part.value);
      if (part.fieldname === 'languages') data.languages = parseList(part.value);
      if (part.fieldname === 'position') data.position = Number(part.value);
      if (part.fieldname === 'isActive') data.isActive = parseBool(part.value, true);
      if (part.fieldname === 'ctaText') data.ctaText = part.value as string;
      if (part.fieldname === 'ctaLink') data.ctaLink = part.value as string;
      if (part.fieldname === 'targetPlatforms') data.targetPlatforms = parsePlatforms(part.value);
      if (part.fieldname === 'startDate') data.startDate = parseDate(part.value);
      if (part.fieldname === 'endDate') data.endDate = parseDate(part.value);
      if (part.fieldname === 'thumbnail') data.thumbnail = part.value as string;
      if (part.fieldname === 'bannerImage') data.thumbnail = part.value as string;
      if (part.fieldname === 'contentId') data.contentId = part.value as string;
    } else if (part.type === 'file') {
      if (part.fieldname === 'thumbnailFile' || part.fieldname === 'bannerFile') {
        const uploadedFile = await uploadHandler.saveFileFromPart(part, request as any, 'BANNER');
        data.thumbnail = uploadedFile.url;
        data.thumbnailFilePath = uploadedFile.filePath;
      }
    }
  }

  return data;
};

export const listBanners = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await resequenceBanners();
    const query = request.query as {
      page?: string;
      limit?: string;
      platform?: 'web' | 'mobile' | 'tv';
      admin?: string;
    };
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const now = new Date();
    const isAdminView = parseBool(query.admin, false);
    const filter: any = isAdminView
      ? {}
      : {
          isActive: true,
          $and: [
            { $or: [{ startDate: { $exists: false } }, { startDate: { $lte: now } }] },
            { $or: [{ endDate: { $exists: false } }, { endDate: { $gte: now } }] },
          ],
        };

    if (query.platform) {
      filter.targetPlatforms = query.platform;
    }

    const [bannersRaw, total] = await Promise.all([
      BannerModel.find(filter)
        .sort({ position: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      BannerModel.countDocuments(filter),
    ]);

    const banners = await populateBannersContent(bannersRaw);

    return {
      success: true,
      data: banners.map((banner: any) => mapBanner(banner)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  } catch (error: any) {
    console.error('Error listing banners:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const createBannerFromContent = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      contentId: string;
      contentSource?: 'movie';
      title?: string;
      subtitle?: string;
      description?: string;
      ctaText?: string;
      ctaLink?: string;
      position?: number;
      isActive?: boolean;
    };

    if (!body.contentId) {
      return reply.status(400).send({ success: false, message: 'contentId is required' });
    }

    // Fetch the source movie
    const source: any = await MovieModel.findById(body.contentId).lean();

    if (!source) {
      return reply.status(404).send({ success: false, message: 'Source content not found' });
    }

    // Check if a banner already exists for this content
    const existing = await BannerModel.findOne({ contentId: body.contentId });
    if (existing) {
      return reply.status(409).send({
        success: false,
        message: 'A banner for this content already exists. Please edit the existing banner instead.',
      });
    }

    const thumbnail = source.thumbnail || source.bannerImage || source.imageUrl || ensureDefaultBannerImage();
    const title = body.title || source.title;

    const banner = await BannerModel.create({
      title,
      subtitle: body.subtitle || source.shortDescription || '',
      description: body.description || source.description || '',
      imageUrl: thumbnail,
      ctaText: body.ctaText || 'Watch Now',
      ctaLink: body.ctaLink || '',
      contentId: body.contentId,
      type: 'hero',
      position: Number.isFinite(body.position) ? body.position : 0,
      isActive: body.isActive ?? true,
      targetPlatforms: ['web', 'mobile'],
    });

    await resequenceBanners(banner._id.toString(), banner.position);

    return reply.status(201).send({
      success: true,
      data: {
        id: banner._id,
        title: banner.title,
        subtitle: banner.subtitle,
        description: banner.description,
        imageUrl: banner.imageUrl,
        position: banner.position,
        isActive: banner.isActive,
        contentId: banner.contentId,
      },
      message: 'Banner created successfully from existing content.',
    });
  } catch (error: any) {
    console.error('Error creating banner from content:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const createBanner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const data = await readBannerMultipart(request);

    if (!data.title) {
      return reply.status(400).send({
        success: false,
        message: 'title is required',
      });
    }

    // If a movie is linked, make sure it exists
    if (data.contentId) {
      const movie = await MovieModel.findById(data.contentId).lean();
      if (!movie) {
        return reply.status(404).send({ success: false, message: 'Linked movie not found' });
      }
    }

    const thumbnail = data.thumbnail || ensureDefaultBannerImage();

    const banner = await BannerModel.create({
      title: data.title,
      subtitle: data.subtitle,
      description: data.description,
      imageUrl: thumbnail,
      ctaText: data.ctaText || 'Watch Now',
      ctaLink: data.ctaLink,
      contentId: data.contentId || undefined,
      type: 'hero',
      position: Number.isFinite(data.position) ? data.position : 0,
      isActive: data.isActive ?? true,
      targetPlatforms: data.targetPlatforms?.length ? data.targetPlatforms : ['web', 'mobile'],
      startDate: data.startDate,
      endDate: data.endDate,
    });

    await resequenceBanners(banner._id.toString(), banner.position);

    const bannerRaw = await BannerModel.findById(banner._id).lean();
    const populated = await populateBannersContent([bannerRaw]);

    return reply.status(201).send({
      success: true,
      data: mapBanner(populated[0]),
      message: 'Banner created successfully.',
    });
  } catch (error: any) {
    console.error('Error creating banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const getBannerById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { bannerId } = request.params as { bannerId: string };
    const bannerRaw = await BannerModel.findById(bannerId).lean();

    if (!bannerRaw) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    const populated = await populateBannersContent([bannerRaw]);
    const banner = populated[0];

    return {
      success: true,
      data: mapBanner(banner),
    };
  } catch (error: any) {
    console.error('Error getting banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const updateBanner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { bannerId } = request.params as { bannerId: string };
    const existingBanner = await BannerModel.findById(bannerId);

    if (!existingBanner) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    const existingContent = existingBanner.contentId
      ? await MovieModel.findById(existingBanner.contentId).lean()
      : null;
    const data = await readBannerMultipart(request);
    const updateData: Record<string, any> = {};

    if (data.title !== undefined) updateData.title = data.title;
    if (data.subtitle !== undefined) updateData.subtitle = data.subtitle;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.position !== undefined && Number.isFinite(data.position)) updateData.position = data.position;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.ctaText !== undefined) updateData.ctaText = data.ctaText;
    if (data.ctaLink !== undefined) updateData.ctaLink = data.ctaLink;
    if (data.thumbnail !== undefined) updateData.imageUrl = data.thumbnail;
    if (data.targetPlatforms?.length) updateData.targetPlatforms = data.targetPlatforms;
    if (data.startDate !== undefined) updateData.startDate = data.startDate;
    if (data.endDate !== undefined) updateData.endDate = data.endDate;

    const updatedBannerDoc = await BannerModel.findByIdAndUpdate(bannerId, { $set: updateData }, { new: true });

    if (!updatedBannerDoc) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    await resequenceBanners(updatedBannerDoc._id.toString(), updatedBannerDoc.position);

    if (existingBanner.contentId) {
      const contentUpdate: Record<string, any> = {};
      if (data.title !== undefined) contentUpdate.title = data.title;
      if (data.subtitle !== undefined) contentUpdate.shortDescription = data.subtitle;
      if (data.description !== undefined) contentUpdate.description = data.description;
      if (data.thumbnail !== undefined) {
        contentUpdate.thumbnail = data.thumbnail;
        contentUpdate.bannerImage = data.thumbnail;
      }
      if (data.genres !== undefined) contentUpdate.genres = data.genres;
      if (data.languages?.length) contentUpdate.languages = data.languages;

      if (Object.keys(contentUpdate).length > 0) {
        await MovieModel.findByIdAndUpdate(existingBanner.contentId, { $set: contentUpdate });
      }
    }

    if (data.thumbnail && existingBanner.imageUrl !== data.thumbnail) {
      await uploadHandler.deleteUploadedFile(existingBanner.imageUrl);
    }

    if (data.thumbnail && existingContent?.thumbnail && existingContent.thumbnail !== data.thumbnail) {
      await uploadHandler.deleteUploadedFile(existingContent.thumbnail);
    }

    const bannerRaw = await BannerModel.findById(bannerId).lean();
    if (!bannerRaw) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }
    const populated = await populateBannersContent([bannerRaw]);
    const banner = populated[0];

    return {
      success: true,
      data: mapBanner(banner),
      message: 'Banner updated successfully',
    };
  } catch (error: any) {
    console.error('Error updating banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const deleteBanner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { bannerId } = request.params as { bannerId: string };
    const banner = await BannerModel.findByIdAndDelete(bannerId).lean();

    if (!banner) {
      return reply.status(404).send({ success: false, message: 'Banner not found' });
    }

    if (banner.imageUrl) {
      await uploadHandler.deleteUploadedFile(banner.imageUrl);
    }

    await resequenceBanners();

    return {
      success: true,
      message: 'Banner deleted successfully',
    };
  } catch (error: any) {
    console.error('Error deleting banner:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const bulkDeleteBanners = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }

    const banners = await BannerModel.find({ _id: { $in: ids } }).lean();

    for (const banner of banners) {
      if (banner.imageUrl) {
        await uploadHandler.deleteUploadedFile(banner.imageUrl);
      }
    }

    const result = await BannerModel.deleteMany({ _id: { $in: ids } });

    await resequenceBanners();

    return reply.send({
      success: true,
      message: `${result.deletedCount} banner(s) deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    console.error('Error bulk deleting banners:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
