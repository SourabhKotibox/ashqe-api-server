/**
 * Creator revenue is INR per watch hour.
 *
 * Rate policy: each creator has their own INR per watch hour. A creator with no
 * override uses the global default (what a newly approved creator starts on).
 * Seconds are valued at that creator's resolved rate when they are credited.
 * Changing a creator's rate or the default appends a history row and does not
 * rewrite CreatorWatchCredit or CreatorRevenueDaily rows already stored.
 * Earnings are summed from earning units (creditedSeconds * paise-per-hour),
 * then converted to paise, so many small credits still add up to the hourly rate.
 *
 * Playback policy: the client reports media time actually played, not seek
 * distance. The server drops non-positive amounts, ignores a delta larger than
 * the wall clock since the previous report (plus a small skew), caps each
 * report, caps a session at the title duration, and caps one viewer per title
 * per IST day. The creator's own app account (same email or phone) is ignored.
 * Only published titles owned by an influencer count. Episode time is credited
 * to the series owner.
 */

export const REVENUE_TIMEZONE = 'Asia/Kolkata';
export const REVENUE_CURRENCY = 'INR';

export const RATE_POLICY =
  'Each creator earns at their own INR rate per watch hour. A creator without an override uses the global default, which is the rate applied when a creator is approved. Watch time is valued at that creator\'s resolved rate when the seconds are credited. Changing a creator\'s rate or the default appends a history row from that moment and does not rewrite credits or daily totals already recorded.';

export const REVENUE_LIMITS = {
  /** A single report cannot mint more than this many seconds. Players should heartbeat about every 15s and on pause. */
  maxEventSeconds: 45,
  wallSkewSeconds: 2,
  /** A gap longer than this starts a new session cap so a later sitting can count. */
  sessionGapSeconds: 30 * 60,
  /** Once a heartbeat exists for a title, progress saves stop earning so the two channels are not added together. */
  sessionCapFallbackSeconds: 4 * 3600,
  dailyFloorSeconds: 2 * 3600,
  dailyCeilingSeconds: 8 * 3600,
  dailyDurationMultiplier: 3,
  /** Catalog duration above this is treated as unknown so a bad value cannot raise the caps. */
  maxCatalogDurationSeconds: 12 * 3600,
  openingRateInrPerHour: 5,
  maxRateInrPerHour: 100_000,
} as const;

export type RevenuePeriodKey = 'today' | '7d' | '30d' | 'all' | 'custom';

export type RevenuePeriod = {
  key: RevenuePeriodKey;
  from: string | null;
  to: string | null;
  timezone: typeof REVENUE_TIMEZONE;
};

export type CreditDecisionReason =
  | 'credited'
  | 'non_positive'
  | 'anchor'
  | 'impossible_delta'
  | 'session_cap'
  | 'daily_cap';

export type CreditDecision = {
  creditedSeconds: number;
  reason: CreditDecisionReason;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REVENUE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addIstDays(dateKey: string, days: number): string {
  const noon = new Date(`${dateKey}T12:00:00+05:30`);
  return istDateKey(new Date(noon.getTime() + days * 86_400_000));
}

export function inclusiveDayCount(from: string, to: string): number {
  const start = new Date(`${from}T12:00:00+05:30`).getTime();
  const end = new Date(`${to}T12:00:00+05:30`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

export function eachIstDay(from: string, to: string): string[] {
  const days: string[] = [];
  const count = inclusiveDayCount(from, to);
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    days.push(cursor);
    cursor = addIstDays(cursor, 1);
  }
  return days;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00+05:30`);
  return !Number.isNaN(parsed.getTime()) && istDateKey(parsed) === value;
}

export function resolveRevenuePeriod(input: {
  period?: string | null;
  from?: string | null;
  to?: string | null;
  now?: Date;
}): { ok: true; period: RevenuePeriod } | { ok: false; error: string } {
  const now = input.now ?? new Date();
  const today = istDateKey(now);
  const key = String(input.period || '30d').trim().toLowerCase();
  if (key === 'all' || key === 'alltime' || key === 'all-time' || key === 'all_time') {
    return { ok: true, period: { key: 'all', from: null, to: null, timezone: REVENUE_TIMEZONE } };
  }
  if (key === 'today') {
    return { ok: true, period: { key: 'today', from: today, to: today, timezone: REVENUE_TIMEZONE } };
  }
  if (key === '7d') {
    return { ok: true, period: { key: '7d', from: addIstDays(today, -6), to: today, timezone: REVENUE_TIMEZONE } };
  }
  if (key === '30d') {
    return { ok: true, period: { key: '30d', from: addIstDays(today, -29), to: today, timezone: REVENUE_TIMEZONE } };
  }
  if (key === 'custom') {
    if (!isDateKey(input.from) || !isDateKey(input.to)) {
      return { ok: false, error: 'custom period requires from and to as YYYY-MM-DD' };
    }
    if (input.from > input.to) return { ok: false, error: 'from must be on or before to' };
    if (inclusiveDayCount(input.from, input.to) > 366) {
      return { ok: false, error: 'custom period cannot exceed 366 days' };
    }
    return { ok: true, period: { key: 'custom', from: input.from, to: input.to, timezone: REVENUE_TIMEZONE } };
  }
  return { ok: false, error: 'period must be today, 7d, 30d, custom, or all' };
}

/** Rupees per hour with at most 2 decimal places, from 0 through the configured maximum. */
export function normalizeRateInr(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > REVENUE_LIMITS.maxRateInrPerHour) return null;
  const paise = Math.round(n * 100);
  if (Math.abs(n * 100 - paise) > 1e-6) return null;
  return paise / 100;
}

export function ratePaisePerHour(rateInrPerHour: number): number {
  return Math.round(rateInrPerHour * 100);
}

/** Integer units = creditedSeconds * paise per hour. Divide by 3600 to get paise. */
export function earningUnitsFor(creditedSeconds: number, rateInrPerHour: number): number {
  return Math.max(0, Math.floor(creditedSeconds)) * ratePaisePerHour(rateInrPerHour);
}

export function amountPaiseFromUnits(earningUnits: number): number {
  if (!Number.isFinite(earningUnits) || earningUnits <= 0) return 0;
  return Math.round(earningUnits / 3600);
}

export function amountInrFromPaise(amountPaise: number): number {
  return Number((amountPaise / 100).toFixed(2));
}

export function watchHoursFromSeconds(seconds: number): number {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return Math.round((safe / 3600) * 10_000) / 10_000;
}

export function presentMoney(watchSeconds: number, earningUnits: number) {
  const amountPaise = amountPaiseFromUnits(earningUnits);
  return {
    watchSeconds,
    watchHours: watchHoursFromSeconds(watchSeconds),
    amountPaise,
    amountInr: amountInrFromPaise(amountPaise),
  };
}

export function sessionCapSeconds(catalogDurationSeconds: number | null | undefined): number {
  const duration = Number(catalogDurationSeconds);
  if (Number.isFinite(duration) && duration > 0 && duration <= REVENUE_LIMITS.maxCatalogDurationSeconds) {
    return Math.floor(duration);
  }
  return REVENUE_LIMITS.sessionCapFallbackSeconds;
}

export function dailyCapSeconds(catalogDurationSeconds: number | null | undefined): number {
  const duration = Number(catalogDurationSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || duration > REVENUE_LIMITS.maxCatalogDurationSeconds) {
    return REVENUE_LIMITS.dailyCeilingSeconds;
  }
  const scaled = Math.floor(duration) * REVENUE_LIMITS.dailyDurationMultiplier;
  return Math.min(
    REVENUE_LIMITS.dailyCeilingSeconds,
    Math.max(REVENUE_LIMITS.dailyFloorSeconds, scaled)
  );
}

/**
 * Decide how many seconds of one report can earn.
 * `wallElapsedSeconds === null` means this is the first observation for the session.
 * Progress anchors on that first observation (0 credit). A heartbeat may credit
 * up to maxEventSeconds because the player is reporting time already played.
 */
export function decidePlaybackCredit(input: {
  playedSeconds: number;
  wallElapsedSeconds: number | null;
  anchorWithoutWall: boolean;
  sessionCreditedSeconds: number;
  dayCreditedSeconds: number;
  sessionCap: number;
  dailyCap: number;
}): CreditDecision {
  const played = Math.floor(Number(input.playedSeconds));
  if (!Number.isFinite(played) || played <= 0) {
    return { creditedSeconds: 0, reason: 'non_positive' };
  }

  if (input.wallElapsedSeconds == null) {
    if (input.anchorWithoutWall) return { creditedSeconds: 0, reason: 'anchor' };
  } else {
    const wall = Number(input.wallElapsedSeconds);
    if (!Number.isFinite(wall) || wall < 0 || played > wall + REVENUE_LIMITS.wallSkewSeconds) {
      return { creditedSeconds: 0, reason: 'impossible_delta' };
    }
  }

  let credit = Math.min(played, REVENUE_LIMITS.maxEventSeconds);
  if (input.wallElapsedSeconds != null) {
    credit = Math.min(credit, Math.floor(input.wallElapsedSeconds + REVENUE_LIMITS.wallSkewSeconds));
  }

  const sessionRoom = Math.floor(input.sessionCap - input.sessionCreditedSeconds);
  if (sessionRoom <= 0) return { creditedSeconds: 0, reason: 'session_cap' };
  const dailyRoom = Math.floor(input.dailyCap - input.dayCreditedSeconds);
  if (dailyRoom <= 0) return { creditedSeconds: 0, reason: 'daily_cap' };

  credit = Math.min(credit, sessionRoom, dailyRoom);
  if (credit <= 0) return { creditedSeconds: 0, reason: 'session_cap' };
  return { creditedSeconds: credit, reason: 'credited' };
}

export function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

/** Last 10 digits, so +91 and a local mobile number compare equal. */
export function normalizePhone(value: unknown): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

export function isSameParty(
  viewer: { email?: string | null; phone?: string | null },
  creator: { email?: string | null; phone?: string | null }
): boolean {
  const viewerEmail = normalizeEmail(viewer.email);
  const creatorEmail = normalizeEmail(creator.email);
  if (viewerEmail && creatorEmail && viewerEmail === creatorEmail) return true;
  const viewerPhone = normalizePhone(viewer.phone);
  const creatorPhone = normalizePhone(creator.phone);
  if (viewerPhone && creatorPhone && viewerPhone === creatorPhone) return true;
  return false;
}

export function buildDailySeries(
  rows: Array<{ day: string; watchSeconds: number; earningUnits: number }>,
  period: RevenuePeriod
) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = period.from && period.to
    ? eachIstDay(period.from, period.to)
    : [...byDay.keys()].sort();
  return days.map((day) => {
    const row = byDay.get(day);
    return {
      date: day,
      ...presentMoney(row?.watchSeconds || 0, row?.earningUnits || 0),
    };
  });
}
