import type { FastifyReply, FastifyRequest } from 'fastify';
import { SettingsModel } from '../models/Settings';
import uploadHandler from '../lib/uploadHandler';
import { updateEnvFile } from '../lib/envUpdater';
import { sendWelcomeEmail } from '../lib/email';

async function getOrCreateSettings() {
  let settings = await SettingsModel.findOne();
  if (!settings) settings = await SettingsModel.create({});
  return settings;
}

export const getSettings = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const settings = await getOrCreateSettings();
    const obj = settings.toObject ? settings.toObject() : { ...(settings as any) };

    // Check if requester is an admin with settings view permission
    let isAdmin = false;
    try {
      await request.jwtVerify();
      const decodedUser = request.user as { id?: string; _id?: string; role?: string };
      const adminId = decodedUser?.id || decodedUser?._id;
      // Trust admin/superadmin role on JWT (same token used for PUT)
      if (decodedUser?.role === 'superadmin' || decodedUser?.role === 'admin') {
        isAdmin = true;
      } else if (adminId) {
        const { checkUserPermission } = await import('../middlewares/rbac');
        const permResult = await checkUserPermission(String(adminId), 'settings', 'canView');
        if (permResult.allowed) {
          isAdmin = true;
        }
      }
    } catch {
      // Not logged in or not an admin
    }

    // Never send raw secrets to the browser — only "is set" flags
    const mcAuthTokenSet = !!(obj as any).mcAuthToken;
    const mcPasswordSet = !!(obj as any).mcPassword;
    delete (obj as any).mcAuthToken;
    delete (obj as any).mcPassword;

    if (isAdmin) {
      return reply.send({
        success: true,
        data: {
          ...obj,
          mcAuthTokenSet,
          mcPasswordSet,
        },
      });
    }

    const sensitiveFields = [
      'mailEmail', 'mailDriver', 'mailHost', 'mailPort', 'mailEncryption', 'mailUsername', 'mailPassword', 'mailFrom', 'mailFromName',
      'awsAccessKeyId', 'awsSecretAccessKey', 'awsRegion', 'awsBucket', 'awsPathStyleEndpoint', 'bunnyStorageZone', 'bunnyAccessKey',
      'fcmServerKey', 'fcmSenderId', 'firebaseApiKey', 'firebaseProjectId', 'firebaseAppId',
      'mcCustomerId', 'mcEmail', 'mcBaseUrl',
      'razorpayKeySecret', 'razorpayKeyId',
    ];
    for (const field of sensitiveFields) {
      delete (obj as any)[field];
    }
    return reply.send({
      success: true,
      data: {
        ...obj,
        mcAuthTokenSet: false,
        mcPasswordSet: false,
      },
    });
  } catch (error: any) {
    console.error(error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateSettings = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = (request.body || {}) as Record<string, any>;

    // Whitelist Message Central fields so they always persist (even if other
    // keys in the body are ignored by schema elsewhere).
    const mcSet: Record<string, any> = {};
    if (body.mcEnabled !== undefined) {
      mcSet.mcEnabled = body.mcEnabled === true || body.mcEnabled === 'true';
    }
    if (typeof body.mcCustomerId === 'string') {
      mcSet.mcCustomerId = body.mcCustomerId.trim();
    }
    if (typeof body.mcAuthToken === 'string') {
      const t = body.mcAuthToken.replace(/\s+/g, '').trim();
      if (t) mcSet.mcAuthToken = t;
    }
    if (typeof body.mcPassword === 'string') {
      const p = body.mcPassword.trim();
      if (p) mcSet.mcPassword = p;
    }
    if (typeof body.mcEmail === 'string') mcSet.mcEmail = body.mcEmail.trim();
    if (typeof body.mcBaseUrl === 'string') {
      mcSet.mcBaseUrl = body.mcBaseUrl.trim().replace(/\/$/, '') || 'https://cpaas.messagecentral.com';
    }
    if (typeof body.mcCountryCode === 'string') {
      mcSet.mcCountryCode = body.mcCountryCode.trim().replace(/^\+/, '') || '91';
    }
    if (body.mcOtpLength !== undefined) {
      mcSet.mcOtpLength = Math.min(8, Math.max(4, Number(body.mcOtpLength) || 4));
    }
    if (typeof body.mcFlowType === 'string') {
      mcSet.mcFlowType = body.mcFlowType.trim().toUpperCase() || 'SMS';
    }

    // Everything else (mail, storage, branding, …)
    const $set: Record<string, any> = { ...body, ...mcSet };
    // Never persist client-only flags
    delete $set.mcAuthTokenSet;
    delete $set.mcPasswordSet;
    delete $set._id;
    delete $set.__v;
    // Don't blank secrets with empty strings
    if ($set.mcAuthToken === '') delete $set.mcAuthToken;
    if ($set.mcPassword === '') delete $set.mcPassword;

    const col = SettingsModel.collection;
    const existingCount = await col.countDocuments();
    if (existingCount === 0) {
      await col.insertOne({ ...$set, createdAt: new Date(), updatedAt: new Date() });
    } else {
      // Update ALL settings docs — avoids duplicate-doc hide bugs
      await col.updateMany({}, { $set: { ...$set, updatedAt: new Date() } });
    }

    // Read back via native driver (source of truth)
    const settings = await col.findOne({}, { sort: { updatedAt: -1 } }) as any;

    // Sync SMTP + storage + MC fields to .env
    const envUpdates: Record<string, string> = {};
    if (body.mailHost !== undefined)     envUpdates.EMAIL_HOST     = body.mailHost;
    if (body.mailPort !== undefined)     envUpdates.EMAIL_PORT     = String(body.mailPort);
    if (body.mailEncryption !== undefined) envUpdates.EMAIL_SECURE = body.mailEncryption === 'ssl' ? 'true' : 'false';
    if (body.mailUsername !== undefined) envUpdates.EMAIL_USER     = body.mailUsername;
    if (body.mailPassword !== undefined && body.mailPassword) envUpdates.EMAIL_PASS = body.mailPassword;
    if (body.mailFrom !== undefined)     envUpdates.EMAIL_FROM     = body.mailFrom;
    if (body.mailFromName !== undefined) envUpdates.EMAIL_FROM_NAME = body.mailFromName;
    if (body.storageDriver !== undefined) envUpdates.STORAGE_DRIVER = body.storageDriver;
    if (body.awsAccessKeyId !== undefined) envUpdates.AWS_S3_ACCESS_KEY_ID = body.awsAccessKeyId;
    if (body.awsSecretAccessKey !== undefined && body.awsSecretAccessKey) {
      envUpdates.AWS_S3_SECRET_ACCESS_KEY = body.awsSecretAccessKey;
    }
    if (body.awsRegion !== undefined) envUpdates.AWS_S3_REGION = body.awsRegion;
    if (body.awsBucket !== undefined) envUpdates.AWS_S3_BUCKET_NAME = body.awsBucket;
    if (body.awsCdnUrl !== undefined) envUpdates.AWS_S3_PUBLIC_BASE_URL = body.awsCdnUrl;

    if (mcSet.mcEnabled !== undefined) envUpdates.MC_ENABLED = mcSet.mcEnabled ? 'true' : 'false';
    if (mcSet.mcCustomerId !== undefined) envUpdates.MC_CUSTOMER_ID = mcSet.mcCustomerId;
    if (mcSet.mcAuthToken) envUpdates.MC_AUTH_TOKEN = mcSet.mcAuthToken;
    if (mcSet.mcEmail !== undefined) envUpdates.MC_EMAIL = mcSet.mcEmail;
    if (mcSet.mcPassword) envUpdates.MC_PASSWORD = mcSet.mcPassword;
    if (mcSet.mcBaseUrl !== undefined) envUpdates.MC_BASE_URL = mcSet.mcBaseUrl;
    if (mcSet.mcCountryCode !== undefined) envUpdates.MC_COUNTRY_CODE = mcSet.mcCountryCode;
    if (mcSet.mcOtpLength !== undefined) envUpdates.MC_OTP_LENGTH = String(mcSet.mcOtpLength);
    if (mcSet.mcFlowType !== undefined) envUpdates.MC_FLOW_TYPE = mcSet.mcFlowType;

    if (Object.keys(envUpdates).length > 0) {
      updateEnvFile(envUpdates);
    }

    const safe = { ...(settings || {}) } as any;
    const mcAuthTokenSet = !!safe.mcAuthToken;
    const mcPasswordSet = !!safe.mcPassword;
    delete safe.mcAuthToken;
    delete safe.mcPassword;

    // If client sent MC secrets but they didn't land, fail loudly
    if ((mcSet.mcAuthToken || mcSet.mcCustomerId || mcSet.mcEnabled) && !safe.mcCustomerId && mcSet.mcCustomerId) {
      return reply.status(500).send({
        success: false,
        error: 'SMS settings failed to persist — check server MongoDB connection',
      });
    }

    return reply.send({
      success: true,
      data: {
        ...safe,
        mcAuthTokenSet,
        mcPasswordSet,
      },
    });
  } catch (error: any) {
    console.error(error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** Dedicated SMS/OTP save — only Message Central fields, native Mongo write */
export const updateSmsSettings = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = (request.body || {}) as Record<string, any>;
    const db = SettingsModel.db.db;
    if (!db) {
      return reply.status(500).send({ success: false, error: 'Database not connected' });
    }
    const col = db.collection('settings');

    const $set: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (body.mcEnabled !== undefined) {
      $set.mcEnabled = body.mcEnabled === true || body.mcEnabled === 'true' || body.mcEnabled === 1;
    }
    if (body.mcCustomerId !== undefined) {
      $set.mcCustomerId = String(body.mcCustomerId || '').trim();
    }
    if (body.mcAuthToken !== undefined && String(body.mcAuthToken).trim()) {
      $set.mcAuthToken = String(body.mcAuthToken).replace(/\s+/g, '').trim();
    }
    if (body.mcPassword !== undefined && String(body.mcPassword).trim()) {
      $set.mcPassword = String(body.mcPassword).trim();
    }
    if (body.mcEmail !== undefined) $set.mcEmail = String(body.mcEmail || '').trim();
    if (body.mcBaseUrl !== undefined) {
      $set.mcBaseUrl =
        String(body.mcBaseUrl || '').trim().replace(/\/$/, '') ||
        'https://cpaas.messagecentral.com';
    }
    if (body.mcCountryCode !== undefined) {
      $set.mcCountryCode = String(body.mcCountryCode || '91').replace(/^\+/, '') || '91';
    }
    if (body.mcOtpLength !== undefined) {
      $set.mcOtpLength = Math.min(8, Math.max(4, Number(body.mcOtpLength) || 4));
    }
    if (body.mcFlowType !== undefined) {
      $set.mcFlowType = String(body.mcFlowType || 'SMS').toUpperCase();
    }

    console.log('[updateSmsSettings] writing keys:', Object.keys($set), {
      hasToken: !!$set.mcAuthToken,
      tokenLen: $set.mcAuthToken ? String($set.mcAuthToken).length : 0,
      customerId: $set.mcCustomerId,
      enabled: $set.mcEnabled,
    });

    const count = await col.countDocuments();
    let writeResult;
    if (count === 0) {
      writeResult = await col.insertOne({ ...$set, createdAt: new Date() });
      console.log('[updateSmsSettings] inserted', writeResult.insertedId);
    } else {
      writeResult = await col.updateMany({}, { $set });
      console.log('[updateSmsSettings] updateMany', {
        matched: writeResult.matchedCount,
        modified: writeResult.modifiedCount,
      });
    }

    const doc = await col.find({}).sort({ updatedAt: -1 }).limit(1).next();
    if (!doc) {
      return reply.status(500).send({ success: false, error: 'Settings document missing after write' });
    }

    // Sync env so OTP works even if Settings read fails later
    const envUpdates: Record<string, string> = {};
    if ($set.mcEnabled !== undefined) envUpdates.MC_ENABLED = $set.mcEnabled ? 'true' : 'false';
    if ($set.mcCustomerId !== undefined) envUpdates.MC_CUSTOMER_ID = $set.mcCustomerId;
    if ($set.mcAuthToken) envUpdates.MC_AUTH_TOKEN = $set.mcAuthToken;
    if ($set.mcEmail !== undefined) envUpdates.MC_EMAIL = $set.mcEmail;
    if ($set.mcPassword) envUpdates.MC_PASSWORD = $set.mcPassword;
    if ($set.mcBaseUrl) envUpdates.MC_BASE_URL = $set.mcBaseUrl;
    if ($set.mcCountryCode) envUpdates.MC_COUNTRY_CODE = $set.mcCountryCode;
    if ($set.mcOtpLength !== undefined) envUpdates.MC_OTP_LENGTH = String($set.mcOtpLength);
    if ($set.mcFlowType) envUpdates.MC_FLOW_TYPE = $set.mcFlowType;
    if (Object.keys(envUpdates).length) updateEnvFile(envUpdates);

    const mcAuthTokenSet = !!doc.mcAuthToken;
    const mcPasswordSet = !!doc.mcPassword;

    if ($set.mcAuthToken && !mcAuthTokenSet) {
      return reply.status(500).send({
        success: false,
        error: 'Auth token write verification failed',
        debug: { wroteKeys: Object.keys($set), docKeys: Object.keys(doc) },
      });
    }

    return reply.send({
      success: true,
      data: {
        mcEnabled: !!doc.mcEnabled,
        mcCustomerId: doc.mcCustomerId || '',
        mcEmail: doc.mcEmail || '',
        mcBaseUrl: doc.mcBaseUrl || 'https://cpaas.messagecentral.com',
        mcCountryCode: doc.mcCountryCode || '91',
        mcOtpLength: doc.mcOtpLength || 4,
        mcFlowType: doc.mcFlowType || 'SMS',
        mcAuthTokenSet,
        mcPasswordSet,
      },
    });
  } catch (error: any) {
    console.error('[updateSmsSettings]', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// File field name -> Settings model field name
const LOGO_FIELD_MAP: Record<string, string> = {
  logo: 'logoUrl',
  darkLogo: 'darkLogoUrl',
  lightLogo: 'lightLogoUrl',
  favicon: 'faviconUrl',
};

export const uploadSettingsLogos = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const parts = request.parts();
    const updates: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file' && LOGO_FIELD_MAP[part.fieldname]) {
        const uploadedFile = await uploadHandler.saveFileFromPart(part, request, 'IMAGE');
        updates[LOGO_FIELD_MAP[part.fieldname]] = uploadedFile.filePath;
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ success: false, error: 'No logo files provided' });
    }

    const settings = await SettingsModel.findOneAndUpdate(
      {},
      { $set: updates },
      { new: true, upsert: true }
    );
    return reply.send({
      success: true,
      data: settings
    });
  } catch (error: any) {
    console.error(error);
    return reply.status(500).send({ success: false, error: 'Upload failed' });
  }
};

export const getEmailStatus = async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    const settings = await SettingsModel.findOne().lean();
    const hasCredentials = !!(settings && (settings as any).mailUsername && (settings as any).mailPassword);
    const hasEnvCredentials = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
    return reply.send({
      success: true,
      data: {
        configured: hasCredentials || hasEnvCredentials,
        fromDb: hasCredentials,
        fromEnv: hasEnvCredentials,
        host: (settings as any)?.mailHost || process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: (settings as any)?.mailPort || process.env.EMAIL_PORT || '587',
        username: ((settings as any)?.mailUsername || process.env.EMAIL_USER || '').replace(/./g, '*'),
        from: (settings as any)?.mailFrom || process.env.EMAIL_FROM || (settings as any)?.mailUsername || process.env.EMAIL_USER || '',
      }
    });
  } catch (error: any) {
    console.error(error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const testEmail = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as { to?: string };
    const to = body?.to || 'test@example.com';
    const sent = await sendWelcomeEmail(to, 'Test User', to, 'TestPassword123!');
    if (sent) {
      return reply.send({ success: true, message: 'Test email sent successfully. Check your inbox.' });
    }
    return reply.status(400).send({
      success: false,
      error: 'Email not sent. SMTP credentials are not configured.',
      hint: 'Go to Settings → Mail and configure mailUsername, mailPassword, mailHost, and mailPort. Or set EMAIL_USER and EMAIL_PASS in your .env file.'
    });
  } catch (error: any) {
    console.error(error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};
