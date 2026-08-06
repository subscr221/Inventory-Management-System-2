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
    throw new Error(
      `Invalid POWERSYNC_TOKEN_TTL "${raw}": must resolve to a positive number of seconds.`,
    );
  }
  return seconds;
}

const rawNodeEnv = process.env['NODE_ENV'];
const nodeEnv = rawNodeEnv ?? 'development';
const authMode = resolveAuthMode();

/**
 * Parses a positive-integer operational knob from the environment, falling back to `fallback`
 * for an unset, non-numeric, non-integer, or non-positive value. Without this guard,
 * `Number('oops')` yields NaN, and `setInterval(fn, NaN)` coerces the delay to 0 ms - turning a
 * mistyped `NOTIFY_*_MS` env var into a tight, unthrottled loop that hammers the database.
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${raw}": must be a positive integer.`);
  }
  return parsed;
}

/**
 * Parses a positive-number statutory rate from the environment, falling back to `fallback`
 * for an unset, non-numeric, or non-positive value. Fractional values are valid: the MSMED
 * s.16 rate is three times the RBI bank rate, which is frequently fractional (3 x 6.5 = 19.5),
 * so an integer-only parse would make the legally correct rate unconfigurable.
 */
function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${raw}": must be a positive number.`);
  }
  return parsed;
}

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
  const missing = ['AUTH_JWKS_URI', 'AUTH_ISSUER', 'AUTH_AUDIENCE'].filter(
    (key) => !process.env[key],
  );
  if (missing.length > 0) {
    throw new Error(
      `AUTH_MODE=oidc requires the following env vars to be set: ${missing.join(', ')}`,
    );
  }
}

if (authMode === 'local' && !process.env['AUTH_LOCAL_SECRET']) {
  throw new Error(
    'AUTH_MODE=local requires AUTH_LOCAL_SECRET to be set (no default value permitted)',
  );
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
    dispatchIntervalMs: parsePositiveIntEnv('NOTIFY_DISPATCH_INTERVAL_MS', 5000),
    // Dispatch attempts before an event is dead-lettered (excluded from dispatch and surfaced to
    // operators) instead of retrying forever at the front of the oldest-first queue - a single
    // permanently-failing event must never starve the events behind it.
    dispatchMaxAttempts: parsePositiveIntEnv('NOTIFY_DISPATCH_MAX_ATTEMPTS', 5),
    escalationIntervalMs: parsePositiveIntEnv('NOTIFY_ESCALATION_INTERVAL_MS', 15000),
    // The stale-notification expiry sweep runs far less often than dispatch/escalation - default
    // hourly - since the Expired transition is a 30-day lifecycle boundary, not a real-time one.
    expiryIntervalMs: parsePositiveIntEnv('NOTIFY_EXPIRY_INTERVAL_MS', 3_600_000),
    notificationRetentionDays: parsePositiveIntEnv('NOTIFY_RETENTION_DAYS', 30),
    // Terminal escalation tier (AC2 "no alert expires silently"): when an escalation target has no
    // active holder, or an escalated alert is itself never acknowledged, the chain escalates once
    // more to this guaranteed-staffed role and then stops. Operations must keep it staffed.
    fallbackEscalationRole: process.env['NOTIFY_FALLBACK_ESCALATION_ROLE'] ?? 'system_admin',
  },
  indent: {
    // Story 4.3 (AC 2 / AC 3): the trailing open window, in days, within which a second
    // requisition for the same SKU by the same requester counts as a potential duplicate.
    duplicateWindowDays: parsePositiveIntEnv('INDENT_DUPLICATE_WINDOW_DAYS', 7),
  },
  erp: {
    // Story 2.9 (INT-ERP-01): an ERP inbound reference projection is stale when its heartbeat's
    // last_successful_at is older than this threshold (default 15 minutes per AC3). Staleness is
    // computed in SQL (now() - last_successful_at), never against the JS wall clock.
    freshnessMs: parsePositiveIntEnv('ERP_SYNC_FRESHNESS_MS', 900_000),
  },
  supplierInvoice: {
    // Story 4.7 (Binding Scope Decisions): the Indian financial year (April 1 - March 31, IST)
    // used to derive the duplicate-detection grain from invoice_date. Never derived from upload
    // or event time. A non-1..12 value fails closed rather than silently wrapping.
    financialYearStartMonth: (() => {
      const raw = process.env['SUPPLIER_INVOICE_FY_START_MONTH'];
      if (raw === undefined || raw.trim() === '') return 4;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
        throw new Error(
          `Invalid SUPPLIER_INVOICE_FY_START_MONTH "${raw}": must be an integer 1-12.`,
        );
      }
      return parsed;
    })(),
  },
  msme: {
    // Story 4.6: dated statutory rule configuration (architecture spine: statutory thresholds are
    // dated configuration, never hard-coded). ruleVersion is stamped alongside every statutory due
    // date so a later amendment to MSMED timelines can ship as new configuration while existing
    // stamps remain traceable to the rule they were computed under.
    ruleVersion: (() => {
      const raw = process.env['MSME_STATUTORY_RULE_VERSION'];
      if (raw === undefined || raw.trim() === '') return 'msmed-2006.s15-16.v1';
      return raw;
    })(),
    // Days before udyam_revalidation_due_date at which the daily compliance check raises the
    // re-verification alert (AC5).
    revalidationLeadDays: parsePositiveIntEnv('MSME_REVALIDATION_LEAD_DAYS', 30),
    // MSMED 2006 s.16: compound interest at three times the RBI bank rate, compounded monthly.
    // The bank rate moves with RBI policy, so the effective annual percent stays configuration;
    // fractional percents are valid (3 x 6.5 = 19.5).
    interestRatePercentAnnual: parsePositiveNumberEnv('MSME_S16_BANK_RATE_X3_PERCENT', 27),
  },
} as const;
