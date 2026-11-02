import { Types } from 'mongoose';
import { PartnerModel } from '../models/Partner';
import { PartnerCommissionModel } from '../models/PartnerCommission';
import { getPartnerProgramSettings } from '../models/PartnerProgramSettings';
import { UserModel } from '../models/User';

/** Round to 2 decimals (paise precision). */
export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Pure commission calculator. 50,000 @ 10% => 5,000. */
export function calculateCommission(params: {
  saleAmount: number;
  tax?: number;
  rate: number;
  base?: 'net' | 'gross';
}) {
  const sale = Math.max(0, Number(params.saleAmount) || 0);
  const tax = Math.max(0, Number(params.tax) || 0);
  const baseAmount = params.base === 'gross' ? sale : Math.max(0, sale - tax);
  const rate = Math.min(100, Math.max(0, Number(params.rate) || 0));
  return { baseAmount: round2(baseAmount), rate, amount: round2((baseAmount * rate) / 100) };
}

/** Effective rate: per-partner override, else program default. */
export function effectiveRate(partner: { commissionRate?: number | null }, defaultRate: number) {
  return partner.commissionRate === null || partner.commissionRate === undefined
    ? defaultRate
    : partner.commissionRate;
}

/** Generate a readable unique code like RAHUL4821. */
export async function generatePartnerCode(name: string) {
  const prefix = (name || 'ASHQE').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6) || 'ASHQE';
  for (let i = 0; i < 20; i++) {
    const code = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await PartnerModel.exists({ code }))) return code;
  }
  return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Attribute a user to a partner code. Never overwrites an existing attribution,
 * blocks self-referral and (for manual codes) enforces the attribution window.
 */
export async function attachReferral(
  userId: string,
  rawCode: string,
  source: 'link' | 'signup_code' | 'manual_code' | 'admin' = 'manual_code'
): Promise<{ ok: boolean; error?: string; partnerCode?: string }> {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Referral code is required' };
  const [user, partner, settings] = await Promise.all([
    UserModel.findById(userId),
    PartnerModel.findOne({ code, status: 'active' }).lean(),
    getPartnerProgramSettings(),
  ]);
  if (!user) return { ok: false, error: 'User not found' };
  if (!settings.enabled) return { ok: false, error: 'Partner program is not active' };
  if (!partner) return { ok: false, error: 'Invalid or inactive referral code' };
  if (user.referredByPartnerId) return { ok: false, error: 'A referral code is already applied to this account' };
  if (String(partner.userId) === String(user._id)) return { ok: false, error: 'You cannot use your own referral code' };
  if (source !== 'admin') {
    const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / 86400000;
    if (ageDays > settings.attributionWindowDays) {
      return { ok: false, error: `Referral codes can only be applied within ${settings.attributionWindowDays} days of signing up` };
    }
    const hasPaid = await PartnerCommissionModel.exists({ referredUserId: user._id });
    if (hasPaid) return { ok: false, error: 'Referral code cannot be applied after a purchase' };
  }
  user.referredBy = partner.code;
  user.referredByPartnerId = partner._id as Types.ObjectId;
  user.referredAt = new Date();
  user.referralSource = source;
  await user.save();
  return { ok: true, partnerCode: partner.code };
}

/**
 * Called after a VERIFIED successful payment. Idempotent per paymentId
 * (unique index; duplicate inserts are swallowed and the existing row returned).
 */
export async function recordCommissionForPayment(input: {
  userId: string;
  paymentId: string;
  orderId?: string;
  subscriptionId?: string;
  planName?: string;
  saleAmount: number;
  tax?: number;
}) {
  if (!input.paymentId || !(input.saleAmount > 0)) return { created: false, reason: 'no_payment' as const };
  const existing = await PartnerCommissionModel.findOne({ paymentId: input.paymentId }).lean();
  if (existing) return { created: false, reason: 'duplicate' as const, commission: existing };

  const user = await UserModel.findById(input.userId).select('referredByPartnerId').lean();
  if (!user?.referredByPartnerId) return { created: false, reason: 'not_referred' as const };

  const [partner, settings] = await Promise.all([
    PartnerModel.findById(user.referredByPartnerId).lean(),
    getPartnerProgramSettings(),
  ]);
  if (!settings.enabled) return { created: false, reason: 'program_disabled' as const };
  if (!partner || partner.status !== 'active') return { created: false, reason: 'partner_inactive' as const };
  if (String(partner.userId) === String(input.userId)) return { created: false, reason: 'self' as const };

  const previous = await PartnerCommissionModel.countDocuments({
    referredUserId: input.userId,
    partnerId: partner._id,
    status: { $ne: 'reversed' },
  });
  const isRenewal = previous > 0;
  if (isRenewal && !settings.commissionOnRenewals) return { created: false, reason: 'renewals_disabled' as const };

  const calc = calculateCommission({
    saleAmount: input.saleAmount,
    tax: input.tax,
    rate: effectiveRate(partner, settings.defaultCommissionRate),
    base: settings.commissionBase,
  });
  if (calc.amount <= 0) return { created: false, reason: 'zero' as const };

  try {
    const commission = await PartnerCommissionModel.create({
      partnerId: partner._id,
      referredUserId: input.userId,
      subscriptionId: input.subscriptionId,
      paymentId: input.paymentId,
      orderId: input.orderId,
      planName: input.planName,
      saleAmount: round2(input.saleAmount),
      baseAmount: calc.baseAmount,
      rate: calc.rate,
      amount: calc.amount,
      isRenewal,
      status: 'pending',
      holdUntil: new Date(Date.now() + settings.holdDays * 86400000),
    });
    return { created: true, commission };
  } catch (err: any) {
    if (err?.code === 11000) {
      const dup = await PartnerCommissionModel.findOne({ paymentId: input.paymentId }).lean();
      return { created: false, reason: 'duplicate' as const, commission: dup };
    }
    throw err;
  }
}

/** Reverse commission when a payment is refunded/charged back. Idempotent. */
export async function reverseCommissionForPayment(paymentId: string, reason = 'Payment refunded') {
  const c = await PartnerCommissionModel.findOne({ paymentId });
  if (!c) return { reversed: false, reason: 'not_found' as const };
  if (c.status === 'reversed') return { reversed: false, reason: 'already_reversed' as const };
  const wasPaid = c.status === 'paid';
  c.status = 'reversed';
  c.reversedAt = new Date();
  c.reversalReason = reason;
  c.reversedAfterPaid = wasPaid;
  // If it was locked into an unpaid payout request, release it from that payout
  if (!wasPaid && c.payoutId) c.payoutId = undefined;
  await c.save();
  return { reversed: true, clawback: wasPaid, commission: c };
}

/** Move pending commissions whose hold has expired to approved (lazy, called on reads). */
export async function maturePendingCommissions(partnerId?: string) {
  const filter: any = { status: 'pending', holdUntil: { $lte: new Date() } };
  if (partnerId) filter.partnerId = partnerId;
  const res = await PartnerCommissionModel.updateMany(filter, { $set: { status: 'approved', approvedAt: new Date() } });
  return res.modifiedCount || 0;
}

/** Balance + totals for one partner. */
export async function getPartnerBalances(partnerId: string | Types.ObjectId) {
  const pid = new Types.ObjectId(String(partnerId));
  await maturePendingCommissions(String(pid));
  const rows = await PartnerCommissionModel.aggregate([
    { $match: { partnerId: pid } },
    {
      $group: {
        _id: { status: '$status', inPayout: { $cond: [{ $ifNull: ['$payoutId', false] }, true, false] }, clawback: '$reversedAfterPaid' },
        amount: { $sum: '$amount' },
        sales: { $sum: '$saleAmount' },
        count: { $sum: 1 },
      },
    },
  ]);
  const t = { pending: 0, approved: 0, inPayout: 0, paid: 0, reversed: 0, clawback: 0, revenue: 0, sales: 0 };
  for (const r of rows) {
    const { status, inPayout, clawback } = r._id;
    if (status === 'pending') t.pending += r.amount;
    if (status === 'approved' && !inPayout) t.approved += r.amount;
    if (status === 'approved' && inPayout) t.inPayout += r.amount;
    if (status === 'paid') t.paid += r.amount;
    if (status === 'reversed') {
      t.reversed += r.amount;
      if (clawback) t.clawback += r.amount;
    }
    if (status !== 'reversed') {
      t.revenue += r.sales;
      t.sales += r.count;
    }
  }
  // Clawbacks already deducted in earlier payouts are not owed again
  const { PartnerPayoutModel } = await import('../models/PartnerPayout');
  const deducted = await PartnerPayoutModel.aggregate([
    { $match: { partnerId: pid, status: { $in: ['requested', 'paid'] } } },
    { $group: { _id: null, sum: { $sum: '$clawbackDeducted' } } },
  ]);
  const outstandingClawback = Math.max(0, t.clawback - (deducted[0]?.sum || 0));
  return {
    pending: round2(t.pending),
    approved: round2(t.approved),
    inPayout: round2(t.inPayout),
    paid: round2(t.paid),
    reversed: round2(t.reversed),
    clawback: round2(outstandingClawback),
    earned: round2(t.pending + t.approved + t.inPayout + t.paid),
    available: round2(Math.max(0, t.approved - outstandingClawback)),
    revenue: round2(t.revenue),
    salesCount: t.sales,
  };
}

/** Mask a name for partner-facing lists: "Rahul Sharma" -> "Ra*** Sh***". */
export function maskName(name?: string) {
  if (!name) return 'User';
  return name
    .trim()
    .split(/\s+/)
    .map((p) => (p.length <= 2 ? `${p[0]}*` : `${p.slice(0, 2)}${'*'.repeat(Math.min(4, p.length - 2))}`))
    .join(' ');
}

export function maskDestination(method: string, upi?: string, acct?: string) {
  if (method === 'upi' && upi) {
    const [u, h] = upi.split('@');
    return `${u.slice(0, 2)}***@${h || ''}`;
  }
  if (acct) return `XXXX${acct.slice(-4)}`;
  return '-';
}
