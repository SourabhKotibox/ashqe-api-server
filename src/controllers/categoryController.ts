import type { FastifyRequest, FastifyReply } from 'fastify';
import { CategoryModel } from '../models/Category';
import uploadHandler from '../lib/uploadHandler';

type CategoryMultipartData = {
  name?: string;
  slug?: string;
  description?: string;
  thumbnail?: string;
  bannerImage?: string;
  icon?: string;
  color?: string;
  isActive?: boolean;
  isFeatured?: boolean;
  order?: number;
  parentCategory?: string;
  thumbnailFile?: any;
  bannerFile?: any;
  iconFile?: any;
};

const readCategoryMultipart = async (request: FastifyRequest): Promise<CategoryMultipartData> => {
  const data: CategoryMultipartData = {};

  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'name') data.name = part.value as string;
      if (part.fieldname === 'slug') data.slug = part.value as string;
      if (part.fieldname === 'description') data.description = part.value as string;
      if (part.fieldname === 'thumbnail') data.thumbnail = part.value as string;
      if (part.fieldname === 'bannerImage') data.bannerImage = part.value as string;
      if (part.fieldname === 'icon') data.icon = part.value as string;
      if (part.fieldname === 'color') data.color = part.value as string;
      if (part.fieldname === 'isActive') data.isActive = part.value === 'true';
      if (part.fieldname === 'isFeatured') data.isFeatured = part.value === 'true';
      if (part.fieldname === 'order') data.order = parseInt(part.value as string, 10);
      if (part.fieldname === 'parentCategory') data.parentCategory = part.value as string;
    } else if (part.type === 'file') {
      if (part.fieldname === 'thumbnailFile') {
        data.thumbnailFile = part;
      }
      if (part.fieldname === 'bannerFile') {
        data.bannerFile = part;
      }
      if (part.fieldname === 'iconFile') {
        data.iconFile = part;
      }
    }
  }

  console.log("readCategoryMultipart returning data: ", data);
  return data;
};

export const listCategories = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      admin?: string;
    };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const isAdminView = query.admin === 'true';

    const filter: any = isAdminView ? {} : { isActive: true };

    const [categories, total] = await Promise.all([
      CategoryModel.find(filter)
        .sort({ order: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CategoryModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: categories.map((category: any) => ({
        id: category._id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        thumbnail: category.thumbnail,
        bannerImage: category.bannerImage,
        icon: category.icon,
        color: category.color,
        contentCount: category.contentCount,
        isActive: category.isActive,
        isFeatured: category.isFeatured,
        order: category.order,
        parentCategory: category.parentCategory,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getCategoryById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { categoryId } = request.params as { categoryId: string };
    const category = await CategoryModel.findById(categoryId).lean();

    if (!category) {
      return reply.status(404).send({ success: false, error: 'Category not found' });
    }

    return reply.send({
      success: true,
      data: {
        id: category._id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        thumbnail: category.thumbnail,
        bannerImage: category.bannerImage,
        icon: category.icon,
        color: category.color,
        contentCount: category.contentCount,
        isActive: category.isActive,
        isFeatured: category.isFeatured,
        order: category.order,
        parentCategory: category.parentCategory,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createCategory = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    console.log("createCategory called!");
    const data = await readCategoryMultipart(request);
    console.log("Received data: ", data);

    if (!data.name) {
      return reply.status(400).send({ success: false, error: "Name is required" });
    }

    // Generate slug from name if not provided
    const slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    // Handle file uploads
    let thumbnail = data.thumbnail;
    let bannerImage = data.bannerImage;
    let icon = data.icon;

    if (data.thumbnailFile) {
      const uploadedFile = await uploadHandler.saveFileFromPart(data.thumbnailFile, request, 'CATEGORY_THUMBNAIL');
      thumbnail = uploadedFile.filePath;
    }
    if (data.bannerFile) {
      const uploadedFile = await uploadHandler.saveFileFromPart(data.bannerFile, request, 'CATEGORY_BANNER');
      bannerImage = uploadedFile.filePath;
    }
    if (data.iconFile) {
      const uploadedFile = await uploadHandler.saveFileFromPart(data.iconFile, request, 'CATEGORY_ICON');
      icon = uploadedFile.filePath;
    }

    const category = await CategoryModel.create({
      name: data.name,
      slug,
      description: data.description,
      thumbnail,
      bannerImage,
      icon,
      color: data.color || '#e50914',
      isActive: parseBool(data.isActive, true),
      isFeatured: parseBool(data.isFeatured, false),
      order: data.order || 0,
      parentCategory: data.parentCategory,
    });

    return reply.status(201).send({
      success: true,
      data: {
        id: category._id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        thumbnail: category.thumbnail,
        bannerImage: category.bannerImage,
        icon: category.icon,
        color: category.color,
        contentCount: category.contentCount,
        isActive: category.isActive,
        isFeatured: category.isFeatured,
        order: category.order,
        parentCategory: category.parentCategory,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateCategory = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { categoryId } = request.params as { categoryId: string };
    const data = await readCategoryMultipart(request);

    const existingCategory = await CategoryModel.findById(categoryId).lean();
    if (!existingCategory) {
      return reply.status(404).send({ success: false, error: 'Category not found' });
    }

    // Handle file uploads
    let thumbnail = data.thumbnail;
    let bannerImage = data.bannerImage;
    let icon = data.icon;

    if (data.thumbnailFile) {
      if (existingCategory.thumbnail) {
        uploadHandler.deleteUploadedFile(existingCategory.thumbnail);
      }
      const uploadedFile = await uploadHandler.saveFileFromPart(data.thumbnailFile, request, 'CATEGORY_THUMBNAIL');
      thumbnail = uploadedFile.filePath;
    }
    if (data.bannerFile) {
      if (existingCategory.bannerImage) {
        uploadHandler.deleteUploadedFile(existingCategory.bannerImage);
      }
      const uploadedFile = await uploadHandler.saveFileFromPart(data.bannerFile, request, 'CATEGORY_BANNER');
      bannerImage = uploadedFile.filePath;
    }
    if (data.iconFile) {
      if (existingCategory.icon) {
        uploadHandler.deleteUploadedFile(existingCategory.icon);
      }
      const uploadedFile = await uploadHandler.saveFileFromPart(data.iconFile, request, 'CATEGORY_ICON');
      icon = uploadedFile.filePath;
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.slug !== undefined) updateData.slug = data.slug;
    if (data.description !== undefined) updateData.description = data.description;
    if (thumbnail !== undefined) updateData.thumbnail = thumbnail;
    if (bannerImage !== undefined) updateData.bannerImage = bannerImage;
    if (icon !== undefined) updateData.icon = icon;
    if (data.color !== undefined) updateData.color = data.color;
    if (data.isActive !== undefined) updateData.isActive = parseBool(data.isActive, true);
    if (data.isFeatured !== undefined) updateData.isFeatured = parseBool(data.isFeatured, false);
    if (data.order !== undefined) updateData.order = data.order || 0;
    if (data.parentCategory !== undefined) updateData.parentCategory = data.parentCategory;

    const category = await CategoryModel.findByIdAndUpdate(
      categoryId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).lean();

    if (!category) {
      return reply.status(404).send({ success: false, error: 'Category not found' });
    }

    return reply.send({
      success: true,
      data: {
        id: category._id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        thumbnail: category.thumbnail,
        bannerImage: category.bannerImage,
        icon: category.icon,
        color: category.color,
        contentCount: category.contentCount,
        isActive: category.isActive,
        isFeatured: category.isFeatured,
        order: category.order,
        parentCategory: category.parentCategory,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteCategory = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { categoryId } = request.params as { categoryId: string };
    const category = await CategoryModel.findByIdAndDelete(categoryId);

    if (!category) {
      return reply.status(404).send({ success: false, error: 'Category not found' });
    }

    // Delete associated files
    if (category.thumbnail) uploadHandler.deleteUploadedFile(category.thumbnail);
    if (category.bannerImage) uploadHandler.deleteUploadedFile(category.bannerImage);
    if (category.icon) uploadHandler.deleteUploadedFile(category.icon);

    return reply.send({ success: true, message: 'Category deleted successfully' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteCategories = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, error: 'Invalid or empty ids array' });
    }

    // Get all categories to delete files
    const categories = await CategoryModel.find({ _id: { $in: ids } });
    for (const category of categories) {
      if (category.thumbnail) uploadHandler.deleteUploadedFile(category.thumbnail);
      if (category.bannerImage) uploadHandler.deleteUploadedFile(category.bannerImage);
      if (category.icon) uploadHandler.deleteUploadedFile(category.icon);
    }

    const result = await CategoryModel.deleteMany({ _id: { $in: ids } });

    return reply.send({
      success: true,
      message: `${result.deletedCount} categories deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

const parseBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 'yes';
};
