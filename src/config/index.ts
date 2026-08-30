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
function parsePositiveIntEnv(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${raw}": must be a positive integer.`);
  }
  // An upper bound is not pedantry here: an unbounded retention-alert lead makes every retained
  // sample due on the first sweep tick and irreversibly flips them all, an unbounded retention
  // year count produces a calendar date no `::date` cast accepts, and an interval above 2^31-1 is
  // silently clamped by Node's setInterval to 1 ms - a tick storm instead of an hourly sweep.
  if (max !== undefined && parsed > max) {
    throw new Error(`Invalid ${name} "${raw}": must not exceed ${max}.`);
  }
  return parsed;
}

/** Node clamps any setInterval delay above this to 1 ms, so every interval knob is bounded by it. */
const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Story 8.4 Open Question 1, answered by the product owner 2026-08-30: which released lots require a
 * retention sample before they can be released.
 *
 * `all_released_lots` (the default) keeps Binding Scope Decision 6 - every lot released via accept
 * or conditional_release needs one. `bis_covered_only` narrows it to products where
 * item_master.bis_licence_required is true.
 *
 * Fails closed on an unrecognised value rather than silently falling back to either behaviour: the
 * two settings differ in whether a statutory evidence sample exists at all, so a typo must stop the
 * boot, not quietly pick one.
 */
export const RETENTION_SAMPLE_SCOPES = ['all_released_lots', 'bis_covered_only'] as const;
export type RetentionSampleScope = (typeof RETENTION_SAMPLE_SCOPES)[number];

function parseRetentionSampleScope(): RetentionSampleScope {
  const raw = process.env['QC_RETENTION_SAMPLE_SCOPE'];
  if (raw === undefined || raw.trim() === '') return 'all_released_lots';
  const value = raw.trim();
  if (!(RETENTION_SAMPLE_SCOPES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid QC_RETENTION_SAMPLE_SCOPE "${raw}": must be one of ${RETENTION_SAMPLE_SCOPES.join(', ')}.`,
    );
  }
  return value as RetentionSampleScope;
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

/**
 * A comma-separated YYYY-MM-DD holiday calendar from the environment, validated fail-closed at
 * load time (the config.msme precedent). Business-day arithmetic matches holidays by exact
 * zero-padded string, so a malformed entry like "2026-1-1" would silently never match and the
 * holiday would silently not be removed from the count - a wrong answer with no error. Shared by
 * every holiday calendar in the codebase (Story 4.2 responsiveness, Story 7.4 spare returns) so a
 * second copy of this validation cannot drift from the first.
 */
function parseHolidayCalendarEnv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      if (!match) {
        throw new Error(`Invalid ${name} entry "${d}": must be a YYYY-MM-DD calendar date.`);
      }
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        throw new Error(`Invalid ${name} entry "${d}": not a real calendar date.`);
      }
      return d;
    });
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

/**
 * Story 7.8 (FR-M-18): one fail-closed closure-code catalogue (fault, cause or remedy). Cloned
 * from the warrantyOverrideReasonCodes IIFE: only an ABSENT variable takes the defaults; a
 * present-but-blank value is an operator statement and fails closed rather than silently
 * substituting the permissive defaults. Bounded to 64 characters, the maintenance_work_order_
 * closure column CHECK and the seam constant MAX_CLOSURE_CODE_LENGTH in
 * src/compliance/maintenance-plan.ts. Not imported from the seam: config loads before the seams
 * and must not depend on them (the Story 7.7 MAX_REASON_CODE_LENGTH note).
 */
function parseClosureCodeCatalogue(name: string, defaults: string): string[] {
  const raw = process.env[name];
  const value = raw === undefined ? defaults : raw;
  const codes = value
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const MAX_CLOSURE_CODE_LENGTH = 64;
  const malformed = codes.some((c) => c.length > MAX_CLOSURE_CODE_LENGTH || /[\r\n,]/.test(c));
  if (codes.length === 0 || new Set(codes).size !== codes.length || malformed) {
    throw new Error(
      `Invalid ${name} "${raw}": must be a non-empty, duplicate-free, comma-separated list of codes at most ${MAX_CLOSURE_CODE_LENGTH} characters with no line breaks.`,
    );
  }
  return codes;
}

/**
 * Story 6.3: the reason-code list parser, extracted verbatim from the Story 6.2
 * PRODUCTION_MATERIAL_RETURN_REASON_CODES loader (which itself follows the Story 7.7 pattern).
 * Only an ABSENT variable takes the defaults - a variable that is present but blank is an operator
 * statement and fails closed at load rather than silently substituting permissive defaults.
 */
function parseReasonCodeList(envVar: string, defaults: string): string[] {
  const raw = process.env[envVar];
  const value = raw === undefined ? defaults : raw;
  const codes = value
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const MAX_REASON_CODE_LENGTH = 200;
  const malformed = codes.some((c) => c.length > MAX_REASON_CODE_LENGTH || /[\r\n,]/.test(c));
  if (codes.length === 0 || new Set(codes).size !== codes.length || malformed) {
    throw new Error(
      `Invalid ${envVar} "${raw}": must be a non-empty, duplicate-free, comma-separated list of codes at most ${MAX_REASON_CODE_LENGTH} characters with no line breaks.`,
    );
  }
  return codes;
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
  threeWayMatch: {
    // Story 4.5 (AC2): the tolerances a PO/GRN/invoice comparison must fall within to pass. These
    // are commercial policy, not code - they move per deployment and per financial year, so they
    // live here and are snapshotted into every match record alongside ruleVersion. Do NOT conflate
    // them with erp_purchase_order_line.over_receipt_tolerance_pct, which is Story 3.4's
    // receiving-side check with its own error code (RECEIPT_TOLERANCE_EXCEEDED).
    quantityTolerancePercent: parsePositiveNumberEnv('MATCH_QTY_TOLERANCE_PCT', 2),
    priceTolerancePercent: parsePositiveNumberEnv('MATCH_PRICE_TOLERANCE_PCT', 2),
    // Absolute currency tolerance on the invoice header total vs the sum of matched line values,
    // which catches rounding and tax-allocation drift that per-line percentages cannot.
    invoiceValueToleranceAbsolute: parsePositiveNumberEnv('MATCH_INVOICE_VALUE_TOLERANCE_ABS', 100),
    // Dated rule version stamped onto every match record so a historical match stays explainable
    // after the tolerances above are amended (mirrors config.msme.ruleVersion).
    ruleVersion: (() => {
      const raw = process.env['MATCH_TOLERANCE_RULE_VERSION'];
      if (raw === undefined || raw.trim() === '') return '2026-08-fy27';
      return raw;
    })(),
  },
  scorecard: {
    // Story 4.2 (AC4): statutory/bank holidays removed from the responsiveness business-day count
    // (IST calendar, Monday-Saturday working week). Comma-separated YYYY-MM-DD list; default
    // empty - holiday calendars are deployment configuration, never code. Every entry is
    // validated as a strict calendar date at load time (fail closed, the config.msme precedent):
    // businessDaysBetween matches holidays by exact zero-padded YYYY-MM-DD string, so a malformed
    // entry like "2026-1-1" would silently never match and the holiday would silently not be
    // removed from the business-day count.
    responsivenessHolidayCalendar: parseHolidayCalendarEnv('SCORECARD_RESPONSIVENESS_HOLIDAYS'),
  },
  maintenance: {
    // Story 7.4 (FR-M-08): the three-working-day spare return clock skips Sundays and every date
    // listed here. A SEPARATE knob from the scorecard calendar despite sharing a parser and a
    // default: a plant's maintenance-store closure days are not necessarily the supplier
    // responsiveness holidays, and naming one after the other would make the config lie.
    spareReturnHolidayCalendar: parseHolidayCalendarEnv('MAINTENANCE_SPARE_RETURN_HOLIDAYS'),
    // Business days allowed before an issued spare is overdue back at the store (FR-M-08).
    // Capped at 3650, the addBusinessDays ceiling, so an operator typo (e.g. 30000) fails fast
    // at config load instead of surfacing as a 500 on every issue route call.
    spareReturnBusinessDays: (() => {
      const days = parsePositiveIntEnv('MAINTENANCE_SPARE_RETURN_DAYS', 3);
      if (days > 3650) {
        throw new Error(
          `Invalid MAINTENANCE_SPARE_RETURN_DAYS "${days}": must be at most 3650 (the addBusinessDays ceiling).`,
        );
      }
      return days;
    })(),
    // Story 7.6 (FR-M-15, Binding Decision 7): the repair-vs-capitalize threshold is a NUMERIC
    // STRING, never a JS float, compared in SQL with ::numeric. The comparison is strictly greater
    // than: total_cost equal to the threshold is NOT flagged. A malformed env value fails closed at
    // load time (the config.msme precedent) so a typo cannot silently change every capitalization
    // decision.
    capitalizationThreshold: (() => {
      const raw = process.env['MAINTENANCE_CAPITALIZATION_THRESHOLD'];
      if (raw === undefined || raw.trim() === '') return '50000';
      const value = raw.trim();
      if (!/^\d{1,12}(\.\d{1,6})?$/.test(value)) {
        throw new Error(
          `Invalid MAINTENANCE_CAPITALIZATION_THRESHOLD "${raw}": must be a NUMERIC string with at most 6 decimals.`,
        );
      }
      return value;
    })(),
    // Story 7.7 (FR-M-11): the reason codes a warranty override may cite. Commercial policy, not
    // code: comma-separated, trimmed, unique, at least one entry. A malformed env value fails
    // closed at load time (the capitalizationThreshold precedent).
    warrantyOverrideReasonCodes: (() => {
      const raw = process.env['MAINTENANCE_WARRANTY_OVERRIDE_REASON_CODES'];
      // Only an ABSENT variable takes the defaults. A variable that is present but blank (or all
      // whitespace) is an operator statement, almost always "allow no overrides", and silently
      // substituting the four permissive defaults for it is the opposite of failing closed.
      const value =
        raw === undefined
          ? 'OUT_OF_WARRANTY_SCOPE,WARRANTY_NOT_APPLICABLE,PREVIOUS_UNAUTHORIZED_REPAIR,EMERGENCY_REPAIR'
          : raw;
      const codes = value
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      // Bounded to the same ceiling the override route enforces on a cited code. An unbounded
      // entry loaded happily and was then permanently unreachable, while still being advertised in
      // the 422 `allowed` detail as if a caller could use it.
      // Kept equal to MAX_REASON_CODE_LENGTH in src/compliance/maintenance-coverage.ts. Not
      // imported: config is loaded before the seams and must not depend on them.
      const MAX_REASON_CODE_LENGTH = 200;
      const malformed = codes.some((c) => c.length > MAX_REASON_CODE_LENGTH || /[\r\n,]/.test(c));
      if (codes.length === 0 || new Set(codes).size !== codes.length || malformed) {
        throw new Error(
          `Invalid MAINTENANCE_WARRANTY_OVERRIDE_REASON_CODES "${raw}": must be a non-empty, duplicate-free, comma-separated list of codes at most ${MAX_REASON_CODE_LENGTH} characters with no line breaks.`,
        );
      }
      return codes;
    })(),
    // Story 7.8 (FR-M-18, Binding Decision 8): the three fail-closed closure-code catalogues
    // (fault, cause, remedy). Each is parsed EXACTLY like warrantyOverrideReasonCodes: only an
    // ABSENT variable takes the defaults; a present-but-blank value, a duplicate, an entry over 64
    // characters or one carrying a line break or comma fails closed at load time.
    closureCodes: {
      fault: parseClosureCodeCatalogue(
        'MAINTENANCE_FAULT_CODES',
        'MECHANICAL,ELECTRICAL,HYDRAULIC,PNEUMATIC,INSTRUMENTATION,STRUCTURAL,NO_FAULT_FOUND',
      ),
      cause: parseClosureCodeCatalogue(
        'MAINTENANCE_CAUSE_CODES',
        'WEAR,OVERLOAD,CONTAMINATION,LUBRICATION,OPERATOR_ERROR,DESIGN,UNKNOWN',
      ),
      remedy: parseClosureCodeCatalogue(
        'MAINTENANCE_REMEDY_CODES',
        'REPLACED,REPAIRED,ADJUSTED,CLEANED,LUBRICATED,CALIBRATED,NO_ACTION',
      ),
    },
  },
  bom: {
    maxDepth: parsePositiveIntEnv('BOM_MAX_DEPTH', 20),
  },
  production: {
    // Story 6.2 (FR-MO-06): the reason codes a material return may cite. Commercial policy, not
    // code: comma-separated, trimmed, unique, at least one entry. Parsed EXACTLY like
    // maintenance.warrantyOverrideReasonCodes (the 7.7 pattern): only an ABSENT variable takes the
    // defaults - a variable that is present but blank is an operator statement and fails closed at
    // load time rather than silently substituting the four permissive defaults.
    materialReturnReasonCodes: (() => {
      const raw = process.env['PRODUCTION_MATERIAL_RETURN_REASON_CODES'];
      const value =
        raw === undefined
          ? 'SURPLUS_TO_ORDER,DAMAGED_IN_PROCESS,INCORRECT_MATERIAL,QUALITY_REJECTED'
          : raw;
      const codes = value
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      // Bounded to the same ceiling the return route enforces on a cited code. An unbounded entry
      // loaded happily and was then permanently unreachable, while still being advertised in the
      // 422 `allowed` detail as if a caller could use it.
      const MAX_REASON_CODE_LENGTH = 200;
      const malformed = codes.some((c) => c.length > MAX_REASON_CODE_LENGTH || /[\r\n,]/.test(c));
      if (codes.length === 0 || new Set(codes).size !== codes.length || malformed) {
        throw new Error(
          `Invalid PRODUCTION_MATERIAL_RETURN_REASON_CODES "${raw}": must be a non-empty, duplicate-free, comma-separated list of codes at most ${MAX_REASON_CODE_LENGTH} characters with no line breaks.`,
        );
      }
      return codes;
    })(),
    // Story 6.3 (FR-MO-09): the symmetric completion tolerance. One value governs BOTH the
    // over-completion ceiling (order_quantity * (1 + t/100)) and the short-completion floor
    // (order_quantity * (1 - t/100)) - Binding Decision 6 withdraws the per-item tolerance registry
    // rather than deferring it. Kept as an exact decimal STRING so the bounds settle in SQL
    // NUMERIC and never through a JS float. Only an ABSENT variable takes the default; a
    // present-but-blank value fails closed at load, and a value outside [0, 100] refuses to boot
    // (a negative tolerance would invert the bounds and a tolerance above 100 would make the floor
    // negative, silently disabling AC6).
    completionTolerancePercent: (() => {
      const raw = process.env['PRODUCTION_COMPLETION_TOLERANCE_PERCENT'];
      const value = raw === undefined ? '5' : raw.trim();
      // Strictly BELOW 100 (code review 2026-08-31): at exactly 100 the short floor is 0 and no
      // non-negative cumulative quantity is ever below it, so every close-short returns
      // SHORT_CLOSE_NOT_APPLICABLE and AC6 is disabled just as thoroughly as it would be by a
      // negative floor - the very outcome the above-100 bound exists to prevent.
      if (!/^\d{1,3}(\.\d{1,4})?$/.test(value) || Number(value) >= 100) {
        throw new Error(
          `Invalid PRODUCTION_COMPLETION_TOLERANCE_PERCENT "${raw}": must be a decimal percentage of at least 0 and less than 100, with at most four decimal places.`,
        );
      }
      return value;
    })(),
    // Story 6.3 (FR-MO-08): the reason codes a process-scrap declaration may cite.
    scrapReasonCodes: parseReasonCodeList(
      'PRODUCTION_SCRAP_REASON_CODES',
      'PROCESS_LOSS,SETUP_REJECT,MACHINE_FAULT,OPERATOR_ERROR,MATERIAL_DEFECT',
    ),
    // Story 6.3 (FR-MO-09): the reason codes a close-short decision may cite.
    shortCloseReasonCodes: parseReasonCodeList(
      'PRODUCTION_SHORT_CLOSE_REASON_CODES',
      'YIELD_SHORTFALL,MATERIAL_EXHAUSTED,ORDER_CURTAILED,QUALITY_LOSS',
    ),
  },
  quality: {
    // Story 8.1 (FR-Q-01, Binding Scope Decision 10): the roles that count as QC Head-level
    // authority for qc.inspection_plan_approval. The DOA registry still names WHICH role governs
    // the transaction type (AD-3); this list only fails the approval closed when the registry names
    // a role that does not represent QC Head authority (a misconfigured registry is a fail-closed
    // condition, not an escalation). Parsed exactly like the closure-code catalogues: only an
    // ABSENT variable takes the default; a present-but-blank value fails closed at load time.
    qcHeadRoles: parseClosureCodeCatalogue('QC_HEAD_APPROVAL_ROLES', 'qc_head'),
    // Story 8.1 (Binding Scope Decision 12): the role the transactional inspection-task
    // notification fans out to, scoped to the completion site. The task row is created whether or
    // not any holder exists; the notification is a convenience, the task list is the inbox.
    inspectionTaskNotificationRole: (() => {
      const raw = process.env['QC_INSPECTION_TASK_NOTIFICATION_ROLE'];
      const value = raw === undefined ? 'qc_inspector' : raw.trim();
      if (value.length === 0 || value.length > 100 || /[\r\n,]/.test(value)) {
        throw new Error(
          `Invalid QC_INSPECTION_TASK_NOTIFICATION_ROLE "${raw}": must be a single non-empty role name of at most 100 characters with no line breaks or commas.`,
        );
      }
      return value;
    })(),
    // Story 8.4 (FR-Q-07, AC 1 and AC 2, Binding Scope Decision 7): the retention window stamped on
    // every batch release record and retention sample, and the BIS Scheme of Testing and Inspection
    // (STI) floor it may never fall below. There is no per-SKU/per-scheme STI registry anywhere in
    // this codebase yet, so the floor is modelled as a single admin-configurable value and AC 2's
    // RETENTION_FLOOR_VIOLATION is a boot-time guard, not a runtime route: a deployment configured
    // below the statutory floor fails to start rather than silently issuing under-retained
    // certificates. Both default to 7 (ARCHITECTURE-SPINE.md Retention Policy: "CoA / CoC
    // documents: 7 years"), i.e. no floor above the default until a real STI registry exists.
    retentionYearsDefault: parsePositiveIntEnv('QC_RETENTION_YEARS_DEFAULT', 7, 100),
    bisRetentionFloorYears: parsePositiveIntEnv('QC_BIS_RETENTION_FLOOR_YEARS', 7, 100),
    // Story 8.4 (AC 5): how far ahead of expiry the retention-sample sweep raises the recorded
    // disposal event. 30 days per AC 5, bounded to a year so a mistyped value cannot sweep the
    // whole table on one tick.
    retentionExpiryAlertLeadDays: parsePositiveIntEnv(
      'QC_RETENTION_EXPIRY_ALERT_LEAD_DAYS',
      30,
      365,
    ),
    // Story 8.4 (AC 5): the retention-sample expiry sweep interval. Hourly, exactly like the
    // notification expiry sweep - the 30-day alert window is a calendar boundary, not a real-time
    // one. Kept beside its three siblings rather than under `notify`, so one feature's knobs live
    // in one namespace.
    retentionExpiryIntervalMs: parsePositiveIntEnv(
      'QC_RETENTION_EXPIRY_INTERVAL_MS',
      3_600_000,
      MAX_INTERVAL_MS,
    ),
    /** Rows one sweep tick may claim, so a backlog cannot lock the whole table in one transaction. */
    retentionExpiryBatchSize: parsePositiveIntEnv('QC_RETENTION_EXPIRY_BATCH_SIZE', 500, 10_000),
    // Story 8.4 Open Question 1 (answered 2026-08-30): which lots need a retention sample before
    // release. Defaults to the broader rule, so an unconfigured deployment keeps the safer
    // behaviour rather than silently releasing lots with no physical evidence retained.
    retentionSampleScope: parseRetentionSampleScope(),
  },
} as const;

// Story 8.4 (AC 2): RETENTION_FLOOR_VIOLATION. Validated at boot, beside the config object it
// guards, in the same throw-at-startup style as the quality/production catalogue parsers above -
// a retention default below the BIS STI floor is a misconfiguration that must never reach a
// request, because every release record it stamps would carry an unlawfully short retention window.
if (config.quality.retentionYearsDefault < config.quality.bisRetentionFloorYears) {
  // Carries a machine-identifiable `code` so a supervisor, a test, or an operator can tell this
  // boot refusal apart from any other startup failure. AC2 names an ERROR CODE, and a bare message
  // substring is not one.
  const violation = Object.assign(
    new Error(
      `RETENTION_FLOOR_VIOLATION: QC_RETENTION_YEARS_DEFAULT (${config.quality.retentionYearsDefault}) must not be below QC_BIS_RETENTION_FLOOR_YEARS (${config.quality.bisRetentionFloorYears}), the BIS Scheme of Testing and Inspection retention floor.`,
    ),
    { code: 'RETENTION_FLOOR_VIOLATION' },
  );
  throw violation;
}
