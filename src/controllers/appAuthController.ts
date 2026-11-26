import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserModel } from '../models/User';
import { LanguageModel } from '../models/Language';
import { messageCentral } from '../services/messageCentralService';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { sendTemplateEmail } from '../lib/email';
import { SettingsModel } from '../models/Settings';
import jwt from 'jsonwebtoken';
import { resolveAccountEntitlement, type AccountEntitlement } from '../lib/subscriptionAccess';
import {
  deviceIdentityForLogin,
  publicLimitCount,
  registerDevice,
  toDeviceRecords,
  type DeviceLoginResult,
} from '../lib/accountLimits';

const messageCentralService = messageCentral;

/** Normalize any Indian/intl phone input to 10 digits */
function normalizePhone(input: string): string {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) return String(value[0] || '');
  return value ? String(value) : '';
}

function readDeviceInput(request: FastifyRequest, body?: any) {
  const source = body || {};
  return {
    deviceId: source.deviceId || headerValue(request, 'x-device-id'),
    deviceName: source.deviceName || headerValue(request, 'x-device-name'),
    deviceType: source.deviceType || headerValue(request, 'x-device-type'),
  };
}

function subscriptionPayload(ent: AccountEntitlement) {
  const active = ent.active && ent.planKey !== 'free';
  return {
    subscriptionPlan: active ? ent.planName : 'free',
    subscriptionPlanName: active ? ent.planName : null,
    subscriptionStatus: active ? ('active' as const) : ('inactive' as const),
    subscriptionExpiry: ent.expiry,
    subscription: active,
    profileLimitCount: publicLimitCount(ent.profileLimitCount),
    deviceLimitCount: publicLimitCount(ent.deviceLimitCount),
  };
}

/**
 * Count this login against the plan device cap.
 * The returned entitlement is resolved before the device write, which is correct:
 * registering a device does not change the plan.
 */
async function attachLoginDevice(userDoc: any, request: FastifyRequest, body?: any) {
  const ent = await resolveAccountEntitlement(userDoc._id);
  const identity = deviceIdentityForLogin(String(userDoc._id), readDeviceInput(request, body));
  const result = registerDevice(toDeviceRecords(userDoc.devices), identity, ent.deviceLimitCount);
  if (result.ok) {
    userDoc.devices = result.devices;
    if (typeof userDoc.markModified === 'function') userDoc.markModified('devices');
  }
  return { ent, identity, result };
}

function isDeviceRejected(
  result: DeviceLoginResult
): result is Extract<DeviceLoginResult, { ok: false }> {
  return result.ok === false;
}

function deviceLimitReply(reply: FastifyReply, result: DeviceLoginResult) {
  if (!isDeviceRejected(result)) {
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
  return reply.status(200).send({
    success: false,
    message: result.message,
    code: result.code,
    deviceLimitCount: result.deviceLimitCount,
  });
}

function deviceIsOverLimit(result: DeviceLoginResult): boolean {
  return result.ok && result.overLimit;
}

// Validation schemas
const sendOtpSchema = z.object({
  mobileNumber: z.string().min(8, 'Mobile number required'),
});

const verifyOtpSchema = z.object({
  mobileNumber: z.string().min(8, 'Mobile number required'),
  verificationId: z.string().optional(),
  otp: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
  name: z.string().trim().min(1).max(80).optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
  referralCode: z.string().trim().optional(),
});

const setLanguageSchema = z.object({
  language: z.string().trim().min(1, 'Language is required'),
});

export const sendOtp = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const siteSettings = await SettingsModel.findOne().lean();
    if (siteSettings?.maintenanceMode) {
      return reply.status(503).send({
        success: false,
        message: 'The platform is currently under maintenance. Please try again later.',
        maintenance: true,
      });
    }

    const body = sendOtpSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        success: false,
        message: 'Validation failed',
        errors: body.error.flatten().fieldErrors,
      });
    }

    const mobileNumber = normalizePhone(body.data.mobileNumber);
    if (mobileNumber.length !== 10) {
      return reply.status(400).send({
        success: false,
        message: 'Enter a valid 10-digit mobile number',
      });
    }

    const result = await messageCentralService.sendOtp(mobileNumber);
    if (!result.success) {
      return reply.status(400).send(result);
    }
    if (!result.verificationId) {
      return reply.status(500).send({
        success: false,
        message: 'OTP provider returned no verificationId — check Message Gateway settings',
      });
    }

    return reply.status(200).send({
      success: true,
      verificationId: result.verificationId,
      message: result.message || 'OTP sent successfully',
      mobileNumber,
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    return reply.status(500).send({ 
      success: false, 
      message: 'Internal server error',
      error: (error as Error).message 
    });
  }
};

export const verifyOtp = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const siteSettings = await SettingsModel.findOne().lean();
    if (siteSettings?.maintenanceMode) {
      return reply.status(503).send({
        success: false,
        message: 'The platform is currently under maintenance. Please try again later.',
        maintenance: true,
      });
    }

    const body = verifyOtpSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        success: false,
        message: 'Validation failed',
        errors: body.error.flatten().fieldErrors,
      });
    }
    const { verificationId, otp, name: providedName } = body.data;
    const mobileNumber = normalizePhone(body.data.mobileNumber);

    if (mobileNumber.length !== 10) {
      return reply.status(400).send({
        success: false,
        message: 'Enter a valid 10-digit mobile number',
      });
    }

    const verifyResult = await messageCentralService.verifyOtp(verificationId, otp);
    if (!verifyResult.success) {
      return reply.status(400).send({ 
        success: false, 
        message: verifyResult.message || 'Invalid or expired OTP',
      });
    }

    // Match phone stored as 10 digits or with country prefix
    const phoneQuery = {
      $or: [
        { phone: mobileNumber },
        { phone: `91${mobileNumber}` },
        { phone: `+91${mobileNumber}` },
      ],
    };

    const allUsersWithPhone = await UserModel.find(phoneQuery).lean();

    let user: any = null;
    const displayName = (providedName || '').trim() || 'User';

    if (allUsersWithPhone.length === 0) {
      // Prefer an existing email account that already has this phone unset —
      // do NOT create a temp user if one already exists for this phone under another format.
      // Create temp only when truly new.
      const newProfile = { name: displayName, isKids: false, maturityLevel: 18, language: 'Hindi' };
      const newUser = new UserModel({
        phone: mobileNumber,
        name: displayName,
        email: `${mobileNumber}@temp.local`,
        profiles: [newProfile],
        preferredLanguage: 'Hindi',
        languageSelectionSkipped: false,
      });
      await newUser.save();
      user = newUser;
    } else if (allUsersWithPhone.length === 1) {
      user = allUsersWithPhone[0];
    } else {
      const realAccount = allUsersWithPhone.find(
        (u) => u.email && !u.email.endsWith('@temp.local')
      );
      const tempAccount = allUsersWithPhone.find(
        (u) => u.email && u.email.endsWith('@temp.local')
      );

      user = realAccount || allUsersWithPhone[0];

      if (realAccount && tempAccount) {
        console.log(`[verifyOtp] Merging temp account ${tempAccount._id} into real account ${realAccount._id} for phone ${mobileNumber}`);
        await UserModel.findByIdAndDelete(tempAccount._id);
      }
    }

    const userDoc = await UserModel.findById(user._id);
    if (!userDoc) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    if (userDoc.status === 'banned' || userDoc.status === 'suspended') {
      return reply.status(403).send({
        success: false,
        message: userDoc.banReason ? `Your account has been suspended: ${userDoc.banReason}` : 'Your account has been suspended.'
      });
    }

    // Normalize stored phone to 10 digits
    (userDoc as any).phone = mobileNumber;

    // Optional name update for new/temp accounts
    if (providedName && (userDoc.name === 'User' || !(userDoc as any).email || String((userDoc as any).email).endsWith('@temp.local'))) {
      userDoc.name = displayName;
      if (userDoc.profiles?.length) {
        userDoc.profiles[0].name = displayName;
      }
    }

    const deviceAttempt = await attachLoginDevice(userDoc, request, body.data);
    if (!deviceAttempt.result.ok) {
      return deviceLimitReply(reply, deviceAttempt.result);
    }

    userDoc.lastLogin = new Date();
    userDoc.loginCount = (userDoc.loginCount || 0) + 1;
    await userDoc.save();

    const server = request.server as any;
    const tokenPayload = {
      id: userDoc._id.toString(),
      name: userDoc.name,
      phone: (userDoc as any).phone,
      role: 'user' as const,
      deviceId: deviceAttempt.identity.deviceId,
    };
    const accessToken = server.jwt.sign(tokenPayload, {
      expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '365d',
    });

    const sub = subscriptionPayload(deviceAttempt.ent);

    return reply.status(200).send({
      success: true,
      accessToken,
      userId: userDoc._id.toString(),
      name: userDoc.name,
      email: (userDoc as any).email && !(userDoc as any).email.endsWith('@temp.local')
        ? (userDoc as any).email
        : null,
      phone: (userDoc as any).phone || null,
      avatar: (userDoc as any).avatar || null,
      ...sub,
      walletBalance: (userDoc as any).walletBalance || 0,
      isNewUser: allUsersWithPhone.length === 0,
      expiresIn: 31536000,
      ...(deviceIsOverLimit(deviceAttempt.result) ? { deviceLimitReached: true } : {}),
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return reply.status(500).send({ 
      success: false, 
      message: 'Internal server error',
      error: (error as Error).message 
    });
  }
};

export const setPreferredLanguage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { userId } = request.params as { userId: string };
    const body = setLanguageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        success: false,
        message: 'Validation failed',
        errors: body.error.flatten().fieldErrors,
      });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    // Resolve language input robustly
    let resolvedLanguage = body.data.language;
    const langDoc = await LanguageModel.findOne({
      $or: [
        { name: new RegExp(`^${body.data.language}$`, 'i') },
        { code: body.data.language.toLowerCase() },
        ...(mongoose.Types.ObjectId.isValid(body.data.language) ? [{ _id: body.data.language }] : [])
      ]
    }).lean();
    if (langDoc) {
      resolvedLanguage = langDoc.name;
    }

    user.preferredLanguage = resolvedLanguage;
    user.languageSelectionSkipped = false;
    if (user.profiles.length > 0) {
      user.profiles[0].language = resolvedLanguage;
    }
    await user.save();

    return reply.status(200).send({
      success: true,
      message: 'Preferred language updated successfully',
      data: {
        userId: user._id.toString(),
        preferredLanguage: user.preferredLanguage,
        languageSelectionSkipped: user.languageSelectionSkipped,
      },
    });
  } catch (error) {
    console.error('Error setting preferred language:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};

export const skipPreferredLanguage = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { userId } = request.params as { userId: string };

    const user = await UserModel.findById(userId);
    if (!user) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    user.preferredLanguage = 'Hindi';
    user.languageSelectionSkipped = true;
    if (user.profiles.length > 0) {
      user.profiles[0].language = 'Hindi';
    }
    await user.save();

    return reply.status(200).send({
      success: true,
      message: 'Language selection skipped successfully',
      data: {
        userId: user._id.toString(),
        preferredLanguage: 'Hindi',
        languageSelectionSkipped: true,
      },
    });
  } catch (error) {
    console.error('Error skipping preferred language:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string(),
  phone: z.string().optional(),
  referralCode: z.string().trim().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
});

export const registerUser = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    // Check maintenance mode and registration setting
    const siteSettings = await SettingsModel.findOne().lean();
    if (siteSettings?.maintenanceMode) {
      return reply.status(503).send({ success: false, message: 'The platform is currently under maintenance. Please try again later.', maintenance: true });
    }
    if (siteSettings?.userRegistration === false) {
      return reply.status(403).send({ success: false, message: 'New user registration is currently disabled.' });
    }

    const body = registerSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ success: false, message: 'Validation failed', errors: body.error.flatten().fieldErrors });
    const { email, password, name, phone } = body.data;

    const passwordHash = await bcrypt.hash(password, 10);

    // If phone provided: check if an app user (phone-only) already exists — link accounts
    if (phone) {
      const appUser = await UserModel.findOne({ phone, email: { $exists: false } });
      if (appUser) {
        appUser.email = email;
        appUser.passwordHash = passwordHash;
        if (!appUser.name || appUser.name === phone) appUser.name = name;
        const deviceAttempt = await attachLoginDevice(appUser, request, body.data);
        if (!deviceAttempt.result.ok) {
          return deviceLimitReply(reply, deviceAttempt.result);
        }
        await appUser.save();
        const server = request.server as any;
        const accessToken = server.jwt.sign(
          { id: appUser._id.toString(), name: appUser.name, role: 'user', deviceId: deviceAttempt.identity.deviceId },
          { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '365d' }
        );
        const sub = subscriptionPayload(deviceAttempt.ent);
        return reply.status(200).send({ success: true, accessToken, userId: appUser._id.toString(), name: appUser.name, avatar: appUser.avatar || null, ...sub, expiresIn: 31536000, linked: true });
      }
    }

    // Normal registration — check email uniqueness
    const existing = await UserModel.findOne({ email });
    if (existing) return reply.status(400).send({ success: false, message: 'Email already registered' });

    const newProfile = { name, isKids: false, maturityLevel: 18, language: 'Hindi' };
    const user = new UserModel({ email, passwordHash, name, phone: phone || undefined, profiles: [newProfile], preferredLanguage: 'Hindi', languageSelectionSkipped: false });
    await user.save();

    const deviceAttempt = await attachLoginDevice(user, request, body.data);
    if (!deviceAttempt.result.ok) {
      return deviceLimitReply(reply, deviceAttempt.result);
    }
    await user.save();

    sendTemplateEmail('Registration', email, {
      user_name: name,
      site_url: process.env.FRONTEND_URL || process.env.ADMIN_PANEL_URL || 'http://localhost:5173',
    }).catch((err) => console.error('[email] Registration email failed:', err));

    const server = request.server as any;
    const accessToken = server.jwt.sign(
      { id: user._id.toString(), name: user.name, role: 'user', deviceId: deviceAttempt.identity.deviceId },
      { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '365d' }
    );
    const sub = subscriptionPayload(deviceAttempt.ent);
    return reply.status(200).send({ success: true, accessToken, userId: user._id.toString(), name: user.name, avatar: user.avatar || null, ...sub, expiresIn: 31536000 });
  } catch (error) {
    console.error('Register Error:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};

// Login accepts email OR phone number (phone if no '@' in value)
const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  deviceType: z.string().optional(),
});

export const loginUser = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const siteSettings = await SettingsModel.findOne().lean();
    if (siteSettings?.maintenanceMode) {
      return reply.status(503).send({ success: false, message: 'The platform is currently under maintenance. Please try again later.', maintenance: true });
    }

    const body = loginSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ success: false, message: 'Validation failed' });
    const { email: emailOrPhone, password } = body.data;

    // Determine if input is a phone number (no '@') or email
    const isPhone = !emailOrPhone.includes('@');
    const phoneNorm = isPhone ? emailOrPhone.replace(/\D/g, '').slice(-10) : '';
    const user = await UserModel.findOne(
      isPhone
        ? { $or: [{ phone: phoneNorm }, { phone: emailOrPhone }, { phone: `91${phoneNorm}` }] }
        : { email: emailOrPhone }
    );

    if (!user) return reply.status(401).send({ success: false, message: 'No account found. Please register first.' });
    
    if (user.status === 'banned' || user.status === 'suspended') {
      return reply.status(403).send({
        success: false,
        message: user.banReason ? `Your account has been suspended: ${user.banReason}` : 'Your account has been suspended.'
      });
    }

    if (!user.passwordHash) return reply.status(401).send({ success: false, message: 'This account uses phone OTP login. Please set a password first.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return reply.status(401).send({ success: false, message: 'Invalid credentials' });

    const deviceAttempt = await attachLoginDevice(user, request, body.data);
    if (!deviceAttempt.result.ok) {
      return deviceLimitReply(reply, deviceAttempt.result);
    }

    user.lastLogin = new Date();
    user.loginCount += 1;
    await user.save();
    const server = request.server as any;
    const accessToken = server.jwt.sign(
      { id: user._id.toString(), name: user.name, role: 'user', deviceId: deviceAttempt.identity.deviceId },
      { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '365d' }
    );
    const sub = subscriptionPayload(deviceAttempt.ent);
    return reply.status(200).send({
      success: true,
      accessToken,
      userId: user._id.toString(),
      name: user.name,
      email: user.email || null,
      phone: (user as any).phone || null,
      avatar: user.avatar || null,
      ...sub,
      walletBalance: user.walletBalance || 0,
      expiresIn: 31536000,
      ...(deviceIsOverLimit(deviceAttempt.result) ? { deviceLimitReached: true } : {}),
    });

  } catch (error) {
    console.error('Login Error:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};

// ── Helper: sign a user JWT ────────────────────────────────────────────────
function signUserToken(request: FastifyRequest, user: any, deviceId?: string) {
  const server = request.server as any;
  return server.jwt.sign(
    { id: user._id.toString(), name: user.name, role: 'user', deviceId: deviceId || 'unknown' },
    { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '365d' }
  );
}

// ── Helper: find or create social user ────────────────────────────────────
async function findOrCreateSocialUser(email: string, name: string, provider: string) {
  let user = await UserModel.findOne({ email });
  if (!user) {
    const defaultProfile = { name, isKids: false, maturityLevel: 18, language: 'Hindi' };
    user = new UserModel({
      email,
      passwordHash: await bcrypt.hash(Math.random().toString(36), 10),
      name,
      profiles: [defaultProfile],
      preferredLanguage: 'Hindi',
      languageSelectionSkipped: false,
    });
    await user.save();
    sendTemplateEmail('Registration', email, { user_name: name, site_url: process.env.FRONTEND_URL || 'http://localhost:5173' }).catch(() => {});
  }
  return user;
}

// ── Google Sign In ─────────────────────────────────────────────────────────
export const googleAuth = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const siteSettings = await SettingsModel.findOne().lean();
    if (siteSettings?.maintenanceMode) {
      return reply.status(503).send({ success: false, message: 'The platform is under maintenance.', maintenance: true });
    }
    if (!siteSettings?.socialLogin) {
      return reply.status(403).send({ success: false, message: 'Social login is disabled.' });
    }
    if (!siteSettings?.googleClientId) {
      return reply.status(400).send({ success: false, message: 'Google Sign In is not configured.' });
    }

    const { idToken } = request.body as { idToken: string };
    if (!idToken) return reply.status(400).send({ success: false, message: 'idToken is required' });

    // Verify Google ID token via Google's tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verifyRes.ok) return reply.status(401).send({ success: false, message: 'Invalid Google token' });
    const payload = await verifyRes.json() as any;

    // Check audience matches our clientId
    if (payload.aud !== siteSettings.googleClientId && payload.azp !== siteSettings.googleClientId) {
      return reply.status(401).send({ success: false, message: 'Token audience mismatch' });
    }
    if (!payload.email) return reply.status(400).send({ success: false, message: 'No email in Google token' });

    const user = await findOrCreateSocialUser(payload.email, payload.name || payload.email.split('@')[0], 'google');
    const deviceAttempt = await attachLoginDevice(user, request, request.body);
    if (!deviceAttempt.result.ok) {
      return deviceLimitReply(reply, deviceAttempt.result);
    }
    await user.save();
    const accessToken = signUserToken(request, user, deviceAttempt.identity.deviceId);
    const sub = subscriptionPayload(deviceAttempt.ent);
    return reply.send({ success: true, accessToken, userId: user._id.toString(), name: user.name, avatar: user.avatar || null, ...sub, expiresIn: 31536000, ...(deviceIsOverLimit(deviceAttempt.result) ? { deviceLimitReached: true } : {}) });
  } catch (error) {
    console.error('Google Auth Error:', error);
    return reply.status(500).send({ success: false, message: 'Google authentication failed' });
  }
};

// ── Apple Sign In ──────────────────────────────────────────────────────────
export const appleAuth = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const siteSettings = await SettingsModel.findOne().lean();
    if (siteSettings?.maintenanceMode) {
      return reply.status(503).send({ success: false, message: 'The platform is under maintenance.', maintenance: true });
    }
    if (!siteSettings?.socialLogin) {
      return reply.status(403).send({ success: false, message: 'Social login is disabled.' });
    }
    if (!siteSettings?.appleClientId) {
      return reply.status(400).send({ success: false, message: 'Apple Sign In is not configured.' });
    }

    const { idToken, user: appleUser } = request.body as { idToken: string; user?: { name?: { firstName?: string; lastName?: string }; email?: string } };
    if (!idToken) return reply.status(400).send({ success: false, message: 'idToken is required' });

    // Decode Apple JWT header to get kid
    const decoded = jwt.decode(idToken, { complete: true }) as any;
    if (!decoded?.header?.kid) return reply.status(401).send({ success: false, message: 'Invalid Apple token' });

    // Fetch Apple public keys
    const keysRes = await fetch('https://appleid.apple.com/auth/keys');
    if (!keysRes.ok) return reply.status(500).send({ success: false, message: 'Could not fetch Apple public keys' });
    const keys = (await keysRes.json() as any).keys as any[];
    const appleKey = keys.find((k: any) => k.kid === decoded.header.kid);
    if (!appleKey) return reply.status(401).send({ success: false, message: 'Apple key not found' });

    // Build PEM from JWK using Node crypto (synchronous)
    const jwkToPem = (jwk: any): string => {
      const crypto = require('crypto');
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      return key.export({ type: 'spki', format: 'pem' }) as string;
    };

    let payload: any;
    try {
      const pem = jwkToPem(appleKey);
      payload = jwt.verify(idToken, pem, { algorithms: ['RS256'], audience: siteSettings.appleClientId, issuer: 'https://appleid.apple.com' });
    } catch (err) {
      return reply.status(401).send({ success: false, message: 'Apple token verification failed' });
    }

    const email = (payload as any).email || appleUser?.email;
    if (!email) return reply.status(400).send({ success: false, message: 'No email in Apple token' });

    const firstName = appleUser?.name?.firstName || '';
    const lastName = appleUser?.name?.lastName || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

    const user = await findOrCreateSocialUser(email, name, 'apple');
    const deviceAttempt = await attachLoginDevice(user, request, request.body);
    if (!deviceAttempt.result.ok) {
      return deviceLimitReply(reply, deviceAttempt.result);
    }
    await user.save();
    const accessToken = signUserToken(request, user, deviceAttempt.identity.deviceId);
    const sub = subscriptionPayload(deviceAttempt.ent);
    return reply.send({ success: true, accessToken, userId: user._id.toString(), name: user.name, avatar: user.avatar || null, ...sub, expiresIn: 31536000, ...(deviceIsOverLimit(deviceAttempt.result) ? { deviceLimitReached: true } : {}) });
  } catch (error) {
    console.error('Apple Auth Error:', error);
    return reply.status(500).send({ success: false, message: 'Apple authentication failed' });
  }
};

// ── App Logout ─────────────────────────────────────────────────────────────
export const logoutUser = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    // Verify the JWT is valid before processing logout
    await request.jwtVerify();

    const userId = (request.user as any).id;
    const deviceId = (request.user as any).deviceId;

    if (userId && deviceId && deviceId !== 'unknown') {
      await UserModel.findByIdAndUpdate(userId, {
        $pull: { devices: { deviceId } },
      });
    }

    return reply.status(200).send({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    // If JWT is invalid/expired, the user is already logged out — still return 200
    return reply.status(200).send({
      success: true,
      message: 'Logged out successfully',
    });
  }
};

