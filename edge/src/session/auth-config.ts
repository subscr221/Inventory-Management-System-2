/**
 * Story 1.12: runtime auth configuration for the edge UI.
 *
 * The edge image is built once in CI and promoted by digest between environments, so nothing
 * here may come from `NEXT_PUBLIC_*` (those are baked at build time). Instead the edge container's
 * own Next.js server exposes `GET /auth/config`, read from `process.env` per request, and the
 * browser caches the answer in `localStorage` so an offline start can still find its cached
 * Keycloak user (oidc-client-ts keys the user record by authority and client id).
 */

export const AUTH_CONFIG_PATH = '/auth/config';
export const AUTH_CONFIG_STORAGE_KEY = 'inventory-edge-auth-config';

/** Wire shape returned by `GET /auth/config`. */
export type AuthConfigWire =
  | { mode: 'oidc'; authority: string; client_id: string }
  | { mode: 'local'; dev_subject: string | null };

/** Parsed, browser-side shape. */
export type AuthConfig =
  | { mode: 'oidc'; authority: string; clientId: string }
  | { mode: 'local'; devSubject: string | null };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class AuthConfigUnavailableError extends Error {
  constructor() {
    super('Auth configuration is unavailable and nothing is cached');
    this.name = 'AuthConfigUnavailableError';
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Server side: derive the wire config from the container environment. Returns null when the
 * configuration is invalid so the route handler can fail closed (500) instead of silently
 * running an unauthenticated edge in `oidc` mode.
 *
 * `EDGE_AUTH_MODE` unset means `local` with no subject: the Playwright specs and `next dev` run
 * with no API at all, and that is exactly today's behaviour (no bearer, bootstrap fails, the
 * first-sync card renders).
 */
export function readServerAuthConfig(env: Record<string, string | undefined>): AuthConfigWire | null {
  const mode = nonEmpty(env['EDGE_AUTH_MODE']) ?? 'local';
  if (mode === 'local') {
    return { mode: 'local', dev_subject: nonEmpty(env['EDGE_DEV_SUBJECT']) };
  }
  if (mode === 'oidc') {
    const authority = nonEmpty(env['EDGE_OIDC_AUTHORITY']);
    const clientId = nonEmpty(env['EDGE_OIDC_CLIENT_ID']);
    if (!authority || !clientId) return null;
    return { mode: 'oidc', authority, client_id: clientId };
  }
  return null;
}

/** Browser side: validate whatever came over the wire (or out of localStorage). */
export function parseAuthConfig(json: unknown): AuthConfig {
  if (typeof json !== 'object' || json === null) throw new Error('invalid auth config');
  const record = json as Record<string, unknown>;
  if (record['mode'] === 'oidc') {
    const authority = record['authority'];
    const clientId = record['client_id'];
    if (typeof authority !== 'string' || authority === '') throw new Error('invalid auth config');
    if (typeof clientId !== 'string' || clientId === '') throw new Error('invalid auth config');
    return { mode: 'oidc', authority, clientId };
  }
  if (record['mode'] === 'local') {
    const subject = record['dev_subject'];
    return { mode: 'local', devSubject: typeof subject === 'string' && subject !== '' ? subject : null };
  }
  throw new Error('invalid auth config');
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the runtime config, cache it, and fall back to the cached copy when the network (or the
 * edge server itself) is unavailable. A server 500 (fail-closed `oidc` with missing values) never
 * overwrites a previously good cached copy.
 */
export async function loadAuthConfig(storage: StorageLike | null = defaultStorage()): Promise<AuthConfig> {
  try {
    const response = await fetch(AUTH_CONFIG_PATH, { cache: 'no-store' });
    if (response.ok) {
      const wire = (await response.json()) as unknown;
      const config = parseAuthConfig(wire);
      try {
        storage?.setItem(AUTH_CONFIG_STORAGE_KEY, JSON.stringify(wire));
      } catch {
        // Quota or private mode: the live config is still good, only the offline copy is lost.
      }
      return config;
    }
  } catch {
    // fall through to the cached copy
  }
  const cached = storage?.getItem(AUTH_CONFIG_STORAGE_KEY) ?? null;
  if (cached) {
    try {
      return parseAuthConfig(JSON.parse(cached) as unknown);
    } catch {
      storage?.removeItem(AUTH_CONFIG_STORAGE_KEY);
    }
  }
  throw new AuthConfigUnavailableError();
}
