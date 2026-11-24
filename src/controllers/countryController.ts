import type { FastifyRequest, FastifyReply } from 'fastify';
import { CountryModel } from '../models/Country';
import {
  applyCatalogSearch,
  asBool,
  blockInfluencerCatalogPublish,
  catalogCreatedBy,
  denyUnlessCatalogOwner,
  enforceInfluencerCatalogCreate,
  exactNameRegex,
  findCatalogDuplicate,
  invalidCatalogName,
  ownedId,
  sendDuplicate,
} from '../lib/catalogAccess';

const mapCountry = (country: any) => ({
  id: country._id,
  name: country.name,
  code: country.code,
  active: country.active,
  createdBy: ownedId(country.createdBy),
  createdAt: country.createdAt,
  updatedAt: country.updatedAt,
});

export const listCountries = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { page?: string; limit?: string; admin?: string; search?: string; q?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '200', 10)));
    const isAdminView = query.admin === 'true';
    const filter: Record<string, unknown> = isAdminView ? {} : { active: true };
    applyCatalogSearch(filter, query.search || query.q, ['name', 'code']);

    const [countries, total] = await Promise.all([
      CountryModel.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CountryModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: countries.map((country) => mapCountry(country)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getCountryById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const country = await CountryModel.findById(id).lean();
    if (!country) return reply.status(404).send({ success: false, error: 'Country not found' });
    return reply.send({ success: true, data: mapCountry(country) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

const duplicateCountry = (name: string, code: string, exceptId?: string) =>
  findCatalogDuplicate(CountryModel, name, exceptId, [{ code: exactNameRegex(code) }]);

export const createCountry = async (request: FastifyRequest, reply: FastifyReply) => {
  let code = '';
  try {
    const data = { ...((request.body as Record<string, unknown>) || {}) };
    if (blockInfluencerCatalogPublish(request, reply, data)) return;
    const nameError = invalidCatalogName(data.name);
    if (nameError) return reply.status(400).send({ success: false, error: nameError });
    code = String(data.code || '').trim().toUpperCase();
    if (!code) return reply.status(400).send({ success: false, error: 'Name and code are required' });
    if (code.length > 8) return reply.status(400).send({ success: false, error: 'Code must be 8 characters or fewer' });

    const name = String(data.name).trim();
    const existing = await duplicateCountry(name, code);
    if (existing) return sendDuplicate(reply, existing, 'country');
    if (!(await enforceInfluencerCatalogCreate(request, reply, CountryModel))) return;

    const country = await CountryModel.create({
      name,
      code,
      active: asBool(data.active, true),
      createdBy: catalogCreatedBy(request),
    });

    return reply.status(201).send({ success: true, data: mapCountry(country) });
  } catch (error: any) {
    if (error?.code === 11000 && code) {
      const existing = await CountryModel.findOne({ code: exactNameRegex(code) }).lean();
      if (existing) return sendDuplicate(reply, existing, 'country');
    }
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateCountry = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const existingCountry = await CountryModel.findById(id);
    if (!existingCountry) return reply.status(404).send({ success: false, error: 'Country not found' });
    if (denyUnlessCatalogOwner(request, reply, existingCountry)) return;

    const data = { ...((request.body as Record<string, unknown>) || {}) };
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const nameError = invalidCatalogName(data.name);
      if (nameError) return reply.status(400).send({ success: false, error: nameError });
      updateData.name = String(data.name).trim();
    }
    if (data.code !== undefined) {
      const code = String(data.code).trim().toUpperCase();
      if (!code || code.length > 8) return reply.status(400).send({ success: false, error: 'Code must be 8 characters or fewer' });
      updateData.code = code;
    }
    if (data.active !== undefined) updateData.active = asBool(data.active, existingCountry.active);

    const nextName = String(updateData.name || existingCountry.name);
    const nextCode = String(updateData.code || existingCountry.code);
    const duplicate = await duplicateCountry(nextName, nextCode, id);
    if (duplicate) return sendDuplicate(reply, duplicate, 'country');

    const country = await CountryModel.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: true }).lean();
    return reply.send({ success: true, data: mapCountry(country) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteCountry = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const existing = await CountryModel.findById(id);
    if (!existing) return reply.status(404).send({ success: false, error: 'Country not found' });
    if (denyUnlessCatalogOwner(request, reply, existing)) return;
    const country = await CountryModel.findByIdAndDelete(id);
    if (!country) return reply.status(404).send({ success: false, error: 'Country not found' });
    return reply.send({ success: true, message: 'Country deleted successfully' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};
