import mongoose, { Schema, Document, Types } from 'mongoose';

export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'reversed';

/**
 * Commission ledger. One row per successful payment by a referred user.
 * `paymentId` is unique => recording the same payment twice is a no-op (idempotent).
 */
export interface IPartnerCommission extends Document {
  partnerId: Types.ObjectId;
  referredUserId: Types.ObjectId;
  subscriptionId?: Types.ObjectId;
  paymentId: string;
  orderId?: string;
  planName?: string;
  saleAmount: number; // what the user actually paid (incl. GST, after discount)
  listPrice?: number; // plan price before partner discount
  discountAmount?: number;
  discountPercent?: number;
  discountCode?: string;
  baseAmount: number; // amount commission is computed on
  rate: number; // percent applied
  amount: number; // commission in INR
  isRenewal: boolean;
  status: CommissionStatus;
  holdUntil: Date;
  approvedAt?: Date;
  payoutId?: Types.ObjectId;
  paidAt?: Date;
  reversedAt?: Date;
  reversalReason?: string;
  reversedAfterPaid?: boolean; // clawback: deducted from future balance
  createdAt: Date;
  updatedAt: Date;
}

const PartnerCommissionSchema = new Schema<IPartnerCommission>(
  {
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner', required: true, index: true },
    referredUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    paymentId: { type: String, required: true, unique: true },
    orderId: String,
    planName: String,
    saleAmount: { type: Number, required: true, min: 0 },
    listPrice: Number,
    discountAmount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    discountCode: String,
    baseAmount: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    isRenewal: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'approved', 'paid', 'reversed'], default: 'pending', index: true },
    holdUntil: { type: Date, required: true },
    approvedAt: Date,
    payoutId: { type: Schema.Types.ObjectId, ref: 'PartnerPayout', index: true },
    paidAt: Date,
    reversedAt: Date,
    reversalReason: String,
    reversedAfterPaid: { type: Boolean, default: false },
  },
  { timestamps: true }
);

PartnerCommissionSchema.index({ partnerId: 1, createdAt: -1 });

export const PartnerCommissionModel = mongoose.model<IPartnerCommission>(
  'PartnerCommission',
  PartnerCommissionSchema
);
