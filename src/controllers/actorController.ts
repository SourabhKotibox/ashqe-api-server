import type { FastifyRequest, FastifyReply } from 'fastify';
import { ActorModel } from '../models/Actor';
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

const readActorInput = async (request: FastifyRequest) => {
  if (!isMultipartRequest(request)) return { ...((request.body as Record<string, unknown>) || {}) };
  const data: Record<string, unknown> = {};
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (['name', 'designation', 'dateOfBirth', 'birthPlace', 'image'].includes(part.fieldname)) {
        data[part.fieldname] = part.value;
      }
      if (part.fieldname === 'status') data.status = part.value;
    } else if (part.type === 'file' && part.fieldname === 'imageFile') {
      const uploadedFile = await uploadHandler.saveFileFromPart(part, request, 'ACTOR');
      data.image = uploadedFile.filePath;
    }
  }
  return data;
};

const mapActor = (actor: any) => ({
  id: actor._id,
  name: actor.name,
  designation: actor.designation,
  image: actor.image,
  dateOfBirth: actor.dateOfBirth,
  birthPlace: actor.birthPlace,
  status: actor.status,
  approvalStatus: actor.approvalStatus,
  createdBy: ownedId(actor.createdBy),
  createdAt: actor.createdAt,
  updatedAt: actor.updatedAt,
});

export const listActors = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { page?: string; limit?: string; admin?: string; search?: string; q?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '20', 10)));
    const isAdminView = query.admin === 'true';
    const filter: Record<string, unknown> = isAdminView ? {} : { status: true };
    applyCatalogSearch(filter, query.search || query.q, ['name', 'designation']);

    const [actors, total] = await Promise.all([
      ActorModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ActorModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: actors.map((actor) => mapActor(actor)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getActorById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { actorId } = request.params as { actorId: string };
    const actor = await ActorModel.findById(actorId).lean();
    if (!actor) return reply.status(404).send({ success: false, error: 'Actor not found' });
    return reply.send({ success: true, data: mapActor(actor) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

const resolveDesignation = (request: FastifyRequest, data: Record<string, unknown>, fallback: string) => {
  const designation = String(data.designation || '').trim();
  if (designation) return designation.length > 80 ? null : designation;
  if (isInfluencerRequest(request)) return fallback;
  return '';
};

export const createActor = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const data = await readActorInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;
    const nameError = invalidCatalogName(data.name);
    if (nameError) return reply.status(400).send({ success: false, error: nameError });
    const designation = resolveDesignation(request, data, 'Actor');
    if (designation === null) return reply.status(400).send({ success: false, error: 'Designation must be 80 characters or fewer' });
    if (!designation) return reply.status(400).send({ success: false, error: 'Name and designation are required' });
    if (data.dateOfBirth && !parseDate(data.dateOfBirth)) {
      return reply.status(400).send({ success: false, error: 'dateOfBirth is not a valid date' });
    }

    const name = String(data.name).trim();
    const existing = await findCatalogDuplicate(ActorModel, name);
    if (existing) return sendDuplicate(reply, existing, 'actor');
    if (!(await enforceInfluencerCatalogCreate(request, reply, ActorModel))) return;

    const actor = await ActorModel.create({
      name,
      designation,
      image: data.image ? String(data.image) : undefined,
      dateOfBirth: parseDate(data.dateOfBirth),
      birthPlace: data.birthPlace ? String(data.birthPlace).trim() : undefined,
      status: asBool(data.status, true),
      createdBy: catalogCreatedBy(request),
    });

    return reply.status(201).send({ success: true, data: mapActor(actor) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateActor = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { actorId } = request.params as { actorId: string };
    const existingActor = await ActorModel.findById(actorId);
    if (!existingActor) return reply.status(404).send({ success: false, error: 'Actor not found' });
    if (denyUnlessCatalogOwner(request, reply, existingActor)) return;

    const data = await readActorInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const nameError = invalidCatalogName(data.name);
      if (nameError) return reply.status(400).send({ success: false, error: nameError });
      updateData.name = String(data.name).trim();
      const duplicate = await findCatalogDuplicate(ActorModel, String(updateData.name), actorId);
      if (duplicate) return sendDuplicate(reply, duplicate, 'actor');
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
    if (data.status !== undefined) updateData.status = asBool(data.status, existingActor.status);

    if (data.image && existingActor.image && data.image !== existingActor.image) {
      await uploadHandler.deleteUploadedFile(existingActor.image, undefined, { ignoreIds: [actorId] });
    }

    const actor = await ActorModel.findByIdAndUpdate(actorId, { $set: updateData }, { new: true, runValidators: true }).lean();
    return reply.send({ success: true, data: mapActor(actor) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteActor = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { actorId } = request.params as { actorId: string };
    const existing = await ActorModel.findById(actorId);
    if (!existing) return reply.status(404).send({ success: false, error: 'Actor not found' });
    if (denyUnlessCatalogOwner(request, reply, existing)) return;
    const actor = await ActorModel.findByIdAndDelete(actorId);
    if (!actor) return reply.status(404).send({ success: false, error: 'Actor not found' });
    if (actor.image) await uploadHandler.deleteUploadedFile(actor.image);
    return reply.send({ success: true, message: 'Actor deleted successfully' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteActors = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }
    if (await denyBulkUnlessOwned(request, reply, ActorModel, ids)) return;

    const actors = await ActorModel.find({ _id: { $in: ids } });
    for (const actor of actors) {
      if (actor.image) await uploadHandler.deleteUploadedFile(actor.image, undefined, { ignoreIds: ids });
    }
    const result = await ActorModel.deleteMany({ _id: { $in: ids } });
    return {
      success: true,
      message: `${result.deletedCount} actors deleted successfully`,
      deletedCount: result.deletedCount,
    };
  } catch (error: any) {
    console.error('Error bulk deleting actors:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
