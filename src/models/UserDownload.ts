import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUserDownload extends Document {
  userId: Types.ObjectId;
  contentId: Types.ObjectId;
  contentModelType: 'Movie'; // which collection contentId refers to
  profileId?: string | null; // OTT profile isolation (null = default/unscoped)
  createdAt: Date;
  updatedAt: Date;
}

const UserDownloadSchema = new Schema<IUserDownload>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentId: { type: Schema.Types.ObjectId, required: true, index: true },
    contentModelType: { type: String, enum: ['Movie'], required: true },
    profileId: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

// Unique constraint: one record per user per content
UserDownloadSchema.index({ userId: 1, contentId: 1 }, { unique: true });

export const UserDownloadModel = mongoose.model<IUserDownload>('UserDownload', UserDownloadSchema);
