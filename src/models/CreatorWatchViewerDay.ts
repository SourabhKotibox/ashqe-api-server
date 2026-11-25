import mongoose, { Schema, Document, Types } from 'mongoose';

/** Seconds already credited to one viewer for one asset on one IST day. Enforces the daily cap. */
export interface ICreatorWatchViewerDay extends Document {
  viewerUserId: Types.ObjectId;
  contentId: Types.ObjectId;
  day: string;
  creditedSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}

const CreatorWatchViewerDaySchema = new Schema<ICreatorWatchViewerDay>(
  {
    viewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    contentId: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    creditedSeconds: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

CreatorWatchViewerDaySchema.index({ viewerUserId: 1, contentId: 1, day: 1 }, { unique: true });

export const CreatorWatchViewerDayModel = mongoose.model<ICreatorWatchViewerDay>(
  'CreatorWatchViewerDay',
  CreatorWatchViewerDaySchema
);
