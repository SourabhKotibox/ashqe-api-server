import type { FastifyRequest, FastifyReply } from 'fastify';
import { CrewModel } from '../models/Crew';
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
  ownedId,
  sendDuplicate,
} from '../lib/catalogAccess';

const mapCrew = (crew: any) => ({
  id: crew._id,
  name: crew.name,
  designation: crew.designation,
  image: crew.image,
  status: crew.status,
  approvalStatus: crew.approvalStatus,
  createdBy: ownedId(crew.createdBy),
  createdAt: crew.createdAt,
  updatedAt: crew.updatedAt,
});

export const listCrews = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { page?: string; limit?: string; admin?: string; search?: string; q?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '200', 10)));
    const isAdminView = query.admin === 'true';
    const filter: Record<string, unknown> = isAdminView ? {} : { status: true };
    applyCatalogSearch(filter, query.search || query.q, ['name', 'designation']);

    const [crews, total] = await Promise.all([
      CrewModel.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CrewModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: crews.map((crew) => mapCrew(crew)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getCrewById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const crew = await CrewModel.findById(id).lean();
    if (!crew) return reply.status(404).send({ success: false, error: 'Crew member not found' });
    return reply.send({ success: true, data: mapCrew(crew) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createCrew = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const data = { ...((request.body as Record<string, unknown>) || {}) };
    if (blockInfluencerCatalogPublish(request, reply, data)) return;
    const nameError = invalidCatalogName(data.name);
    if (nameError) return reply.status(400).send({ success: false, error: nameError });
    let designation = String(data.designation || '').trim();
    if (!designation && isInfluencerRequest(request)) designation = 'Crew';
    if (!designation) return reply.status(400).send({ success: false, error: 'Name and designation are required' });
    if (designation.length > 80) return reply.status(400).send({ success: false, error: 'Designation must be 80 characters or fewer' });

    const name = String(data.name).trim();
    const existing = await findCatalogDuplicate(CrewModel, name);
    if (existing) return sendDuplicate(reply, existing, 'crew member');
    if (!(await enforceInfluencerCatalogCreate(request, reply, CrewModel))) return;

    const crew = await CrewModel.create({
      name,
      designation,
      image: data.image ? String(data.image) : undefined,
      status: asBool(data.status, true),
      createdBy: catalogCreatedBy(request),
    });

    return reply.status(201).send({ success: true, data: mapCrew(crew) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateCrew = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const existingCrew = await CrewModel.findById(id);
    if (!existingCrew) return reply.status(404).send({ success: false, error: 'Crew member not found' });
    if (denyUnlessCatalogOwner(request, reply, existingCrew)) return;

    const data = { ...((request.body as Record<string, unknown>) || {}) };
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const nameError = invalidCatalogName(data.name);
      if (nameError) return reply.status(400).send({ success: false, error: nameError });
      updateData.name = String(data.name).trim();
      const duplicate = await findCatalogDuplicate(CrewModel, String(updateData.name), id);
      if (duplicate) return sendDuplicate(reply, duplicate, 'crew member');
    }
    if (data.designation !== undefined) {
      const designation = String(data.designation).trim();
      if (!designation || designation.length > 80) {
        return reply.status(400).send({ success: false, error: 'Designation must be 80 characters or fewer' });
      }
      updateData.designation = designation;
    }
    if (data.image !== undefined) updateData.image = data.image;
    if (data.status !== undefined) updateData.status = asBool(data.status, existingCrew.status);

    const crew = await CrewModel.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: true }).lean();
    return reply.send({ success: true, data: mapCrew(crew) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteCrew = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const existing = await CrewModel.findById(id);
    if (!existing) return reply.status(404).send({ success: false, error: 'Crew member not found' });
    if (denyUnlessCatalogOwner(request, reply, existing)) return;
    const crew = await CrewModel.findByIdAndDelete(id);
    if (!crew) return reply.status(404).send({ success: false, error: 'Crew member not found' });
    return reply.send({ success: true, message: 'Crew member deleted successfully' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteCrews = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }
    if (await denyBulkUnlessOwned(request, reply, CrewModel, ids)) return;

    const result = await CrewModel.deleteMany({ _id: { $in: ids } });
    return reply.send({
      success: true,
      message: `${result.deletedCount} crew member(s) deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
