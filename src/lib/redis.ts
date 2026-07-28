import Redis from 'ioredis';
import { logger } from './logger';

let redis: Redis | null = null;
let isRedisConnected = false;

// In-memory fallback for refresh tokens when Redis is unavailable
export const inMemoryRefreshTokens = new Set<string>();

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

export async function connectRedis(): Promise<boolean> {
  const url = process.env.REDIS_URL || process.env.REDIS_URI;
  if (!url || url.includes('localhost') || url.includes('127.0.0.1')) {
    logger.warn('REDIS_URL not set or pointing to localhost — using in-memory token store');
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null, // don't keep retrying forever
    });

    client
      .connect()
      .then(() => {
        redis = client;
        isRedisConnected = true;
        logger.info('Redis connected');

        client.on('error', (err: unknown) => {
          logger.error({ err }, 'Redis error');
          isRedisConnected = false;
        });
        client.on('close', () => {
          isRedisConnected = false;
        });

        resolve(true);
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'Redis connection failed — using in-memory token store');
        try {
          client.disconnect();
        } catch {
          /* ignore */
        }
        resolve(false);
      });
  });
}

export function getRedis(): Redis | null {
  return redis;
}

export function isRedisAvailable(): boolean {
  return isRedisConnected && !!redis;
}

export async function storeRefreshToken(token: string, userId: string): Promise<void> {
  // Never block login on Redis — fall back to memory within 1.5s
  if (redis && isRedisConnected) {
    try {
      const ttl = 7 * 24 * 60 * 60; // 7 days
      await withTimeout(redis.setex(`rt:${token}`, ttl, userId), 1500, 'redis.setex');
      return;
    } catch (err) {
      logger.warn({ err }, 'Redis storeRefreshToken failed — using memory');
      isRedisConnected = false;
    }
  }
  inMemoryRefreshTokens.add(token);
}

export async function validateRefreshToken(token: string): Promise<boolean> {
  if (redis && isRedisConnected) {
    try {
      const val = await withTimeout(redis.get(`rt:${token}`), 1500, 'redis.get');
      return val !== null;
    } catch (err) {
      logger.warn({ err }, 'Redis validateRefreshToken failed — checking memory');
      isRedisConnected = false;
    }
  }
  return inMemoryRefreshTokens.has(token);
}

export async function revokeRefreshToken(token: string): Promise<void> {
  if (redis && isRedisConnected) {
    try {
      await withTimeout(redis.del(`rt:${token}`), 1500, 'redis.del');
    } catch (err) {
      logger.warn({ err }, 'Redis revokeRefreshToken failed');
      isRedisConnected = false;
    }
  }
  inMemoryRefreshTokens.delete(token);
}
