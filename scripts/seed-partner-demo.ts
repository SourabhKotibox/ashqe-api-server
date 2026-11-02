/**
 * LOCAL-ONLY demo seed for the partner program.
 * Refuses to run unless MONGODB_URI points at localhost/127.0.0.1.
 *   npm run seed:partner-demo
 * Writes demo login tokens to /tmp/partner-demo-session.json (local screenshots only).
 */
import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel } from '../src/models/User';
import { AdminUserModel } from '../src/models/AdminUser';
import { SubscriptionModel } from '../src/models/Subscription';
import { SubscriptionPlanModel } from '../src/models/SubscriptionPlan';
import { PartnerModel } from '../src/models/Partner';
import { PartnerApplicationModel } from '../src/models/PartnerApplication';
import { PartnerCommissionModel } from '../src/models/PartnerCommission';
import { PartnerPayoutModel } from '../src/models/PartnerPayout';
import { getPartnerProgramSettings, PartnerProgramSettingsModel } from '../src/models/PartnerProgramSettings';
import { recordCommissionForPayment, reverseCommissionForPayment, applyBuyerDiscount, tdsForPartnerPayout, round2 } from '../src/lib/partnerCommission';

const uri = process.env.MONGODB_URI || '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) {
  console.error('Refusing to seed: MONGODB_URI is not a local database.');
  process.exit(1);
}
const DAY = 86400000;
const NAMES = ['Aarav Mehta','Diya Patel','Vihaan Rao','Ananya Iyer','Kabir Singh','Isha Verma','Arjun Nair','Meera Joshi','Rohan Gupta','Sana Khan','Aditya Kulkarni','Priya Menon','Karan Malhotra','Neha Reddy','Yash Agarwal','Tara Bose','Dev Chauhan','Riya Sharma','Nikhil Das','Pooja Pillai'];

async function main() {
  await mongoose.connect(uri);
  await PartnerProgramSettingsModel.deleteMany({}); // reset to current defaults (gross base, 10% buyer discount, TDS 2% / ₹20k)
  const settings = await getPartnerProgramSettings();

  // clean previous demo data
  const demoUsers = await UserModel.find({ email: /@partner-demo\.local$/ }).select('_id').lean();
  const ids = demoUsers.map((u) => u._id);
  const oldPartners = await PartnerModel.find({ userId: { $in: ids } }).select('_id').lean();
  await PartnerCommissionModel.deleteMany({ partnerId: { $in: oldPartners.map((p) => p._id) } });
  await PartnerPayoutModel.deleteMany({ partnerId: { $in: oldPartners.map((p) => p._id) } });
  await PartnerModel.deleteMany({ userId: { $in: ids } });
  await PartnerApplicationModel.deleteMany({ userId: { $in: ids } });
  await SubscriptionModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });

  let plan = await SubscriptionPlanModel.findOne({}).lean();
  if (!plan) plan = (await SubscriptionPlanModel.create({ name: 'Premium Yearly', duration: 'year', durationValue: 1, price: 999, discount: 0, totalPrice: 999 })).toObject();

  const admin = await AdminUserModel.findOneAndUpdate(
    { email: 'admin@partner-demo.local' },
    { $setOnInsert: { name: 'Demo Superadmin', passwordHash: await bcrypt.hash(Math.random().toString(36), 10), role: 'superadmin', isActive: true } },
    { upsert: true, returnDocument: 'after' },
  );

  const pu = await UserModel.create({ email: 'riya.partner@partner-demo.local', name: 'Riya Kapoor', phone: '9876500001', status: 'active' } as any);
  const app = await PartnerApplicationModel.create({
    userId: pu._id, fullName: 'Riya Kapoor', email: pu.email, phone: '9876500001', city: 'Mumbai', state: 'Maharashtra',
    promotionChannels: ['instagram', 'youtube'], audienceSize: '50k-100k', socialLinks: ['https://instagram.com/riya.reels'],
    payoutMethod: 'upi', upiId: 'riya@okaxis', agreedToTerms: true, status: 'approved', reviewedBy: admin._id, reviewedAt: new Date(Date.now() - 30 * DAY),
  } as any);
  const partner = await PartnerModel.create({
    userId: pu._id, applicationId: app._id, code: 'RIYA2026', displayName: 'Riya Kapoor', email: pu.email, phone: '9876500001',
    status: 'active', payoutMethod: 'upi', upiId: 'riya@okaxis', approvedAt: new Date(Date.now() - 30 * DAY), approvedBy: admin._id, pan: 'ABCPR1234K',
  } as any);
  app.set('partnerId', partner._id); await app.save();

  // pending applications for the admin queue
  for (const [i, [n, city]] of [['Karthik Subramanian', 'Chennai'], ['Fatima Sheikh', 'Hyderabad'], ['Gurpreet Gill', 'Ludhiana']].entries() as any) {
    const u = await UserModel.create({ email: `applicant${i}@partner-demo.local`, name: n, phone: `98765100${i}0` } as any);
    await PartnerApplicationModel.create({
      userId: u._id, fullName: n, email: u.email, phone: `98765100${i}0`, city, state: '',
      promotionChannels: i === 1 ? ['social', 'other'] : ['instagram'], audienceSize: ['10k-50k', '1k-10k', '100k+'][i], socialLinks: [],
      payoutMethod: 'upi', upiId: `user${i}@upi`, agreedToTerms: true, status: i === 2 ? 'under_review' : 'pending', createdAt: new Date(Date.now() - (i + 1) * 3600000),
    } as any);
  }

  // 20 referred users over the last 28 days; 9 purchase
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.now() - (27 - i) * DAY - (i % 5) * 3600000);
    const u = await UserModel.create({ email: `ref${i}@partner-demo.local`, name: NAMES[i], status: 'active', referredBy: 'RIYA2026', referredByPartnerId: partner._id, referredAt: at, referralSource: i % 3 ? 'link' : 'signup_code', createdAt: at } as any);
    if (i % 2 === 0 || i === 19) {
      const yearly = i % 4 === 0;
      const listPrice = yearly ? 999 : 149;
      const discounted = i % 4 !== 2; // most sales via partner discount
      const d = discounted ? applyBuyerDiscount(listPrice, settings.buyerDiscountPercent) : { discountAmount: 0, finalAmount: listPrice };
      const price = d.finalAmount; const tax = round2(price * 0.18);
      const sub = await SubscriptionModel.create({ userId: u._id, planId: plan!._id, plan: yearly ? 'Premium Yearly' : 'Premium Monthly', duration: yearly ? 'year' : 'month', durationValue: 1, paymentMethod: 'razorpay', startDate: at, endDate: new Date(at.getTime() + (yearly ? 365 : 30) * DAY), price, tax, totalAmount: round2(price + tax), couponCode: discounted ? 'RIYA2026' : undefined, couponDiscount: d.discountAmount, status: 'active' } as any);
      const pid = `pay_demo_${i}`;
      await recordCommissionForPayment({ userId: String(u._id), paymentId: pid, orderId: `order_demo_${i}`, subscriptionId: String(sub._id), planName: sub.plan, saleAmount: sub.totalAmount, tax, listPrice, discountAmount: d.discountAmount, discountPercent: discounted ? settings.buyerDiscountPercent : 0, discountCode: discounted ? 'RIYA2026' : undefined });
      const purchasedAt = i >= 18 ? new Date(Date.now() - (19 - i + 1) * DAY) : new Date(at.getTime() + DAY / 2);
      await PartnerCommissionModel.updateOne({ paymentId: pid }, { createdAt: purchasedAt, holdUntil: new Date(purchasedAt.getTime() + settings.holdDays * DAY) }, { timestamps: false });
    }
  }
  // one refund
  await reverseCommissionForPayment('pay_demo_6', 'Refund requested by customer');

  // mature + one paid payout from the oldest approved commissions
  await PartnerCommissionModel.updateMany({ status: 'pending', holdUntil: { $lte: new Date() } }, { status: 'approved', approvedAt: new Date() });
  const oldest = await PartnerCommissionModel.find({ partnerId: partner._id, status: 'approved' }).sort({ createdAt: 1 }).limit(3);
  // earlier this FY: ₹15,000 (under ₹20k → no TDS) then ₹6,000 (crosses ₹20k → 2% on the whole ₹21,000 = ₹420), simulating prior campaign earnings
  for (const [gross, daysAgo, ref] of [[15000, 60, 'UTR4400917733'], [6000, 20, 'UTR4401552904']] as const) {
    const at = new Date(Date.now() - daysAgo * DAY);
    const t0 = await tdsForPartnerPayout(partner._id, gross, at);
    await PartnerPayoutModel.create({ partnerId: partner._id, amount: gross, tdsRate: t0.rate ?? settings.tdsRate, tdsAmount: t0.tdsAmount, netAmount: t0.netAmount, financialYear: t0.financialYear, tdsSection: t0.section, pan: 'ABCPR1234K', commissionIds: [], method: 'upi', destination: 'ri***@okaxis', status: 'paid', reference: ref, processedBy: admin._id, processedAt: at, createdAt: at } as any);
  }
  // recent paid payout crosses the threshold → TDS on the whole FY amount
  const amt = round2(oldest.reduce((s, c) => s + c.amount, 0));
  const paidAt = new Date(Date.now() - 5 * DAY);
  const t = await tdsForPartnerPayout(partner._id, amt, paidAt);
  const payout = await PartnerPayoutModel.create({ partnerId: partner._id, amount: amt, tdsRate: t.rate ?? settings.tdsRate, tdsAmount: t.tdsAmount, netAmount: t.netAmount, financialYear: t.financialYear, tdsSection: t.section, pan: 'ABCPR1234K', commissionIds: oldest.map((c) => c._id), method: 'upi', destination: 'ri***@okaxis', status: 'paid', reference: 'UTR4402291188', processedBy: admin._id, processedAt: paidAt, createdAt: new Date(Date.now() - 6 * DAY) } as any);
  await PartnerCommissionModel.updateMany({ _id: { $in: oldest.map((c) => c._id) } }, { status: 'paid', paidAt, payoutId: payout._id });
  // one requested payout awaiting admin
  const next = await PartnerCommissionModel.find({ partnerId: partner._id, status: 'approved' }).sort({ createdAt: 1 }).limit(2);
  if (next.length) {
    const g = round2(next.reduce((s, c) => s + c.amount, 0));
    const tr = await tdsForPartnerPayout(partner._id, g);
    const req = await PartnerPayoutModel.create({ partnerId: partner._id, amount: g, tdsRate: tr.rate ?? settings.tdsRate, tdsAmount: tr.tdsAmount, netAmount: tr.netAmount, financialYear: tr.financialYear, tdsSection: tr.section, pan: 'ABCPR1234K', commissionIds: next.map((c) => c._id), method: 'upi', destination: 'ri***@okaxis', status: 'requested' } as any);
    await PartnerCommissionModel.updateMany({ _id: { $in: next.map((c) => c._id) } }, { payoutId: req._id });
  }
  // a buyer (not yet subscribed) attributed to RIYA2026 for the checkout-with-discount screenshot
  const buyer = await UserModel.create({ email: 'buyer@partner-demo.local', name: 'Aman Buyer', status: 'active', referredBy: 'RIYA2026', referredByPartnerId: partner._id, referredAt: new Date(), referralSource: 'link' } as any);

  const secret = process.env.JWT_SECRET!;
  const session = {
    appAccessToken: jwt.sign({ id: String(pu._id), name: pu.name, role: 'user' }, secret, { expiresIn: '7d' }),
    applicantAccessToken: jwt.sign({ id: String((await UserModel.findOne({ email: 'applicant0@partner-demo.local' }))!._id), name: 'Karthik Subramanian', role: 'user' }, secret, { expiresIn: '7d' }),
    adminAccessToken: jwt.sign({ id: String(admin._id), email: admin.email, name: admin.name, role: 'superadmin' }, secret, { expiresIn: '7d' }),
    buyerAccessToken: jwt.sign({ id: String(buyer._id), name: buyer.name, role: 'user' }, secret, { expiresIn: '7d' }),
    buyerUser: { _id: String(buyer._id), id: String(buyer._id), name: buyer.name, email: buyer.email },
    partnerUser: { id: String(pu._id), name: pu.name, email: pu.email },
  };
  fs.writeFileSync('/tmp/partner-demo-session.json', JSON.stringify(session), { mode: 0o600 });
  const counts = await PartnerCommissionModel.aggregate([{ $match: { partnerId: partner._id } }, { $group: { _id: '$status', n: { $sum: 1 }, amt: { $sum: '$amount' } } }]);
  console.log('Seeded partner RIYA2026 with 20 referrals; commissions:', JSON.stringify(counts));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
