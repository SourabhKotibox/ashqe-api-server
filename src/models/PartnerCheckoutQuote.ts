import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Server-side record of the price we charged for a Razorpay order. Written when the order is
 * created and read back on verify, so the discounted amount is never taken from the client.
 */
export interface IPartnerCheckoutQuote extends Document {
  orderId: string;
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  listPrice: number;
  discountPercent: number;
  discountAmount: number;
  finalAmount: number;
  partnerId?: Types.ObjectId;
  code?: string;
  source?: 'attributed' | 'checkout_code';
  createdAt: Date;
}

const schema = new Schema<IPartnerCheckoutQuote>(
  {
    orderId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    listPrice: { type: Number, required: true },
    discountPercent: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    finalAmount: { type: Number, required: true },
    partnerId: { type: Schema.Types.ObjectId, ref: 'Partner' },
    code: String,
    source: String,
  },
  { timestamps: true }
);

export const PartnerCheckoutQuoteModel = mongoose.model<IPartnerCheckoutQuote>('PartnerCheckoutQuote', schema);
