import type { FastifyRequest, FastifyReply } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';
import { PartnerApplicationModel } from '../models/PartnerApplication';
import { PartnerModel } from '../models/Partner';
import { PartnerCommissionModel } from '../models/PartnerCommission';
import { PartnerPayoutModel } from '../models/PartnerPayout';
import { PartnerProgramSettingsModel, getPartnerProgramSettings } from '../models/PartnerProgramSettings';
import { UserModel } from '../models/User';
import { AdminNotificationModel } from '../models/AdminNotification';
import { sendTemplateEmail } from '../lib/email';
import {
  attachReferral,
  generatePartnerCode,
  getPartnerBalances,
  maskDestination,
  maskName,
  maturePendingCommissions,
  reverseCommissionForPayment,
  round2,
  effectiveRate,
} from '../lib/partnerCommission';

const uid = (request: FastifyRequest) => String((request.user as any)?.id || '');
const siteUrl = () => (process.env.FRONTEND_URL || 'https://ashqe.app').replace(/\/$/, '');
const shareLink = (code: string) => `${siteUrl()}/?ref=${encodeURIComponent(code)}`;
const isId = (v: any) => Types.ObjectId.isValid(String(v || ''));

const notifyEmail = (type: string, to: string | undefined, vars: Record<string, string>) => {
  if (!to || to.endsWith('@temp.local')) return;
  sendTemplateEmail(type, to, { site_url: siteUrl(), ...vars }).catch((e) => console.error('[partner email]', e));
};

/* ─────────────────────────────── USER SIDE ─────────────────────────────── */

const applySchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().trim().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number'),
    email: z.string().trim().email(),
    city: z.string().trim().max(80).optional().default(''),
    state: z.string().trim().max(80).optional().default(''),
    promotionChannels: z.array(z.enum(['social', 'youtube', 'instagram', 'offline', 'other'])).min(1, 'Select at least one channel'),
    promotionDetails: z.string().trim().max(1000).optional().default(''),
    audienceSize: z.string().trim().max(50).optional().default(''),
    socialLinks: z.array(z.string().trim().max(300)).max(10).optional().default([]),
    pan: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
      .optional()
      .or(z.literal('')),
    payoutMethod: z.enum(['upi', 'bank']),
    upiId: z.string().trim().max(100).optional().default(''),
    bankAccountName: z.string().trim().max(100).optional().default(''),
    bankAccountNumber: z.string().trim().max(30).optional().default(''),
    ifsc: z.string().trim().toUpperCase().optional().default(''),
    agreedToTerms: z.literal(true, { message: 'You must accept the partner terms' } as any),
  })
  .superRefine((d, ctx) => {
    if (d.payoutMethod === 'upi' && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(d.upiId || '')) {
      ctx.addIssue({ code: 'custom', path: ['upiId'], message: 'Enter a valid UPI ID' });
    }
    if (d.payoutMethod === 'bank') {
      if (!/^\d{9,18}$/.test(d.bankAccountNumber || '')) ctx.addIssue({ code: 'custom', path: ['bankAccountNumber'], message: 'Enter a valid account number' });
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(d.ifsc || '')) ctx.addIssue({ code: 'custom', path: ['ifsc'], message: 'Enter a valid IFSC' });
      if (!d.bankAccountName) ctx.addIssue({ code: 'custom', path: ['bankAccountName'], message: 'Account holder name is required' });
    }
  });

/** POST /api/app/partner/apply */
export const applyForPartner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userId = uid(request);
    const settings = await getPartnerProgramSettings();
    if (!settings.enabled) return reply.status(403).send({ success: false, message: 'Partner program is currently closed' });

    if (await PartnerModel.exists({ userId })) {
      return reply.status(400).send({ success: false, message: 'You are already a partner' });
    }
    const open = await PartnerApplicationModel.findOne({ userId, status: { $in: ['pending', 'under_review'] } }).lean();
    if (open) return reply.status(400).send({ success: false, message: 'Your application is already under review' });

    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, message: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
    }
    const app = await PartnerApplicationModel.create({ ...parsed.data, pan: parsed.data.pan || undefined, userId, status: 'pending' });

    AdminNotificationModel.create({
      title: 'New partner application',
      message: `${app.fullName} applied to become a partner`,
      type: 'system',
      modelName: 'PartnerApplication',
      action: 'created',
    }).catch(() => {});
    notifyEmail('Partner Application Received', app.email, {
      user_name: app.fullName,
      description_note: `Your application is under review and will be approved within ${settings.reviewSlaHours} hours.`,
    });

    return reply.send({
      success: true,
      message: `Your application is under review and will be approved within ${settings.reviewSlaHours} hours.`,
      data: { id: app._id, status: app.status, createdAt: app.createdAt },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/app/partner/status */
export const getPartnerStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const userId = uid(request);
    const [settings, partner, application, user] = await Promise.all([
      getPartnerProgramSettings(),
      PartnerModel.findOne({ userId }).lean(),
      PartnerApplicationModel.findOne({ userId }).sort({ createdAt: -1 }).lean(),
      UserModel.findById(userId).select('name email phone referredBy createdAt').lean(),
    ]);
    const windowEnds = user ? new Date(new Date(user.createdAt).getTime() + settings.attributionWindowDays * 86400000) : null;
    return reply.send({
      success: true,
      data: {
        programEnabled: settings.enabled,
        defaultCommissionRate: settings.defaultCommissionRate,
        reviewSlaHours: settings.reviewSlaHours,
        minPayout: settings.minPayout,
        holdDays: settings.holdDays,
        isPartner: !!partner,
        partner: partner
          ? { code: partner.code, status: partner.status, shareLink: shareLink(partner.code), commissionRate: effectiveRate(partner, settings.defaultCommissionRate), couponCode: partner.couponCode || null }
          : null,
        application: application
          ? { id: application._id, status: application.status, rejectionReason: application.rejectionReason || null, createdAt: application.createdAt, reviewedAt: application.reviewedAt || null }
          : null,
        prefill: { fullName: user?.name || '', email: user?.email?.endsWith('@temp.local') ? '' : user?.email || '', phone: user?.phone || '' },
        referral: {
          appliedCode: user?.referredBy || null,
          canApplyCode: !user?.referredBy && !!windowEnds && windowEnds.getTime() > Date.now(),
          windowEndsAt: windowEnds,
        },
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** POST /api/app/partner/referral  { code, source? } — attach a referral code to the logged-in user */
export const applyReferralCode = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { code, source } = (request.body || {}) as { code?: string; source?: string };
    const src = source === 'link' ? 'link' : source === 'signup_code' ? 'signup_code' : 'manual_code';
    const result = await attachReferral(uid(request), String(code || ''), src);
    if (!result.ok) return reply.status(400).send({ success: false, message: result.error });
    return reply.send({ success: true, message: 'Referral code applied', data: { code: result.partnerCode } });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/public/partner/:code — validate a referral code (no auth) */
export const validatePartnerCode = async (request: FastifyRequest, reply: FastifyReply) => {
  const code = String((request.params as any).code || '').toUpperCase();
  const partner = await PartnerModel.findOne({ code, status: 'active' }).select('code displayName').lean();
  if (!partner) return reply.status(404).send({ success: false, message: 'Invalid referral code' });
  return reply.send({ success: true, data: { code: partner.code, partnerName: partner.displayName.split(' ')[0] } });
};

async function requirePartner(request: FastifyRequest, reply: FastifyReply) {
  const partner = await PartnerModel.findOne({ userId: uid(request) });
  if (!partner) {
    reply.status(403).send({ success: false, message: 'You are not an approved partner' });
    return null;
  }
  return partner;
}

/** Shared stats builder (used by partner dashboard and admin partner detail). */
export async function buildPartnerStats(partnerId: Types.ObjectId, days = 30) {
  const pid = new Types.ObjectId(String(partnerId));
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setHours(0, 0, 0, 0);
  const [balances, referred, paying, signupsByDay, salesByDay] = await Promise.all([
    getPartnerBalances(pid),
    UserModel.countDocuments({ referredByPartnerId: pid }),
    PartnerCommissionModel.distinct('referredUserId', { partnerId: pid, status: { $ne: 'reversed' } }),
    UserModel.aggregate([
      { $match: { referredByPartnerId: pid, referredAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$referredAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
    ]),
    PartnerCommissionModel.aggregate([
      { $match: { partnerId: pid, status: { $ne: 'reversed' }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
          revenue: { $sum: '$saleAmount' },
          commission: { $sum: '$amount' },
          sales: { $sum: 1 },
        },
      },
    ]),
  ]);
  const sMap = new Map(signupsByDay.map((r: any) => [r._id, r.n]));
  const rMap = new Map(salesByDay.map((r: any) => [r._id, r]));
  const chart: any[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400000);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const r: any = rMap.get(key) || {};
    chart.push({ date: key, signups: sMap.get(key) || 0, revenue: round2(r.revenue || 0), commission: round2(r.commission || 0), sales: r.sales || 0 });
  }
  return {
    usersReferred: referred,
    payingUsers: paying.length,
    conversionRate: referred ? round2((paying.length / referred) * 100) : 0,
    revenueGenerated: balances.revenue,
    salesCount: balances.salesCount,
    commission: {
      earned: balances.earned,
      pending: balances.pending,
      approved: balances.approved + balances.inPayout,
      inPayout: balances.inPayout,
      paid: balances.paid,
      reversed: balances.reversed,
      clawback: balances.clawback,
    },
    availableBalance: balances.available,
    chart,
  };
}

/** GET /api/app/partner/dashboard?days=30 */
export const getPartnerDashboard = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const partner = await requirePartner(request, reply);
    if (!partner) return;
    const settings = await getPartnerProgramSettings();
    const days = Math.min(365, Math.max(7, Number((request.query as any)?.days) || 30));
    const stats = await buildPartnerStats(partner._id as Types.ObjectId, days);
    return reply.send({
      success: true,
      data: {
        partner: {
          code: partner.code,
          displayName: partner.displayName,
          status: partner.status,
          shareLink: shareLink(partner.code),
          commissionRate: effectiveRate(partner, settings.defaultCommissionRate),
          couponCode: partner.couponCode || null,
          payoutMethod: partner.payoutMethod,
          payoutDestination: maskDestination(partner.payoutMethod, partner.upiId, partner.bankAccountNumber),
        },
        program: { minPayout: settings.minPayout, holdDays: settings.holdDays, commissionOnRenewals: settings.commissionOnRenewals },
        stats,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/app/partner/referrals?page&limit */
export const getPartnerReferrals = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const partner = await requirePartner(request, reply);
    if (!partner) return;
    const q = request.query as any;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const filter = { referredByPartnerId: partner._id };
    const [total, users] = await Promise.all([
      UserModel.countDocuments(filter),
      UserModel.find(filter).select('name referredAt createdAt subscriptionStatus subscriptionPlanName').sort({ referredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const ids = users.map((u) => u._id);
    const agg = await PartnerCommissionModel.aggregate([
      { $match: { partnerId: partner._id, referredUserId: { $in: ids }, status: { $ne: 'reversed' } } },
      { $group: { _id: '$referredUserId', spent: { $sum: '$saleAmount' }, earned: { $sum: '$amount' }, purchases: { $sum: 1 } } },
    ]);
    const m = new Map(agg.map((a: any) => [String(a._id), a]));
    return reply.send({
      success: true,
      data: users.map((u: any) => {
        const a: any = m.get(String(u._id)) || {};
        return {
          id: String(u._id).slice(-6),
          name: maskName(u.name),
          joinedAt: u.referredAt || u.createdAt,
          isPaying: (a.purchases || 0) > 0,
          plan: a.purchases ? u.subscriptionPlanName || null : null,
          purchases: a.purchases || 0,
          spent: round2(a.spent || 0),
          commission: round2(a.earned || 0),
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

const commissionView = (c: any, includeUser = false) => ({
  id: c._id,
  ...(includeUser && c.referredUserId && typeof c.referredUserId === 'object'
    ? { user: { id: c.referredUserId._id, name: c.referredUserId.name, email: c.referredUserId.email } }
    : {}),
  userName: c.referredUserId && typeof c.referredUserId === 'object' ? maskName(c.referredUserId.name) : undefined,
  planName: c.planName,
  saleAmount: c.saleAmount,
  baseAmount: c.baseAmount,
  rate: c.rate,
  amount: c.amount,
  isRenewal: c.isRenewal,
  status: c.status,
  holdUntil: c.holdUntil,
  paidAt: c.paidAt,
  reversedAt: c.reversedAt,
  reversalReason: c.reversalReason,
  createdAt: c.createdAt,
  ...(includeUser ? { paymentId: c.paymentId, payoutId: c.payoutId, partnerId: c.partnerId } : {}),
});

/** GET /api/app/partner/commissions?status&page&limit */
export const getPartnerCommissions = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const partner = await requirePartner(request, reply);
    if (!partner) return;
    await maturePendingCommissions(String(partner._id));
    const q = request.query as any;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const filter: any = { partnerId: partner._id };
    if (q.status) filter.status = q.status;
    const [total, rows] = await Promise.all([
      PartnerCommissionModel.countDocuments(filter),
      PartnerCommissionModel.find(filter).populate('referredUserId', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return reply.send({ success: true, data: rows.map((c) => commissionView(c)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** GET /api/app/partner/payouts */
export const getPartnerPayouts = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const partner = await requirePartner(request, reply);
    if (!partner) return;
    const rows = await PartnerPayoutModel.find({ partnerId: partner._id }).select('-commissionIds').sort({ createdAt: -1 }).limit(100).lean();
    return reply.send({ success: true, data: rows });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/** POST /api/app/partner/payouts — request payout of full available balance */
export const requestPartnerPayout = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const partner = await requirePartner(request, reply);
    if (!partner) return;
    if (partner.status !== 'active') return reply.status(403).send({ success: false, message: 'Your partner account is suspended' });
    if (await PartnerPayoutModel.exists({ partnerId: partner._id, status: 'requested' })) {
      return reply.status(400).send({ success: false, message: 'You already have a payout request in progress' });
    }
    const settings = await getPartnerProgramSettings();
    const balances = await getPartnerBalances(partner._id as Types.ObjectId);
    if (balances.available < settings.minPayout) {
      return reply.status(400).send({ success: false, message: `Minimum payout is ₹${settings.minPayout}. Available: ₹${balances.available}` });
    }
    const commissions = await PartnerCommissionModel.find({ partnerId: partner._id, status: 'approved', payoutId: { $exists: false } }).select('_id amount').lean();
    const gross = round2(commissions.reduce((s, c) => s + c.amount, 0));
    const clawback = Math.min(gross, balances.clawback);
    const payout = await PartnerPayoutModel.create({
      partnerId: partner._id,
      amount: round2(gross - clawback),
      commissionIds: commissions.map((c) => c._id),
      clawbackDeducted: clawback,
      method: partner.payoutMethod,
      destination: maskDestination(partner.payoutMethod, partner.upiId, partner.bankAccountNumber),
      status: 'requested',
    });
    await PartnerCommissionModel.updateMany(
      { _id: { $in: commissions.map((c) => c._id) }, payoutId: { $exists: false } },
      { $set: { payoutId: payout._id } }
    );
    AdminNotificationModel.create({ title: 'Partner payout requested', message: `${partner.displayName} requested ₹${payout.amount}`, type: 'system', modelName: 'PartnerPayout', action: 'created' }).catch(() => {});
    return reply.send({ success: true, message: 'Payout requested', data: payout });
  } catch (error: any) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/* ─────────────────────────────── ADMIN SIDE ─────────────────────────────── */

/** GET /api/partners/overview */
export const adminPartnerOverview = async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    await maturePendingCommissions();
    const [apps, partners, referred, comm, payouts] = await Promise.all([
      PartnerApplicationModel.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      PartnerModel.countDocuments({ status: 'active' }),
      UserModel.countDocuments({ referredByPartnerId: { $exists: true, $ne: null } }),
      PartnerCommissionModel.aggregate([{ $group: { _id: '$status', amount: { $sum: '$amount' }, sales: { $sum: '$saleAmount' }, n: { $sum: 1 } } }]),
      PartnerPayoutModel.aggregate([{ $match: { status: 'requested' } }, { $group: { _id: null, amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    ]);
    const a: any = Object.fromEntries(apps.map((x: any) => [x._id, x.n]));
    const c: any = Object.fromEntries(comm.map((x: any) => [x._id, x]));
    const revenue = comm.filter((x: any) => x._id !== 'reversed').reduce((s: number, x: any) => s + x.sales, 0);
    return reply.send({
      success: true,
      data: {
        applications: { pending: a.pending || 0, under_review: a.under_review || 0, approved: a.approved || 0, rejected: a.rejected || 0 },
        activePartners: partners,
        referredUsers: referred,
        revenue: round2(revenue),
        commission: {
          pending: round2(c.pending?.amount || 0),
          approved: round2(c.approved?.amount || 0),
          paid: round2(c.paid?.amount || 0),
          reversed: round2(c.reversed?.amount || 0),
        },
        payoutsRequested: { count: payouts[0]?.n || 0, amount: round2(payouts[0]?.amount || 0) },
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** GET /api/partners/applications?status&search&page&limit */
export const adminListApplications = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const q = request.query as any;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const filter: any = {};
    if (q.status === 'open') filter.status = { $in: ['pending', 'under_review'] };
    else if (q.status && q.status !== 'all') filter.status = q.status;
    if (q.search) {
      const rx = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }, { city: rx }];
    }
    const [total, rows] = await Promise.all([
      PartnerApplicationModel.countDocuments(filter),
      PartnerApplicationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return reply.send({ success: true, data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** PATCH /api/partners/applications/:id  { action: 'review'|'approve'|'reject', reason?, commissionRate?, code? } */
export const adminReviewApplication = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!isId(id)) return reply.status(400).send({ success: false, error: 'Invalid id' });
    const body = (request.body || {}) as { action?: string; reason?: string; commissionRate?: number | null; code?: string; couponCode?: string; couponDiscountPercent?: number };
    const app = await PartnerApplicationModel.findById(id);
    if (!app) return reply.status(404).send({ success: false, error: 'Application not found' });
    if (app.status === 'approved') return reply.status(400).send({ success: false, error: 'Application already approved' });
    const adminId = uid(request);

    if (body.action === 'review') {
      app.status = 'under_review';
      await app.save();
      return reply.send({ success: true, data: app });
    }

    if (body.action === 'reject') {
      if (!body.reason?.trim()) return reply.status(400).send({ success: false, error: 'Rejection reason is required' });
      app.status = 'rejected';
      app.rejectionReason = body.reason.trim();
      app.reviewedBy = adminId as any;
      app.reviewedAt = new Date();
      await app.save();
      notifyEmail('Partner Application Rejected', app.email, { user_name: app.fullName, description_note: app.rejectionReason });
      return reply.send({ success: true, data: app });
    }

    if (body.action === 'approve') {
      if (await PartnerModel.exists({ userId: app.userId })) return reply.status(400).send({ success: false, error: 'User is already a partner' });
      let code = body.code ? String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      if (code && (await PartnerModel.exists({ code }))) return reply.status(400).send({ success: false, error: 'Code already in use' });
      if (!code) code = await generatePartnerCode(app.fullName);
      const rate = body.commissionRate === undefined || body.commissionRate === null || (body.commissionRate as any) === '' ? null : Number(body.commissionRate);
      const partner = await PartnerModel.create({
        userId: app.userId,
        applicationId: app._id,
        code,
        displayName: app.fullName,
        email: app.email,
        phone: app.phone,
        commissionRate: rate,
        couponCode: body.couponCode ? String(body.couponCode).toUpperCase() : undefined,
        couponDiscountPercent: body.couponDiscountPercent,
        payoutMethod: app.payoutMethod,
        upiId: app.upiId,
        bankAccountName: app.bankAccountName,
        bankAccountNumber: app.bankAccountNumber,
        ifsc: app.ifsc,
        pan: app.pan,
        approvedAt: new Date(),
        approvedBy: adminId as any,
      });
      app.status = 'approved';
      app.reviewedBy = adminId as any;
      app.reviewedAt = new Date();
      app.partnerId = partner._id as any;
      app.rejectionReason = undefined;
      await app.save();
      notifyEmail('Partner Application Approved', app.email, {
        user_name: app.fullName,
        description_note: `Your referral code is ${partner.code}. Share ${shareLink(partner.code)} to start earning.`,
      });
      return reply.send({ success: true, data: { application: app, partner } });
    }
    return reply.status(400).send({ success: false, error: 'Unknown action' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** GET /api/partners?search&status&page&limit */
export const adminListPartners = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await maturePendingCommissions();
    const q = request.query as any;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const filter: any = {};
    if (q.status && q.status !== 'all') filter.status = q.status;
    if (q.search) {
      const rx = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ displayName: rx }, { email: rx }, { code: rx }, { phone: rx }];
    }
    const settings = await getPartnerProgramSettings();
    const [total, partners] = await Promise.all([
      PartnerModel.countDocuments(filter),
      PartnerModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const ids = partners.map((p) => p._id);
    const [refs, comm] = await Promise.all([
      UserModel.aggregate([{ $match: { referredByPartnerId: { $in: ids } } }, { $group: { _id: '$referredByPartnerId', n: { $sum: 1 } } }]),
      PartnerCommissionModel.aggregate([
        { $match: { partnerId: { $in: ids }, status: { $ne: 'reversed' } } },
        { $group: { _id: '$partnerId', revenue: { $sum: '$saleAmount' }, earned: { $sum: '$amount' }, paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }, payers: { $addToSet: '$referredUserId' } } },
      ]),
    ]);
    const rMap = new Map(refs.map((r: any) => [String(r._id), r.n]));
    const cMap = new Map(comm.map((c: any) => [String(c._id), c]));
    return reply.send({
      success: true,
      data: partners.map((p: any) => {
        const c: any = cMap.get(String(p._id)) || {};
        return {
          ...p,
          bankAccountNumber: p.bankAccountNumber ? `XXXX${String(p.bankAccountNumber).slice(-4)}` : undefined,
          effectiveRate: effectiveRate(p, settings.defaultCommissionRate),
          usersReferred: rMap.get(String(p._id)) || 0,
          payingUsers: c.payers?.length || 0,
          revenue: round2(c.revenue || 0),
          commissionEarned: round2(c.earned || 0),
          commissionPaid: round2(c.paid || 0),
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** GET /api/partners/:id */
export const adminGetPartner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!isId(id)) return reply.status(400).send({ success: false, error: 'Invalid id' });
    const partner = await PartnerModel.findById(id).lean();
    if (!partner) return reply.status(404).send({ success: false, error: 'Partner not found' });
    const settings = await getPartnerProgramSettings();
    const [stats, application, user, referred] = await Promise.all([
      buildPartnerStats(partner._id as Types.ObjectId, 30),
      partner.applicationId ? PartnerApplicationModel.findById(partner.applicationId).lean() : null,
      UserModel.findById(partner.userId).select('name email phone createdAt').lean(),
      UserModel.find({ referredByPartnerId: partner._id }).select('name email phone referredAt referralSource subscriptionStatus subscriptionPlanName').sort({ referredAt: -1 }).limit(50).lean(),
    ]);
    return reply.send({
      success: true,
      data: { partner: { ...partner, effectiveRate: effectiveRate(partner, settings.defaultCommissionRate), shareLink: shareLink(partner.code) }, user, application, stats, referredUsers: referred },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** PATCH /api/partners/:id  { commissionRate?, status?, couponCode?, couponDiscountPercent?, notes?, code? } */
export const adminUpdatePartner = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    if (!isId(id)) return reply.status(400).send({ success: false, error: 'Invalid id' });
    const b = (request.body || {}) as any;
    const update: any = {};
    if ('commissionRate' in b) {
      if (b.commissionRate === null || b.commissionRate === '') update.commissionRate = null;
      else {
        const r = Number(b.commissionRate);
        if (!(r >= 0 && r <= 100)) return reply.status(400).send({ success: false, error: 'Rate must be 0–100' });
        update.commissionRate = r;
      }
    }
    if (b.status && ['active', 'suspended'].includes(b.status)) update.status = b.status;
    if ('couponCode' in b) update.couponCode = b.couponCode ? String(b.couponCode).toUpperCase() : undefined;
    if ('couponDiscountPercent' in b) update.couponDiscountPercent = b.couponDiscountPercent === '' ? undefined : Number(b.couponDiscountPercent);
    if ('notes' in b) update.notes = String(b.notes || '');
    if (b.code) {
      const code = String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (await PartnerModel.exists({ code, _id: { $ne: id } })) return reply.status(400).send({ success: false, error: 'Code already in use' });
      update.code = code;
    }
    const partner = await PartnerModel.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' }).lean();
    if (!partner) return reply.status(404).send({ success: false, error: 'Partner not found' });
    if (update.code) await UserModel.updateMany({ referredByPartnerId: partner._id }, { $set: { referredBy: partner.code } });
    return reply.send({ success: true, data: partner });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** GET /api/partners/commissions?partnerId&status&page&limit */
export const adminListCommissions = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await maturePendingCommissions();
    const q = request.query as any;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const filter: any = {};
    if (q.partnerId && isId(q.partnerId)) filter.partnerId = q.partnerId;
    if (q.status && q.status !== 'all') filter.status = q.status;
    const [total, rows] = await Promise.all([
      PartnerCommissionModel.countDocuments(filter),
      PartnerCommissionModel.find(filter).populate('referredUserId', 'name email').populate('partnerId', 'displayName code').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return reply.send({
      success: true,
      data: rows.map((c: any) => ({ ...commissionView(c, true), partner: c.partnerId ? { id: c.partnerId._id, name: c.partnerId.displayName, code: c.partnerId.code } : null })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** POST /api/partners/commissions/:id/reverse { reason } — manual reversal (refund/chargeback/fraud) */
export const adminReverseCommission = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const c = isId(id) ? await PartnerCommissionModel.findById(id).lean() : null;
    if (!c) return reply.status(404).send({ success: false, error: 'Commission not found' });
    const reason = String((request.body as any)?.reason || 'Reversed by admin');
    const r = await reverseCommissionForPayment(c.paymentId, reason);
    return reply.send({ success: true, data: r });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** GET /api/partners/payouts?status&partnerId */
export const adminListPayouts = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const q = request.query as any;
    const filter: any = {};
    if (q.status && q.status !== 'all') filter.status = q.status;
    if (q.partnerId && isId(q.partnerId)) filter.partnerId = q.partnerId;
    const rows = await PartnerPayoutModel.find(filter).populate('partnerId', 'displayName code payoutMethod upiId bankAccountName bankAccountNumber ifsc pan').sort({ createdAt: -1 }).limit(200).lean();
    return reply.send({ success: true, data: rows });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** PATCH /api/partners/payouts/:id { action: 'paid'|'reject', reference?, note? } */
export const adminProcessPayout = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const b = (request.body || {}) as { action?: string; reference?: string; note?: string };
    const payout = isId(id) ? await PartnerPayoutModel.findById(id) : null;
    if (!payout) return reply.status(404).send({ success: false, error: 'Payout not found' });
    if (payout.status !== 'requested') return reply.status(400).send({ success: false, error: `Payout already ${payout.status}` });
    if (b.action === 'paid') {
      if (!b.reference?.trim()) return reply.status(400).send({ success: false, error: 'Payment reference (UTR) is required' });
      payout.status = 'paid';
      payout.reference = b.reference.trim();
      await PartnerCommissionModel.updateMany({ payoutId: payout._id, status: 'approved' }, { $set: { status: 'paid', paidAt: new Date() } });
    } else if (b.action === 'reject') {
      payout.status = 'rejected';
      payout.clawbackDeducted = 0;
      await PartnerCommissionModel.updateMany({ payoutId: payout._id, status: 'approved' }, { $unset: { payoutId: 1 } });
    } else {
      return reply.status(400).send({ success: false, error: 'Unknown action' });
    }
    payout.adminNote = b.note;
    payout.processedBy = uid(request) as any;
    payout.processedAt = new Date();
    await payout.save();
    return reply.send({ success: true, data: payout });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** GET/PUT /api/partners/settings */
export const adminGetPartnerSettings = async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.send({ success: true, data: await getPartnerProgramSettings() });
};

export const adminUpdatePartnerSettings = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const b = (request.body || {}) as any;
    const schema = z.object({
      enabled: z.boolean().optional(),
      defaultCommissionRate: z.coerce.number().min(0).max(100).optional(),
      commissionOnRenewals: z.boolean().optional(),
      holdDays: z.coerce.number().int().min(0).max(90).optional(),
      minPayout: z.coerce.number().min(0).optional(),
      attributionWindowDays: z.coerce.number().int().min(0).max(365).optional(),
      commissionBase: z.enum(['net', 'gross']).optional(),
      reviewSlaHours: z.coerce.number().int().min(1).max(720).optional(),
      termsUrl: z.string().optional(),
    });
    const parsed = schema.safeParse(b);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
    await getPartnerProgramSettings();
    const doc = await PartnerProgramSettingsModel.findOneAndUpdate({}, { $set: parsed.data }, { returnDocument: 'after' }).lean();
    return reply.send({ success: true, data: doc });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** POST /api/partners/attribute { userId, code } — admin manual attribution (support cases) */
export const adminAttributeUser = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId, code } = (request.body || {}) as any;
  if (!isId(userId)) return reply.status(400).send({ success: false, error: 'Invalid userId' });
  const r = await attachReferral(userId, code, 'admin');
  if (!r.ok) return reply.status(400).send({ success: false, error: r.error });
  return reply.send({ success: true, data: r });
};
