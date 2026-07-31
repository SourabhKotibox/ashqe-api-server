/**
 * Message Central VerifyNow OTP
 * Config priority: Settings DB → env vars
 * APIs:
 *   GET  {base}/auth/v1/authentication/token   (only if no Auth Token)
 *   POST {base}/verification/v3/send
 *   GET  {base}/verification/v3/validateOtp
 */
import { SettingsModel } from '../models/Settings';

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
const TIMEOUT_MS = 12_000;

const allowStaticOtp = () =>
  process.env.ALLOW_STATIC_OTP === 'true' ||
  process.env.NODE_ENV === 'development';

function pick(settingsVal: unknown, envVal: string | undefined, fallback = ''): string {
  const fromDb = String(settingsVal ?? '').trim();
  if (fromDb) return fromDb;
  return String(envVal ?? fallback).trim();
}

async function loadConfig(): Promise<McConfig> {
  const settings = await SettingsModel.findOne().lean<any>().catch(() => null);

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

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const data: any = await res.json().catch(() => ({}));
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

export class MessageCentralService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  private useLive(cfg: McConfig) {
    const hasKeys = !!cfg.customerId && (!!cfg.authToken || !!cfg.password);
    return hasKeys && (cfg.enabled || !!cfg.authToken);
  }

  private async getAuthToken(cfg: McConfig): Promise<string> {
    if (cfg.authToken) return cfg.authToken;

    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    if (!cfg.password) {
      throw new Error('MC Auth Token or Password is required (Settings → SMS / OTP)');
    }

    const key = Buffer.from(cfg.password, 'utf8').toString('base64');
    const params = new URLSearchParams({
      customerId: cfg.customerId,
      key,
      scope: 'NEW',
      country: cfg.countryCode,
      ...(cfg.email ? { email: cfg.email } : {}),
    });

    const { res, data } = await fetchJson(
      `${cfg.baseUrl}/auth/v1/authentication/token?${params}`
    );

    const token =
      data?.token ||
      data?.authToken ||
      data?.data?.token ||
      data?.data?.authToken ||
      '';

    if (!token) {
      throw new Error(
        data?.message || data?.errorMessage || `Token failed (HTTP ${res.status})`
      );
    }

    this.cachedToken = String(token);
    this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    return this.cachedToken;
  }

  async sendOtp(mobileNumber: string): Promise<SendOtpResult> {
    const cfg = await loadConfig();
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
      return {
        success: false,
        message:
          'SMS OTP not configured. Set Message Central in Admin → Settings → SMS / OTP.',
      };
    }

    try {
      let token = await this.getAuthToken(cfg);
      const params = new URLSearchParams({
        countryCode: cfg.countryCode,
        customerId: cfg.customerId,
        flowType: cfg.flowType || 'SMS',
        mobileNumber: phone,
        otpLength: String(cfg.otpLength),
      });

      const doSend = (authToken: string) =>
        fetchJson(`${cfg.baseUrl}/verification/v3/send?${params}`, {
          method: 'POST',
          headers: { authToken, Accept: 'application/json' },
        });

      let { res, data } = await doSend(token);

      if (
        !cfg.authToken &&
        (res.status === 401 || Number(data?.responseCode) === 401)
      ) {
        this.cachedToken = null;
        token = await this.getAuthToken(cfg);
        ({ res, data } = await doSend(token));
      }

      const verificationId =
        data?.data?.verificationId ||
        data?.verificationId ||
        data?.data?.verification_id ||
        '';

      if (!verificationId) {
        return {
          success: false,
          message:
            data?.message ||
            data?.errorMessage ||
            `Failed to send OTP (HTTP ${res.status})`,
        };
      }

      return {
        success: true,
        verificationId: String(verificationId),
        message: 'OTP sent successfully',
      };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to send OTP' };
    }
  }

  async verifyOtp(
    verificationId: string | undefined,
    code: string
  ): Promise<VerifyOtpResult> {
    const cfg = await loadConfig();
    const otp = String(code || '').trim();

    if (!this.useLive(cfg)) {
      if (allowStaticOtp() && verificationId === STATIC_VERIFICATION_ID) {
        return otp === STATIC_OTP
          ? { success: true, message: 'OTP verified successfully' }
          : { success: false, message: `Invalid OTP. Use ${STATIC_OTP}` };
      }
      // Legacy: accept static OTP without verificationId in dev
      if (allowStaticOtp() && (!verificationId || verificationId === STATIC_VERIFICATION_ID)) {
        return otp === STATIC_OTP
          ? { success: true, message: 'OTP verified successfully' }
          : { success: false, message: `Invalid OTP. Use ${STATIC_OTP}` };
      }
      return {
        success: false,
        message: 'SMS OTP not configured',
      };
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
      if (!cfg.authToken && (res.status === 401 || Number(data?.responseCode) === 401)) {
        this.cachedToken = null;
        token = await this.getAuthToken(cfg);
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
        return {
          success: false,
          message: data?.message || data?.errorMessage || 'Invalid or expired OTP',
        };
      }

      return { success: true, message: 'OTP verified successfully' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'OTP verification failed' };
    }
  }
}

export const messageCentral = new MessageCentralService();
