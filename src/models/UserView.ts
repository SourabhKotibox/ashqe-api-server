import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUserView extends Document {
  userId: Types.ObjectId;
  contentId: Types.ObjectId;
  contentModelType: 'Movie' | 'TVShow' | 'Episode';
  createdAt: Date;
  updatedAt: Date;
}

const UserViewSchema = new Schema<IUserView>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentId: { type: Schema.Types.ObjectId, required: true, index: true },
    contentModelType: { type: String, enum: ['Movie', 'TVShow', 'Episode'], required: true },
  },
  { timestamps: true }
);

// Unique constraint: one record per user per content
UserViewSchema.index({ userId: 1, contentId: 1 }, { unique: true });

export const UserViewModel = mongoose.model<IUserView>('UserView', UserViewSchema);
