import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserModel } from '../models/User';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PlanLimitModel } from '../models/PlanLimit';
import { LanguageModel } from '../models/Language';
import { SubscriptionModel } from '../models/Subscription';
import { messageCentral } from '../services/messageCentralService';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { sendTemplateEmail } from '../lib/email';
import { SettingsModel } from '../models/Settings';
import jwt from 'jsonwebtoken';
import { normalizePlanKey } from './subscriptionController';

const messageCentralService = messageCentral;

/** Normalize any Indian/intl phone input to 10 digits */
function normalizePhone(input: string): string {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/** Prefer live Subscription rows so admin-created plans show on login immediately */
async function resolveSubscriptionPayload(user: any) {
  const userId = user._id;
  const liveSub = await SubscriptionModel.findOne({
    userId,
    status: 'active',
    $or: [{ endDate: { $gte: new Date() } }, { endDate: null }, { endDate: { $exists: false } }],
  })
    .sort({ endDate: -1 })
    .lean();

  if (liveSub) {
    const planKey = normalizePlanKey(liveSub.plan);
    if (
      user.subscriptionPlan !== planKey ||
      user.subscriptionStatus !== 'active' ||
      !user.subscriptionExpiry ||
      (liveSub.endDate &&
        new Date(user.subscriptionExpiry).getTime() !== new Date(liveSub.endDate).getTime())
    ) {
      await UserModel.findByIdAndUpdate(userId, {
        $set: {
          subscriptionPlan: planKey,
          subscriptionStatus: 'active',
          subscriptionExpiry: liveSub.endDate || null,
          subscriptionPlanId: liveSub.planId || null,
        },
      });
    }
    return {
      subscriptionPlan: planKey,
      subscriptionStatus: 'active' as const,
      subscriptionExpiry: liveSub.endDate || null,
      subscription: true,
    };
  }

  const plan = String(user.subscriptionPlan || 'free').toLowerCase();
  const status = String(user.subscriptionStatus || 'inactive').toLowerCase();
  const expiry = user.subscriptionExpiry || null;
  const active =
    status === 'active' &&
    plan !== 'free' &&
    (!expiry || new Date(expiry) > new Date());

  return {
    subscriptionPlan: active ? plan : 'free',
    subscriptionStatus: active ? 'active' : 'inactive',
    subscriptionExpiry: expiry,
    subscription: active,
  };
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
    const { verificationId, otp, deviceId, deviceName, name: providedName } = body.data;
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

    // ── Manage Device Limits ──────────────────────────────────────────────────
    if (deviceId) {
      let deviceLimitCount = 1;
      const planName = userDoc.subscriptionPlan || 'free';
      const isActive = userDoc.subscriptionStatus === 'active' && 
                       (!userDoc.subscriptionExpiry || userDoc.subscriptionExpiry > new Date());
                       
      if (isActive && planName !== 'free') {
        const plan = await SubscriptionPlanModel.findOne({ name: planName }).lean();
        if (plan) {
          const limit = await PlanLimitModel.findOne({ planId: plan._id }).lean();
          if (limit) {
            deviceLimitCount = limit.deviceLimitCount;
          }
        }
      }

      const devices = (userDoc as any).devices || [];
      const existingDeviceIndex = devices.findIndex((d: any) => d.deviceId === deviceId);

      if (existingDeviceIndex !== -1) {
        devices[existingDeviceIndex].lastActive = new Date();
        devices[existingDeviceIndex].deviceName = deviceName || devices[existingDeviceIndex].deviceName;
      } else {
        const newDevice = {
          deviceId,
          deviceName: deviceName || 'Unknown Device',
          deviceType: 'mobile',
          lastActive: new Date(),
          addedAt: new Date()
        };
        
        while (devices.length >= deviceLimitCount) {
          devices.sort((a: any, b: any) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime());
          devices.shift();
        }
        devices.push(newDevice);
      }
      (userDoc as any).devices = devices;
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
      deviceId: deviceId || 'unknown',
    };
    const accessToken = server.jwt.sign(tokenPayload, {
      expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '7d',
    });

    const sub = await resolveSubscriptionPayload(userDoc);

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
      profileLimitCount: (userDoc as any).profileLimitCount || 1,
      isNewUser: allUsersWithPhone.length === 0,
      expiresIn: 604800,
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
        await appUser.save();
        const server = request.server as any;
        const accessToken = server.jwt.sign({ id: appUser._id.toString(), name: appUser.name, role: 'user' }, { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '7d' });
        return reply.status(200).send({ success: true, accessToken, userId: appUser._id.toString(), name: appUser.name, avatar: appUser.avatar || null, subscriptionPlan: appUser.subscriptionPlan || 'free', subscriptionStatus: appUser.subscriptionStatus || 'inactive', expiresIn: 604800, linked: true });
      }
    }

    // Normal registration — check email uniqueness
    const existing = await UserModel.findOne({ email });
    if (existing) return reply.status(400).send({ success: false, message: 'Email already registered' });

    const newProfile = { name, isKids: false, maturityLevel: 18, language: 'Hindi' };
    const user = new UserModel({ email, passwordHash, name, phone: phone || undefined, profiles: [newProfile], preferredLanguage: 'Hindi', languageSelectionSkipped: false });
    await user.save();

    sendTemplateEmail('Registration', email, {
      user_name: name,
      site_url: process.env.FRONTEND_URL || process.env.ADMIN_PANEL_URL || 'http://localhost:5173',
    }).catch((err) => console.error('[email] Registration email failed:', err));

    const server = request.server as any;
    const accessToken = server.jwt.sign({ id: user._id.toString(), name: user.name, role: 'user' }, { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '7d' });
    return reply.status(200).send({ success: true, accessToken, userId: user._id.toString(), name: user.name, avatar: user.avatar || null, subscriptionPlan: user.subscriptionPlan || 'free', subscriptionStatus: user.subscriptionStatus || 'inactive', expiresIn: 604800 });
  } catch (error) {
    console.error('Register Error:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error' });
  }
};

// Login accepts email OR phone number (phone if no '@' in value)
const loginSchema = z.object({ email: z.string().min(1), password: z.string() });

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

    user.lastLogin = new Date();
    user.loginCount += 1;
    await user.save();
    const server = request.server as any;
    const accessToken = server.jwt.sign({ id: user._id.toString(), name: user.name, role: 'user' }, { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '7d' });
    const sub = await resolveSubscriptionPayload(user);
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
      profileLimitCount: (user as any).profileLimitCount || 1,
      expiresIn: 604800,
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
    { expiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '7d' }
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
    const accessToken = signUserToken(request, user);
    return reply.send({ success: true, accessToken, userId: user._id.toString(), name: user.name, subscriptionPlan: user.subscriptionPlan || 'free', subscriptionStatus: user.subscriptionStatus || 'inactive', expiresIn: 604800 });
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
    const accessToken = signUserToken(request, user);
    return reply.send({ success: true, accessToken, userId: user._id.toString(), name: user.name, subscriptionPlan: user.subscriptionPlan || 'free', subscriptionStatus: user.subscriptionStatus || 'inactive', expiresIn: 604800 });
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

    if (userId) {
      // Remove all devices for this user on logout
      await UserModel.findByIdAndUpdate(userId, {
        $set: { devices: [] },
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

