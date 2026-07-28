import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUserLike extends Document {
  userId: Types.ObjectId;
  contentId: Types.ObjectId;
  contentModelType: 'Movie'; // which collection contentId refers to
  createdAt: Date;
}

const UserLikeSchema = new Schema<IUserLike>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentId: { type: Schema.Types.ObjectId, required: true, index: true },
    contentModelType: { type: String, enum: ['Movie'], required: true },
  },
  { timestamps: true }
);

// Unique constraint: one record per user per content
UserLikeSchema.index({ userId: 1, contentId: 1 }, { unique: true });

export const UserLikeModel = mongoose.model<IUserLike>('UserLike', UserLikeSchema);
