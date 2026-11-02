/**
 * Partner program tests. Pure math runs everywhere; DB tests need a LOCAL mongod
 * (TEST_MONGODB_URI, default mongodb://127.0.0.1:27017/ashqe_partner_test). Never point at production.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { calculateCommission, effectiveRate, maskName, recordCommissionForPayment, reverseCommissionForPayment, maturePendingCommissions, getPartnerBalances, attachReferral } from '../src/lib/partnerCommission';
import { UserModel } from '../src/models/User';
import { PartnerModel } from '../src/models/Partner';
import { PartnerCommissionModel } from '../src/models/PartnerCommission';
import { PartnerProgramSettingsModel } from '../src/models/PartnerProgramSettings';

describe('calculateCommission', () => {
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
    await PartnerProgramSettingsModel.create({ defaultCommissionRate: 10, holdDays: 7, commissionOnRenewals: true, commissionBase: 'net', minPayout: 500, attributionWindowDays: 7 });
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
    assert.equal(c!.amount, 50);
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
    assert.equal(bal.available, 50 + 100 + 50);
  });

  test('refund reversal is idempotent and removes earnings', async () => {
    const r1 = await reverseCommissionForPayment('pay_3', 'refund');
    const r2 = await reverseCommissionForPayment('pay_3', 'refund');
    assert.equal(r1.reversed, true);
    assert.equal(r1.clawback, false);
    assert.equal(r2.reversed, false);
    const bal = await getPartnerBalances(partner._id);
    assert.equal(bal.available, 150);
    assert.equal(bal.reversed, 50);
  });

  test('refund after payout becomes a clawback deducted from balance', async () => {
    await PartnerCommissionModel.updateOne({ paymentId: 'pay_race' }, { status: 'paid', paidAt: new Date() });
    const r = await reverseCommissionForPayment('pay_race', 'chargeback');
    assert.equal(r.clawback, true);
    const bal = await getPartnerBalances(partner._id);
    assert.equal(bal.clawback, 100);
    assert.equal(bal.available, 0); // 50 approved - 100 clawback, floored at 0
  });
});
