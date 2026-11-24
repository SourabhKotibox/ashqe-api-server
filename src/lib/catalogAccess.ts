import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import {
  blockInfluencerEditorial,
  creatorCatalogLimits,
  isInfluencerRequest,
  requestUserId,
  sameOwner,
} from './creatorAccess';
import { consumeRateLimit } from './rateLimit';

const HEX_ID = /^[a-fA-F0-9]{24}$/;
const CATALOG_ROLES = new Set(['influencer', 'moderator', 'admin', 'superadmin']);

type CatalogModel = {
  modelName: string;
  findOne: (filter: Record<string, unknown>) => { lean: () => Promise<any> };
  find: (filter: Record<string, unknown>) => { select: (fields: string) => { lean: () => Promise<any[]> } };
  countDocuments: (filter: Record<string, unknown>) => Promise<number>;
};

export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const exactNameRegex = (value: string) => new RegExp(`^${escapeRegex(value.trim())}$`, 'i');

export const isMultipartRequest = (request: FastifyRequest) =>
  String(request.headers['content-type'] || '').toLowerCase().includes('multipart/form-data');

/** Logged-in staff or creator. Public catalog lists stay filtered when this is false. */
export const hasCatalogSession = async (request: FastifyRequest): Promise<boolean> => {
  if (!request.headers.authorization) return false;
  try {
    await request.jwtVerify();
    return CATALOG_ROLES.has(String((request.user as { role?: string } | undefined)?.role || ''));
  } catch {
    return false;
  }
};

export const applyCatalogSearch = (
  filter: Record<string, unknown>,
  search: string | undefined,
  fields: string[]
) => {
  const q = String(search || '').trim();
  if (!q || fields.length === 0) return filter;
  const rx = new RegExp(escapeRegex(q), 'i');
  filter.$or = fields.map((field) => ({ [field]: rx }));
  return filter;
};

export const asBool = (value: unknown, fallback: boolean) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value) === 'true';
};

export const invalidCatalogName = (name: unknown): string | null => {
  const value = String(name ?? '').trim();
  if (!value) return 'Name is required';
  if (value.length > 120) return 'Name must be 120 characters or fewer';
  return null;
};

export const catalogCreatedBy = (request: FastifyRequest) => {
  const id = requestUserId(request);
  if (!id || !Types.ObjectId.isValid(id)) return undefined;
  return new Types.ObjectId(id);
};

export async function findCatalogDuplicate(
  model: CatalogModel,
  name: string,
  exceptId?: string,
  extraOr: Record<string, unknown>[] = []
) {
  const filter: Record<string, unknown> = {
    $or: [{ name: exactNameRegex(name) }, ...extraOr],
  };
  if (exceptId && HEX_ID.test(exceptId)) filter._id = { $ne: exceptId };
  return model.findOne(filter).lean();
}

export const sendDuplicate = (
  reply: FastifyReply,
  existing: { _id?: unknown; name?: string; code?: string },
  label: string
) => {
  const existingId = String(existing._id || '');
  const message = `A ${label} with this name already exists`;
  return reply.status(409).send({
    success: false,
    message,
    error: message,
    existingId,
    data: {
      id: existingId,
      name: existing.name,
      ...(existing.code ? { code: existing.code } : {}),
    },
  });
};

/**
 * Creators cannot publish catalog rows or spoof createdBy.
 * Boolean active/status flags are left intact. Staff requests are not blocked.
 * Returns true when a response has already been sent.
 */
export const blockInfluencerCatalogPublish = (
  request: FastifyRequest,
  reply: FastifyReply,
  body: Record<string, any> | undefined
): boolean => {
  if (!body || typeof body !== 'object') return false;
  delete body.createdBy;
  delete body._id;
  delete body.id;
  delete body.createdAt;
  delete body.updatedAt;
  delete body.__v;
  delete body.approvedBy;
  delete body.approvedAt;
  delete body.rejectedBy;
  delete body.rejectedAt;
  if (!isInfluencerRequest(request)) return false;
  if (blockInfluencerEditorial(request, reply, body)) return true;
  if (body.approvalStatus === 'published') {
    reply.status(403).send({
      success: false,
      error: 'Creators cannot publish catalog entries.',
    });
    return true;
  }
  delete body.approvalStatus;
  if (typeof body.status === 'string') delete body.status;
  return false;
};

/** Per-creator hourly create rate and a cap on how many rows of one type they can own. */
export const enforceInfluencerCatalogCreate = async (
  request: FastifyRequest,
  reply: FastifyReply,
  model: CatalogModel
): Promise<boolean> => {
  if (!isInfluencerRequest(request)) return true;
  const userId = requestUserId(request);
  const { createsPerHour, maxPerType } = creatorCatalogLimits();
  const owned = await model.countDocuments({ createdBy: userId });
  if (owned >= maxPerType) {
    reply.status(429).send({
      success: false,
      error: `You can create at most ${maxPerType} ${model.modelName.toLowerCase()} entries.`,
    });
    return false;
  }
  const rate = consumeRateLimit(`catalog:${userId}:${model.modelName}`, createsPerHour, 60 * 60 * 1000);
  if (!rate.ok) {
    reply.header('retry-after', String(rate.retryAfterSec));
    reply.status(429).send({
      success: false,
      error: `Too many new entries. Try again in ${rate.retryAfterSec} seconds.`,
    });
    return false;
  }
  return true;
};

/** Returns true when a 403 has already been sent. Staff are not restricted by ownership. */
export const denyUnlessCatalogOwner = (
  request: FastifyRequest,
  reply: FastifyReply,
  doc: { createdBy?: unknown } | null | undefined
): boolean => {
  if (!isInfluencerRequest(request)) return false;
  if (doc && sameOwner(doc, requestUserId(request))) return false;
  reply.status(403).send({
    success: false,
    error: 'You can only edit or delete entries you created',
  });
  return true;
};

/** Returns true when a 403 has already been sent. */
export const denyBulkUnlessOwned = async (
  request: FastifyRequest,
  reply: FastifyReply,
  model: CatalogModel,
  ids: string[]
): Promise<boolean> => {
  if (!isInfluencerRequest(request)) return false;
  const unique = [...new Set(ids.map((id) => String(id)))];
  if (unique.some((id) => !HEX_ID.test(id))) {
    reply.status(403).send({
      success: false,
      error: 'You can only delete entries you created',
    });
    return true;
  }
  const rows = await model.find({ _id: { $in: unique } }).select('createdBy').lean();
  const userId = requestUserId(request);
  const allOwned = rows.length === unique.length && rows.every((row) => sameOwner(row, userId));
  if (!allOwned) {
    reply.status(403).send({
      success: false,
      error: 'You can only delete entries you created',
    });
    return true;
  }
  return false;
};

export const ownedId = (value: unknown) => (value ? String((value as { _id?: unknown })._id || value) : null);
