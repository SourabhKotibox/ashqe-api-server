import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import router from './routes';
import { requestContext } from './lib/context';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local cache/temp dir — required even when STORAGE_DRIVER=s3 (HLS temp, static plugin)
const uploadsRoot = path.join(__dirname, '../uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'media'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'temp'), { recursive: true });

const fastify = Fastify({
  logger: true,
  bodyLimit: 2000 * 1024 * 1024 // 2GB
});

// Register request context lifecycle hook
fastify.addHook('onRequest', (request, reply, done) => {
  const authHeader = request.headers.authorization;
  let user: any = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = (request.server as any).jwt?.decode(token);
      if (decoded) {
        user = {
          id: decoded.id || decoded._id,
          email: decoded.email,
          role: decoded.role,
          name: decoded.name
        };
      }
    } catch (e) {
      // Ignore token decode errors
    }
  }

  requestContext.run({ user }, () => {
    done();
  });
});

// ── JSON body parser (MUST be registered BEFORE multipart) ───────────────────
// @fastify/multipart intercepts ALL POST/PUT body streams globally.
// Without this explicit parser, JSON bodies on non-upload routes are left
// undefined, causing "Cannot destructure property of request.body" errors.
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  }
);

// Enable compression for faster responses
fastify.register(fastifyCompress, {
  global: false,
  encodings: ['gzip', 'deflate', 'br']
});

// Enable CORS
fastify.register(fastifyCors, {
  origin: true,
  credentials: true,
});

// Register JWT plugin
fastify.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'fallback-secret-for-development-only'
});

// Register Multipart for file uploads with optimized config
fastify.register(fastifyMultipart as any, {
  limits: {
    fileSize: 2000 * 1024 * 1024, // 2GB
    files: 10 // Max files per request
  }
});

// Register Static file serving
fastify.register(fastifyStatic, {
  root: uploadsRoot,
  prefix: '/uploads/',
  setHeaders: (res, filePath) => {
    const lower = String(filePath).toLowerCase();
    if (lower.endsWith('.vtt')) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (lower.endsWith('.srt')) {
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (lower.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (lower.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  },
});

// Register all routes under /api (local + correct nginx proxy_pass without URI strip).
fastify.register(router, { prefix: '/api' });

// Also register at root so logins work when nginx strips the /api prefix, e.g.
//   location /api/ { proxy_pass http://127.0.0.1:3000/; }  // strips /api
// Browser calls /api/auth/login → backend sees /auth/login
fastify.register(router);

export default fastify;
