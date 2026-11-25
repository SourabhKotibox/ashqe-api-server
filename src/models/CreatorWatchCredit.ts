import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * One accepted or rejected playback report. idempotencyKey makes retries a no-op.
 * earningUnits snapshots the rate at credit time (seconds * paise per hour).
 * Reports read CreatorRevenueDaily; this collection is the audit trail those rows are built from.
 */
export interface ICreatorWatchCredit extends Document {
  idempotencyKey: string;
  source: 'heartbeat' | 'progress';
  viewerUserId: Types.ObjectId;
  creatorId?: Types.ObjectId | null;
  contentId: Types.ObjectId;
  titleId?: Types.ObjectId | null;
  titleType?: 'movie' | 'series' | null;
  episodeId?: Types.ObjectId | null;
  sessionId: string;
  profileId?: string | null;
  day: string;
  watchedAt: Date;
  creditedSeconds: number;
  rateInrPerHour: number;
  ratePaisePerHour: number;
  earningUnits: number;
  reason: string;
  applied: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CreatorWatchCreditSchema = new Schema<ICreatorWatchCredit>(
  {
    idempotencyKey: { type: String, required: true },
    source: { type: String, enum: ['heartbeat', 'progress'], required: true },
    viewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    contentId: { type: Schema.Types.ObjectId, required: true },
    titleId: { type: Schema.Types.ObjectId, default: null },
    titleType: { type: String, enum: ['movie', 'series'] },
    episodeId: { type: Schema.Types.ObjectId, default: null },
    sessionId: { type: String, required: true },
    profileId: { type: String, default: null },
    day: { type: String, required: true },
    watchedAt: { type: Date, required: true },
    creditedSeconds: { type: Number, required: true, min: 0 },
    rateInrPerHour: { type: Number, required: true, min: 0 },
    ratePaisePerHour: { type: Number, required: true, min: 0 },
    earningUnits: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true },
    applied: { type: Boolean, default: false },
  },
  { timestamps: true }
);

CreatorWatchCreditSchema.index({ idempotencyKey: 1 }, { unique: true });
CreatorWatchCreditSchema.index({ creatorId: 1, watchedAt: -1 });
CreatorWatchCreditSchema.index({ viewerUserId: 1, contentId: 1, watchedAt: -1 });

export const CreatorWatchCreditModel = mongoose.model<ICreatorWatchCredit>(
  'CreatorWatchCredit',
  CreatorWatchCreditSchema
);
