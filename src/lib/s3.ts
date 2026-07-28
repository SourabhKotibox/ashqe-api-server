import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { logger } from './logger';
import { SettingsModel } from '../models/Settings';

export async function getS3Settings() {
  const settings = await SettingsModel.findOne().lean();
  const accessKeyId =
    (settings as any)?.awsAccessKeyId ||
    process.env.AWS_S3_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID ||
    '';
  const secretAccessKey =
    (settings as any)?.awsSecretAccessKey ||
    process.env.AWS_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    '';
  const region =
    (settings as any)?.awsRegion ||
    process.env.AWS_S3_REGION ||
    process.env.AWS_REGION ||
    'us-east-1';
  const bucket =
    (settings as any)?.awsBucket ||
    process.env.AWS_S3_BUCKET_NAME ||
    process.env.AWS_BUCKET_NAME ||
    'tataiya-ott';
  const pathStyle = !!(settings as any)?.awsPathStyleEndpoint;
  const storageDriver =
    (settings as any)?.storageDriver ||
    process.env.STORAGE_DRIVER ||
    's3';
  const cdnUrl =
    ((settings as any)?.awsCdnUrl || process.env.AWS_S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');

  return {
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
    pathStyle,
    storageDriver,
    cdnUrl,
  };
}

export async function getS3Client() {
  const settings = await getS3Settings();
  return new S3Client({
    region: settings.region,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    ...(settings.pathStyle ? { forcePathStyle: true } : {}),
    // Required for browser presigned PUTs — SDK v3 otherwise adds CRC32 query params
    // that XHR/fetch never send → CORS / "S3 network error"
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  } as any);
}

function buildPublicUrl(settings: Awaited<ReturnType<typeof getS3Settings>>, key: string): string {
  const cleanKey = key.replace(/^\/+/, '').replace(/^uploads\//, '');
  if (settings.cdnUrl) return `${settings.cdnUrl}/${cleanKey}`;
  if (settings.pathStyle) {
    return `https://s3.${settings.region}.amazonaws.com/${settings.bucket}/${cleanKey}`;
  }
  return `https://${settings.bucket}.s3.${settings.region}.amazonaws.com/${cleanKey}`;
}

export interface PresignedUrlResult {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

export async function generatePresignedUrl(
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<PresignedUrlResult> {
  const settings = await getS3Settings();

  if (!settings.accessKeyId || !settings.secretAccessKey || settings.storageDriver !== 's3') {
    return {
      uploadUrl: `https://mock-storage.local/upload/${key}?token=dev-placeholder`,
      publicUrl: `https://mock-storage.local/${key}`,
      key,
    };
  }

  const s3Client = await getS3Client();
  const command = new PutObjectCommand({
    Bucket: settings.bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  // Only sign content-type so browser XHR PUT matches the signature
  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn,
    signableHeaders: new Set(['content-type']),
  });

  return {
    uploadUrl,
    publicUrl: buildPublicUrl(settings, key),
    key,
  };
}

export async function uploadToS3(
  key: string,
  body: Buffer | Uint8Array | string | Readable,
  contentType: string
): Promise<string> {
  const settings = await getS3Settings();

  if (!settings.accessKeyId || !settings.secretAccessKey || settings.storageDriver !== 's3') {
    throw new Error('AWS S3 credentials not configured or storage driver is not s3');
  }

  const s3Client = await getS3Client();
  await s3Client.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: key,
      Body: body as any,
      ContentType: contentType,
    })
  );
  return buildPublicUrl(settings, key);
}

export async function downloadFromS3ToFile(s3Key: string, destPath: string): Promise<void> {
  const settings = await getS3Settings();
  const s3Client = await getS3Client();
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: s3Key.replace(/^\/+/, ''),
    })
  );
  if (!response.Body) throw new Error('No response body from S3');

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const body = response.Body as Readable;
  await new Promise<void>((resolve, reject) => {
    const write = fs.createWriteStream(destPath);
    body.pipe(write);
    write.on('finish', () => resolve());
    write.on('error', reject);
    body.on('error', reject);
  });
}

/** Download only the first N bytes — enough for ffprobe without pulling multi‑GB files */
export async function downloadS3RangeToFile(
  s3Key: string,
  destPath: string,
  maxBytes = 48 * 1024 * 1024
): Promise<void> {
  const settings = await getS3Settings();
  const s3Client = await getS3Client();
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: s3Key.replace(/^\/+/, ''),
      Range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
    })
  );
  if (!response.Body) throw new Error('No response body from S3 range get');

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const body = response.Body as Readable;
  await new Promise<void>((resolve, reject) => {
    const write = fs.createWriteStream(destPath);
    body.pipe(write);
    write.on('finish', () => resolve());
    write.on('error', reject);
    body.on('error', reject);
  });
}

export async function deleteFromS3(key: string): Promise<void> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey || settings.storageDriver !== 's3') {
    return;
  }
  const s3Client = await getS3Client();
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: settings.bucket,
      Key: key.replace(/^\/+/, '').replace(/^uploads\//, ''),
    })
  );
}

export async function isS3Configured(): Promise<boolean> {
  const settings = await getS3Settings();
  const hasCreds = !!(settings.accessKeyId && settings.secretAccessKey);
  const notPlaceholder =
    settings.accessKeyId !== 'your-access-key-id' &&
    settings.secretAccessKey !== 'your-secret-access-key';
  return hasCreds && notPlaceholder && settings.storageDriver === 's3';
}

export async function getS3PublicUrl(key: string): Promise<string> {
  const settings = await getS3Settings();
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return buildPublicUrl(settings, key);
}

export async function getHlsPublicBaseUrl(): Promise<string> {
  const settings = await getS3Settings();
  if (settings.cdnUrl) return settings.cdnUrl;
  if (settings.pathStyle) {
    return `https://s3.${settings.region}.amazonaws.com/${settings.bucket}`;
  }
  return `https://${settings.bucket}.s3.${settings.region}.amazonaws.com`;
}

export async function uploadHlsFolderToS3(localFolderPath: string, s3Prefix: string): Promise<number> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey || settings.storageDriver !== 's3') {
    throw new Error('S3 is not configured — cannot upload HLS folder');
  }

  const s3Client = await getS3Client();
  let uploadCount = 0;

  const getContentType = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
    if (ext === '.ts') return 'video/mp2t';
    return 'application/octet-stream';
  };

  const uploadDir = async (dirPath: string, keyPrefix: string) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const s3Key = `${keyPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await uploadDir(fullPath, s3Key);
        } else if (entry.isFile()) {
          const body = fs.readFileSync(fullPath);
          const ext = path.extname(entry.name).toLowerCase();
          await s3Client.send(
            new PutObjectCommand({
              Bucket: settings.bucket,
              Key: s3Key,
              Body: body,
              ContentType: getContentType(entry.name),
              CacheControl: ext === '.m3u8' ? 'no-cache' : 'max-age=31536000',
            })
          );
          uploadCount++;
        }
      })
    );
  };

  await uploadDir(localFolderPath, s3Prefix.replace(/\/$/, ''));
  logger.info({ s3Prefix, uploadCount }, 'HLS folder uploaded to S3');
  return uploadCount;
}

/** HeadObject ContentLength — used to skip multi‑GB local HLS downloads */
export async function getS3ObjectSize(key: string): Promise<number> {
  const settings = await getS3Settings();
  if (!settings.accessKeyId || !settings.secretAccessKey) return 0;
  const s3Client = await getS3Client();
  const cleanKey = key.replace(/^\/+/, '').replace(/^uploads\//, '');
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: settings.bucket, Key: cleanKey })
    );
    return Number(head.ContentLength) || 0;
  } catch (err) {
    logger.warn({ err, key: cleanKey }, 'S3 HeadObject failed');
    return 0;
  }
}
