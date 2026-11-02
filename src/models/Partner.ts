import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IPartner extends Document {
  userId: Types.ObjectId;
  applicationId?: Types.ObjectId;
  code: string; // unique referral code, e.g. RAHUL10
  displayName: string;
  email?: string;
  phone?: string;
  commissionRate?: number | null; // percent override; null/undefined = program default
  status: 'active' | 'suspended';
  couponCode?: string; // optional discount coupon tied to this partner (not yet applied at checkout)
  couponDiscountPercent?: number;
  payoutMethod: 'upi' | 'bank';
  upiId?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  ifsc?: string;
  pan?: string;
  approvedAt?: Date;
  approvedBy?: Types.ObjectId;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PartnerSchema = new Schema<IPartner>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'PartnerApplication' },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    displayName: { type: String, required: true },
    email: String,
    phone: String,
    commissionRate: { type: Number, min: 0, max: 100, default: null },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    couponCode: { type: String, uppercase: true, trim: true },
    couponDiscountPercent: { type: Number, min: 0, max: 100 },
    payoutMethod: { type: String, enum: ['upi', 'bank'], default: 'upi' },
    upiId: String,
    bankAccountName: String,
    bankAccountNumber: String,
    ifsc: String,
    pan: String,
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    notes: String,
  },
  { timestamps: true }
);

export const PartnerModel = mongoose.model<IPartner>('Partner', PartnerSchema);
