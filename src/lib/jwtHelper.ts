import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';

export interface OptionalUser {
  userId: string;
  name?: string;
  role?: string;
  deviceId?: string;
}

/**
 * Safely extracts user identity from Bearer authorization header.
 *
 * 1. Verifies token with standard server.jwt.verify (checks secret & expiry).
 * 2. If token is expired, verifies cryptographic signature with { ignoreExpiration: true }.
 *    Because MongoDB is the true source of truth for whether a user's subscription is
 *    currently active (via endDate >= now), an expired token with a valid signature still
 *    legitimately identifies WHICH user is making the request.
 *    This prevents paying subscribers from suddenly being treated as free guests after 7 days.
 */
export function extractOptionalUser(request: FastifyRequest): OptionalUser | null {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    if (!token) return null;

    const server = request.server as any;

    // 1. Try standard verify
    try {
      if (server?.jwt?.verify) {
        const decoded = server.jwt.verify(token) as any;
        if (decoded?.id || decoded?._id) {
          return {
            userId: String(decoded.id || decoded._id),
            name: decoded.name,
            role: decoded.role,
            deviceId: decoded.deviceId,
          };
        }
      }
    } catch (verifyErr: any) {
      const isExpired =
        verifyErr?.name === 'TokenExpiredError' ||
        verifyErr?.name === 'FastifyJWTError' ||
        String(verifyErr?.message || '').toLowerCase().includes('expired');

      if (!isExpired) {
        return null;
      }
    }

    // 2. Verify signature with ignoreExpiration (ensures token was genuinely issued by our server)
    try {
      const secret = process.env.JWT_SECRET || 'fallback-secret-for-development-only';
      const decoded = jwt.verify(token, secret, { ignoreExpiration: true }) as any;
      if (decoded?.id || decoded?._id) {
        return {
          userId: String(decoded.id || decoded._id),
          name: decoded.name,
          role: decoded.role,
          deviceId: decoded.deviceId,
        };
      }
    } catch {
      return null;
    }

    return null;
  } catch {
    return null;
  }
}
