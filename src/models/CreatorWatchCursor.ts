import mongoose, { Schema, Document, Types } from 'mongoose';

/** Last playback observation for one viewer, asset, and session. Used to measure wall-clock deltas. */
export interface ICreatorWatchCursor extends Document {
  viewerUserId: Types.ObjectId;
  contentId: Types.ObjectId;
  sessionId: string;
  lastEventAt: Date;
  lastPositionSeconds: number;
  creditedSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}

const CreatorWatchCursorSchema = new Schema<ICreatorWatchCursor>(
  {
    viewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    contentId: { type: Schema.Types.ObjectId, required: true },
    sessionId: { type: String, required: true },
    lastEventAt: { type: Date, required: true },
    lastPositionSeconds: { type: Number, required: true, default: 0 },
    creditedSeconds: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

CreatorWatchCursorSchema.index({ viewerUserId: 1, contentId: 1, sessionId: 1 }, { unique: true });

export const CreatorWatchCursorModel = mongoose.model<ICreatorWatchCursor>(
  'CreatorWatchCursor',
  CreatorWatchCursorSchema
);
