const parsedPort = Number(process.env['PORT'] ?? 3000);
const parsedMax = Number(process.env['DB_POOL_MAX'] ?? 20);

type AuthMode = 'oidc' | 'local';

function resolveAuthMode(): AuthMode {
  const raw = process.env['AUTH_MODE'] ?? 'oidc';
  if (raw !== 'oidc' && raw !== 'local') {
    throw new Error(`Invalid AUTH_MODE "${raw}": must be "oidc" or "local"`);
  }
  return raw;
}

const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const authMode = resolveAuthMode();

if (authMode === 'local' && nodeEnv === 'production') {
  throw new Error(
    'AUTH_MODE=local (dev/test only) must never be used when NODE_ENV=production. Configure AUTH_MODE=oidc with a real identity provider.',
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
    port: Number(process.env['DB_PORT'] ?? 5432),
    database: process.env['DB_NAME'] ?? 'inventory_events',
    user: process.env['DB_USER'] ?? 'app_user',
    password: process.env['DB_PASSWORD'] ?? 'app_password',
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
