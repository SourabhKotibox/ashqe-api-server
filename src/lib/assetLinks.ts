import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FastifyReply, FastifyRequest } from 'fastify';

const PACKAGE_NAME = 'com.ashqe.tophills';

/**
 * Last-resort copy of public/.well-known/assetlinks.json.
 * Production should set ANDROID_SHA256_FINGERPRINTS to the Play Console
 * App signing key certificate SHA-256 (not the upload key).
 */
const EMBEDDED_ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: PACKAGE_NAME,
      sha256_cert_fingerprints: [
        'E0:F3:91:95:B2:60:A4:87:B1:F3:83:65:4C:F7:02:B3:CC:BB:72:70:55:21:BF:84:E6:53:D9:8F:50:35:B8:90',
      ],
    },
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveAssetLinksFile(): string | null {
  const candidates = [
    path.join(process.cwd(), 'public', '.well-known', 'assetlinks.json'),
    path.resolve(here, '../../public/.well-known/assetlinks.json'),
    path.resolve(here, '../public/.well-known/assetlinks.json'),
    path.resolve(here, '../../../public/.well-known/assetlinks.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function fingerprintsFromEnv(): string[] | null {
  const raw = process.env.ANDROID_SHA256_FINGERPRINTS;
  if (raw == null || raw.trim() === '') return null;
  const list = raw.split(',').map((part) => part.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

function readAssetLinksFile(): unknown[] {
  const filePath = resolveAssetLinksFile();
  if (!filePath) return structuredClone(EMBEDDED_ASSET_LINKS);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Fall through to the embedded document.
  }
  return structuredClone(EMBEDDED_ASSET_LINKS);
}

function withFingerprints(document: unknown[], fingerprints: string[]): unknown[] {
  return document.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const target = (entry as { target?: { namespace?: string } }).target;
    if (!target || target.namespace !== 'android_app') return entry;
    return {
      ...(entry as Record<string, unknown>),
      target: {
        ...target,
        sha256_cert_fingerprints: fingerprints,
      },
    };
  });
}

/** Digital Asset Links document. Env fingerprints override the file; the file wins when unset. */
export function loadAssetLinks(): unknown[] {
  const document = readAssetLinksFile();
  const override = fingerprintsFromEnv();
  if (!override) return document;
  return withFingerprints(document, override);
}

export const sendAssetLinks = async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.header('Content-Type', 'application/json').send(JSON.stringify(loadAssetLinks()));
};
