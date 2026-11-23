/**
 * Central subscription / lock helpers for all app + web APIs.
 *
 * Source of truth for "active plan":
 * 1. Live Subscription row (status=active, endDate not expired)
 * 2. Fallback: User.subscription* fields (active + not expired + paid plan)
 *
 * Playback rules:
 * - Free movie → unlocked for everyone
 * - Paid movie → isLocked until user's effective plan meets planRequired
 */

import mongoose from 'mongoose';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PlanLimitModel } from '../models/PlanLimit';
import { UserModel } from '../models/User';
import {
  isDeviceAllowedToStream,
  pickCurrentSubscription,
  resolveLimitCounts,
  tierFromPlan,
  type PlanTier,
} from './accountLimits';

export const PLAN_LEVELS: Record<string, number> = {
  free: 0,
  basic: 1,
  standard: 2,
  premium: 3,
};

/** Align with subscriptionController.normalizePlanKey and tierFromPlan. */
export function normalizePlan(plan: unknown): string {
  return tierFromPlan(plan == null ? 'free' : String(plan));
}

/** True when content requires a paid subscription to play. */
export function requiresSubscription(planRequired: unknown): boolean {
  return normalizePlan(planRequired) !== 'free';
}

/** True only for active paid plans (basic / standard / premium). */
export function hasPaidSubscription(userPlan: unknown): boolean {
  return normalizePlan(userPlan) !== 'free';
}

function isExpiryValid(expiry: Date | string | null | undefined): boolean {
  if (!expiry) return true; // no expiry → treat as still valid when status is active
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return true;
  return d > new Date();
}

/**
 * Sync helper from an already-loaded user document (no DB Subscription lookup).
 * Prefer resolveEffectiveUserPlan() for playback / lock decisions.
 */
export function effectiveUserPlan(user: {
  subscriptionPlan?: string | null;
  subscriptionStatus?: string | null;
  subscriptionExpiry?: Date | string | null;
} | null | undefined): string {
  if (!user) return 'free';
  const status = String(user.subscriptionStatus || '').toLowerCase();
  if (status !== 'active') return 'free';
  if (!isExpiryValid(user.subscriptionExpiry)) return 'free';
  const plan = normalizePlan(user.subscriptionPlan);
  return plan === 'free' ? 'free' : plan;
}

export interface AccountEntitlement {
  planKey: PlanTier;
  planName: string;
  planId: string | null;
  active: boolean;
  expiry: Date | null;
  deviceLimitCount: number;
  profileLimitCount: number;
  devices: any[];
}

const FREE_ENTITLEMENT: AccountEntitlement = {
  planKey: 'free',
  planName: 'Free',
  planId: null,
  active: false,
  expiry: null,
  deviceLimitCount: 1,
  profileLimitCount: 1,
  devices: [],
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Active plan for devices, profiles, and playback.
 * Live Subscription rows win. The newest purchase wins over an older plan
 * that ends later (upgrade and downgrade). User fields are only a fallback
 * when no live row exists and they are still unexpired.
 */
export async function resolveAccountEntitlement(
  userId: string | mongoose.Types.ObjectId | null | undefined
): Promise<AccountEntitlement> {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return { ...FREE_ENTITLEMENT, devices: [] };
  }

  const oid = new mongoose.Types.ObjectId(String(userId));
  const now = new Date();

  await SubscriptionModel.updateMany(
    { userId: oid, status: 'active', endDate: { $lt: now } },
    { $set: { status: 'inactive' } }
  );

  const subs = await SubscriptionModel.find({
    userId: oid,
    status: 'active',
    $or: [{ endDate: { $gte: now } }, { endDate: null }, { endDate: { $exists: false } }],
  })
    .sort({ createdAt: -1, startDate: -1 })
    .lean();

  const user = await UserModel.findById(oid)
    .select('devices subscriptionPlan subscriptionStatus subscriptionExpiry subscriptionPlanId subscriptionPlanName')
    .lean();
  const devices = Array.isArray((user as any)?.devices) ? (user as any).devices : [];
  const liveSub = pickCurrentSubscription(subs, now);

  if (liveSub) {
    const planDoc = liveSub.planId
      ? await SubscriptionPlanModel.findById(liveSub.planId).lean()
      : null;
    const planKey = tierFromPlan(planDoc?.name || liveSub.plan, planDoc?.level);
    if (planKey !== 'free') {
      const limitDoc = planDoc
        ? await PlanLimitModel.findOne({ planId: planDoc._id }).lean()
        : null;
      const limits = resolveLimitCounts(planKey, limitDoc);
      const planName = planDoc?.name || liveSub.plan || planKey;
      const expiry = liveSub.endDate ? new Date(liveSub.endDate) : null;
      const planId = liveSub.planId ? String(liveSub.planId) : null;

      const unchanged =
        user &&
        user.subscriptionStatus === 'active' &&
        String(user.subscriptionPlan || '') === planKey &&
        String(user.subscriptionPlanName || '') === String(planName) &&
        String(user.subscriptionPlanId || '') === String(planId || '') &&
        ((expiry == null && !user.subscriptionExpiry) ||
          (!!expiry &&
            !!user.subscriptionExpiry &&
            new Date(user.subscriptionExpiry).getTime() === expiry.getTime()));

      if (!unchanged) {
        try {
          await UserModel.findByIdAndUpdate(oid, {
            $set: {
              subscriptionPlan: planKey,
              subscriptionStatus: 'active',
              subscriptionExpiry: expiry,
              subscriptionPlanId: liveSub.planId || null,
              subscriptionPlanName: planName,
            },
          });
        } catch {
          // Non-fatal — still return the live plan for this request
        }
      }

      return {
        planKey,
        planName,
        planId,
        active: true,
        expiry,
        deviceLimitCount: limits.deviceLimitCount,
        profileLimitCount: limits.profileLimitCount,
        devices,
      };
    }
  }

  const legacyKey = effectiveUserPlan(user);
  if (legacyKey !== 'free' && user) {
    let planDoc = null;
    if (user.subscriptionPlanId && mongoose.Types.ObjectId.isValid(String(user.subscriptionPlanId))) {
      planDoc = await SubscriptionPlanModel.findById(user.subscriptionPlanId).lean();
    }
    if (!planDoc) {
      const name = user.subscriptionPlanName || user.subscriptionPlan;
      if (name && String(name).toLowerCase() !== 'free') {
        planDoc = await SubscriptionPlanModel.findOne({
          name: new RegExp(`^${escapeRegex(String(name))}$`, 'i'),
        }).lean();
      }
    }
    const planKey = (planDoc ? tierFromPlan(planDoc.name, planDoc.level) : legacyKey) as PlanTier;
    if (planKey !== 'free') {
      const limitDoc = planDoc ? await PlanLimitModel.findOne({ planId: planDoc._id }).lean() : null;
      const limits = resolveLimitCounts(planKey, limitDoc);
      const planName = planDoc?.name || user.subscriptionPlanName || planKey;
      return {
        planKey,
        planName,
        planId: planDoc ? String(planDoc._id) : user.subscriptionPlanId ? String(user.subscriptionPlanId) : null,
        active: true,
        expiry: user.subscriptionExpiry ? new Date(user.subscriptionExpiry) : null,
        deviceLimitCount: limits.deviceLimitCount,
        profileLimitCount: limits.profileLimitCount,
        devices,
      };
    }
  }

  const storedPaid =
    user &&
    String(user.subscriptionStatus || '').toLowerCase() === 'active' &&
    normalizePlan(user.subscriptionPlan) !== 'free';
  if (storedPaid) {
    try {
      await UserModel.findByIdAndUpdate(oid, {
        $set: {
          subscriptionPlan: 'free',
          subscriptionStatus: 'inactive',
          subscriptionPlanId: null,
          subscriptionPlanName: null,
        },
      });
    } catch {
      // Non-fatal
    }
  }

  return { ...FREE_ENTITLEMENT, devices };
}

/**
 * Resolve the user's REAL active plan from Subscription collection,
 * then fall back to User fields. Heals stale User.subscription* when a live sub exists.
 */
export async function resolveEffectiveUserPlan(
  userId: string | mongoose.Types.ObjectId | null | undefined
): Promise<string> {
  const entitlement = await resolveAccountEntitlement(userId);
  return entitlement.planKey;
}

/** Playback gate: plan tier plus whether this token's device may stream. */
export async function resolvePlaybackAccess(
  userId: string | mongoose.Types.ObjectId | null | undefined,
  deviceId?: string | null
): Promise<{ userPlan: string; streamsAllowed: boolean; entitlement: AccountEntitlement }> {
  const entitlement = await resolveAccountEntitlement(userId);
  return {
    userPlan: entitlement.planKey,
    streamsAllowed: isDeviceAllowedToStream(entitlement.devices, deviceId, entitlement.deviceLimitCount),
    entitlement,
  };
}

/**
 * Content lock flag for movies.
 * - Free movie → false
 * - Paid movie → true unless effective plan meets or exceeds planRequired
 */
export function isContentLocked(
  planRequired: unknown,
  userPlan: unknown
): boolean {
  const required = normalizePlan(planRequired);
  if (required === 'free') return false;

  const user = normalizePlan(userPlan);
  if (user === 'free') return true;

  return (PLAN_LEVELS[user] ?? 0) < (PLAN_LEVELS[required] ?? 0);
}

/** Quality-option lock — same hierarchy as content. */
export function isQualityLocked(
  qualityRequiresPlan: unknown,
  userPlan: unknown
): boolean {
  return isContentLocked(qualityRequiresPlan, userPlan);
}

/** Play allowed only when content is not locked. */
export function canAccessContent(
  planRequired: unknown,
  userPlan: unknown
): boolean {
  return !isContentLocked(planRequired, userPlan);
}
