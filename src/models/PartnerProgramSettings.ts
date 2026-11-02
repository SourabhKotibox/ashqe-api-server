import mongoose, { Schema, Document } from 'mongoose';

/**
 * Singleton settings document for the Partner (affiliate/reseller) program.
 * Kept separate from Settings and from admin role-based access.
 */
export interface IPartnerProgramSettings extends Document {
  enabled: boolean;
  defaultCommissionRate: number; // percent, e.g. 10 = 10%
  commissionOnRenewals: boolean; // false = only the referred user's first paid subscription earns
  holdDays: number; // refund window before a commission becomes payable
  minPayout: number; // minimum available balance to request a payout (INR)
  attributionWindowDays: number; // how long after signup a user may still enter a partner code
  commissionBase: 'net' | 'gross'; // gross = full amount the buyer paid incl. GST (after discount)
  buyerDiscountEnabled: boolean; // partner code gives the buyer a discount at checkout
  buyerDiscountPercent: number; // program default; per-partner override on Partner.couponDiscountPercent
  discountOnRenewals: boolean; // false = discount only on the buyer's first paid purchase
  tdsEnabled: boolean;
  tdsRate: number; // percent; Income-tax Act 2025 s.393(1) Sl.1(ii) (old s.194H) = 2%
  tdsThresholdPerFY: number; // aggregate commission per FY above which TDS applies on the whole amount (₹20,000)
  tdsSection: string;
  reviewSlaHours: number;
  termsUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PartnerProgramSettingsSchema = new Schema<IPartnerProgramSettings>(
  {
    enabled: { type: Boolean, default: true },
    defaultCommissionRate: { type: Number, default: 10, min: 0, max: 100 },
    commissionOnRenewals: { type: Boolean, default: true },
    holdDays: { type: Number, default: 7, min: 0 },
    minPayout: { type: Number, default: 500, min: 0 },
    attributionWindowDays: { type: Number, default: 7, min: 0 },
    commissionBase: { type: String, enum: ['net', 'gross'], default: 'gross' },
    buyerDiscountEnabled: { type: Boolean, default: true },
    buyerDiscountPercent: { type: Number, default: 10, min: 0, max: 90 },
    discountOnRenewals: { type: Boolean, default: false },
    tdsEnabled: { type: Boolean, default: true },
    tdsRate: { type: Number, default: 2, min: 0, max: 30 },
    tdsThresholdPerFY: { type: Number, default: 20000, min: 0 },
    tdsSection: { type: String, default: '393(1) Sl.1(ii) IT Act 2025 (old 194H)' },
    reviewSlaHours: { type: Number, default: 24 },
    termsUrl: String,
  },
  { timestamps: true }
);

export const PartnerProgramSettingsModel = mongoose.model<IPartnerProgramSettings>(
  'PartnerProgramSettings',
  PartnerProgramSettingsSchema
);

export async function getPartnerProgramSettings() {
  let doc = await PartnerProgramSettingsModel.findOne().lean();
  if (!doc) {
    await PartnerProgramSettingsModel.create({});
    doc = await PartnerProgramSettingsModel.findOne().lean();
  }
  return doc as IPartnerProgramSettings;
}
