import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendError } from '../../middleware/error.js';
import { getParsedBody } from '../../middleware/context.js';
import { config } from '../../config/index.js';
import { provisionUser, updateUserRoles, deprovisionUser, reactivateUser } from '../../adapters/iam/scim.js';
import type { RoleAssignment } from '../../read/projections/users.js';

/** Constant-time string compare. Returns false on length mismatch (length is not secret). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function requireScimAuth(req: IncomingMessage): void {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid SCIM bearer token');
  }
  // Scheme is case-insensitive (RFC 7235); the token is compared in constant time.
  const match = /^bearer[ \t]+(\S.*)$/i.exec(header.trim());
  if (!match || !safeEqual(match[1]!.trim(), config.scim.bearerToken)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid SCIM bearer token');
  }
}

function parseRoles(value: unknown): RoleAssignment[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'roles must be an array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError(400, 'INVALID_SCIM_REQUEST', `roles[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const role = obj['role'];
    const module = obj['module'];
    const functionScope = obj['functionScope'];
    const locationId = obj['locationId'];

    if (typeof role !== 'string' || !role) {
      throw new AppError(400, 'INVALID_SCIM_REQUEST', `roles[${index}].role must be a non-empty string`);
    }
    if (typeof module !== 'string' || !module) {
      throw new AppError(400, 'INVALID_SCIM_REQUEST', `roles[${index}].module must be a non-empty string`);
    }
    if (functionScope !== 'read' && functionScope !== 'write') {
      throw new AppError(400, 'INVALID_SCIM_REQUEST', `roles[${index}].functionScope must be "read" or "write"`);
    }
    if (typeof locationId !== 'string' || !locationId) {
      throw new AppError(400, 'INVALID_SCIM_REQUEST', `roles[${index}].locationId must be a non-empty string`);
    }

    return { role, module, functionScope, locationId };
  });
}

export const provisionUserHandler: RouteHandler = async (req, res, _params) => {
  requireScimAuth(req);

  const body = getParsedBody(req);
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'Request body must be a JSON object');
  }
  const obj = body as Record<string, unknown>;
  const externalId = obj['externalId'];
  const email = obj['email'];
  const displayName = obj['displayName'];

  if (typeof externalId !== 'string' || !externalId) {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'externalId is required');
  }
  if (typeof email !== 'string' || !email) {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'email is required');
  }
  const roles = parseRoles(obj['roles'] ?? []);

  const userId = await provisionUser({
    externalId,
    email,
    displayName: typeof displayName === 'string' ? displayName : null,
    roles,
  });

  sendJson(res, 201, { userId, externalId, email, roles });
};

export const patchUserHandler: RouteHandler = async (req, res, params) => {
  requireScimAuth(req);

  const externalId = params['externalId'];
  if (!externalId) {
    sendError(res, 400, 'INVALID_PARAMS', 'externalId is required');
    return;
  }

  const body = getParsedBody(req);
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'Request body must be a JSON object');
  }
  const obj = body as Record<string, unknown>;
  const hasActive = obj['active'] !== undefined;
  const hasRoles = obj['roles'] !== undefined;

  // `active` must be a real boolean - do not silently ignore `"false"` or `0`.
  if (hasActive && typeof obj['active'] !== 'boolean') {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'active must be a boolean');
  }
  // A single PATCH must not both change activation and replace roles - that would let one of the
  // two intents be silently dropped. Require separate requests.
  if (hasActive && hasRoles) {
    throw new AppError(400, 'INVALID_SCIM_REQUEST', 'Provide either "active" or "roles", not both in one request');
  }

  if (obj['active'] === false) {
    await deprovisionUser(externalId);
    sendJson(res, 200, { externalId, active: false });
    return;
  }

  if (obj['active'] === true) {
    await reactivateUser(externalId);
    sendJson(res, 200, { externalId, active: true });
    return;
  }

  if (hasRoles) {
    const roles = parseRoles(obj['roles']);
    await updateUserRoles(externalId, roles);
    sendJson(res, 200, { externalId, roles });
    return;
  }

  throw new AppError(400, 'INVALID_SCIM_REQUEST', 'PATCH body must include "active" (boolean) or "roles"');
};
