import type { FastifyRequest, FastifyReply } from 'fastify';
import { GenreModel } from '../models/Genre';
import { MovieModel } from '../models/Movie';
import uploadHandler from '../lib/uploadHandler';
import {
  applyCatalogSearch,
  asBool,
  blockInfluencerCatalogPublish,
  catalogCreatedBy,
  denyBulkUnlessOwned,
  denyUnlessCatalogOwner,
  enforceInfluencerCatalogCreate,
  findCatalogDuplicate,
  hasCatalogSession,
  invalidCatalogName,
  isMultipartRequest,
  ownedId,
  sendDuplicate,
} from '../lib/catalogAccess';

const readGenreMultipart = async (request: FastifyRequest): Promise<any> => {
  const data: any = {};
  console.log('readGenreMultipart: Starting to read parts');

  for await (const part of request.parts()) {
    console.log('readGenreMultipart: Got part:', part.type, part.fieldname, part.type === 'field' ? part.value : 'file');
    if (part.type === 'field') {
      if (part.fieldname === 'name') data.name = part.value as string;
      if (part.fieldname === 'description') data.description = part.value as string;
      if (part.fieldname === 'active') data.active = part.value === 'true';
      if (part.fieldname === 'image') data.image = part.value as string;
    } else if (part.type === 'file') {
      if (part.fieldname === 'imageFile') {
        const uploadedFile = await uploadHandler.saveFileFromPart(part, request, 'GENRE');
        data.image = uploadedFile.filePath;
      }
    }
  }
  console.log('readGenreMultipart returning data:', data);

  return data;
};

const mapGenre = (genre: any) => ({
  id: genre._id,
  name: genre.name,
  description: genre.description,
  image: genre.image,
  active: genre.active,
  status: genre.status,
  createdBy: ownedId(genre.createdBy),
  createdAt: genre.createdAt,
  updatedAt: genre.updatedAt,
});

export const listGenres = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      admin?: string;
      search?: string;
      q?: string;
    };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '20', 10)));
    const isAdminView = query.admin === 'true';
    const session = await hasCatalogSession(request);

    const filter: any = isAdminView ? {} : { active: true };

    // Public browse stays limited to genres on published movies.
    // Signed-in creators and staff get the full catalog for dropdowns.
    if (!isAdminView && !session) {
      const activeMovieGenres = await MovieModel.distinct('genres', { status: 'published' });
      const activeGenreIds = [...new Set(activeMovieGenres.map(id => id?.toString()).filter(Boolean))];
      filter._id = { $in: activeGenreIds };
    }
    applyCatalogSearch(filter, query.search || query.q, ['name']);

    const [genres, total] = await Promise.all([
      GenreModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      GenreModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: genres.map((genre: any) => mapGenre(genre)),
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

export const getGenreById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { genreId } = request.params as { genreId: string };
    const genre = await GenreModel.findById(genreId).lean();

    if (!genre) {
      return reply.status(404).send({ success: false, error: 'Genre not found' });
    }

    return reply.send({
      success: true,
      data: mapGenre(genre),
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

const readGenreInput = async (request: FastifyRequest) =>
  isMultipartRequest(request) ? readGenreMultipart(request) : { ...((request.body as Record<string, unknown>) || {}) };

export const createGenre = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const data = await readGenreInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const nameError = invalidCatalogName(data.name);
    if (nameError) return reply.status(400).send({ success: false, error: nameError });
    data.name = String(data.name).trim();

    const existing = await findCatalogDuplicate(GenreModel, data.name);
    if (existing) return sendDuplicate(reply, existing, 'genre');
    if (!(await enforceInfluencerCatalogCreate(request, reply, GenreModel))) return;

    const genre = await GenreModel.create({
      name: data.name,
      description: data.description,
      image: data.image,
      active: asBool(data.active, true),
      createdBy: catalogCreatedBy(request),
    });

    return reply.status(201).send({ success: true, data: mapGenre(genre) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateGenre = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { genreId } = request.params as { genreId: string };
    const existingGenre = await GenreModel.findById(genreId);
    if (!existingGenre) {
      return reply.status(404).send({ success: false, error: 'Genre not found' });
    }
    if (denyUnlessCatalogOwner(request, reply, existingGenre)) return;

    const data = await readGenreInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;
    if (data.name !== undefined) {
      const nameError = invalidCatalogName(data.name);
      if (nameError) return reply.status(400).send({ success: false, error: nameError });
      data.name = String(data.name).trim();
      const duplicate = await findCatalogDuplicate(GenreModel, data.name, genreId);
      if (duplicate) return sendDuplicate(reply, duplicate, 'genre');
    }
    if (data.active !== undefined) data.active = asBool(data.active, existingGenre.active);

    if (data.image && existingGenre.image && data.image !== existingGenre.image) {
      await uploadHandler.deleteUploadedFile(existingGenre.image, undefined, { ignoreIds: [genreId] });
    }

    const genre = await GenreModel.findByIdAndUpdate(
      genreId,
      { $set: data },
      { new: true, runValidators: true }
    ).lean();

    return reply.send({ success: true, data: mapGenre(genre) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteGenre = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { genreId } = request.params as { genreId: string };
    const existing = await GenreModel.findById(genreId);
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Genre not found' });
    }
    if (denyUnlessCatalogOwner(request, reply, existing)) return;
    const genre = await GenreModel.findByIdAndDelete(genreId);

    if (!genre) {
      return reply.status(404).send({ success: false, error: 'Genre not found' });
    }

    if (genre.image) {
      await uploadHandler.deleteUploadedFile(genre.image);
    }

    return reply.send({
      success: true,
      message: 'Genre deleted successfully',
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteGenres = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }
    if (await denyBulkUnlessOwned(request, reply, GenreModel, ids)) return;

    const genres = await GenreModel.find({ _id: { $in: ids } }).lean();
    
    for (const genre of genres) {
      if (genre.image) {
        await uploadHandler.deleteUploadedFile(genre.image, undefined, { ignoreIds: ids });
      }
    }

    const result = await GenreModel.deleteMany({ _id: { $in: ids } });

    return reply.send({
      success: true,
      message: `${result.deletedCount} genres deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    console.error('Error bulk deleting genres:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
