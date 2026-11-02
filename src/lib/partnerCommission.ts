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
  source: 'link' | 'signup_code' | 'manual_code' | 'checkout_code' | 'admin' = 'manual_code'
): Promise<{ ok: boolean; error?: string; partnerCode?: string }> {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Referral code is required' };
  const [user, partner, settings] = await Promise.all([
    UserModel.findById(userId),
    findActivePartnerByCode(code),
    getPartnerProgramSettings(),
  ]);
  if (!user) return { ok: false, error: 'User not found' };
  if (!settings.enabled) return { ok: false, error: 'Partner program is not active' };
  if (!partner) return { ok: false, error: 'Invalid or inactive referral code' };
  if (user.referredByPartnerId) return { ok: false, error: 'A referral code is already applied to this account' };
  if (String(partner.userId) === String(user._id)) return { ok: false, error: 'You cannot use your own referral code' };
  // A code typed at checkout attributes the buyer at purchase time, so the signup window doesn't apply.
  if (source !== 'admin' && source !== 'checkout_code') {
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
  listPrice?: number;
  discountAmount?: number;
  discountPercent?: number;
  discountCode?: string;
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
      listPrice: input.listPrice !== undefined ? round2(input.listPrice) : round2(input.saleAmount),
      discountAmount: round2(input.discountAmount || 0),
      discountPercent: input.discountPercent || 0,
      discountCode: input.discountCode,
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

/* ───────────────────────────── Buyer discount ───────────────────────────── */

/** Find an active partner by referral code OR vanity coupon code. */
export async function findActivePartnerByCode(rawCode: string) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  return PartnerModel.findOne({ status: 'active', $or: [{ code }, { couponCode: code }] }).lean();
}

/** Buyer discount % for a partner: per-partner override, else program default; 0 when disabled. */
export function effectiveDiscountPercent(
  partner: { couponDiscountPercent?: number | null },
  settings: { buyerDiscountEnabled?: boolean; buyerDiscountPercent?: number }
) {
  if (!settings.buyerDiscountEnabled) return 0;
  const p = partner.couponDiscountPercent === null || partner.couponDiscountPercent === undefined
    ? Number(settings.buyerDiscountPercent) || 0
    : Number(partner.couponDiscountPercent) || 0;
  return Math.min(90, Math.max(0, p));
}

/** Pure: apply a % discount to a GST-inclusive price; rounded to whole paise, never below ₹1. */
export function applyBuyerDiscount(listPrice: number, percent: number) {
  const price = round2(Math.max(0, Number(listPrice) || 0));
  const pct = Math.min(90, Math.max(0, Number(percent) || 0));
  if (!price || !pct) return { listPrice: price, discountPercent: 0, discountAmount: 0, finalAmount: price };
  let discountAmount = round2((price * pct) / 100);
  if (price - discountAmount < 1) discountAmount = round2(price - 1);
  return { listPrice: price, discountPercent: pct, discountAmount, finalAmount: round2(price - discountAmount) };
}

/**
 * Server-side checkout quote. The buyer's existing attribution always wins; a typed code only
 * applies if the buyer isn't attributed yet. Never trusts a client price.
 */
export async function quotePartnerDiscount(userId: string, listPrice: number, rawCode?: string) {
  const none = (message?: string) => ({ ...applyBuyerDiscount(listPrice, 0), partnerId: undefined as any, code: undefined as string | undefined, source: undefined as 'attributed' | 'checkout_code' | undefined, message });
  const settings = await getPartnerProgramSettings();
  if (!settings.enabled) return none(rawCode ? 'Partner codes are not active right now' : undefined);
  const user = await UserModel.findById(userId).select('referredByPartnerId').lean();
  if (!user) return none('User not found');

  let partner: any = null;
  let source: 'attributed' | 'checkout_code' | undefined;
  let typedCode: string | undefined;
  const typed = String(rawCode || '').trim().toUpperCase();
  if (user.referredByPartnerId) {
    partner = await PartnerModel.findOne({ _id: user.referredByPartnerId, status: 'active' }).lean();
    source = 'attributed';
  } else if (typed) {
    partner = await findActivePartnerByCode(typed);
    if (!partner) return none('Invalid or inactive partner code');
    if (String(partner.userId) === String(userId)) return none('You cannot use your own partner code');
    source = 'checkout_code';
    typedCode = typed;
  }
  if (!partner) return none(typed ? 'Invalid or inactive partner code' : undefined);

  if (!settings.discountOnRenewals) {
    const { SubscriptionModel } = await import('../models/Subscription');
    const paidBefore = await SubscriptionModel.exists({ userId, paymentMethod: 'Razorpay', totalAmount: { $gt: 0 } });
    if (paidBefore) {
      return { ...none('Partner discount applies to your first subscription only'), partnerId: partner._id, code: typedCode || partner.code, source };
    }
  }
  const pct = effectiveDiscountPercent(partner, settings);
  const calc = applyBuyerDiscount(listPrice, pct);
  let message: string | undefined = calc.discountAmount > 0 ? `${pct}% partner discount applied` : 'This partner code has no buyer discount';
  if (source === 'attributed' && typed && typed !== partner.code && typed !== partner.couponCode) {
    message = `Your account is already linked to partner ${partner.code}; that discount is applied instead`;
  }
  return { ...calc, partnerId: partner._id, code: typedCode || partner.couponCode || partner.code, source, message };
}

/* ───────────────────────────── TDS (s.393 / old 194H) ───────────────────────────── */

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const isValidPan = (pan?: string | null) => PAN_REGEX.test(String(pan || '').trim().toUpperCase());

/** Indian financial year label for a date, in IST: Apr 2026–Mar 2027 => "2026-27". */
export function financialYearOf(d: Date = new Date()) {
  const ist = new Date(d.getTime() + 330 * 60000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Pure TDS calculator. Once the FY aggregate (previous payouts + this one) exceeds the threshold,
 * TDS applies on the ENTIRE FY amount; tax already withheld earlier in the FY is credited.
 */
export function computeTds(p: { gross: number; priorFyGross: number; priorFyTds: number; rate: number; threshold: number; enabled?: boolean }) {
  const gross = round2(Math.max(0, p.gross));
  if (p.enabled === false || !(p.rate > 0)) return { tdsAmount: 0, netAmount: gross, rate: 0, aggregate: round2(p.priorFyGross + gross) };
  const aggregate = round2(Math.max(0, p.priorFyGross) + gross);
  if (aggregate <= p.threshold) return { tdsAmount: 0, netAmount: gross, rate: p.rate, aggregate };
  const due = round2((aggregate * p.rate) / 100 - Math.max(0, p.priorFyTds));
  const tdsAmount = Math.min(gross, Math.max(0, due));
  return { tdsAmount, netAmount: round2(gross - tdsAmount), rate: p.rate, aggregate };
}

/** TDS for a payout of `gross` to a partner, using PAID payouts earlier in the same FY. */
export async function tdsForPartnerPayout(partnerId: string | Types.ObjectId, gross: number, at = new Date(), excludePayoutId?: string) {
  const { PartnerPayoutModel } = await import('../models/PartnerPayout');
  const settings = await getPartnerProgramSettings();
  const fy = financialYearOf(at);
  const match: any = { partnerId: new Types.ObjectId(String(partnerId)), status: 'paid', financialYear: fy };
  if (excludePayoutId) match._id = { $ne: new Types.ObjectId(String(excludePayoutId)) };
  const agg = await PartnerPayoutModel.aggregate([{ $match: match }, { $group: { _id: null, gross: { $sum: '$amount' }, tds: { $sum: '$tdsAmount' } } }]);
  const r = computeTds({
    gross,
    priorFyGross: agg[0]?.gross || 0,
    priorFyTds: agg[0]?.tds || 0,
    rate: settings.tdsRate,
    threshold: settings.tdsThresholdPerFY,
    enabled: settings.tdsEnabled,
  });
  return { ...r, financialYear: fy, section: settings.tdsSection };
}
