import mongoose from 'mongoose';
import { logger } from './logger';

let isMongoConnected = false;

const DEFAULT_DB_NAME = 'tataiya';

/**
 * Atlas URI without a path (e.g. ...mongodb.net/?appName=...) defaults to DB "test".
 * Ensure we always target the Tataiya application database.
 */
export function ensureMongoDbName(uri: string, dbName = DEFAULT_DB_NAME): string {
  try {
    const parsed = new URL(uri);
    const path = parsed.pathname.replace(/^\//, '');
    if (!path || path === 'test') {
      parsed.pathname = `/${dbName}`;
      logger.warn(
        { from: path || '(empty)', to: dbName },
        'MONGODB_URI had no/app default DB name — forcing application database'
      );
      return parsed.toString();
    }
    return uri;
  } catch {
    // Fallback for unusual URI shapes
    if (/\.mongodb\.net\/(\?|$)/.test(uri)) {
      return uri.replace(/\.mongodb\.net\/(\?|$)/, `.mongodb.net/${dbName}$1`);
    }
    return uri;
  }
}

export async function connectMongoDB(): Promise<boolean> {
  const rawUri = process.env.MONGODB_URI;
  if (!rawUri) {
    logger.warn('MONGODB_URI not set — using in-memory mock data');
    return false;
  }

  const uri = ensureMongoDbName(rawUri);

  if (uri.includes('localhost') || uri.includes('127.0.0.1')) {
    logger.info('MONGODB_URI points to localhost, attempting connection...');
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
    isMongoConnected = true;
    logger.info({ dbName: mongoose.connection.name }, 'MongoDB Atlas connected');

    if (mongoose.connection.name === 'test') {
      logger.error(
        'Connected to MongoDB database "test" — set MONGODB_URI path to /tataiya and restart'
      );
    }

    mongoose.connection.on('error', (err: unknown) => {
      logger.error({ err }, 'MongoDB connection error');
    });
    mongoose.connection.on('connected', () => {
      isMongoConnected = true;
      logger.info('MongoDB connection established');
    });
    mongoose.connection.on('reconnected', () => {
      isMongoConnected = true;
      logger.info('MongoDB connection re-established');
    });
    mongoose.connection.on('disconnected', () => {
      isMongoConnected = false;
      logger.warn('MongoDB disconnected — queries will buffer or fail');
    });
    return true;
  } catch (err) {
    logger.warn({ err }, 'MongoDB connection failed');
    return false;
  }
}

export function getIsMongoConnected(): boolean {
  return isMongoConnected;
}
