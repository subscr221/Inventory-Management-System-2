import './audit.js';

export { auditConfig } from './audit.js';

const parsedPort = Number(process.env['PORT'] ?? 3000);
const parsedMax = Number(process.env['DB_POOL_MAX'] ?? 20);
const parsedDbPort = Number(process.env['DB_PORT'] ?? 5432);

type AuthMode = 'oidc' | 'local';

function resolveAuthMode(): AuthMode {
  const raw = process.env['AUTH_MODE'] ?? 'oidc';
  if (raw !== 'oidc' && raw !== 'local') {
    throw new Error(`Invalid AUTH_MODE "${raw}": must be "oidc" or "local"`);
  }
  return raw;
}

function parsePowerSyncTokenTtlSeconds(raw: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Invalid POWERSYNC_TOKEN_TTL "${raw}": must be a positive integer number of seconds or a value like "15m", "1h", "7d".`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  const seconds = value * multiplier;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid POWERSYNC_TOKEN_TTL "${raw}": must resolve to a positive number of seconds.`);
  }
  return seconds;
}

const rawNodeEnv = process.env['NODE_ENV'];
const nodeEnv = rawNodeEnv ?? 'development';
const authMode = resolveAuthMode();

// Local auth mode (which exposes the unauthenticated dev-token endpoint) is only permitted when
// NODE_ENV is EXPLICITLY a dev/test value. Fail closed for every other case - including NODE_ENV
// unset - so a misconfigured host (e.g. a copied env file with NODE_ENV absent) cannot silently
// run the insecure path.
const LOCAL_AUTH_ALLOWED_ENVS = new Set(['development', 'test']);
if (authMode === 'local' && !LOCAL_AUTH_ALLOWED_ENVS.has(rawNodeEnv ?? '')) {
  throw new Error(
    'AUTH_MODE=local (dev/test only) requires NODE_ENV to be explicitly "development" or "test"; refusing to start. Configure AUTH_MODE=oidc with a real identity provider for staging/production.',
  );
}

if (authMode === 'oidc') {
  const missing = ['AUTH_JWKS_URI', 'AUTH_ISSUER', 'AUTH_AUDIENCE'].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=oidc requires the following env vars to be set: ${missing.join(', ')}`);
  }
}

if (authMode === 'local' && !process.env['AUTH_LOCAL_SECRET']) {
  throw new Error('AUTH_MODE=local requires AUTH_LOCAL_SECRET to be set (no default value permitted)');
}

if (!process.env['SCIM_BEARER_TOKEN']) {
  throw new Error('SCIM_BEARER_TOKEN must be set (no default value permitted)');
}

if (!process.env['POWERSYNC_TOKEN_SECRET']) {
  throw new Error('POWERSYNC_TOKEN_SECRET must be set (no default value permitted)');
}

const powerSyncTokenTtl = process.env['POWERSYNC_TOKEN_TTL'] ?? '15m';
const powerSyncTokenTtlSeconds = parsePowerSyncTokenTtlSeconds(powerSyncTokenTtl);

export const config = {
  port: Number.isNaN(parsedPort) ? 3000 : parsedPort,
  hostname: process.env['HOSTNAME'] ?? '0.0.0.0',
  nodeEnv,
  db: {
    host: process.env['DB_HOST'] ?? 'localhost',
    port: Number.isNaN(parsedDbPort) ? 5432 : parsedDbPort,
    database: process.env['DB_NAME'] ?? 'inventory_events',
    user: process.env['DB_USER'] ?? 'app_user',
    password: process.env['DB_PASSWORD'] ?? 'app_password',
    // DDL-only credentials (migrations, test schema setup) - never used for request-serving
    // queries. app_user intentionally has no CREATE privilege on the public schema.
    adminUser: process.env['DB_ADMIN_USER'] ?? 'admin_user',
    adminPassword: process.env['DB_ADMIN_PASSWORD'] ?? 'admin_password',
    max: Number.isNaN(parsedMax) ? 20 : parsedMax,
    ssl: process.env['DB_SSL'] === 'true',
  },
  auth: {
    mode: authMode,
    jwksUri: process.env['AUTH_JWKS_URI'] ?? '',
    issuer: process.env['AUTH_ISSUER'] ?? '',
    audience: process.env['AUTH_AUDIENCE'] ?? '',
    localSecret: process.env['AUTH_LOCAL_SECRET'] ?? '',
  },
  scim: {
    bearerToken: process.env['SCIM_BEARER_TOKEN'] ?? '',
  },
  edge: {
    siteName: process.env['EDGE_SITE_NAME'] ?? 'Pilot Gate Site',
  },
  powerSync: {
    url: process.env['POWERSYNC_URL'] ?? '/powersync',
    tokenIssuer: process.env['POWERSYNC_TOKEN_ISSUER'] ?? 'inventory-edge',
    tokenAudience: process.env['POWERSYNC_TOKEN_AUDIENCE'] ?? 'powersync',
    tokenSecret: process.env['POWERSYNC_TOKEN_SECRET'] ?? '',
    tokenTtl: powerSyncTokenTtl,
    tokenTtlSeconds: powerSyncTokenTtlSeconds,
  },
  notify: {
    // Web push (VAPID) is optional, not fail-closed like the auth/SCIM/PowerSync secrets above:
    // an environment with no push provider configured still gets full in-app notification
    // delivery (AC1's in-app channel and AC4's durable-queue guarantee do not depend on it).
    // Unset keys mean web_push deliveries are recorded as 'failed' with reason
    // 'push_not_configured' rather than being silently skipped or crashing the dispatcher.
    vapidPublicKey: process.env['VAPID_PUBLIC_KEY'] ?? '',
    vapidPrivateKey: process.env['VAPID_PRIVATE_KEY'] ?? '',
    vapidSubject: process.env['VAPID_SUBJECT'] ?? 'mailto:platform@example.com',
    dispatchIntervalMs: Number(process.env['NOTIFY_DISPATCH_INTERVAL_MS'] ?? 5000),
    escalationIntervalMs: Number(process.env['NOTIFY_ESCALATION_INTERVAL_MS'] ?? 15000),
    notificationRetentionDays: Number(process.env['NOTIFY_RETENTION_DAYS'] ?? 30),
  },
} as const;
