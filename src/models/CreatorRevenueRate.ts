import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Append-only INR per watch-hour rate.
 * The row with the latest effectiveFrom at or before a credit is the rate for that credit.
 * `opening` marks the default Rs 5 row so it can be inserted once.
 */
export interface ICreatorRevenueRate extends Document {
  opening: boolean;
  rateInrPerHour: number;
  effectiveFrom: Date;
  setBy?: Types.ObjectId;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CreatorRevenueRateSchema = new Schema<ICreatorRevenueRate>(
  {
    opening: { type: Boolean, default: false },
    rateInrPerHour: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    note: String,
  },
  { timestamps: true }
);

CreatorRevenueRateSchema.index({ effectiveFrom: -1 }, { unique: true });
CreatorRevenueRateSchema.index(
  { opening: 1 },
  { unique: true, partialFilterExpression: { opening: true } }
);

export const CreatorRevenueRateModel = mongoose.model<ICreatorRevenueRate>(
  'CreatorRevenueRate',
  CreatorRevenueRateSchema
);
