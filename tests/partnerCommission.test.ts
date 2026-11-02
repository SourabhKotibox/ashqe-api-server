/**
 * Partner program tests. Pure math runs everywhere; DB tests need a LOCAL mongod
 * (TEST_MONGODB_URI, default mongodb://127.0.0.1:27017/ashqe_partner_test). Never point at production.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { calculateCommission, effectiveRate, maskName, recordCommissionForPayment, reverseCommissionForPayment, maturePendingCommissions, getPartnerBalances, attachReferral, applyBuyerDiscount, effectiveDiscountPercent, computeTds, financialYearOf, isValidPan, quotePartnerDiscount, tdsForPartnerPayout } from '../src/lib/partnerCommission';
import { PartnerPayoutModel } from '../src/models/PartnerPayout';
import { SubscriptionModel } from '../src/models/Subscription';
import { UserModel } from '../src/models/User';
import { PartnerModel } from '../src/models/Partner';
import { PartnerCommissionModel } from '../src/models/PartnerCommission';
import { PartnerProgramSettingsModel } from '../src/models/PartnerProgramSettings';

describe('buyer discount', () => {
  test('10% off a GST-inclusive ₹1,180 plan => ₹1,062', () => {
    assert.deepEqual(applyBuyerDiscount(1180, 10), { listPrice: 1180, discountPercent: 10, discountAmount: 118, finalAmount: 1062 });
  });
  test('0% / disabled leaves price unchanged; capped at 90%; never below ₹1', () => {
    assert.equal(applyBuyerDiscount(499, 0).finalAmount, 499);
    assert.equal(applyBuyerDiscount(100, 100).discountPercent, 90);
    assert.equal(applyBuyerDiscount(1, 50).finalAmount, 1);
  });
  test('per-partner override, null = default, 0 = off, program switch', () => {
    const on = { buyerDiscountEnabled: true, buyerDiscountPercent: 10 };
    assert.equal(effectiveDiscountPercent({ couponDiscountPercent: null }, on), 10);
    assert.equal(effectiveDiscountPercent({ couponDiscountPercent: 15 }, on), 15);
    assert.equal(effectiveDiscountPercent({ couponDiscountPercent: 0 }, on), 0);
    assert.equal(effectiveDiscountPercent({ couponDiscountPercent: 15 }, { ...on, buyerDiscountEnabled: false }), 0);
  });
});

describe('TDS (s.393 Sl.1(ii) / old 194H)', () => {
  const base = { rate: 2, threshold: 20000 };
  test('no TDS while FY aggregate stays at or under ₹20,000', () => {
    assert.equal(computeTds({ ...base, gross: 15000, priorFyGross: 0, priorFyTds: 0 }).tdsAmount, 0);
    assert.equal(computeTds({ ...base, gross: 5000, priorFyGross: 15000, priorFyTds: 0 }).tdsAmount, 0);
  });
  test('crossing the threshold taxes the WHOLE FY amount, crediting nothing withheld so far', () => {
    const r = computeTds({ ...base, gross: 6000, priorFyGross: 15000, priorFyTds: 0 });
    assert.equal(r.tdsAmount, 420); // 2% of 21,000
    assert.equal(r.netAmount, 5580);
  });
  test('after threshold, each payout is taxed at 2% (prior TDS credited)', () => {
    assert.equal(computeTds({ ...base, gross: 5000, priorFyGross: 21000, priorFyTds: 420 }).tdsAmount, 100);
  });
  test('₹50,000 single payout => ₹1,000 TDS, ₹49,000 net; disabled => 0', () => {
    assert.deepEqual([computeTds({ ...base, gross: 50000, priorFyGross: 0, priorFyTds: 0 }).tdsAmount, computeTds({ ...base, gross: 50000, priorFyGross: 0, priorFyTds: 0 }).netAmount], [1000, 49000]);
    assert.equal(computeTds({ ...base, gross: 50000, priorFyGross: 0, priorFyTds: 0, enabled: false }).tdsAmount, 0);
  });
  test('financial year is IST April–March', () => {
    assert.equal(financialYearOf(new Date('2026-03-31T18:00:00Z')), '2025-26'); // 31 Mar 23:30 IST
    assert.equal(financialYearOf(new Date('2026-03-31T18:31:00Z')), '2026-27'); // 1 Apr 00:01 IST
  });
  test('PAN format', () => {
    assert.equal(isValidPan('ABCPR1234K'), true);
    assert.equal(isValidPan('abcpr1234k'), true);
    assert.equal(isValidPan('ABCP1234K'), false);
    assert.equal(isValidPan(''), false);
  });
});

describe('calculateCommission', () => {
  test('gross base = full amount paid incl. GST (default)', () => {
    const r = calculateCommission({ saleAmount: 1062, tax: 162, rate: 10, base: 'gross' });
    assert.equal(r.baseAmount, 1062);
    assert.equal(r.amount, 106.2);
  });
  test('50,000 at 10% => 5,000 (spec example)', () => {
    assert.equal(calculateCommission({ saleAmount: 50000, rate: 10, base: 'gross' }).amount, 5000);
  });
  test('net base excludes tax', () => {
    const r = calculateCommission({ saleAmount: 118, tax: 18, rate: 10, base: 'net' });
    assert.equal(r.baseAmount, 100);
    assert.equal(r.amount, 10);
  });
  test('rounds to paise and clamps rate', () => {
    assert.equal(calculateCommission({ saleAmount: 99, rate: 10, base: 'gross' }).amount, 9.9);
    assert.equal(calculateCommission({ saleAmount: 199, rate: 7.5, base: 'gross' }).amount, 14.93);
    assert.equal(calculateCommission({ saleAmount: 100, rate: 150, base: 'gross' }).amount, 100);
    assert.equal(calculateCommission({ saleAmount: -5, rate: 10 }).amount, 0);
  });
  test('per-partner rate overrides default; null falls back', () => {
    assert.equal(effectiveRate({ commissionRate: 15 }, 10), 15);
    assert.equal(effectiveRate({ commissionRate: null }, 10), 10);
    assert.equal(effectiveRate({ commissionRate: 0 }, 10), 0);
  });
  test('maskName', () => {
    assert.equal(maskName('Rahul Sharma'), 'Ra*** Sh****');
  });
});

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/ashqe_partner_test';
if (/mongodb\.net|ashqe\.app/.test(uri)) throw new Error('Refusing to run DB tests against a remote database');

describe('ledger (local mongo)', () => {
  let partner: any, partnerUser: any, buyer: any;
  before(async () => {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    await mongoose.connection.db!.dropDatabase();
    await PartnerProgramSettingsModel.create({ defaultCommissionRate: 10, holdDays: 7, commissionOnRenewals: true, minPayout: 500, attributionWindowDays: 7 }); // commissionBase defaults to 'gross'
    partnerUser = await UserModel.create({ email: 'p@test.local', name: 'Partner One' });
    buyer = await UserModel.create({ email: 'b@test.local', name: 'Buyer One' });
    partner = await PartnerModel.create({ userId: partnerUser._id, code: 'PONE1234', displayName: 'Partner One' });
  });
  after(async () => {
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  });

  test('self-referral is blocked, valid code attaches once', async () => {
    assert.equal((await attachReferral(String(partnerUser._id), 'PONE1234')).ok, false);
    assert.equal((await attachReferral(String(buyer._id), 'pone1234', 'link')).ok, true);
    assert.equal((await attachReferral(String(buyer._id), 'PONE1234')).ok, false);
  });

  test('non-referred user earns nothing', async () => {
    const other = await UserModel.create({ email: 'o@test.local', name: 'Other' });
    const r = await recordCommissionForPayment({ userId: String(other._id), paymentId: 'pay_X', saleAmount: 999 });
    assert.equal(r.created, false);
    assert.equal(r.reason, 'not_referred');
  });

  test('commission is idempotent per payment id', async () => {
    const a = await recordCommissionForPayment({ userId: String(buyer._id), paymentId: 'pay_1', saleAmount: 590, tax: 90 });
    const b = await recordCommissionForPayment({ userId: String(buyer._id), paymentId: 'pay_1', saleAmount: 590, tax: 90 });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.reason, 'duplicate');
    assert.equal(await PartnerCommissionModel.countDocuments({ paymentId: 'pay_1' }), 1);
    const c = await PartnerCommissionModel.findOne({ paymentId: 'pay_1' }).lean();
    assert.equal(c!.amount, 59); // 10% of ₹590 incl. GST
    assert.equal(c!.status, 'pending');
    assert.equal(c!.isRenewal, false);
  });

  test('concurrent duplicates still produce one row', async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(() => recordCommissionForPayment({ userId: String(buyer._id), paymentId: 'pay_race', saleAmount: 1000 })));
    assert.equal(rs.filter((r) => r.created).length, 1);
    assert.equal(await PartnerCommissionModel.countDocuments({ paymentId: 'pay_race' }), 1);
  });

  test('renewals respect the setting', async () => {
    await PartnerProgramSettingsModel.updateOne({}, { commissionOnRenewals: false });
    const r = await recordCommissionForPayment({ userId: String(buyer._id), paymentId: 'pay_2', saleAmount: 500 });
    assert.equal(r.reason, 'renewals_disabled');
    await PartnerProgramSettingsModel.updateOne({}, { commissionOnRenewals: true });
    const r2 = await recordCommissionForPayment({ userId: String(buyer._id), paymentId: 'pay_3', saleAmount: 500 });
    assert.equal(r2.created, true);
    assert.equal((r2 as any).commission.isRenewal, true);
  });

  test('pending matures to approved after hold', async () => {
    await PartnerCommissionModel.updateMany({}, { holdUntil: new Date(Date.now() - 1000) });
    assert.ok((await maturePendingCommissions()) >= 1);
    const bal = await getPartnerBalances(partner._id);
    assert.equal(bal.pending, 0);
    assert.equal(bal.available, 59 + 100 + 50);
  });

  test('refund reversal is idempotent and removes earnings', async () => {
    const r1 = await reverseCommissionForPayment('pay_3', 'refund');
    const r2 = await reverseCommissionForPayment('pay_3', 'refund');
    assert.equal(r1.reversed, true);
    assert.equal(r1.clawback, false);
    assert.equal(r2.reversed, false);
    const bal = await getPartnerBalances(partner._id);
    assert.equal(bal.available, 159);
    assert.equal(bal.reversed, 50);
  });

  test('refund after payout becomes a clawback deducted from balance', async () => {
    await PartnerCommissionModel.updateOne({ paymentId: 'pay_race' }, { status: 'paid', paidAt: new Date() });
    const r = await reverseCommissionForPayment('pay_race', 'chargeback');
    assert.equal(r.clawback, true);
    const bal = await getPartnerBalances(partner._id);
    assert.equal(bal.clawback, 100);
    assert.equal(bal.available, 0); // 59 approved - 100 clawback, floored at 0
  });

  test('refunded sales are excluded from revenue and sales count', async () => {
    const bal = await getPartnerBalances(partner._id);
    assert.equal(bal.revenue, 590); // pay_3 (500) and pay_race (1000) were refunded
    assert.equal(bal.salesCount, 1);
  });

  test('checkout quote: attributed buyer gets partner discount on first purchase only', async () => {
    const fresh = await UserModel.create({ email: 'f@test.local', name: 'Fresh Buyer' });
    await attachReferral(String(fresh._id), 'PONE1234', 'link');
    const q = await quotePartnerDiscount(String(fresh._id), 1180);
    assert.equal(q.finalAmount, 1062);
    assert.equal(q.source, 'attributed');
    await SubscriptionModel.create({ userId: fresh._id, planId: new mongoose.Types.ObjectId(), duration: 'month', plan: 'premium', paymentMethod: 'Razorpay', price: 1180, totalAmount: 1062, startDate: new Date(), endDate: new Date() });
    assert.equal((await quotePartnerDiscount(String(fresh._id), 1180)).discountAmount, 0);
    await PartnerProgramSettingsModel.updateOne({}, { discountOnRenewals: true });
    assert.equal((await quotePartnerDiscount(String(fresh._id), 1180)).discountAmount, 118);
    await PartnerProgramSettingsModel.updateOne({}, { discountOnRenewals: false });
  });

  test('checkout quote: typed code for unattributed buyer, invalid & own code rejected, override honoured', async () => {
    const walkIn = await UserModel.create({ email: 'w@test.local', name: 'Walk In' });
    const q = await quotePartnerDiscount(String(walkIn._id), 1000, 'pone1234');
    assert.equal(q.source, 'checkout_code');
    assert.equal(q.finalAmount, 900);
    assert.equal((await quotePartnerDiscount(String(walkIn._id), 1000, 'NOPE')).discountAmount, 0);
    assert.equal((await quotePartnerDiscount(String(partnerUser._id), 1000, 'PONE1234')).discountAmount, 0);
    await PartnerModel.updateOne({ _id: partner._id }, { couponDiscountPercent: 0 });
    assert.equal((await quotePartnerDiscount(String(walkIn._id), 1000, 'PONE1234')).discountAmount, 0);
    await PartnerModel.updateOne({ _id: partner._id }, { couponDiscountPercent: null });
  });

  test('commission on a discounted sale uses what was actually paid and records the discount', async () => {
    const r: any = await recordCommissionForPayment({ userId: String(buyer._id), paymentId: 'pay_disc', saleAmount: 1062, tax: 162, listPrice: 1180, discountAmount: 118, discountPercent: 10, discountCode: 'PONE1234' });
    assert.equal(r.commission.amount, 106.2);
    assert.equal(r.commission.discountAmount, 118);
    assert.equal(r.commission.listPrice, 1180);
  });

  test('payout TDS uses paid payouts in the same FY', async () => {
    const fy = financialYearOf();
    assert.equal((await tdsForPartnerPayout(partner._id, 15000)).tdsAmount, 0);
    await PartnerPayoutModel.create({ partnerId: partner._id, amount: 15000, tdsAmount: 0, netAmount: 15000, financialYear: fy, status: 'paid', method: 'upi', commissionIds: [] });
    await PartnerPayoutModel.create({ partnerId: partner._id, amount: 99999, financialYear: '2020-21', status: 'paid', method: 'upi', commissionIds: [] });
    await PartnerPayoutModel.create({ partnerId: partner._id, amount: 99999, financialYear: fy, status: 'rejected', method: 'upi', commissionIds: [] });
    const t = await tdsForPartnerPayout(partner._id, 6000);
    assert.equal(t.tdsAmount, 420);
    assert.equal(t.netAmount, 5580);
  });
});
