const hits = new Map<string, number[]>();

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const consumeRateLimit = (
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } => {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    hits.set(key, recent);
    return { ok: false, retryAfterSec };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true, retryAfterSec: 0 };
};

export const resetRateLimits = () => {
  hits.clear();
};

const FIFTEEN_MIN = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export const creatorApplyLimits = () => ({
  ipLimit: num('CREATOR_APPLY_IP_LIMIT', 8),
  ipWindowMs: num('CREATOR_APPLY_IP_WINDOW_MS', FIFTEEN_MIN),
  emailLimit: num('CREATOR_APPLY_EMAIL_LIMIT', 3),
  emailWindowMs: num('CREATOR_APPLY_EMAIL_WINDOW_MS', ONE_HOUR),
});

export const creatorStatusLimits = () => ({
  ipLimit: num('CREATOR_STATUS_IP_LIMIT', 30),
  ipWindowMs: num('CREATOR_STATUS_IP_WINDOW_MS', FIFTEEN_MIN),
  emailLimit: num('CREATOR_STATUS_EMAIL_LIMIT', 30),
  emailWindowMs: num('CREATOR_STATUS_EMAIL_WINDOW_MS', FIFTEEN_MIN),
});
