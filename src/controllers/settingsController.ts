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

    // Admin gets full settings (including MC secrets) — same as Tataiya.
    // Public GET strips secrets below.
    if (isAdmin) {
      return reply.send({
        success: true,
        data: {
          ...obj,
          messageCentralAuthTokenSet: !!(obj as any).messageCentralAuthToken || !!(obj as any).mcAuthToken,
          messageCentralPasswordSet: !!(obj as any).messageCentralPassword || !!(obj as any).mcPassword,
          mcAuthTokenSet: !!(obj as any).messageCentralAuthToken || !!(obj as any).mcAuthToken,
          mcPasswordSet: !!(obj as any).messageCentralPassword || !!(obj as any).mcPassword,
        },
      });
    }

    // Never send raw secrets to the browser for public
    delete (obj as any).messageCentralAuthToken;
    delete (obj as any).messageCentralPassword;
    delete (obj as any).mcAuthToken;
    delete (obj as any).mcPassword;

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
    const body = { ...((request.body || {}) as Record<string, any>) };

    // Normalize legacy mc* → messageCentral*
    if (body.mcEnabled !== undefined && body.messageCentralEnabled === undefined) {
      body.messageCentralEnabled = body.mcEnabled === true || body.mcEnabled === 'true';
    }
    if (body.mcCustomerId && !body.messageCentralCustomerId) {
      body.messageCentralCustomerId = String(body.mcCustomerId).trim();
    }
    if (body.mcAuthToken && !body.messageCentralAuthToken) {
      body.messageCentralAuthToken = String(body.mcAuthToken).replace(/\s+/g, '').trim();
    }
    if (body.mcPassword && !body.messageCentralPassword) {
      body.messageCentralPassword = String(body.mcPassword).trim();
    }
    if (body.mcEmail !== undefined && body.messageCentralEmail === undefined) {
      body.messageCentralEmail = String(body.mcEmail || '').trim();
    }
    if (body.mcBaseUrl && !body.messageCentralBaseUrl) {
      body.messageCentralBaseUrl = String(body.mcBaseUrl).trim().replace(/\/$/, '');
    }
    if (body.mcCountryCode && !body.messageCentralCountryCode) {
      body.messageCentralCountryCode = String(body.mcCountryCode).replace(/^\+/, '');
    }
    if (body.mcOtpLength !== undefined && body.messageCentralOtpLength === undefined) {
      body.messageCentralOtpLength = Math.min(8, Math.max(4, Number(body.mcOtpLength) || 4));
    }
    if (body.mcFlowType && !body.messageCentralFlowType) {
      body.messageCentralFlowType = String(body.mcFlowType).toUpperCase();
    }

    if (typeof body.messageCentralAuthToken === 'string') {
      body.messageCentralAuthToken = body.messageCentralAuthToken.replace(/\s+/g, '').trim();
    }
    // Don't blank existing secrets
    if (!body.messageCentralAuthToken) delete body.messageCentralAuthToken;
    if (!body.messageCentralPassword) delete body.messageCentralPassword;

    delete body.messageCentralAuthTokenSet;
    delete body.messageCentralPasswordSet;
    delete body.mcAuthTokenSet;
    delete body.mcPasswordSet;
    delete body._id;
    delete body.__v;
    for (const k of [
      'mcEnabled', 'mcCustomerId', 'mcAuthToken', 'mcPassword', 'mcEmail',
      'mcBaseUrl', 'mcCountryCode', 'mcOtpLength', 'mcFlowType',
    ]) {
      delete body[k];
    }

    // Tataiya-style upsert — strict:false so Message Gateway fields always persist
    const settings = await SettingsModel.findOneAndUpdate(
      {},
      { $set: body },
      { new: true, upsert: true, setDefaultsOnInsert: true, strict: false }
    );

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
    if (Object.keys(envUpdates).length > 0) updateEnvFile(envUpdates);

    const obj = settings?.toObject ? settings.toObject() : { ...(settings as any) };
    return reply.send({
      success: true,
      data: {
        ...obj,
        messageCentralAuthTokenSet: !!obj.messageCentralAuthToken,
        messageCentralPasswordSet: !!obj.messageCentralPassword,
        mcAuthTokenSet: !!obj.messageCentralAuthToken,
        mcPasswordSet: !!obj.messageCentralPassword,
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

    const enabledRaw = body.messageCentralEnabled ?? body.mcEnabled;
    const customerId = String(body.messageCentralCustomerId ?? body.mcCustomerId ?? '').trim();
    const authToken = String(body.messageCentralAuthToken ?? body.mcAuthToken ?? '')
      .replace(/\s+/g, '')
      .trim();
    const password = String(body.messageCentralPassword ?? body.mcPassword ?? '').trim();
    const email = String(body.messageCentralEmail ?? body.mcEmail ?? '').trim();
    const baseUrl =
      String(body.messageCentralBaseUrl ?? body.mcBaseUrl ?? 'https://cpaas.messagecentral.com')
        .trim()
        .replace(/\/$/, '') || 'https://cpaas.messagecentral.com';
    const countryCode =
      String(body.messageCentralCountryCode ?? body.mcCountryCode ?? '91').replace(/^\+/, '') || '91';
    const otpLength = Math.min(
      8,
      Math.max(4, Number(body.messageCentralOtpLength ?? body.mcOtpLength) || 4)
    );
    const flowType =
      String(body.messageCentralFlowType ?? body.mcFlowType ?? 'SMS').toUpperCase() || 'SMS';

    if (!customerId) {
      return reply.status(400).send({ success: false, error: 'Customer ID is required' });
    }

    const $set: Record<string, any> = {
      updatedAt: new Date(),
      messageCentralEnabled:
        enabledRaw === undefined
          ? true
          : enabledRaw === true || enabledRaw === 'true' || enabledRaw === 1,
      messageCentralCustomerId: customerId,
      messageCentralBaseUrl: baseUrl,
      messageCentralCountryCode: countryCode,
      messageCentralOtpLength: otpLength,
      messageCentralFlowType: flowType,
      messageCentralEmail: email,
    };
    if (authToken) {
      $set.messageCentralAuthToken = authToken;
    }
    if (password) {
      $set.messageCentralPassword = password;
    }

    // Prefer mongoose upsert with strict:false so new fields always land
    // even if an older process had a stale schema cache.
    const doc = await SettingsModel.findOneAndUpdate(
      {},
      {
        $set,
        $unset: {
          mcEnabled: 1,
          mcCustomerId: 1,
          mcAuthToken: 1,
          mcPassword: 1,
          mcEmail: 1,
          mcBaseUrl: 1,
          mcCountryCode: 1,
          mcOtpLength: 1,
          mcFlowType: 1,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        strict: false,
        lean: true,
      }
    );

    // Native verify (source of truth)
    const raw = await SettingsModel.collection
      .find({})
      .sort({ updatedAt: -1 })
      .limit(1)
      .next();

    const tokenOnDisk = String(
      raw?.messageCentralAuthToken || (doc as any)?.messageCentralAuthToken || ''
    ).trim();
    const messageCentralAuthTokenSet = tokenOnDisk.length > 0;
    const messageCentralPasswordSet = !!(
      raw?.messageCentralPassword || (doc as any)?.messageCentralPassword
    );

    console.log('[updateSmsSettings]', {
      bodyKeys: Object.keys(body),
      receivedTokenLen: authToken.length,
      savedTokenLen: tokenOnDisk.length,
      customerId,
      enabled: $set.messageCentralEnabled,
    });

    if (authToken && !messageCentralAuthTokenSet) {
      // Last-resort native write
      await SettingsModel.collection.updateMany(
        {},
        { $set: { messageCentralAuthToken: authToken, updatedAt: new Date() } }
      );
      const retry = await SettingsModel.collection
        .find({})
        .sort({ updatedAt: -1 })
        .limit(1)
        .next();
      const retryToken = String(retry?.messageCentralAuthToken || '').trim();
      if (!retryToken) {
        return reply.status(500).send({
          success: false,
          error: 'Auth token write verification failed',
          debug: {
            receivedTokenLen: authToken.length,
            bodyHadToken: !!(body.messageCentralAuthToken || body.mcAuthToken),
            bodyKeys: Object.keys(body),
          },
        });
      }
    }

    const finalDoc =
      (await SettingsModel.collection.find({}).sort({ updatedAt: -1 }).limit(1).next()) || raw;

    return reply.send({
      success: true,
      data: {
        messageCentralEnabled: !!finalDoc?.messageCentralEnabled,
        messageCentralCustomerId: finalDoc?.messageCentralCustomerId || customerId,
        messageCentralEmail: finalDoc?.messageCentralEmail || '',
        messageCentralBaseUrl:
          finalDoc?.messageCentralBaseUrl || 'https://cpaas.messagecentral.com',
        messageCentralCountryCode: finalDoc?.messageCentralCountryCode || '91',
        messageCentralOtpLength: finalDoc?.messageCentralOtpLength || 4,
        messageCentralFlowType: finalDoc?.messageCentralFlowType || 'SMS',
        messageCentralAuthTokenSet: !!String(finalDoc?.messageCentralAuthToken || '').trim(),
        messageCentralPasswordSet: !!finalDoc?.messageCentralPassword,
        // Legacy aliases for older admin builds
        mcEnabled: !!finalDoc?.messageCentralEnabled,
        mcCustomerId: finalDoc?.messageCentralCustomerId || customerId,
        mcBaseUrl: finalDoc?.messageCentralBaseUrl || 'https://cpaas.messagecentral.com',
        mcCountryCode: finalDoc?.messageCentralCountryCode || '91',
        mcOtpLength: finalDoc?.messageCentralOtpLength || 4,
        mcFlowType: finalDoc?.messageCentralFlowType || 'SMS',
        mcAuthTokenSet: !!String(finalDoc?.messageCentralAuthToken || '').trim(),
        mcPasswordSet: !!finalDoc?.messageCentralPassword,
        debug: {
          receivedTokenLen: authToken.length,
          savedTokenLen: String(finalDoc?.messageCentralAuthToken || '').length,
        },
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
