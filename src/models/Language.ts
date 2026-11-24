import { adminAuditPlugin } from '../middlewares/adminAuditPlugin';
import mongoose, { Schema, Document } from 'mongoose';

export interface ILanguage extends Document {
  name: string;
  code: string;
  image?: string;
  isActive: boolean;
  order: number;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const LanguageSchema = new Schema<ILanguage>(
  {
    name: { type: String, required: true, index: true },
    code: { type: String, required: true, unique: true, index: true },
    image: String,
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

LanguageSchema.plugin(adminAuditPlugin);
export const LanguageModel = mongoose.model<ILanguage>('Language', LanguageSchema);
