import type { FastifyRequest, FastifyReply } from 'fastify';
import { DirectorModel } from '../models/Director';
import uploadHandler from '../lib/uploadHandler';
import { isInfluencerRequest } from '../lib/creatorAccess';
import {
  applyCatalogSearch,
  asBool,
  blockInfluencerCatalogPublish,
  catalogCreatedBy,
  denyBulkUnlessOwned,
  denyUnlessCatalogOwner,
  enforceInfluencerCatalogCreate,
  findCatalogDuplicate,
  invalidCatalogName,
  isMultipartRequest,
  ownedId,
  sendDuplicate,
} from '../lib/catalogAccess';

const parseDate = (value: unknown): Date | undefined => {
  if (value == null || value === '') return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const readDirectorInput = async (request: FastifyRequest) => {
  if (!isMultipartRequest(request)) return { ...((request.body as Record<string, unknown>) || {}) };
  const data: Record<string, unknown> = {};
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (['name', 'designation', 'dateOfBirth', 'birthPlace', 'image'].includes(part.fieldname)) {
        data[part.fieldname] = part.value;
      }
      if (part.fieldname === 'status') data.status = part.value;
    } else if (part.type === 'file' && part.fieldname === 'imageFile') {
      const uploadedFile = await uploadHandler.saveFileFromPart(part, request, 'DIRECTOR');
      data.image = uploadedFile.filePath;
    }
  }
  return data;
};

const mapDirector = (director: any) => ({
  id: director._id,
  name: director.name,
  designation: director.designation,
  image: director.image,
  dateOfBirth: director.dateOfBirth,
  birthPlace: director.birthPlace,
  status: director.status,
  approvalStatus: director.approvalStatus,
  createdBy: ownedId(director.createdBy),
  createdAt: director.createdAt,
  updatedAt: director.updatedAt,
});

export const listDirectors = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { page?: string; limit?: string; admin?: string; search?: string; q?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '20', 10)));
    const isAdminView = query.admin === 'true';
    const filter: Record<string, unknown> = isAdminView ? {} : { status: true };
    applyCatalogSearch(filter, query.search || query.q, ['name', 'designation']);

    const [directors, total] = await Promise.all([
      DirectorModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      DirectorModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: directors.map((director) => mapDirector(director)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getDirectorById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { directorId } = request.params as { directorId: string };
    const director = await DirectorModel.findById(directorId).lean();
    if (!director) return reply.status(404).send({ success: false, error: 'Director not found' });
    return reply.send({ success: true, data: mapDirector(director) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createDirector = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const data = await readDirectorInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;
    const nameError = invalidCatalogName(data.name);
    if (nameError) return reply.status(400).send({ success: false, error: nameError });
    let designation = String(data.designation || '').trim();
    if (!designation && isInfluencerRequest(request)) designation = 'Director';
    if (!designation) return reply.status(400).send({ success: false, error: 'Name and designation are required' });
    if (designation.length > 80) return reply.status(400).send({ success: false, error: 'Designation must be 80 characters or fewer' });
    if (data.dateOfBirth && !parseDate(data.dateOfBirth)) {
      return reply.status(400).send({ success: false, error: 'dateOfBirth is not a valid date' });
    }

    const name = String(data.name).trim();
    const existing = await findCatalogDuplicate(DirectorModel, name);
    if (existing) return sendDuplicate(reply, existing, 'director');
    if (!(await enforceInfluencerCatalogCreate(request, reply, DirectorModel))) return;

    const director = await DirectorModel.create({
      name,
      designation,
      image: data.image ? String(data.image) : undefined,
      dateOfBirth: parseDate(data.dateOfBirth),
      birthPlace: data.birthPlace ? String(data.birthPlace).trim() : undefined,
      status: asBool(data.status, true),
      createdBy: catalogCreatedBy(request),
    });

    return reply.status(201).send({ success: true, data: mapDirector(director) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateDirector = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { directorId } = request.params as { directorId: string };
    const existingDirector = await DirectorModel.findById(directorId);
    if (!existingDirector) return reply.status(404).send({ success: false, error: 'Director not found' });
    if (denyUnlessCatalogOwner(request, reply, existingDirector)) return;

    const data = await readDirectorInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const nameError = invalidCatalogName(data.name);
      if (nameError) return reply.status(400).send({ success: false, error: nameError });
      updateData.name = String(data.name).trim();
      const duplicate = await findCatalogDuplicate(DirectorModel, String(updateData.name), directorId);
      if (duplicate) return sendDuplicate(reply, duplicate, 'director');
    }
    if (data.designation !== undefined) {
      const designation = String(data.designation).trim();
      if (!designation || designation.length > 80) {
        return reply.status(400).send({ success: false, error: 'Designation must be 80 characters or fewer' });
      }
      updateData.designation = designation;
    }
    if (data.image) updateData.image = data.image;
    if (data.dateOfBirth) {
      const date = parseDate(data.dateOfBirth);
      if (!date) return reply.status(400).send({ success: false, error: 'dateOfBirth is not a valid date' });
      updateData.dateOfBirth = date;
    }
    if (data.birthPlace !== undefined) updateData.birthPlace = String(data.birthPlace).trim();
    if (data.status !== undefined) updateData.status = asBool(data.status, existingDirector.status);

    if (data.image && existingDirector.image && data.image !== existingDirector.image) {
      uploadHandler.deleteUploadedFile(existingDirector.image);
    }

    const director = await DirectorModel.findByIdAndUpdate(
      directorId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).lean();
    return reply.send({ success: true, data: mapDirector(director) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteDirector = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { directorId } = request.params as { directorId: string };
    const existing = await DirectorModel.findById(directorId);
    if (!existing) return reply.status(404).send({ success: false, error: 'Director not found' });
    if (denyUnlessCatalogOwner(request, reply, existing)) return;
    const director = await DirectorModel.findByIdAndDelete(directorId);
    if (!director) return reply.status(404).send({ success: false, error: 'Director not found' });
    if (director.image) uploadHandler.deleteUploadedFile(director.image);
    return reply.send({ success: true, message: 'Director deleted successfully' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteDirectors = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }
    if (await denyBulkUnlessOwned(request, reply, DirectorModel, ids)) return;

    const directors = await DirectorModel.find({ _id: { $in: ids } });
    directors.forEach((director) => {
      if (director.image) uploadHandler.deleteUploadedFile(director.image);
    });
    const result = await DirectorModel.deleteMany({ _id: { $in: ids } });
    return {
      success: true,
      message: `${result.deletedCount} directors deleted successfully`,
      deletedCount: result.deletedCount,
    };
  } catch (error: any) {
    console.error('Error bulk deleting directors:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
