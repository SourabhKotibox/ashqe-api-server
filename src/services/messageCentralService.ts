import { SettingsModel } from '../models/Settings';
import { logger } from '../lib/logger';

interface SendOtpResponse {
  success: boolean;
  verificationId?: string;
  message?: string;
}

interface VerifyOtpResponse {
  success: boolean;
  message?: string;
}

interface MessageCentralConfig {
  enabled: boolean;
  customerId: string;
  email: string;
  password: string;
  /** Paste from console → API Credentials → Auth Token */
  authToken: string;
  baseUrl: string;
  countryCode: string;
  otpLength: number;
  flowType: string;
}

const STATIC_OTP = '1234';
const STATIC_VERIFICATION_ID = 'static-otp-verification';
const DEFAULT_BASE = 'https://cpaas.messagecentral.com';
const MC_TIMEOUT_MS = 12_000;

/** Static 1234 only when explicitly allowed (local/dev). Never on production by default. */
const allowStaticOtp = () =>
  process.env.ALLOW_STATIC_OTP === 'true' ||
  process.env.NODE_ENV === 'development';

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ res: Response; data: any }> {
  const { timeoutMs = MC_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const data: any = await res.json().catch(() => ({}));
    return { res, data };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Message Central timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class MessageCentralService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  async loadConfig(): Promise<MessageCentralConfig> {
    // Native read so schema lag / lean never drops fields
    let s: any = null;
    try {
      s = await SettingsModel.collection.findOne({}, { sort: { updatedAt: -1 } });
    } catch {
      s = await SettingsModel.findOne().lean();
    }
    // Prefer Tataiya field names; fall back to legacy mc* if still present
    const otpLen = Number(
      s?.messageCentralOtpLength ?? s?.mcOtpLength ?? 4
    );
    const enabled = !!(s?.messageCentralEnabled ?? s?.mcEnabled);
    return {
      enabled,
      customerId: String(s?.messageCentralCustomerId || s?.mcCustomerId || '').trim(),
      email: String(s?.messageCentralEmail || s?.mcEmail || '').trim(),
      password: String(s?.messageCentralPassword || s?.mcPassword || ''),
      authToken: String(s?.messageCentralAuthToken || s?.mcAuthToken || '').trim(),
      baseUrl: String(
        s?.messageCentralBaseUrl || s?.mcBaseUrl || DEFAULT_BASE
      ).replace(/\/$/, ''),
      countryCode: String(
        s?.messageCentralCountryCode || s?.mcCountryCode || '91'
      ).replace(/^\+/, ''),
      otpLength: otpLen >= 4 && otpLen <= 8 ? otpLen : 4,
      flowType: String(
        s?.messageCentralFlowType || s?.mcFlowType || 'SMS'
      ).toUpperCase(),
    };
  }

  /** Live OTP when Customer ID + Auth Token (or password) are configured.
   *  If keys exist, treat as live even if the enable switch was left off. */
  private useLive(cfg: MessageCentralConfig) {
    const hasKeys = !!cfg.customerId && (!!cfg.authToken || !!cfg.password);
    return hasKeys && (cfg.enabled || !!cfg.authToken);
  }

  private missingKeysMessage() {
    return 'Message Gateway is not configured. Admin → Settings → Message Gateway (OTP): paste Customer ID + Auth Token, turn Enable ON, then Save.';
  }

  private async getAuthToken(cfg: MessageCentralConfig): Promise<string> {
    if (cfg.authToken) {
      return cfg.authToken;
    }

    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    if (!cfg.password) {
      throw new Error('Message Central Auth Token or Password is required');
    }

    const key = Buffer.from(cfg.password, 'utf8').toString('base64');
    const params = new URLSearchParams({
      customerId: cfg.customerId,
      key,
      scope: 'NEW',
      country: cfg.countryCode,
      ...(cfg.email ? { email: cfg.email } : {}),
    });

    const url = `${cfg.baseUrl}/auth/v1/authentication/token?${params.toString()}`;
    const { res, data } = await fetchJson(url, { method: 'GET' });

    const token =
      data?.token ||
      data?.authToken ||
      data?.data?.token ||
      data?.data?.authToken ||
      '';

    if (!token) {
      logger.error({ data, status: res.status }, 'Message Central token failed');
      throw new Error(data?.message || data?.errorMessage || 'Failed to get Message Central auth token');
    }

    this.cachedToken = String(token);
    this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    return this.cachedToken;
  }

  private clearToken() {
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  async sendOtp(mobileNumber: string): Promise<SendOtpResponse> {
    const cfg = await this.loadConfig();
    const phone = String(mobileNumber || '').replace(/\D/g, '').slice(-10);

    if (!phone || phone.length !== 10) {
      return { success: false, message: 'Enter a valid 10-digit mobile number' };
    }

    if (!this.useLive(cfg)) {
      if (allowStaticOtp()) {
        logger.warn('Message Central not live — static OTP 1234 (ALLOW_STATIC_OTP / development)');
        return {
          success: true,
          verificationId: STATIC_VERIFICATION_ID,
          message: `OTP sent successfully. Use ${STATIC_OTP} as OTP (dev fallback)`,
        };
      }
      logger.error(
        {
          enabled: cfg.enabled,
          hasCustomerId: !!cfg.customerId,
          hasAuthToken: !!cfg.authToken,
          hasPassword: !!cfg.password,
        },
        'Message Central OTP blocked — not configured'
      );
      return { success: false, message: this.missingKeysMessage() };
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

      const doSend = async (authToken: string) =>
        fetchJson(`${cfg.baseUrl}/verification/v3/send?${params.toString()}`, {
          method: 'POST',
          headers: {
            authToken,
            Accept: 'application/json',
          },
        });

      let { res, data } = await doSend(token);
      if (
        !cfg.authToken &&
        (res.status === 401 || data?.responseCode === 401 || /token|unauthor/i.test(String(data?.message || '')))
      ) {
        this.clearToken();
        token = await this.getAuthToken(cfg);
        ({ res, data } = await doSend(token));
      }

      const verificationId =
        data?.data?.verificationId ||
        data?.verificationId ||
        data?.data?.verification_id ||
        '';

      const ok =
        !!verificationId ||
        res.ok ||
        Number(data?.responseCode) === 200 ||
        Number(data?.status) === 200 ||
        String(data?.message || '').toLowerCase().includes('success');

      if (!ok || !verificationId) {
        logger.error({ data, status: res.status }, 'Message Central send OTP failed');
        return {
          success: false,
          message:
            data?.message ||
            data?.errorMessage ||
            data?.data?.message ||
            `Failed to send OTP (HTTP ${res.status}). Check Auth Token / credits in Message Central.`,
        };
      }

      // Auto-flip enable flag if keys work but switch was off
      if (!cfg.enabled) {
        void SettingsModel.updateOne({}, { $set: { messageCentralEnabled: true } }).catch(() => {});
      }

      return {
        success: true,
        verificationId: String(verificationId),
        message: 'OTP sent successfully',
      };
    } catch (err: any) {
      logger.error({ err }, 'Message Central send OTP error');
      return {
        success: false,
        message: err?.message || 'Failed to send OTP',
      };
    }
  }

  async verifyOtp(verificationId: string | undefined, code: string): Promise<VerifyOtpResponse> {
    const cfg = await this.loadConfig();
    const otp = String(code || '').trim();

    if (!this.useLive(cfg)) {
      if (allowStaticOtp() && verificationId === STATIC_VERIFICATION_ID) {
        if (otp === STATIC_OTP) return { success: true, message: 'OTP verified successfully' };
        return { success: false, message: `Invalid OTP. Use ${STATIC_OTP}` };
      }
      return { success: false, message: this.missingKeysMessage() };
    }

    // Reject stale static sessions once live is on
    if (verificationId === STATIC_VERIFICATION_ID) {
      return { success: false, message: 'Invalid verification session. Request a new OTP.' };
    }

    if (!verificationId) {
      return { success: false, message: 'Missing verificationId — request a new OTP' };
    }

    try {
      let token = await this.getAuthToken(cfg);
      const params = new URLSearchParams({
        verificationId: String(verificationId),
        code: otp,
        customerId: cfg.customerId,
      });

      const doValidate = async (authToken: string) =>
        fetchJson(`${cfg.baseUrl}/verification/v3/validateOtp?${params.toString()}`, {
          method: 'GET',
          headers: {
            authToken,
            Accept: 'application/json',
          },
        });

      let { res, data } = await doValidate(token);
      if (!cfg.authToken && (res.status === 401 || data?.responseCode === 401)) {
        this.clearToken();
        token = await this.getAuthToken(cfg);
        ({ res, data } = await doValidate(token));
      }

      const verificationStatus = String(
        data?.data?.verificationStatus ||
        data?.verificationStatus ||
        data?.data?.status ||
        ''
      ).toUpperCase();

      const responseCode = Number(data?.responseCode ?? data?.status ?? res.status);

      if (/FAIL|INVALID|EXPIRED|REJECT/i.test(verificationStatus)) {
        return { success: false, message: data?.message || 'Invalid or expired OTP' };
      }

      const ok =
        verificationStatus === 'VERIFICATION_COMPLETED' ||
        verificationStatus === 'SUCCESS' ||
        verificationStatus === 'VERIFIED' ||
        (responseCode === 200 && !verificationStatus);

      if (!ok) {
        return {
          success: false,
          message: data?.message || data?.errorMessage || 'Invalid or expired OTP',
        };
      }

      return { success: true, message: 'OTP verified successfully' };
    } catch (err: any) {
      logger.error({ err }, 'Message Central verify OTP error');
      return { success: false, message: err?.message || 'OTP verification failed' };
    }
  }
}

export const messageCentral = new MessageCentralService();

/** For scripts / diagnostics — same DB fields as Tataiya Message Gateway */
export async function loadMcConfig() {
  return messageCentral.loadConfig();
}
