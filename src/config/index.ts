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
} as const;
