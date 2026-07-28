import type { FastifyRequest, FastifyReply } from 'fastify';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { UserModel } from '../models/User';

const roundCurrency = (value: number) => Math.round(value * 100) / 100;

const toNumber = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const formatDate = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().split('T')[0];
};

/** Map plan display names → User.subscriptionPlan enum */
export const normalizePlanKey = (
  name?: string | null
): 'free' | 'basic' | 'standard' | 'premium' => {
  const n = String(name || 'free').toLowerCase().trim();
  if (!n || n === 'free') return 'free';
  if (n.includes('premium') || n.includes('vip')) return 'premium';
  if (n.includes('standard')) return 'standard';
  if (n.includes('basic')) return 'basic';
  // Any other paid plan name → standard access tier
  return 'standard';
};

const formatDurationLabel = (duration: string, durationValue: number) => {
  const d = String(duration || '').toLowerCase();
  const n = Math.max(1, durationValue || 1);
  if (d.includes('day')) return n === 1 ? '1 Day' : `${n} Days`;
  if (d.includes('week')) return n === 1 ? '1 Week' : `${n} Weeks`;
  if (d.includes('year')) return n === 1 ? '1 Year' : `${n} Years`;
  if (d.includes('month')) return n === 1 ? '1 Month' : `${n} Months`;
  if (/\d/.test(duration) && !d.includes('month')) return duration;
  return `${n} ${duration || 'Month'}`;
};

/**
 * durationValue semantics:
 * - "Day(s)" → days
 * - "Week(s)" → weeks
 * - "Month(s)/Monthly" → months (if value looks like days for monthly, e.g. 30 with Monthly, treat as 1 month)
 * - "Year(s)" → years
 */
const addDuration = (start: Date, duration: string, durationValue: number) => {
  const end = new Date(start);
  const normalized = String(duration || '').toLowerCase();
  let value = Math.max(1, Math.trunc(durationValue || 1));

  // Common misconfig: Monthly + durationValue 30 (meant ₹30 / 30 days) → 1 month
  if (normalized.includes('month') && value >= 28 && value <= 31) {
    value = 1;
  }

  if (normalized.includes('day')) {
    end.setDate(end.getDate() + value);
    return end;
  }
  if (normalized.includes('week')) {
    end.setDate(end.getDate() + value * 7);
    return end;
  }
  if (normalized.includes('year')) {
    end.setFullYear(end.getFullYear() + value);
    return end;
  }

  end.setMonth(end.getMonth() + value);
  return end;
};

const serializeSubscription = (subscription: any) => {
  const user = subscription.userId && typeof subscription.userId === 'object' ? subscription.userId : null;
  const plan = subscription.planId && typeof subscription.planId === 'object' ? subscription.planId : null;

  return {
    id: String(subscription._id),
    userId: user?._id ? String(user._id) : String(subscription.userId || ''),
    userName: user?.name || '',
    userEmail: user?.email || '',
    planId: plan?._id ? String(plan._id) : String(subscription.planId || ''),
    plan: subscription.plan,
    duration: subscription.duration,
    durationValue: subscription.durationValue || 1,
    durationLabel: formatDurationLabel(subscription.duration, subscription.durationValue || 1),
    paymentMethod: subscription.paymentMethod,
    startDate: formatDate(subscription.startDate),
    endDate: formatDate(subscription.endDate),
    price: subscription.price,
    discount: subscription.discount,
    couponDiscount: subscription.couponDiscount,
    tax: subscription.tax,
    totalAmount: subscription.totalAmount,
    status: subscription.status,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
};

/** Keep User document in sync so the public site can hide Subscribe */
export async function syncUserSubscription(
  userId: any,
  data: {
    plan?: string | null;
    status?: string | null;
    endDate?: Date | string | null;
    planId?: any;
  }
) {
  if (!userId) return;

  const status = String(data.status || 'inactive').toLowerCase();
  const planKey = normalizePlanKey(data.plan);
  const endDate = data.endDate ? new Date(data.endDate) : undefined;
  const stillActive =
    status === 'active' && (!endDate || Number.isNaN(endDate.getTime()) || endDate > new Date());

  await UserModel.findByIdAndUpdate(
    userId,
    {
      $set: {
        subscriptionPlan: stillActive ? planKey : 'free',
        subscriptionStatus: stillActive ? 'active' : status === 'cancelled' ? 'cancelled' : 'inactive',
        subscriptionExpiry: stillActive && endDate ? endDate : endDate || null,
        subscriptionPlanId: stillActive && data.planId ? data.planId : null,
      },
    },
    { runValidators: true }
  );
}

const buildSubscriptionPayload = async (body: Record<string, any>, existing?: any) => {
  const resolvedPlanId = body.planId || existing?.planId;
  const plan = resolvedPlanId ? await SubscriptionPlanModel.findById(resolvedPlanId).lean() : null;

  if (!plan && !existing) {
    throw new Error('Plan not found');
  }

  const duration = body.duration || plan?.duration || existing?.duration || 'Month';
  let durationValue = Math.max(
    1,
    Math.trunc(toNumber(body.durationValue, plan?.durationValue || existing?.durationValue || 1))
  );

  // Normalize Monthly+30 → 1 month (price was confused with duration)
  if (String(duration).toLowerCase().includes('month') && durationValue >= 28 && durationValue <= 31) {
    durationValue = 1;
  }

  const startDate = new Date(body.startDate || body.paymentDate || existing?.startDate || new Date());
  const endDate = body.endDate
    ? new Date(body.endDate)
    : addDuration(startDate, duration, durationValue);

  const price = roundCurrency(toNumber(body.price ?? body.amount, plan?.price ?? existing?.price ?? 0));
  const discountPercent = plan?.discount || 0;
  const calculatedDiscount = price * (discountPercent / 100);
  const discount = roundCurrency(toNumber(body.discount, existing?.discount ?? calculatedDiscount));
  const couponDiscount = roundCurrency(toNumber(body.couponDiscount, existing?.couponDiscount ?? 0));
  const tax = roundCurrency(toNumber(body.tax, existing?.tax ?? 0));
  const totalAmount = roundCurrency(
    body.totalAmount !== undefined
      ? toNumber(body.totalAmount, 0)
      : price - discount - couponDiscount + tax
  );

  return {
    userId: body.userId || existing?.userId,
    planId: resolvedPlanId,
    plan: plan?.name || existing?.plan,
    duration,
    durationValue,
    paymentMethod: body.paymentMethod ?? existing?.paymentMethod ?? '-',
    startDate,
    endDate,
    price,
    discount,
    couponDiscount,
    tax,
    totalAmount,
    status: body.status || existing?.status || 'active',
  };
};

export const listSubscriptions = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      plan?: string;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
    };

    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const filter: Record<string, any> = {};

    if (query.plan && query.plan !== 'All Plans') {
      filter.plan = query.plan;
    }

    if (query.dateFrom || query.dateTo) {
      filter.startDate = {};
      if (query.dateFrom) filter.startDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const endOfDay = new Date(query.dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        filter.startDate.$lte = endOfDay;
      }
    }

    if (query.search) {
      const searchRegex = new RegExp(query.search, 'i');
      filter.$or = [{ plan: searchRegex }, { paymentMethod: searchRegex }];
    }

    const [subscriptions, total] = await Promise.all([
      SubscriptionModel.find(filter)
        .populate('userId', 'name email')
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SubscriptionModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: subscriptions.map(serializeSubscription),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getSubscriptionById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const subscription = await SubscriptionModel.findById(id)
      .populate('userId', 'name email')
      .populate('planId', 'name')
      .lean();

    if (!subscription) {
      return reply.status(404).send({ success: false, error: 'Subscription not found' });
    }

    return reply.send({ success: true, data: serializeSubscription(subscription) });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as Record<string, any>;

    if (!body.userId || !body.planId || !(body.startDate || body.paymentDate)) {
      return reply.status(400).send({
        success: false,
        error: 'User, plan, and start date are required',
      });
    }

    const payload = await buildSubscriptionPayload(body);
    const subscription = await SubscriptionModel.create(payload);

    await syncUserSubscription(payload.userId, {
      plan: payload.plan,
      status: payload.status,
      endDate: payload.endDate,
      planId: payload.planId,
    });

    const created = await SubscriptionModel.findById(subscription._id)
      .populate('userId', 'name email')
      .populate('planId', 'name')
      .lean();

    return reply.status(201).send({
      success: true,
      data: created ? serializeSubscription(created) : serializeSubscription(subscription),
    });
  } catch (error: any) {
    const statusCode = error.message === 'Plan not found' ? 404 : 500;
    return reply.status(statusCode).send({ success: false, error: error.message });
  }
};

export const updateSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, any>;
    const existing = await SubscriptionModel.findById(id).lean();

    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Subscription not found' });
    }

    const payload = await buildSubscriptionPayload(body, existing);
    const updated = await SubscriptionModel.findByIdAndUpdate(
      id,
      { $set: payload },
      { new: true, runValidators: true }
    )
      .populate('userId', 'name email')
      .populate('planId', 'name')
      .lean();

    await syncUserSubscription(payload.userId || existing.userId, {
      plan: payload.plan,
      status: payload.status,
      endDate: payload.endDate,
      planId: payload.planId,
    });

    return reply.send({
      success: true,
      data: updated ? serializeSubscription(updated) : null,
    });
  } catch (error: any) {
    const statusCode = error.message === 'Plan not found' ? 404 : 500;
    return reply.status(statusCode).send({ success: false, error: error.message });
  }
};

export const deleteSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { id } = request.params as { id: string };
    const subscription = await SubscriptionModel.findByIdAndDelete(id);

    if (!subscription) {
      return reply.status(404).send({ success: false, error: 'Subscription not found' });
    }

    // Downgrade user unless they still have another active subscription
    const otherActive = await SubscriptionModel.findOne({
      userId: subscription.userId,
      status: 'active',
      endDate: { $gte: new Date() },
    }).lean();

    if (otherActive) {
      await syncUserSubscription(subscription.userId, {
        plan: otherActive.plan,
        status: otherActive.status,
        endDate: otherActive.endDate,
        planId: otherActive.planId,
      });
    } else {
      await syncUserSubscription(subscription.userId, {
        plan: 'free',
        status: 'inactive',
        endDate: null,
        planId: null,
      });
    }

    return reply.send({ success: true, message: 'Subscription deleted successfully' });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteSubscriptions = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, error: 'Invalid or empty ids array' });
    }

    const result = await SubscriptionModel.deleteMany({ _id: { $in: ids } });

    return reply.send({
      success: true,
      message: `${result.deletedCount} subscription(s) deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

import Razorpay from 'razorpay';
import crypto from 'crypto';
import { SettingsModel } from '../models/Settings';

export const createRazorpayOrder = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { planId } = request.body as { planId: string };
    
    // Validate Plan
    const plan = await SubscriptionPlanModel.findById(planId).lean();
    if (!plan) {
      return reply.status(404).send({ success: false, error: 'Plan not found' });
    }

    // Get settings
    const settings = await SettingsModel.findOne().lean();
    if (!settings?.razorpayEnabled || !settings?.razorpayKeyId || !settings?.razorpayKeySecret) {
      return reply.status(400).send({ success: false, error: 'Razorpay is not configured or enabled' });
    }

    const instance = new Razorpay({
      key_id: settings.razorpayKeyId,
      key_secret: settings.razorpayKeySecret,
    });

    const amountInPaise = Math.round((plan.totalPrice || 0) * 100);

    if (amountInPaise === 0) {
      // Provision free subscription directly
      const userId = (request.user as any)?.id || (request.body as any).userId;
      if (!userId) {
        return reply.status(400).send({ success: false, error: 'User ID is required for free plans' });
      }

      const body = {
        userId,
        planId,
        paymentMethod: 'Free',
        status: 'active',
        price: 0,
        totalAmount: 0,
        duration: plan.duration,
        durationValue: plan.durationValue
      };

      const payload = await buildSubscriptionPayload(body);
      const subscription = await SubscriptionModel.create(payload);

      await syncUserSubscription(userId, {
        plan: payload.plan,
        status: payload.status,
        endDate: payload.endDate,
        planId: payload.planId,
      });

      return reply.send({
        success: true,
        isFree: true,
        message: 'Free plan activated successfully',
        subscriptionId: subscription._id
      });
    }

    const order = await instance.orders.create({
      amount: amountInPaise,
      currency: settings.currencyCode || 'INR',
      receipt: `receipt_${Date.now()}`,
    });

    return reply.send({
      success: true,
      order,
      keyId: settings.razorpayKeyId,
    });
  } catch (error: any) {
    console.error('Razorpay Create Order Error:', error);
    const errorMsg = error?.error?.description || error?.message || 'Failed to create Razorpay order';
    return reply.status(400).send({ success: false, error: errorMsg });
  }
};

export const verifyRazorpayPayment = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature, 
      planId,
      userId: bodyUserId
    } = request.body as any;

    // Use JWT user if available (user-facing route), otherwise fall back to body userId (admin route)
    const userId = (request.user as any)?.id || bodyUserId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId || !userId) {
      return reply.status(400).send({ success: false, error: 'Missing payment details or plan details' });
    }

    const settings = await SettingsModel.findOne().lean();
    if (!settings?.razorpayEnabled || !settings?.razorpayKeySecret) {
      return reply.status(400).send({ success: false, error: 'Razorpay is not configured' });
    }

    // Verify signature
    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const generated_signature = crypto
      .createHmac('sha256', settings.razorpayKeySecret)
      .update(text)
      .digest('hex');

    if (generated_signature !== razorpay_signature) {
      return reply.status(400).send({ success: false, error: 'Invalid payment signature' });
    }

    // Provision subscription
    const plan = await SubscriptionPlanModel.findById(planId).lean();
    if (!plan) {
      return reply.status(404).send({ success: false, error: 'Plan not found' });
    }

    const body = {
      userId,
      planId,
      paymentMethod: 'Razorpay',
      status: 'active',
      price: plan.totalPrice,
      totalAmount: plan.totalPrice,
      duration: plan.duration,
      durationValue: plan.durationValue
    };

    const payload = await buildSubscriptionPayload(body);
    const subscription = await SubscriptionModel.create(payload);

    await syncUserSubscription(userId, {
      plan: payload.plan,
      status: payload.status,
      endDate: payload.endDate,
      planId: payload.planId,
    });

    return reply.send({
      success: true,
      message: 'Payment verified and subscription activated successfully',
      subscriptionId: subscription._id,
      subscriptionPlan: normalizePlanKey(payload.plan),
      subscriptionStatus: 'active',
      subscriptionExpiry: payload.endDate,
    });
  } catch (error: any) {
    console.error('Razorpay Verify Error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};
