import type { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Types } from 'mongoose';
import { CreatorApplicationModel } from '../models/CreatorApplication';
import { AdminUserModel } from '../models/AdminUser';
import { AdminNotificationModel } from '../models/AdminNotification';
import { sendCreatorApplicationRejectedEmail, sendCreatorWelcomeEmail } from '../lib/email';
import { CREATOR_MODULE_PERMISSIONS } from '../lib/creatorAccess';
import { consumeRateLimit, creatorApplyLimits, creatorStatusLimits } from '../lib/rateLimit';
import { logger } from '../lib/logger';

const applySchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(7).max(20),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  channelName: z.string().trim().max(120).optional(),
  contentTypes: z.array(z.enum(['movie', 'webseries'])).min(1, 'Select at least one content type'),
  sampleLinks: z.array(z.string().trim().max(500)).max(10).optional(),
  portfolioSummary: z.string().trim().min(1).max(5000),
  copyrightAttested: z.literal(true, { message: 'You must confirm you own the rights to the content you will upload' } as any),
  website: z.string().optional(),
});

const BLOCKING_STATUSES = ['pending', 'under_review', 'approved'] as const;

const clientIp = (request: FastifyRequest) => request.ip || request.headers['x-forwarded-for']?.toString() || 'unknown';

const tooMany = (reply: FastifyReply, retryAfterSec: number) =>
  reply.status(429).send({
    success: false,
    message: 'Too many requests. Please try again later.',
    retryAfterSec,
  });

const validationError = (reply: FastifyReply, error: z.ZodError) =>
  reply.status(400).send({
    success: false,
    message: 'Validation failed',
    errors: error.flatten().fieldErrors,
  });

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const generateTemporaryPassword = (length = 16) => {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let i = 0; i < length; i++) password += charset[bytes[i] % charset.length];
  return password;
};

const publicApplication = (app: any) => ({
  ...app,
  id: app._id?.toString(),
  applicationId: app._id?.toString(),
});

/** POST /api/public/creator/apply */
export const applyAsCreator = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const limits = creatorApplyLimits();
    const ip = clientIp(request);
    const ipHit = consumeRateLimit(`creator-apply:ip:${ip}`, limits.ipLimit, limits.ipWindowMs);
    if (!ipHit.ok) return tooMany(reply, ipHit.retryAfterSec);

    const parsed = applySchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(reply, parsed.error);

    if (parsed.data.website && parsed.data.website.trim()) {
      return reply.status(400).send({ success: false, message: 'Unable to submit application' });
    }

    const email = parsed.data.email.toLowerCase().trim();
    const emailHit = consumeRateLimit(`creator-apply:email:${email}`, limits.emailLimit, limits.emailWindowMs);
    if (!emailHit.ok) return tooMany(reply, emailHit.retryAfterSec);

    const duplicate = await CreatorApplicationModel.findOne({
      email,
      status: { $in: [...BLOCKING_STATUSES] },
    })
      .select('_id status')
      .lean();
    if (duplicate) {
      return reply.status(409).send({
        success: false,
        message: 'An application for this email is already pending, under review, or approved.',
      });
    }

    const application = await CreatorApplicationModel.create({
      fullName: parsed.data.fullName,
      email,
      phone: parsed.data.phone,
      city: parsed.data.city,
      state: parsed.data.state,
      channelName: parsed.data.channelName,
      contentTypes: parsed.data.contentTypes,
      sampleLinks: parsed.data.sampleLinks || [],
      portfolioSummary: parsed.data.portfolioSummary,
      copyrightAttested: true,
      copyrightAttestedAt: new Date(),
      status: 'pending',
      ipAddress: ip,
      userAgent: String(request.headers['user-agent'] || ''),
    });

    try {
      await AdminNotificationModel.create({
        title: 'New creator application',
        message: `${application.fullName} (${application.email}) applied to become a creator`,
        type: 'system',
        modelName: 'CreatorApplication',
        action: 'created',
      });
    } catch (err) {
      logger.error({ err }, 'Failed to notify admins of creator application');
    }

    return reply.status(201).send({
      success: true,
      message: 'Application submitted. We will review it and email you when a decision is made.',
      data: {
        applicationId: application._id.toString(),
        status: 'pending' as const,
        submittedAt: application.createdAt,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Error submitting creator application');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/public/creator/status?email= */
export const getCreatorApplicationStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const limits = creatorStatusLimits();
    const ip = clientIp(request);
    const ipHit = consumeRateLimit(`creator-status:ip:${ip}`, limits.ipLimit, limits.ipWindowMs);
    if (!ipHit.ok) return tooMany(reply, ipHit.retryAfterSec);

    const emailRaw = String((request.query as { email?: string })?.email || '').trim().toLowerCase();
    if (!emailRaw || !z.string().email().safeParse(emailRaw).success) {
      return reply.status(400).send({ success: false, message: 'A valid email is required' });
    }

    const emailHit = consumeRateLimit(`creator-status:email:${emailRaw}`, limits.emailLimit, limits.emailWindowMs);
    if (!emailHit.ok) return tooMany(reply, emailHit.retryAfterSec);

    const application = await CreatorApplicationModel.findOne({ email: emailRaw })
      .sort({ createdAt: -1 })
      .select('status createdAt reviewedAt rejectionReason')
      .lean();

    if (!application) {
      return reply.send({ success: true, data: { found: false } });
    }

    const data: Record<string, unknown> = {
      found: true,
      status: application.status,
      submittedAt: application.createdAt,
    };
    if (application.reviewedAt) data.reviewedAt = application.reviewedAt;
    if (application.status === 'rejected' && application.rejectionReason) {
      data.rejectionReason = application.rejectionReason;
    }

    return reply.send({ success: true, data });
  } catch (error: any) {
    logger.error({ error }, 'Error reading creator application status');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/admin/creator-applications */
export const listCreatorApplications = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { status?: string; search?: string; page?: string; limit?: string };
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (query.status && ['pending', 'under_review', 'approved', 'rejected'].includes(query.status)) {
      filter.status = query.status;
    }
    if (query.search && query.search.trim()) {
      const term = new RegExp(escapeRegex(query.search.trim()), 'i');
      filter.$or = [{ fullName: term }, { email: term }, { channelName: term }, { phone: term }, { city: term }];
    }

    const [rows, total, grouped] = await Promise.all([
      CreatorApplicationModel.find(filter)
        .populate('reviewedBy', 'name email')
        .populate('adminUserId', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CreatorApplicationModel.countDocuments(filter),
      CreatorApplicationModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    const counts = { pending: 0, under_review: 0, approved: 0, rejected: 0 };
    for (const row of grouped) {
      if (row._id && row._id in counts) (counts as any)[row._id] = row.count;
    }

    return reply.send({
      success: true,
      data: rows.map(publicApplication),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      counts,
    });
  } catch (error: any) {
    logger.error({ error }, 'Error listing creator applications');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/admin/creator-applications/:id */
export const getCreatorApplication = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(404).send({ success: false, message: 'Application not found' });
    }
    const application = await CreatorApplicationModel.findById(id)
      .populate('reviewedBy', 'name email')
      .populate('adminUserId', 'name email role')
      .lean();
    if (!application) return reply.status(404).send({ success: false, message: 'Application not found' });
    return reply.send({ success: true, data: publicApplication(application) });
  } catch (error: any) {
    logger.error({ error }, 'Error getting creator application');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** POST /api/admin/creator-applications/:id/approve */
export const approveCreatorApplication = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const notes = String((request.body as { notes?: string } | undefined)?.notes || '').trim();
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(404).send({ success: false, message: 'Application not found' });
    }

    const application = await CreatorApplicationModel.findById(id);
    if (!application) return reply.status(404).send({ success: false, message: 'Application not found' });
    if (application.status === 'approved' || application.adminUserId) {
      return reply.status(409).send({ success: false, message: 'This application has already been approved.' });
    }

    const email = application.email.toLowerCase().trim();
    const existingUser = await AdminUserModel.findOne({ email }).select('_id email').lean();
    if (existingUser) {
      return reply.status(409).send({
        success: false,
        message: 'An admin account with this email already exists. Resolve the collision before approving.',
      });
    }

    const reviewerId = (request as any).adminUser?._id || (request as any).user?.id;
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    // No per-creator revenue row is written here. Until a super admin sets an
    // override, this creator earns at the global default watch-hour rate.
    const adminUser = await AdminUserModel.create({
      email,
      name: application.fullName,
      passwordHash,
      role: 'influencer',
      phone: application.phone,
      isActive: true,
      mustChangePassword: true,
      modulePermissions: CREATOR_MODULE_PERMISSIONS,
      createdBy: reviewerId,
    });

    application.status = 'approved';
    application.adminUserId = adminUser._id;
    application.reviewedBy = reviewerId;
    application.reviewedAt = new Date();
    if (notes) application.adminNotes = notes;
    await application.save();

    const emailSent = await sendCreatorWelcomeEmail(email, application.fullName, temporaryPassword);

    const fresh = await CreatorApplicationModel.findById(application._id)
      .populate('reviewedBy', 'name email')
      .populate('adminUserId', 'name email role')
      .lean();

    return reply.send({
      success: true,
      message: emailSent
        ? 'Creator approved and login credentials emailed.'
        : 'Creator approved. Email could not be sent — share the temporary password securely.',
      data: {
        application: publicApplication(fresh),
        adminUser: {
          id: adminUser._id.toString(),
          name: adminUser.name,
          email: adminUser.email,
          role: adminUser.role,
        },
        temporaryPassword,
        emailSent,
      },
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return reply.status(409).send({
        success: false,
        message: 'An admin account with this email already exists. Resolve the collision before approving.',
      });
    }
    logger.error({ error }, 'Error approving creator application');
    return reply.status(500).send({ success: false, message: error.message });
  }
};

const rejectSchema = z.object({
  rejectionReason: z.string().trim().min(1, 'A rejection reason is required').max(2000),
});

/** POST /api/admin/creator-applications/:id/reject */
export const rejectCreatorApplication = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(404).send({ success: false, message: 'Application not found' });
    }
    const parsed = rejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(reply, parsed.error);

    const application = await CreatorApplicationModel.findById(id);
    if (!application) return reply.status(404).send({ success: false, message: 'Application not found' });
    if (application.status === 'approved') {
      return reply.status(409).send({ success: false, message: 'An approved application cannot be rejected.' });
    }

    const reviewerId = (request as any).adminUser?._id || (request as any).user?.id;
    application.status = 'rejected';
    application.rejectionReason = parsed.data.rejectionReason;
    application.reviewedBy = reviewerId;
    application.reviewedAt = new Date();
    await application.save();

    await sendCreatorApplicationRejectedEmail(application.email, application.fullName, parsed.data.rejectionReason);

    const fresh = await CreatorApplicationModel.findById(application._id)
      .populate('reviewedBy', 'name email')
      .lean();

    return reply.send({
      success: true,
      message: 'Application rejected.',
      data: publicApplication(fresh),
    });
  } catch (error: any) {
    logger.error({ error }, 'Error rejecting creator application');
    return reply.status(500).send({ success: false, message: error.message });
  }
};
