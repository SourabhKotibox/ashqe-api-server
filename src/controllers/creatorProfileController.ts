import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';
import { isInfluencerRequest, requestUserId } from '../lib/creatorAccess';
import { logger } from '../lib/logger';
import { AdminUserModel } from '../models/AdminUser';
import { CreatorApplicationModel } from '../models/CreatorApplication';

const PLATFORMS = ['instagram', 'youtube', 'facebook', 'x', 'website', 'other'] as const;

const httpUrl = z.string().trim().max(300).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Enter a valid http(s) URL');

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatar: z.string().trim().max(2000).optional(),
  bio: z.string().trim().max(1000).optional(),
  socialLinks: z.array(z.object({
    platform: z.enum(PLATFORMS),
    url: httpUrl,
  })).max(8).optional(),
}).strict();

const safeAvatar = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) return null;
  return trimmed;
};

const applicationFor = (application: any, includeStaffNotes: boolean) => {
  if (!application) return null;
  const profile = {
    id: application._id?.toString(),
    fullName: application.fullName,
    email: application.email,
    phone: application.phone,
    city: application.city || '',
    state: application.state || '',
    channelName: application.channelName || '',
    contentTypes: application.contentTypes || [],
    sampleLinks: application.sampleLinks || [],
    portfolioSummary: application.portfolioSummary || '',
    status: application.status,
    copyrightAttested: !!application.copyrightAttested,
    submittedAt: application.createdAt,
    reviewedAt: application.reviewedAt || null,
  };
  if (!includeStaffNotes) return profile;
  return {
    ...profile,
    rejectionReason: application.rejectionReason || '',
    adminNotes: application.adminNotes || '',
  };
};

const profilePayload = (user: any, application: any, includeStaffNotes: boolean) => ({
  id: user._id?.toString(),
  name: user.name,
  email: user.email,
  phone: user.phone || '',
  avatar: user.avatar || '',
  bio: user.bio || '',
  socialLinks: Array.isArray(user.socialLinks) ? user.socialLinks.map((link: any) => ({
    platform: link.platform,
    url: link.url,
  })) : [],
  role: user.role,
  isActive: user.isActive !== false,
  application: applicationFor(application, includeStaffNotes),
});

const loadApplication = (user: { _id: Types.ObjectId; email?: string }) =>
  CreatorApplicationModel.findOne({
    $or: [{ adminUserId: user._id }, { email: String(user.email || '').toLowerCase() }],
  })
    .sort({ createdAt: -1 })
    .lean();

/** GET /api/creator/profile */
export const getOwnCreatorProfile = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    if (!isInfluencerRequest(request)) {
      return reply.status(403).send({ success: false, error: 'Creator profile is only available to creator accounts' });
    }
    const userId = requestUserId(request);
    if (!Types.ObjectId.isValid(userId)) return reply.status(401).send({ success: false, error: 'Unauthorized' });
    const user = await AdminUserModel.findById(userId).select('-passwordHash').lean();
    if (!user || user.role !== 'influencer') {
      return reply.status(404).send({ success: false, error: 'Creator not found' });
    }
    const application = await loadApplication(user);
    return reply.send({ success: true, data: profilePayload(user, application, false) });
  } catch (error: any) {
    logger.error({ error }, 'Error reading creator profile');
    return reply.status(500).send({ success: false, error: 'Failed to load creator profile' });
  }
};

/** PATCH /api/creator/profile */
export const updateOwnCreatorProfile = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    if (!isInfluencerRequest(request)) {
      return reply.status(403).send({ success: false, error: 'Creator profile is only available to creator accounts' });
    }
    const userId = requestUserId(request);
    if (!Types.ObjectId.isValid(userId)) return reply.status(401).send({ success: false, error: 'Unauthorized' });
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
    }
    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.bio !== undefined) update.bio = parsed.data.bio;
    if (parsed.data.socialLinks !== undefined) update.socialLinks = parsed.data.socialLinks;
    if (parsed.data.avatar !== undefined) {
      const avatar = safeAvatar(parsed.data.avatar);
      if (avatar === null) return reply.status(400).send({ success: false, error: 'Avatar must be an uploaded image URL' });
      update.avatar = avatar;
    }
    const user = await AdminUserModel.findOneAndUpdate(
      { _id: userId, role: 'influencer' },
      { $set: update },
      { new: true }
    ).select('-passwordHash').lean();
    if (!user) return reply.status(404).send({ success: false, error: 'Creator not found' });
    const application = await loadApplication(user);
    return reply.send({ success: true, data: profilePayload(user, application, false) });
  } catch (error: any) {
    logger.error({ error }, 'Error updating creator profile');
    return reply.status(500).send({ success: false, error: 'Failed to update creator profile' });
  }
};

/** GET /api/admin/creators/:id/profile */
export const getCreatorProfileForStaff = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ success: false, error: 'Creator not found' });
    const user = await AdminUserModel.findById(id).select('-passwordHash').lean();
    if (!user || user.role !== 'influencer') {
      return reply.status(404).send({ success: false, error: 'Creator not found' });
    }
    const application = await loadApplication(user);
    return reply.send({ success: true, data: profilePayload(user, application, true) });
  } catch (error: any) {
    logger.error({ error }, 'Error reading creator profile for staff');
    return reply.status(500).send({ success: false, error: 'Failed to load creator profile' });
  }
};
