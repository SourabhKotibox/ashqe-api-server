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
import { UserModel } from '../models/User';

export const PLAN_LEVELS: Record<string, number> = {
  free: 0,
  basic: 1,
  standard: 2,
  premium: 3,
};

/** Align with subscriptionController.normalizePlanKey */
export function normalizePlan(plan: unknown): string {
  const p = String(plan || 'free').toLowerCase().trim();
  if (!p || p === 'free') return 'free';
  if (p.includes('premium') || p.includes('vip')) return 'premium';
  if (p.includes('standard')) return 'standard';
  if (p.includes('basic')) return 'basic';
  // Named paid plans (e.g. "Gold") → standard tier access
  return 'standard';
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

/**
 * Resolve the user's REAL active plan from Subscription collection,
 * then fall back to User fields. Heals stale User.subscription* when live sub exists.
 */
export async function resolveEffectiveUserPlan(
  userId: string | mongoose.Types.ObjectId | null | undefined
): Promise<string> {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return 'free';

  const oid = new mongoose.Types.ObjectId(String(userId));
  const now = new Date();

  const liveSub = await SubscriptionModel.findOne({
    userId: oid,
    status: 'active',
    $or: [{ endDate: { $gte: now } }, { endDate: null }, { endDate: { $exists: false } }],
  })
    .sort({ endDate: -1 })
    .lean();

  if (liveSub) {
    const planKey = normalizePlan(liveSub.plan);
    if (planKey === 'free') return 'free';

    // Keep User document in sync with the live subscription row
    try {
      await UserModel.findByIdAndUpdate(oid, {
        $set: {
          subscriptionPlan: planKey,
          subscriptionStatus: 'active',
          subscriptionExpiry: liveSub.endDate || null,
          subscriptionPlanId: liveSub.planId || null,
        },
      });
    } catch {
      // Non-fatal — still return the live plan for this request
    }

    return planKey;
  }

  // No live Subscription row — use User fields (legacy / admin-set)
  const user = await UserModel.findById(oid)
    .select('subscriptionPlan subscriptionStatus subscriptionExpiry')
    .lean();
  return effectiveUserPlan(user);
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
