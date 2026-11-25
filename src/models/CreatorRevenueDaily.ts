import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Accrual bucket: one IST day, one creator, one movie or one episode.
 * Sum episode rows to get the series. Payouts can later set payoutId on a closed day.
 * A credit that arrives after that row is locked is written at the next `generation`
 * so the paid total is not rewritten and the new seconds stay payable.
 */
export interface ICreatorRevenueDaily extends Document {
  creatorId: Types.ObjectId;
  day: string;
  titleId: Types.ObjectId;
  titleType: 'movie' | 'series';
  episodeKey: string;
  episodeId?: Types.ObjectId | null;
  generation: number;
  supplement: boolean;
  title: string;
  episodeTitle?: string;
  season?: number;
  episodeNumber?: number;
  watchSeconds: number;
  earningUnits: number;
  payoutId?: Types.ObjectId | null;
  paidAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CreatorRevenueDailySchema = new Schema<ICreatorRevenueDaily>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    day: { type: String, required: true },
    titleId: { type: Schema.Types.ObjectId, required: true },
    titleType: { type: String, enum: ['movie', 'series'], required: true },
    episodeKey: { type: String, required: true, default: '' },
    episodeId: { type: Schema.Types.ObjectId, default: null },
    generation: { type: Number, required: true, default: 0, min: 0 },
    supplement: { type: Boolean, default: false },
    title: { type: String, required: true },
    episodeTitle: String,
    season: Number,
    episodeNumber: Number,
    watchSeconds: { type: Number, required: true, default: 0, min: 0 },
    earningUnits: { type: Number, required: true, default: 0, min: 0 },
    payoutId: { type: Schema.Types.ObjectId, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CreatorRevenueDailySchema.index(
  { creatorId: 1, day: 1, titleId: 1, episodeKey: 1, generation: 1 },
  { unique: true }
);
CreatorRevenueDailySchema.index({ day: 1, creatorId: 1 });
CreatorRevenueDailySchema.index({ creatorId: 1, payoutId: 1, day: 1 });

export const CreatorRevenueDailyModel = mongoose.model<ICreatorRevenueDaily>(
  'CreatorRevenueDaily',
  CreatorRevenueDailySchema
);
