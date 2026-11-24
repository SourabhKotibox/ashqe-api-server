import mongoose, { Schema, Document, Types } from 'mongoose';

export type CreatorApplicationStatus = 'pending' | 'under_review' | 'approved' | 'rejected';
export type CreatorContentType = 'movie' | 'webseries';

/**
 * Public creator / influencer applications.
 * Kept fully separate from PartnerApplication (affiliate/reseller program).
 */
export interface ICreatorApplication extends Document {
  fullName: string;
  email: string;
  phone: string;
  city?: string;
  state?: string;
  channelName?: string;
  contentTypes: CreatorContentType[];
  sampleLinks: string[];
  portfolioSummary: string;
  copyrightAttested: boolean;
  copyrightAttestedAt?: Date;
  status: CreatorApplicationStatus;
  rejectionReason?: string;
  adminNotes?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  adminUserId?: Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CreatorApplicationSchema = new Schema<ICreatorApplication>(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    phone: { type: String, required: true, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    channelName: { type: String, trim: true },
    contentTypes: {
      type: [{ type: String, enum: ['movie', 'webseries'] }],
      required: true,
      validate: {
        validator: (v: string[]) => Array.isArray(v) && v.length > 0,
        message: 'At least one content type is required',
      },
    },
    sampleLinks: { type: [String], default: [] },
    portfolioSummary: { type: String, required: true, trim: true },
    copyrightAttested: { type: Boolean, required: true },
    copyrightAttestedAt: Date,
    status: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    rejectionReason: String,
    adminNotes: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: Date,
    adminUserId: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    ipAddress: String,
    userAgent: String,
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

CreatorApplicationSchema.index({ email: 1, status: 1 });
CreatorApplicationSchema.index({ createdAt: -1 });

export const CreatorApplicationModel = mongoose.model<ICreatorApplication>(
  'CreatorApplication',
  CreatorApplicationSchema
);
