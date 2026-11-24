import type { FastifyReply, FastifyRequest } from 'fastify';
import { LanguageModel } from '../models/Language';
import uploadHandler from '../lib/uploadHandler';
import {
  applyCatalogSearch,
  asBool,
  blockInfluencerCatalogPublish,
  catalogCreatedBy,
  denyUnlessCatalogOwner,
  enforceInfluencerCatalogCreate,
  exactNameRegex,
  findCatalogDuplicate,
  hasCatalogSession,
  invalidCatalogName,
  isMultipartRequest,
  ownedId,
  sendDuplicate,
} from '../lib/catalogAccess';

async function getImageUrl(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) return null;
  if (filePath.startsWith('http')) return filePath;
  if (filePath.startsWith('/uploads/')) return filePath;
  return `/uploads/${filePath.replace(/^\//, '')}`;
}

const languageData = async (language: any) => ({
  id: language._id.toString(),
  name: language.name,
  code: language.code,
  image: await getImageUrl(language.image),
  isActive: language.isActive,
  order: language.order,
  createdBy: ownedId(language.createdBy),
  createdAt: language.createdAt,
  updatedAt: language.updatedAt,
});

const readLanguageInput = async (request: FastifyRequest) => {
  if (!isMultipartRequest(request)) return { ...((request.body as Record<string, unknown>) || {}) };
  const data: Record<string, unknown> = {};
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'name') data.name = part.value;
      if (part.fieldname === 'code') data.code = part.value;
      if (part.fieldname === 'image') data.image = part.value;
      if (part.fieldname === 'isActive') data.isActive = part.value;
      if (part.fieldname === 'order') data.order = part.value;
    } else if (part.type === 'file') {
      const uploadedFile = await uploadHandler.saveFileFromPart(part, request, 'LANGUAGE');
      data.image = uploadedFile.filePath;
    }
  }
  return data;
};

export const listLanguages = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { includeSkip?: string; search?: string; q?: string; admin?: string };
    const includeSkip = query.includeSkip === 'true';
    const includeInactive = query.admin === 'true' && (await hasCatalogSession(request));
    const filter: Record<string, unknown> = includeInactive ? {} : { isActive: true };
    applyCatalogSearch(filter, query.search || query.q, ['name', 'code']);

    const languages = await LanguageModel.find(filter).sort({ order: 1, createdAt: -1 }).lean();
    const filteredLanguages = await Promise.all(languages.map((lang) => languageData(lang)));

    const data = includeSkip
      ? [
          {
            id: 'skip',
            name: 'Skip',
            code: 'skip',
            image: null,
            isActive: true,
            order: -1,
            createdBy: null,
            createdAt: null,
            updatedAt: null,
            isSkippable: true,
          },
          ...filteredLanguages,
        ]
      : filteredLanguages;

    return { success: true, data };
  } catch (error: any) {
    console.error('Error in listLanguages:', error);
    return reply.status(500).send({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

export const getLanguage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const language = await LanguageModel.findById(id).lean();
    if (!language) {
      return reply.status(404).send({ success: false, message: 'Language not found' });
    }
    return { success: true, data: await languageData(language) };
  } catch (error) {
    console.error('Error getting language:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};

const duplicateLanguage = (name: string, code: string, exceptId?: string) =>
  findCatalogDuplicate(LanguageModel, name, exceptId, [{ code: exactNameRegex(code) }]);

export const createLanguage = async (request: FastifyRequest, reply: FastifyReply) => {
  let code = '';
  try {
    const data = await readLanguageInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const nameError = invalidCatalogName(data.name);
    if (nameError) return reply.status(400).send({ success: false, message: nameError, error: nameError });
    code = String(data.code || '').trim();
    if (!code) return reply.status(400).send({ success: false, message: 'Name and code are required', error: 'Name and code are required' });
    if (code.length > 12) {
      return reply.status(400).send({ success: false, message: 'Code must be 12 characters or fewer', error: 'Code must be 12 characters or fewer' });
    }

    const name = String(data.name).trim();
    const existing = await duplicateLanguage(name, code);
    if (existing) return sendDuplicate(reply, existing, 'language');
    if (!(await enforceInfluencerCatalogCreate(request, reply, LanguageModel))) return;

    const language = new LanguageModel({
      name,
      code,
      image: data.image,
      isActive: asBool(data.isActive, true),
      order: data.order != null && data.order !== '' ? Number(data.order) : 0,
      createdBy: catalogCreatedBy(request),
    });
    await language.save();

    return reply.status(201).send({ success: true, data: await languageData(language) });
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = code ? await LanguageModel.findOne({ code: exactNameRegex(code) }).lean() : null;
      if (existing) return sendDuplicate(reply, existing, 'language');
    }
    console.error('Error creating language:', error.message, error.stack);
    return reply.status(500).send({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

export const updateLanguage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const existingLang = await LanguageModel.findById(id);
    if (!existingLang) {
      return reply.status(404).send({ success: false, message: 'Language not found' });
    }
    if (denyUnlessCatalogOwner(request, reply, existingLang)) return;

    const data = await readLanguageInput(request);
    if (blockInfluencerCatalogPublish(request, reply, data)) return;

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const nameError = invalidCatalogName(data.name);
      if (nameError) return reply.status(400).send({ success: false, message: nameError, error: nameError });
      updateData.name = String(data.name).trim();
    }
    if (data.code !== undefined) {
      const code = String(data.code).trim();
      if (!code || code.length > 12) {
        return reply.status(400).send({ success: false, message: 'Code must be 12 characters or fewer', error: 'Code must be 12 characters or fewer' });
      }
      updateData.code = code;
    }
    if (data.isActive !== undefined) updateData.isActive = asBool(data.isActive, existingLang.isActive);
    if (data.order !== undefined && data.order !== '') updateData.order = Number(data.order);
    if (data.image !== undefined) updateData.image = data.image;

    const nextName = String(updateData.name || existingLang.name);
    const nextCode = String(updateData.code || existingLang.code);
    const duplicate = await duplicateLanguage(nextName, nextCode, id);
    if (duplicate) return sendDuplicate(reply, duplicate, 'language');

    if (data.image && existingLang.image && data.image !== existingLang.image) {
      await uploadHandler.deleteUploadedFile(existingLang.image, undefined, { ignoreIds: [id] });
    }

    const language = await LanguageModel.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean();
    if (!language) return reply.status(404).send({ success: false, message: 'Language not found' });
    return { success: true, data: await languageData(language) };
  } catch (error: any) {
    console.error('Error updating language:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};

export const deleteLanguage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const language = await LanguageModel.findById(id);
    if (!language) {
      return reply.status(404).send({ success: false, message: 'Language not found' });
    }
    if (denyUnlessCatalogOwner(request, reply, language)) return;

    if (language.image) await uploadHandler.deleteUploadedFile(language.image, undefined, { ignoreIds: [id] });
    await LanguageModel.findByIdAndDelete(id);
    return reply.status(200).send({ success: true, message: 'Language deleted successfully' });
  } catch (error) {
    console.error('Error deleting language:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};
