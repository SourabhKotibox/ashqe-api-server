import mongoose, { Schema, Document, Types } from 'mongoose';

export type PartnerApplicationStatus = 'pending' | 'under_review' | 'approved' | 'rejected';

export interface IPartnerApplication extends Document {
  userId: Types.ObjectId;
  fullName: string;
  phone: string;
  email: string;
  city?: string;
  state?: string;
  promotionChannels: string[]; // social | youtube | instagram | offline | other
  promotionDetails?: string;
  audienceSize?: string;
  socialLinks: string[];
  pan?: string;
  payoutMethod: 'upi' | 'bank';
  upiId?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  ifsc?: string;
  agreedToTerms: boolean;
  status: PartnerApplicationStatus;
  rejectionReason?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  partnerId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PartnerApplicationSchema = new Schema<IPartnerApplication>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    city: String,
    state: String,
    promotionChannels: { type: [String], default: [] },
    promotionDetails: String,
    audienceSize: String,
    socialLinks: { type: [String], default: [] },
    pan: { type: String, uppercase: true, trim: true },
    payoutMethod: { type: String, enum: ['upi', 'bank'], default: 'upi' },
    upiId: String,
    bankAccountName: String,
    bankAccountNumber: String,
    ifsc: { type: String, uppercase: true, trim: true },
    agreedToTerms: { type: Boolean, required: true },
    status: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    rejectionReason: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: Date,
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner' },
  },
  { timestamps: true }
);

PartnerApplicationSchema.index({ createdAt: -1 });

export const PartnerApplicationModel = mongoose.model<IPartnerApplication>(
  'PartnerApplication',
  PartnerApplicationSchema
);
