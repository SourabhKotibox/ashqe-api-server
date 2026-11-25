import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Append-only INR per watch-hour rate.
 * `creatorId` null is the global default. A set creatorId is that creator's override.
 * The row used for a credit is the creator override with the latest effectiveFrom
 * at or before the credit, or the default row when the creator has none yet.
 * `opening` marks the default Rs 5 row so it can be inserted once.
 */
export interface ICreatorRevenueRate extends Document {
  creatorId?: Types.ObjectId | null;
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
    creatorId: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    opening: { type: Boolean, default: false },
    rateInrPerHour: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    note: String,
  },
  { timestamps: true }
);

CreatorRevenueRateSchema.index({ creatorId: 1, effectiveFrom: -1 }, { unique: true });
CreatorRevenueRateSchema.index(
  { opening: 1 },
  { unique: true, partialFilterExpression: { opening: true } }
);

export const CreatorRevenueRateModel = mongoose.model<ICreatorRevenueRate>(
  'CreatorRevenueRate',
  CreatorRevenueRateSchema
);
