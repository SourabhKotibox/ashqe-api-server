/**
 * Pure plan / device / profile limit rules.
 *
 * Seeded plan limits (seed-plan-limits.ts):
 *   basic    — 1 device, 1 profile
 *   standard — 2 devices, 2 profiles
 *   premium  — 4 devices, 4 profiles
 * No subscription, an expired subscription, or a missing PlanLimit row
 * uses the same caps as basic (1 and 1).
 *
 * The deviceLimit / profileLimit booleans default to false on the schema.
 * Counts are the source of truth so a row that only set the count is still enforced.
 */

export type PlanTier = 'free' | 'basic' | 'standard' | 'premium';

export const TIER_LIMITS: Record<PlanTier, { devices: number; profiles: number }> = {
  free: { devices: 1, profiles: 1 },
  basic: { devices: 1, profiles: 1 },
  standard: { devices: 2, profiles: 2 },
  premium: { devices: 4, profiles: 4 },
};

export interface PlanLimitSnapshot {
  deviceLimitCount?: number | null;
  profileLimitCount?: number | null;
}

export interface SubscriptionSnapshot {
  status?: string | null;
  endDate?: Date | string | null;
  createdAt?: Date | string | null;
  startDate?: Date | string | null;
  plan?: string | null;
  planId?: unknown;
}

export interface DeviceRecord {
  _id?: unknown;
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
  lastSeen?: Date | string | null;
  lastActive?: Date | string | null;
  addedAt?: Date | string | null;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  deviceType: string;
}

export type DeviceLoginResult =
  | { ok: true; devices: DeviceRecord[]; overLimit: boolean }
  | {
      ok: false;
      code: 'DEVICE_LIMIT_REACHED';
      deviceLimitCount: number;
      message: string;
    };

const DEVICE_TYPES = new Set(['mobile', 'tablet', 'web', 'tv', 'other']);

export function tierFromPlan(name?: string | null, level?: number | null): PlanTier {
  const raw = String(name || '').toLowerCase().trim();
  if (!raw || raw === 'free') return 'free';
  // A known tier in the name wins over SubscriptionPlan.level.
  // Standard is seeded with level 1, which is not the content tier.
  if (raw.includes('premium') || raw.includes('vip')) return 'premium';
  if (raw.includes('standard')) return 'standard';
  if (raw.includes('basic')) return 'basic';
  if (typeof level === 'number' && Number.isFinite(level)) {
    if (level >= 3) return 'premium';
    if (level === 2) return 'standard';
    if (level === 1) return 'basic';
  }
  return 'standard';
}

export function limitsForTier(planKey: string): { devices: number; profiles: number } {
  if (planKey === 'premium' || planKey === 'standard' || planKey === 'basic' || planKey === 'free') {
    return TIER_LIMITS[planKey];
  }
  return TIER_LIMITS.free;
}

function positiveCount(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Numeric cap sent to clients. Unlimited is represented as a large finite number. */
export function publicLimitCount(count: number): number {
  if (!Number.isFinite(count)) return 100;
  return Math.max(1, Math.floor(count));
}

export function resolveLimitCounts(planKey: string, planLimit: PlanLimitSnapshot | null | undefined): {
  deviceLimitCount: number;
  profileLimitCount: number;
} {
  const fallback = limitsForTier(planKey);
  if (!planLimit) {
    return { deviceLimitCount: fallback.devices, profileLimitCount: fallback.profiles };
  }
  return {
    deviceLimitCount: positiveCount(planLimit.deviceLimitCount, fallback.devices),
    profileLimitCount: positiveCount(planLimit.profileLimitCount, fallback.profiles),
  };
}

function timeOf(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The subscription that is in force right now.
 * Latest purchase wins, so an upgrade or downgrade replaces a longer older plan.
 * Expired rows are ignored. A missing end date is treated as still active.
 */
export function pickCurrentSubscription<T extends SubscriptionSnapshot>(
  subs: T[],
  now: Date = new Date()
): T | null {
  const live = (subs || []).filter((sub) => {
    if (String(sub?.status || '').toLowerCase() !== 'active') return false;
    if (sub.endDate == null || sub.endDate === '') return true;
    const end = timeOf(sub.endDate);
    if (!end) return true;
    return end >= now.getTime();
  });
  live.sort((a, b) => {
    const created = timeOf(b.createdAt) - timeOf(a.createdAt);
    if (created !== 0) return created;
    return timeOf(b.startDate) - timeOf(a.startDate);
  });
  return live[0] || null;
}

export function deviceActivityTime(device: DeviceRecord): number {
  return timeOf(device.lastActive) || timeOf(device.lastSeen) || timeOf(device.addedAt);
}

export function allowedDeviceIds(devices: DeviceRecord[], limitCount: number): Set<string> {
  if (!Number.isFinite(limitCount)) {
    return new Set(devices.map((device) => device.deviceId));
  }
  const cap = Math.max(1, Math.floor(limitCount));
  const sorted = [...devices].sort(
    (a, b) => deviceActivityTime(b) - deviceActivityTime(a) || String(a.deviceId).localeCompare(String(b.deviceId))
  );
  return new Set(sorted.slice(0, cap).map((device) => device.deviceId));
}

export function normalizeDeviceType(value?: string | null): string {
  const raw = String(value || '').toLowerCase().trim();
  if (DEVICE_TYPES.has(raw)) return raw;
  if (raw.includes('tv')) return 'tv';
  if (raw.includes('tablet') || raw.includes('ipad')) return 'tablet';
  if (raw.includes('web') || raw.includes('browser')) return 'web';
  if (raw.includes('mobile') || raw.includes('phone') || raw.includes('android') || raw.includes('ios')) {
    return 'mobile';
  }
  return 'mobile';
}

/**
 * Clients that do not send a device id (the website login) share one slot
 * so the plan cap still applies without a frontend change.
 */
export function deviceIdentityForLogin(
  userId: string,
  input?: { deviceId?: string | null; deviceName?: string | null; deviceType?: string | null } | null
): DeviceIdentity {
  const deviceId = String(input?.deviceId || '').trim();
  if (deviceId) {
    return {
      deviceId,
      deviceName: String(input?.deviceName || '').trim() || 'Unknown Device',
      deviceType: normalizeDeviceType(input?.deviceType || 'mobile'),
    };
  }
  return {
    deviceId: `web:${userId}`,
    deviceName: 'Web browser',
    deviceType: 'web',
  };
}

export function deviceLimitMessage(count: number): string {
  const n = publicLimitCount(count);
  const label = n === 1 ? '1 device' : `${n} devices`;
  return `Your plan allows ${label}. Sign out on another device, or remove it from Manage Devices, then try again.`;
}

export function profileLimitMessage(count: number): string {
  const n = publicLimitCount(count);
  return `Profile limit of ${n} reached on your current plan.`;
}

export function toDeviceRecords(devices: unknown): DeviceRecord[] {
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((device) => device && typeof device === 'object' && (device as DeviceRecord).deviceId)
    .map((device) => {
      const row = device as DeviceRecord;
      const lastActive = row.lastActive || row.lastSeen || null;
      return {
        _id: row._id,
        deviceId: String(row.deviceId),
        deviceName: row.deviceName || undefined,
        deviceType: row.deviceType || undefined,
        lastSeen: row.lastSeen || lastActive,
        lastActive,
        addedAt: row.addedAt || null,
      };
    });
}

export function serializeDevice(device: DeviceRecord) {
  const lastActive = device.lastActive || device.lastSeen || null;
  const payload: Record<string, unknown> = {
    deviceId: device.deviceId,
    deviceName: device.deviceName || 'Unknown Device',
    deviceType: device.deviceType || 'other',
    lastSeen: device.lastSeen || lastActive,
    lastActive,
    addedAt: device.addedAt || null,
  };
  if (device._id) payload._id = device._id;
  return payload;
}

/**
 * Register or refresh a device at login.
 * A new device past the cap is rejected.
 * A device that is already registered but outside the cap after a downgrade
 * may sign in again (so Manage Devices stays reachable) but is not promoted
 * into the streaming set.
 */
export function registerDevice(
  devices: DeviceRecord[],
  identity: DeviceIdentity,
  limitCount: number,
  now: Date = new Date()
): DeviceLoginResult {
  const current = toDeviceRecords(devices);
  const existingIndex = current.findIndex((device) => device.deviceId === identity.deviceId);
  const capped = Number.isFinite(limitCount);

  if (existingIndex >= 0) {
    const allowed = allowedDeviceIds(current, limitCount);
    const withinCap = !capped || current.length <= limitCount || allowed.has(identity.deviceId);
    if (!withinCap) {
      return { ok: true, devices: current, overLimit: true };
    }
    const next = current.map((device, index) =>
      index === existingIndex
        ? {
            ...device,
            deviceName: identity.deviceName || device.deviceName,
            deviceType: identity.deviceType || device.deviceType || 'mobile',
            lastActive: now,
            lastSeen: now,
          }
        : device
    );
    return { ok: true, devices: next, overLimit: false };
  }

  if (capped && current.length >= limitCount) {
    const count = publicLimitCount(limitCount);
    return {
      ok: false,
      code: 'DEVICE_LIMIT_REACHED',
      deviceLimitCount: count,
      message: deviceLimitMessage(count),
    };
  }

  return {
    ok: true,
    overLimit: false,
    devices: [
      ...current,
      {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName || 'Unknown Device',
        deviceType: identity.deviceType || 'mobile',
        lastActive: now,
        lastSeen: now,
        addedAt: now,
      },
    ],
  };
}

/**
 * Streaming is allowed for legacy tokens with no device id, for an empty
 * device list, and for the most recently active devices inside the cap.
 * A removed device id is not allowed.
 */
export function isDeviceAllowedToStream(
  devices: DeviceRecord[],
  deviceId: string | null | undefined,
  limitCount: number
): boolean {
  if (!deviceId || deviceId === 'unknown') return true;
  const current = toDeviceRecords(devices);
  if (current.length === 0) return true;
  const known = current.some((device) => device.deviceId === deviceId);
  if (!known) return false;
  if (!Number.isFinite(limitCount)) return true;
  if (current.length <= limitCount) return true;
  return allowedDeviceIds(current, limitCount).has(deviceId);
}

export function canCreateProfile(currentCount: number, limitCount: number): boolean {
  if (!Number.isFinite(limitCount)) return true;
  return currentCount < limitCount;
}
