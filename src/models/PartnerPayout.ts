import mongoose, { Schema, Document, Types } from 'mongoose';

export type PayoutStatus = 'requested' | 'paid' | 'rejected';

export interface IPartnerPayout extends Document {
  partnerId: Types.ObjectId;
  amount: number;
  commissionIds: Types.ObjectId[];
  clawbackDeducted: number;
  method: 'upi' | 'bank';
  destination: string; // masked UPI / account snapshot
  status: PayoutStatus;
  reference?: string; // UTR / transaction reference entered by admin
  adminNote?: string;
  processedBy?: Types.ObjectId;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PartnerPayoutSchema = new Schema<IPartnerPayout>(
  {
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    commissionIds: [{ type: Schema.Types.ObjectId, ref: 'PartnerCommission' }],
    clawbackDeducted: { type: Number, default: 0 },
    method: { type: String, enum: ['upi', 'bank'], default: 'upi' },
    destination: String,
    status: { type: String, enum: ['requested', 'paid', 'rejected'], default: 'requested', index: true },
    reference: String,
    adminNote: String,
    processedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    processedAt: Date,
  },
  { timestamps: true }
);

export const PartnerPayoutModel = mongoose.model<IPartnerPayout>('PartnerPayout', PartnerPayoutSchema);
