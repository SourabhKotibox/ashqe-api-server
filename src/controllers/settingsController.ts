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

    // Flags for UI (secrets never returned raw to browser — same idea as Tataiya strip)
    const messageCentralAuthTokenSet = !!(obj as any).messageCentralAuthToken || !!(obj as any).mcAuthToken;
    const messageCentralPasswordSet = !!(obj as any).messageCentralPassword || !!(obj as any).mcPassword;
    delete (obj as any).messageCentralAuthToken;
    delete (obj as any).messageCentralPassword;
    delete (obj as any).mcAuthToken;
    delete (obj as any).mcPassword;

    if (isAdmin) {
      return reply.send({
        success: true,
        data: {
          ...obj,
          messageCentralAuthTokenSet,
          messageCentralPasswordSet,
          // Legacy aliases for older admin builds
          mcAuthTokenSet: messageCentralAuthTokenSet,
          mcPasswordSet: messageCentralPasswordSet,
        },
      });
    }

    const sensitiveFields = [
      'mailEmail', 'mailDriver', 'mailHost', 'mailPort', 'mailEncryption', 'mailUsername', 'mailPassword', 'mailFrom', 'mailFromName',
      'awsAccessKeyId', 'awsSecretAccessKey', 'awsRegion', 'awsBucket', 'awsPathStyleEndpoint', 'bunnyStorageZone', 'bunnyAccessKey',
      'fcmServerKey', 'fcmSenderId', 'firebaseApiKey', 'firebaseProjectId', 'firebaseAppId',
      'razorpayKeySecret', 'razorpayKeyId',
      // Tataiya-style Message Gateway secrets (hidden on public GET)
      'messageCentralPassword', 'messageCentralAuthToken', 'messageCentralCustomerId', 'messageCentralEmail',
      'mcCustomerId', 'mcEmail', 'mcBaseUrl', 'mcAuthToken', 'mcPassword',
    ];
    for (const field of sensitiveFields) {
      delete (obj as any)[field];
    }
    return reply.send({
      success: true,
      data: {
        ...obj,
        messageCentralAuthTokenSet: false,
        messageCentralPasswordSet: false,
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

    // Normalize MC fields to Tataiya names (also accept legacy mc*)
    const mcSet: Record<string, any> = {};
    const enabledRaw = body.messageCentralEnabled ?? body.mcEnabled;
    if (enabledRaw !== undefined) {
      mcSet.messageCentralEnabled = enabledRaw === true || enabledRaw === 'true';
    }
    const customerId = body.messageCentralCustomerId ?? body.mcCustomerId;
    if (typeof customerId === 'string') {
      mcSet.messageCentralCustomerId = customerId.trim();
    }
    const authToken = body.messageCentralAuthToken ?? body.mcAuthToken;
    if (typeof authToken === 'string') {
      const t = authToken.replace(/\s+/g, '').trim();
      if (t) mcSet.messageCentralAuthToken = t;
    }
    const password = body.messageCentralPassword ?? body.mcPassword;
    if (typeof password === 'string') {
      const p = password.trim();
      if (p) mcSet.messageCentralPassword = p;
    }
    const email = body.messageCentralEmail ?? body.mcEmail;
    if (typeof email === 'string') mcSet.messageCentralEmail = email.trim();
    const baseUrl = body.messageCentralBaseUrl ?? body.mcBaseUrl;
    if (typeof baseUrl === 'string') {
      mcSet.messageCentralBaseUrl =
        baseUrl.trim().replace(/\/$/, '') || 'https://cpaas.messagecentral.com';
    }
    const country = body.messageCentralCountryCode ?? body.mcCountryCode;
    if (typeof country === 'string') {
      mcSet.messageCentralCountryCode = country.trim().replace(/^\+/, '') || '91';
    }
    const otpLen = body.messageCentralOtpLength ?? body.mcOtpLength;
    if (otpLen !== undefined) {
      mcSet.messageCentralOtpLength = Math.min(8, Math.max(4, Number(otpLen) || 4));
    }
    const flow = body.messageCentralFlowType ?? body.mcFlowType;
    if (typeof flow === 'string') {
      mcSet.messageCentralFlowType = flow.trim().toUpperCase() || 'SMS';
    }

    const $set: Record<string, any> = { ...body, ...mcSet };
    delete $set.messageCentralAuthTokenSet;
    delete $set.messageCentralPasswordSet;
    delete $set.mcAuthTokenSet;
    delete $set.mcPasswordSet;
    delete $set._id;
    delete $set.__v;
    // Don't blank secrets / don't write legacy mc* keys from body
    for (const k of [
      'messageCentralAuthToken', 'messageCentralPassword',
      'mcAuthToken', 'mcPassword', 'mcEnabled', 'mcCustomerId', 'mcEmail',
      'mcBaseUrl', 'mcCountryCode', 'mcOtpLength', 'mcFlowType',
    ]) {
      if ($set[k] === '') delete $set[k];
    }
    // Prefer only Tataiya keys in $set from mcSet merge
    delete $set.mcAuthToken;
    delete $set.mcPassword;
    delete $set.mcEnabled;
    delete $set.mcCustomerId;
    delete $set.mcEmail;
    delete $set.mcBaseUrl;
    delete $set.mcCountryCode;
    delete $set.mcOtpLength;
    delete $set.mcFlowType;

    const col = SettingsModel.collection;
    const existingCount = await col.countDocuments();
    if (existingCount === 0) {
      await col.insertOne({ ...$set, createdAt: new Date(), updatedAt: new Date() });
    } else {
      await col.updateMany({}, { $set: { ...$set, updatedAt: new Date() } });
    }

    const settings = await col.findOne({}, { sort: { updatedAt: -1 } }) as any;

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

    if (Object.keys(envUpdates).length > 0) {
      updateEnvFile(envUpdates);
    }

    const safe = { ...(settings || {}) } as any;
    const messageCentralAuthTokenSet = !!safe.messageCentralAuthToken;
    const messageCentralPasswordSet = !!safe.messageCentralPassword;
    delete safe.messageCentralAuthToken;
    delete safe.messageCentralPassword;
    delete safe.mcAuthToken;
    delete safe.mcPassword;

    return reply.send({
      success: true,
      data: {
        ...safe,
        messageCentralAuthTokenSet,
        messageCentralPasswordSet,
        mcAuthTokenSet: messageCentralAuthTokenSet,
        mcPasswordSet: messageCentralPasswordSet,
      },
    });
  } catch (error: any) {
    console.error(error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

/** Dedicated SMS/OTP save — Tataiya Message Gateway field names */
export const updateSmsSettings = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = (request.body || {}) as Record<string, any>;
    const db = SettingsModel.db.db;
    if (!db) {
      return reply.status(500).send({ success: false, error: 'Database not connected' });
    }
    const col = db.collection('settings');

    const enabledRaw = body.messageCentralEnabled ?? body.mcEnabled;
    const customerId = String(body.messageCentralCustomerId ?? body.mcCustomerId ?? '').trim();
    const authToken = String(body.messageCentralAuthToken ?? body.mcAuthToken ?? '').replace(/\s+/g, '').trim();
    const password = String(body.messageCentralPassword ?? body.mcPassword ?? '').trim();
    const email = String(body.messageCentralEmail ?? body.mcEmail ?? '').trim();
    const baseUrl = String(
      body.messageCentralBaseUrl ?? body.mcBaseUrl ?? 'https://cpaas.messagecentral.com'
    ).trim().replace(/\/$/, '') || 'https://cpaas.messagecentral.com';
    const countryCode = String(
      body.messageCentralCountryCode ?? body.mcCountryCode ?? '91'
    ).replace(/^\+/, '') || '91';
    const otpLength = Math.min(
      8,
      Math.max(4, Number(body.messageCentralOtpLength ?? body.mcOtpLength) || 4)
    );
    const flowType = String(
      body.messageCentralFlowType ?? body.mcFlowType ?? 'SMS'
    ).toUpperCase() || 'SMS';

    const $set: Record<string, any> = {
      updatedAt: new Date(),
      messageCentralEnabled:
        enabledRaw === undefined ? true : enabledRaw === true || enabledRaw === 'true' || enabledRaw === 1,
      messageCentralCustomerId: customerId,
      messageCentralBaseUrl: baseUrl,
      messageCentralCountryCode: countryCode,
      messageCentralOtpLength: otpLength,
      messageCentralFlowType: flowType,
      messageCentralEmail: email,
    };
    if (authToken) $set.messageCentralAuthToken = authToken;
    if (password) $set.messageCentralPassword = password;

    // Drop legacy mc* keys so only Tataiya names are source of truth
    const $unset: Record<string, 1> = {
      mcEnabled: 1,
      mcCustomerId: 1,
      mcAuthToken: 1,
      mcPassword: 1,
      mcEmail: 1,
      mcBaseUrl: 1,
      mcCountryCode: 1,
      mcOtpLength: 1,
      mcFlowType: 1,
    };

    console.log('[updateSmsSettings] writing messageCentral* keys', {
      hasToken: !!$set.messageCentralAuthToken,
      tokenLen: $set.messageCentralAuthToken ? String($set.messageCentralAuthToken).length : 0,
      customerId: $set.messageCentralCustomerId,
      enabled: $set.messageCentralEnabled,
    });

    const count = await col.countDocuments();
    if (count === 0) {
      await col.insertOne({ ...$set, createdAt: new Date() });
    } else {
      await col.updateMany({}, { $set, $unset });
    }

    const doc = await col.find({}).sort({ updatedAt: -1 }).limit(1).next();
    if (!doc) {
      return reply.status(500).send({ success: false, error: 'Settings document missing after write' });
    }

    const messageCentralAuthTokenSet = !!doc.messageCentralAuthToken;
    const messageCentralPasswordSet = !!doc.messageCentralPassword;

    if (authToken && !messageCentralAuthTokenSet) {
      return reply.status(500).send({
        success: false,
        error: 'Auth token write verification failed',
      });
    }

    return reply.send({
      success: true,
      data: {
        messageCentralEnabled: !!doc.messageCentralEnabled,
        messageCentralCustomerId: doc.messageCentralCustomerId || '',
        messageCentralEmail: doc.messageCentralEmail || '',
        messageCentralBaseUrl: doc.messageCentralBaseUrl || 'https://cpaas.messagecentral.com',
        messageCentralCountryCode: doc.messageCentralCountryCode || '91',
        messageCentralOtpLength: doc.messageCentralOtpLength || 4,
        messageCentralFlowType: doc.messageCentralFlowType || 'SMS',
        messageCentralAuthTokenSet,
        messageCentralPasswordSet,
        // Legacy aliases
        mcEnabled: !!doc.messageCentralEnabled,
        mcCustomerId: doc.messageCentralCustomerId || '',
        mcBaseUrl: doc.messageCentralBaseUrl || 'https://cpaas.messagecentral.com',
        mcCountryCode: doc.messageCentralCountryCode || '91',
        mcOtpLength: doc.messageCentralOtpLength || 4,
        mcFlowType: doc.messageCentralFlowType || 'SMS',
        mcAuthTokenSet: messageCentralAuthTokenSet,
        mcPasswordSet: messageCentralPasswordSet,
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
