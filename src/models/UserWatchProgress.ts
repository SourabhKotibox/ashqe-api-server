import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUserWatchProgress extends Document {
  userId: Types.ObjectId;
  contentId: Types.ObjectId;
  contentModelType: 'Movie'; // which collection contentId refers to
  profileId?: string | null; // OTT profile isolation (null = default/unscoped)
  progressSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  lastWatchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserWatchProgressSchema = new Schema<IUserWatchProgress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentId: { type: Schema.Types.ObjectId, required: true, refPath: 'contentModelType', index: true },
    contentModelType: { type: String, enum: ['Movie'], required: true },
    profileId: { type: String, default: null, index: true },
    progressSeconds: { type: Number, required: true },
    durationSeconds: { type: Number, required: true },
    progressPercent: { type: Number, required: true },
    lastWatchedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// Unique constraint: one record per user per content
UserWatchProgressSchema.index({ userId: 1, contentId: 1 }, { unique: true });

export const UserWatchProgressModel = mongoose.model<IUserWatchProgress>('UserWatchProgress', UserWatchProgressSchema);
