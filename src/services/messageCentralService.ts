/**
 * Message Central VerifyNow OTP
 * Config priority: Settings DB → env vars
 * APIs:
 *   GET  {base}/auth/v1/authentication/token
 *   POST {base}/verification/v3/send
 *   GET  {base}/verification/v3/validateOtp
 *
 * Note: Console Auth Tokens expire (~24h). Prefer saving MC email+password
 * so we can mint a fresh token automatically.
 */
import { SettingsModel } from '../models/Settings';
import { logger } from '../lib/logger';

export type SendOtpResult = {
  success: boolean;
  verificationId?: string;
  message?: string;
};

export type VerifyOtpResult = {
  success: boolean;
  message?: string;
};

type McConfig = {
  enabled: boolean;
  customerId: string;
  email: string;
  password: string;
  authToken: string;
  baseUrl: string;
  countryCode: string;
  otpLength: number;
  flowType: string;
};

const STATIC_OTP = '1234';
const STATIC_VERIFICATION_ID = 'static-otp-verification';
const DEFAULT_BASE = 'https://cpaas.messagecentral.com';
const TIMEOUT_MS = 15_000;

const allowStaticOtp = () => process.env.ALLOW_STATIC_OTP === 'true';

function pick(settingsVal: unknown, envVal: string | undefined, fallback = ''): string {
  const fromDb = String(settingsVal ?? '').trim();
  if (fromDb) return fromDb;
  return String(envVal ?? fallback).trim();
}

export async function loadMcConfig(): Promise<McConfig> {
  // Prefer native collection read so we never miss fields due to schema lag
  let settings: any = null;
  try {
    settings = await SettingsModel.collection.findOne({}, { sort: { updatedAt: -1 } });
  } catch {
    settings = await SettingsModel.findOne().lean<any>().catch(() => null);
  }

  const otpLen = Number(
    pick(settings?.mcOtpLength, process.env.MC_OTP_LENGTH, '4') || 4
  );

  const enabled =
    typeof settings?.mcEnabled === 'boolean'
      ? settings.mcEnabled
      : String(process.env.MC_ENABLED || '').toLowerCase() === 'true';

  return {
    enabled,
    customerId: pick(settings?.mcCustomerId, process.env.MC_CUSTOMER_ID),
    email: pick(settings?.mcEmail, process.env.MC_EMAIL),
    password: pick(settings?.mcPassword, process.env.MC_PASSWORD),
    authToken: pick(settings?.mcAuthToken, process.env.MC_AUTH_TOKEN),
    baseUrl: pick(settings?.mcBaseUrl, process.env.MC_BASE_URL, DEFAULT_BASE).replace(/\/$/, ''),
    countryCode: pick(settings?.mcCountryCode, process.env.MC_COUNTRY_CODE, '91').replace(/^\+/, ''),
    otpLength: otpLen >= 4 && otpLen <= 8 ? otpLen : 4,
    flowType: pick(settings?.mcFlowType, process.env.MC_FLOW_TYPE, 'SMS').toUpperCase(),
  };
}

function configGapMessage(cfg: McConfig): string {
  const missing: string[] = [];
  if (!cfg.enabled) missing.push('Enable toggle is OFF');
  if (!cfg.customerId) missing.push('Customer ID');
  if (!cfg.authToken && !cfg.password) missing.push('Auth Token or Password');
  return `SMS OTP not ready: ${missing.join(', ') || 'incomplete config'}. Admin → Settings → SMS / OTP`;
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text?.slice(0, 300) };
    }
    return { res, data };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Message Central timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractToken(data: any): string {
  return String(
    data?.token ||
      data?.authToken ||
      data?.data?.token ||
      data?.data?.authToken ||
      ''
  ).trim();
}

function extractVerificationId(data: any): string {
  return String(
    data?.data?.verificationId ||
      data?.verificationId ||
      data?.data?.verification_id ||
      data?.data?.verificationID ||
      data?.data?.transactionId ||
      data?.transactionId ||
      ''
  ).trim();
}

function mcErrorMessage(data: any, res: { status: number }, fallback: string): string {
  return (
    data?.message ||
    data?.errorMessage ||
    data?.data?.message ||
    data?.error ||
    (data?.responseCode != null ? `MC error code ${data.responseCode}` : '') ||
    `${fallback} (HTTP ${res.status})`
  );
}

export class MessageCentralService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  /** Live when enabled + customerId + (token or password). */
  private useLive(cfg: McConfig) {
    return (
      cfg.enabled &&
      !!cfg.customerId &&
      (!!cfg.authToken || !!cfg.password)
    );
  }

  /** Mint a fresh JWT via customerId + Base64(password). Email is optional. */
  private async fetchPasswordToken(cfg: McConfig): Promise<string> {
    if (!cfg.password) {
      throw new Error('MC Password is required to refresh Auth Token');
    }
    const key = Buffer.from(cfg.password, 'utf8').toString('base64');

    const tryToken = async (withEmail: boolean) => {
      const params = new URLSearchParams({
        customerId: cfg.customerId,
        key,
        scope: 'NEW',
        country: cfg.countryCode || '91',
      });
      // Only send email when explicitly requested — wrong email causes
      // "email is not found in database" from Message Central
      if (withEmail && cfg.email) params.set('email', cfg.email);

      const { res, data } = await fetchJson(
        `${cfg.baseUrl}/auth/v1/authentication/token?${params}`
      );
      return { res, data, token: extractToken(data) };
    };

    // 1) customerId + password (no email) — works for most MC accounts
    let result = await tryToken(false);
    if (!result.token && cfg.email) {
      // 2) retry with email if configured
      result = await tryToken(true);
    }

    if (!result.token) {
      const msg = mcErrorMessage(result.data, result.res, 'Auth token generation failed');
      // Fall back to saved console Auth Token if it looks like a real JWT
      if (cfg.authToken && cfg.authToken.startsWith('eyJ') && cfg.authToken.length > 100) {
        logger.warn({ msg }, 'MC password token failed — falling back to saved Auth Token');
        return cfg.authToken;
      }
      throw new Error(
        `${msg}. Use the exact Message Central login password with Customer ID ${cfg.customerId}, or paste a full Auth Token (200+ chars starting with eyJ).`
      );
    }

    this.cachedToken = result.token;
    this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    return result.token;
  }

  private async getAuthToken(cfg: McConfig, _forceRefresh = false): Promise<string> {
    // Primary path (Message Central console): paste Auth Token — no email needed
    if (cfg.authToken) {
      const t = cfg.authToken.replace(/\s+/g, '').trim();
      if (t.length < 100) {
        throw new Error(
          `Auth Token looks incomplete (${t.length} chars). Paste the FULL token from Message Central (usually 200–500+ chars, starts with eyJ).`
        );
      }
      return t;
    }

    // Optional: only if Auth Token is empty and password is stored
    if (cfg.password) {
      if (!_forceRefresh && this.cachedToken && Date.now() < this.tokenExpiresAt) {
        return this.cachedToken;
      }
      return this.fetchPasswordToken(cfg);
    }

    throw new Error('Paste Auth Token in Settings → SMS / OTP (Customer ID + Auth Token). Email is not required.');
  }

  private isUnauthorized(res: { status: number }, data: any) {
    const code = Number(data?.responseCode ?? data?.status ?? res.status);
    return res.status === 401 || res.status === 403 || code === 401 || code === 403;
  }

  async sendOtp(mobileNumber: string): Promise<SendOtpResult> {
    const cfg = await loadMcConfig();
    const phone = String(mobileNumber || '').replace(/\D/g, '').slice(-10);

    if (phone.length !== 10) {
      return { success: false, message: 'Enter a valid 10-digit mobile number' };
    }

    if (!this.useLive(cfg)) {
      if (allowStaticOtp()) {
        return {
          success: true,
          verificationId: STATIC_VERIFICATION_ID,
          message: `Use ${STATIC_OTP} (dev fallback)`,
        };
      }
      logger.warn({ cfg: { enabled: cfg.enabled, hasCustomerId: !!cfg.customerId, hasToken: !!cfg.authToken, hasPassword: !!cfg.password } }, 'MC OTP not configured');
      return { success: false, message: configGapMessage(cfg) };
    }

    try {
      let token = await this.getAuthToken(cfg);
      // Match Message Central VerifyNow docs: countryCode, flowType, mobileNumber, type=OTP
      const params = new URLSearchParams({
        countryCode: cfg.countryCode,
        flowType: cfg.flowType || 'SMS',
        type: 'OTP',
        mobileNumber: phone,
        otpLength: String(cfg.otpLength),
      });
      if (cfg.customerId) params.set('customerId', cfg.customerId);

      const doSend = (authToken: string) =>
        fetchJson(`${cfg.baseUrl}/verification/v3/send?${params}`, {
          method: 'POST',
          headers: {
            authToken,
            Accept: '*/*',
          },
        });

      let { res, data } = await doSend(token);
      logger.info(
        {
          phone,
          httpStatus: res.status,
          responseCode: data?.responseCode,
          message: data?.message,
          hasVerificationId: !!extractVerificationId(data),
          errorMessage: data?.data?.errorMessage || data?.errorMessage,
        },
        'MC send OTP response'
      );

      // Expired console token → refresh via password if possible
      if (this.isUnauthorized(res, data)) {
        if (cfg.password) {
          this.cachedToken = null;
          token = await this.getAuthToken(cfg, true);
          ({ res, data } = await doSend(token));
        } else {
          return {
            success: false,
            message:
              'Auth Token expired or invalid. Paste a fresh token from Message Central, or save Email + Password in SMS / OTP settings so tokens auto-refresh.',
          };
        }
      }

      const verificationId = extractVerificationId(data);
      const mcCode = Number(data?.responseCode ?? data?.data?.responseCode ?? res.status);

      // Reject non-success MC codes even if some id-looking field exists
      if (mcCode && mcCode !== 200) {
        logger.error({ status: res.status, mcCode, data }, 'MC send OTP non-200');
        return {
          success: false,
          message: mcErrorMessage(data, res, `Message Central error ${mcCode}`),
        };
      }

      if (!verificationId) {
        logger.error({ status: res.status, mcCode, data }, 'MC send OTP failed');
        return {
          success: false,
          message: mcErrorMessage(data, res, 'Failed to send OTP'),
        };
      }

      return {
        success: true,
        verificationId,
        message: 'OTP sent successfully via SMS',
      };
    } catch (err: any) {
      logger.error({ err }, 'MC send OTP exception');
      return { success: false, message: err?.message || 'Failed to send OTP' };
    }
  }

  async verifyOtp(
    verificationId: string | undefined,
    code: string
  ): Promise<VerifyOtpResult> {
    const cfg = await loadMcConfig();
    const otp = String(code || '').trim();

    if (!this.useLive(cfg)) {
      if (allowStaticOtp() && (!verificationId || verificationId === STATIC_VERIFICATION_ID)) {
        return otp === STATIC_OTP
          ? { success: true, message: 'OTP verified successfully' }
          : { success: false, message: `Invalid OTP. Use ${STATIC_OTP}` };
      }
      return { success: false, message: configGapMessage(cfg) };
    }

    if (verificationId === STATIC_VERIFICATION_ID) {
      return { success: false, message: 'Request a new OTP' };
    }
    if (!verificationId) {
      return { success: false, message: 'Missing verificationId — request OTP again' };
    }

    try {
      let token = await this.getAuthToken(cfg);
      const params = new URLSearchParams({
        verificationId: String(verificationId),
        code: otp,
        customerId: cfg.customerId,
      });

      const doValidate = (authToken: string) =>
        fetchJson(`${cfg.baseUrl}/verification/v3/validateOtp?${params}`, {
          method: 'GET',
          headers: { authToken, Accept: 'application/json' },
        });

      let { res, data } = await doValidate(token);
      if (this.isUnauthorized(res, data) && cfg.password) {
        this.cachedToken = null;
        token = await this.getAuthToken(cfg, true);
        ({ res, data } = await doValidate(token));
      }

      const status = String(
        data?.data?.verificationStatus ||
          data?.verificationStatus ||
          data?.data?.status ||
          ''
      ).toUpperCase();

      const codeNum = Number(data?.responseCode ?? data?.status ?? res.status);

      if (/FAIL|INVALID|EXPIRED|REJECT/i.test(status)) {
        return { success: false, message: data?.message || 'Invalid or expired OTP' };
      }

      const ok =
        status === 'VERIFICATION_COMPLETED' ||
        status === 'SUCCESS' ||
        status === 'VERIFIED' ||
        (codeNum === 200 && !status);

      if (!ok) {
        logger.error({ status: res.status, data }, 'MC validate OTP failed');
        return {
          success: false,
          message: mcErrorMessage(data, res, 'Invalid or expired OTP'),
        };
      }

      return { success: true, message: 'OTP verified successfully' };
    } catch (err: any) {
      logger.error({ err }, 'MC validate OTP exception');
      return { success: false, message: err?.message || 'OTP verification failed' };
    }
  }
}

export const messageCentral = new MessageCentralService();
