import { createSecretKey, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { config } from '../config/index.js';
import { AppError } from './error.js';
import { lookupActiveUserWithRoles } from '../read/projections/users.js';
import type { AuthContext } from './context.js';

let remoteJwks: JWTVerifyGetKey | null = null;
function getRemoteJwks(): JWTVerifyGetKey {
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(new URL(config.auth.jwksUri));
  }
  return remoteJwks;
}

let localSecretKey: KeyObject | null = null;
function getLocalSecretKey(): KeyObject {
  if (!localSecretKey) {
    localSecretKey = createSecretKey(Buffer.from(config.auth.localSecret, 'utf-8'));
  }
  return localSecretKey;
}

function extractBearerToken(req: IncomingMessage): string {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header) || !header.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');
  }
  return token;
}

async function verifyTokenSubject(token: string): Promise<string> {
  let sub: string | undefined;
  try {
    if (config.auth.mode === 'oidc') {
      const { payload } = await jwtVerify(token, getRemoteJwks(), {
        issuer: config.auth.issuer,
        audience: config.auth.audience,
      });
      sub = payload.sub;
    } else {
      const { payload } = await jwtVerify(token, getLocalSecretKey());
      sub = payload.sub;
    }
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }

  if (!sub) {
    throw new AppError(401, 'UNAUTHORIZED', 'Token is missing a subject claim');
  }
  return sub;
}

/**
 * Verifies the request's bearer token and resolves the caller's identity + current role
 * assignments fresh from the directory (no caching - see Dev Notes on deprovisioning).
 * Throws AppError(401, 'UNAUTHORIZED') for any failure: missing/malformed/invalid/expired
 * token, or a token whose subject has no active directory record.
 */
export async function authenticateRequest(req: IncomingMessage): Promise<AuthContext> {
  const token = extractBearerToken(req);
  const externalId = await verifyTokenSubject(token);

  const user = await lookupActiveUserWithRoles(externalId);
  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'No active account for this identity');
  }

  return { userId: user.userId, externalId: user.externalId, roles: user.roles };
}

/**
 * Issues a short-lived HS256 test token for a given subject. Only usable when
 * AUTH_MODE=local (enforced at startup in src/config/index.ts and here defensively).
 * Contains no role data - roles are always resolved fresh from the directory per request.
 */
export async function issueDevToken(sub: string): Promise<string> {
  if (config.auth.mode !== 'local') {
    throw new AppError(404, 'NOT_FOUND', 'Dev token issuance is only available in AUTH_MODE=local');
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getLocalSecretKey());
}
