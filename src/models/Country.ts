import { adminAuditPlugin } from '../middlewares/adminAuditPlugin';
import mongoose, { Schema, Document } from 'mongoose';

export interface ICountry extends Document {
  name: string;
  code: string;
  active: boolean;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CountrySchema = new Schema<ICountry>(
  {
    name: { type: String, required: true, index: true },
    code: { type: String, required: true, unique: true, uppercase: true },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

CountrySchema.plugin(adminAuditPlugin);
export const CountryModel = mongoose.model<ICountry>('Country', CountrySchema);
