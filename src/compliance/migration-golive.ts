import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import type { EventEnvelope } from '../events/store.js';
import { logRejectionAudit, type AuditEntryPayload } from '../read/projections/audit_log.js';
import type {
  MigrationGoLiveSignoffType,
  MigrationGoLiveUnblockedPayload,
  MigrationSignoffRecordedPayload,
} from '../events/schema.js';
import { MIGRATION_DOCUMENT_DOMAINS } from '../migration/document-templates.js';
import {
  computeOpeningStockVariances,
  summariseOpeningStockVariances,
  type OpeningStockVariance,
} from '../read/projections/migration_variance.js';
import {
  getDomainVerificationStatuses,
  type DomainVerificationStatus,
} from '../read/projections/migration_domain_verification.js';
import { lockMigrationStage, OPENING_STOCK_DOMAIN } from './migration-opening-stock.js';

/**
 * Story 13.3 (FR-DM-03, SM-48): the go-live reconciliation sign-off gate.
 *
 * This module COMPOSES two already-correct derivations and adds nothing to either:
 * `computeOpeningStockVariances` (Story 13.1 - a variance is unexplained unless its status is
 * `explained`) and `getDomainVerificationStatuses` (Story 13.2 - `verified` iff the latest run of
 * the latest load is signed off). Re-deriving either rule here would be the Story 11.5 D1 defect.
 *
 * - `assertMigrationGoLiveEventShape` is PURE and is reached from `assertMigrationEventShape`
 *   (one seam entry point), so a malformed event never consumes an idempotency key.
 * - `applyMigrationGoLiveProjection` is reached from `applyMigrationProjection`'s switch inside
 *   persistEvent's transaction. The gate (`evaluateGoLiveGate`) and the SOD-07 identity check
 *   (`assertGoLiveSignoffAllowed`) run HERE as well as in the route, under the opening-stock
 *   stage lock, and every refusal self-audits through auditCtx (the Story 11.2 pattern).
 *
 * Gate order (Task 3.3, widened by the 2026-09-12 code review, decision 2): (a) both effective
 * final sign-offs recorded, else APPROVAL_REQUIRED; (b) neither sign-off predates the site's
 * latest migration load or ERP snapshot, else SIGNOFF_STALE (the attestation must describe the
 * data being released; a stale sign-off is re-attested, never edited); (c) zero opening-stock
 * variances whose status is not `explained`, else VARIANCE_UNRESOLVED listing every one (AC 3);
 * (d) opening stock promoted (stage `dry_run`), else PROMOTION_REQUIRED; (e) every document
 * domain in the wave `verified`, else DOMAIN_UNVERIFIED naming the rest. The report's
 * `gate.blocking` is the same refusal the unblock route returns.
 *
 * Error-code decision (Task 0.2): AC 2's literal `APPROVAL_REQUIRED` is the contractual value, so
 * the string is REUSED from Story 13.1's MIGRATION_ERROR_CODES, where it means "the caller is not
 * the frozen approver of a variance explanation" (403, one route). Here it is the 409-class gate
 * block "go-live requested before both final sign-offs are recorded". The two call sites never
 * collide (different routes, different status codes, `details.missing_signoffs` only here).
 * `VARIANCE_UNRESOLVED` is the same concept as 13.1's promotion gate and is reused on purpose.
 * SIGNOFF_STALE, PROMOTION_REQUIRED and DOMAIN_UNVERIFIED are minted here (no earlier story has
 * the concept). The codes are spelled as literals in this file because
 * migration-opening-stock.ts imports this module (ESM cycle): reading MIGRATION_ERROR_CODES at
 * load time would be a temporal-dead-zone read. test/integration/story-13-3.test.ts pins the
 * reused literals to the 13.1 and 13.2 constants.
 */

export const MIGRATION_GOLIVE_ERROR_CODES = {
  /** = MIGRATION_ERROR_CODES.APPROVAL_REQUIRED (reused, see the module comment). */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  /** = MIGRATION_ERROR_CODES.VARIANCE_UNRESOLVED (reused). */
  VARIANCE_UNRESOLVED: 'VARIANCE_UNRESOLVED',
  /** = MIGRATION_DOCUMENT_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT (reused: SOD-07 is one policy). */
  SIGNOFF_ACTOR_CONFLICT: 'SIGNOFF_ACTOR_CONFLICT',
  /** = MIGRATION_ERROR_CODES.INVALID_STATE (reused). */
  INVALID_STATE: 'INVALID_STATE',
  /** An effective sign-off predates the site's latest migration load or ERP snapshot. */
  SIGNOFF_STALE: 'SIGNOFF_STALE',
  /** Opening stock has not been promoted (migration_stage.stage is not `dry_run`). */
  PROMOTION_REQUIRED: 'PROMOTION_REQUIRED',
  /** At least one document domain in the wave is not `verified` (Story 13.2 status). */
  DOMAIN_UNVERIFIED: 'DOMAIN_UNVERIFIED',
  /** Platform RBAC code: the signer holds no qualifying write assignment (applier-side twin). */
  FUNCTION_ACCESS_DENIED: 'FUNCTION_ACCESS_DENIED',
} as const;

export const GOLIVE_SIGNOFF_TYPES = ['department_head_final', 'finance_final'] as const;

/**
 * Access matrix section 3.7: "Sign off domain balances: A" is the department head; "Final go-live
 * financial sign-off: A" is the finance controller. Both are checked on module `migration` (the
 * gate is not domain-specific, unlike Story 13.2's per-domain sign-off modules).
 */
export const GOLIVE_SIGNOFF_ROLES: Readonly<Record<MigrationGoLiveSignoffType, string>> = {
  department_head_final: 'department_head',
  finance_final: 'finance_controller',
};

/** The module the two sign-off roles are checked on; = MIGRATION_MODULE in src/api/v1/migration.ts. */
const MIGRATION_MODULE = 'migration';

/**
 * The pilot-wave go-live scope (epic dev note): Story 13.1's domain plus Story 13.2's four.
 * `'opening_stock'` is spelled as a literal rather than `OPENING_STOCK_DOMAIN` because this
 * array is evaluated at module load and migration-opening-stock.ts is this module's ESM cycle
 * partner (the same temporal-dead-zone reason as the error codes above).
 */
export const GOLIVE_WAVE_SCOPE: readonly string[] = [
  'opening_stock',
  ...MIGRATION_DOCUMENT_DOMAINS,
];

/** Audit rows keep at most this many unexplained variances; the HTTP response keeps them all. */
export const MAX_AUDIT_VARIANCE_ENTRIES = 200;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNOFF_TYPES = new Set<string>(GOLIVE_SIGNOFF_TYPES);

type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;
type Queryable = Pick<PoolClient, 'query'>;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_REGEX.test(v);
}
function shapeError(eventType: string, message: string, details: Record<string, unknown> = {}) {
  return new AppError(400, 'INVALID_PARAMS', message, { event_type: eventType, ...details });
}

export function isGoLiveSignoffType(v: unknown): v is MigrationGoLiveSignoffType {
  return typeof v === 'string' && SIGNOFF_TYPES.has(v);
}

function otherSignoffType(t: MigrationGoLiveSignoffType): MigrationGoLiveSignoffType {
  return t === 'department_head_final' ? 'finance_final' : 'department_head_final';
}

// ---------------------------------------------------------------------------
// Pre-transaction shape assert (pure)
// ---------------------------------------------------------------------------

export function assertMigrationGoLiveEventShape(envelope: EventEnvelope): void {
  const type = envelope.event_type;
  const p = envelope.payload as Record<string, unknown>;
  if ((p['site_id'] as string).toLowerCase() !== envelope.stream_id.toLowerCase()) {
    throw shapeError(type, 'site_id must equal the stream_id');
  }
  if (type === 'migration.signoff.recorded') {
    const q = p as Partial<MigrationSignoffRecordedPayload>;
    if (!isGoLiveSignoffType(q.signoff_type)) {
      throw shapeError(type, `signoff_type must be one of ${GOLIVE_SIGNOFF_TYPES.join(', ')}`, {
        signoff_type: q.signoff_type ?? null,
      });
    }
    if (!isUuid(q.signed_off_by_actor_id))
      throw shapeError(type, 'signed_off_by_actor_id must be a UUID');
    // The payload may only restate the envelope's authenticated actor (code review 2026-09-12):
    // a payload that names someone else is refused before any key is consumed, so the event and
    // the projection row can never disagree on who signed.
    if (q.signed_off_by_actor_id.toLowerCase() !== envelope.metadata.actor.user_id.toLowerCase()) {
      throw shapeError(type, 'signed_off_by_actor_id must equal the envelope actor', {
        reason: 'payload_actor_mismatch',
      });
    }
    const expectedRole = GOLIVE_SIGNOFF_ROLES[q.signoff_type];
    if (q.signed_off_role !== expectedRole) {
      throw shapeError(type, `signed_off_role must be ${expectedRole} for ${q.signoff_type}`, {
        signed_off_role: q.signed_off_role ?? null,
        expected_role: expectedRole,
      });
    }
    return;
  }
  if (type === 'migration.golive.unblocked') {
    const q = p as Partial<MigrationGoLiveUnblockedPayload>;
    if (!isUuid(q.department_head_signoff_event_id))
      throw shapeError(type, 'department_head_signoff_event_id must be a UUID');
    if (!isUuid(q.finance_signoff_event_id))
      throw shapeError(type, 'finance_signoff_event_id must be a UUID');
    if (q.unexplained_variance_count !== 0) {
      throw shapeError(type, 'unexplained_variance_count must be 0 (SM-48)');
    }
  }
}

// ---------------------------------------------------------------------------
// Site data activity (what a sign-off can go stale against)
// ---------------------------------------------------------------------------

export interface SiteDataActivity {
  /** Latest `migration_import.created_at` for the site, any domain; null when nothing loaded. */
  latest_import_at: string | null;
  /** Latest `erp_stock_balance.snapshot_at` matched to the site as VARIANCE_SQL matches it. */
  latest_snapshot_at: string | null;
}

/**
 * The site match is the one VARIANCE_SQL uses (site_id, or the legacy site_code_ext when the
 * ERP row carries no site_id) so "latest snapshot" means the rows the variances compare.
 */
const DATA_ACTIVITY_SQL = `
  SELECT
    (SELECT max(i.created_at) FROM migration_import i WHERE i.site_id = $1) AS latest_import_at,
    (SELECT max(b.snapshot_at)
       FROM erp_stock_balance b, location_register s
      WHERE s.location_id = $1
        AND (b.site_id = s.location_id OR (b.site_id IS NULL AND b.site_code_ext = s.location_code))
    ) AS latest_snapshot_at`;

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : isoOf(v);
}

export async function loadSiteDataActivity(
  siteId: string,
  client: Queryable,
): Promise<SiteDataActivity> {
  const r = await client.query(DATA_ACTIVITY_SQL, [siteId]);
  const row = r.rows[0] as Record<string, unknown>;
  return {
    latest_import_at: isoOrNull(row['latest_import_at']),
    latest_snapshot_at: isoOrNull(row['latest_snapshot_at']),
  };
}

// ---------------------------------------------------------------------------
// Sign-off records
// ---------------------------------------------------------------------------

export interface GoLiveSignoffRecord {
  site_id: string;
  signoff_type: MigrationGoLiveSignoffType;
  signed_off_by_actor_id: string;
  signed_off_role: string;
  source_event_id: string;
  occurred_at: string;
  business_date: string;
  /** True when this attestation predates the site's latest migration load or ERP snapshot. */
  stale: boolean;
  /** Earlier attestations of this type that this one supersedes (append-only re-attestation). */
  superseded_count: number;
}

export type GoLiveSignoffs = Record<MigrationGoLiveSignoffType, GoLiveSignoffRecord | null>;

const SIGNOFF_SELECT_SQL = `
  WITH activity AS (${DATA_ACTIVITY_SQL}),
  effective AS (
    SELECT DISTINCT ON (signoff_type) *
      FROM migration_golive_signoff
     WHERE site_id = $1
     ORDER BY signoff_type, occurred_at DESC, created_at DESC
  )
  SELECT e.site_id, e.signoff_type, e.signed_off_by_actor_id, e.signed_off_role,
         e.source_event_id, e.occurred_at, e.business_date::text AS business_date,
         ((SELECT count(*) FROM migration_golive_signoff x
            WHERE x.site_id = e.site_id AND x.signoff_type = e.signoff_type) - 1)::int
           AS superseded_count,
         (e.occurred_at < GREATEST(COALESCE(a.latest_import_at, '-infinity'::timestamptz),
                                   COALESCE(a.latest_snapshot_at, '-infinity'::timestamptz)))
           AS stale
    FROM effective e, activity a`;

function signoffRecordOf(row: Record<string, unknown>): GoLiveSignoffRecord {
  return {
    site_id: row['site_id'] as string,
    signoff_type: row['signoff_type'] as MigrationGoLiveSignoffType,
    signed_off_by_actor_id: row['signed_off_by_actor_id'] as string,
    signed_off_role: row['signed_off_role'] as string,
    source_event_id: row['source_event_id'] as string,
    occurred_at: isoOf(row['occurred_at']),
    business_date: row['business_date'] as string,
    stale: row['stale'] === true,
    superseded_count: row['superseded_count'] as number,
  };
}

/** The EFFECTIVE (latest) sign-off of each type for the site, with its staleness. */
export async function loadGoLiveSignoffs(
  siteId: string,
  client: Queryable,
): Promise<GoLiveSignoffs> {
  const r = await client.query(SIGNOFF_SELECT_SQL, [siteId]);
  const out: GoLiveSignoffs = { department_head_final: null, finance_final: null };
  for (const row of r.rows as Record<string, unknown>[]) {
    const rec = signoffRecordOf(row);
    out[rec.signoff_type] = rec;
  }
  return out;
}

/** One sign-off by its event id (the replay path returns the row the replayed event wrote). */
export async function loadGoLiveSignoffByEventId(
  siteId: string,
  eventId: string,
  client: Queryable,
): Promise<GoLiveSignoffRecord | null> {
  const r = await client.query(
    `WITH activity AS (${DATA_ACTIVITY_SQL})
     SELECT e.site_id, e.signoff_type, e.signed_off_by_actor_id, e.signed_off_role,
            e.source_event_id, e.occurred_at, e.business_date::text AS business_date,
            0::int AS superseded_count,
            (e.occurred_at < GREATEST(COALESCE(a.latest_import_at, '-infinity'::timestamptz),
                                      COALESCE(a.latest_snapshot_at, '-infinity'::timestamptz)))
              AS stale
       FROM migration_golive_signoff e, activity a
      WHERE e.site_id = $1 AND e.source_event_id = $2`,
    [siteId, eventId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? signoffRecordOf(row) : null;
}

export interface GoLiveStatusRecord {
  site_id: string;
  unblocked_at: string;
  unblocked_event_id: string;
  unblocked_by_actor_id: string;
  unblocked_by_role: string;
  department_head_signoff_event_id: string;
  finance_signoff_event_id: string;
  business_date: string;
}

export async function loadGoLiveStatus(
  siteId: string,
  client: Queryable,
): Promise<GoLiveStatusRecord | null> {
  const r = await client.query(
    `SELECT site_id, unblocked_at, unblocked_event_id, unblocked_by_actor_id, unblocked_by_role,
            department_head_signoff_event_id, finance_signoff_event_id,
            business_date::text AS business_date
       FROM migration_golive_status WHERE site_id = $1`,
    [siteId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    site_id: row['site_id'] as string,
    unblocked_at: isoOf(row['unblocked_at']),
    unblocked_event_id: row['unblocked_event_id'] as string,
    unblocked_by_actor_id: row['unblocked_by_actor_id'] as string,
    unblocked_by_role: row['unblocked_by_role'] as string,
    department_head_signoff_event_id: row['department_head_signoff_event_id'] as string,
    finance_signoff_event_id: row['finance_signoff_event_id'] as string,
    business_date: row['business_date'] as string,
  };
}

/**
 * SOD-07 ("Migration loader != sign-off authority"), the request-time twin of the
 * `migration.domain_signoff` / `migration.variance_explanation` pairs in
 * src/cli/verify-segregated-roles-core.ts. Shared by the route (pre-check) and the applier (under
 * the stage lock). Returns the refusal instead of throwing so the applier can self-audit it.
 *
 * Every leg is provable from the database so the applier can repeat them without the request:
 * (0) the effective sign-off of this type is absent or STALE (a fresh one is refused rather than
 * overwritten - the record is append-only; a stale one may be re-attested); (1) the signer holds a
 * WRITE assignment for the type's role on module `migration` (or `*`) reaching this site (the
 * positive privilege leg the route also checks from the token); (2) the signer holds no
 * `migration_lead` assignment reaching this site; (3) the signer loaded no migration file for
 * the site; (4) the signer promoted no opening stock for the site; (5) the signer ran no
 * document-domain verification for the site; (6) the signer did not give the site's OTHER
 * effective final sign-off (two hats, two people - code review 2026-09-12, decision 1).
 */
export async function assertGoLiveSignoffAllowed(
  siteId: string,
  signoffType: MigrationGoLiveSignoffType,
  signerActorId: string,
  client: Queryable,
): Promise<AppError | null> {
  const signoffs = await loadGoLiveSignoffs(siteId, client);
  const prior = signoffs[signoffType];
  if (prior && !prior.stale) {
    return new AppError(
      409,
      MIGRATION_GOLIVE_ERROR_CODES.INVALID_STATE,
      `The ${signoffType} sign-off is already recorded for this site; a second attestation is refused`,
      {
        site_id: siteId,
        signoff_type: signoffType,
        reason: 'already_signed_off',
        source_event_id: prior.source_event_id,
        signed_off_by_actor_id: prior.signed_off_by_actor_id,
      },
    );
  }
  const role = GOLIVE_SIGNOFF_ROLES[signoffType];
  const r = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM user_role_assignments a
                WHERE a.user_id = $2 AND a.role = $4 AND a.function_scope = 'write'
                  AND a.module IN ($5, '*')
                  AND (a.location_id = '*' OR lower(a.location_id) = lower($3))) AS holds_role,
       EXISTS (SELECT 1 FROM user_role_assignments a
                WHERE a.user_id = $2 AND a.role = 'migration_lead'
                  AND (a.location_id = '*' OR lower(a.location_id) = lower($3))) AS is_migration_lead,
       EXISTS (SELECT 1 FROM migration_import i
                WHERE i.site_id = $1 AND i.created_by_actor_id = $2) AS is_loader,
       EXISTS (SELECT 1 FROM migration_stage s
                WHERE s.site_id = $1 AND s.promoted_by_actor_id = $2) AS is_promoter,
       EXISTS (SELECT 1 FROM migration_domain_verification v
                WHERE v.site_id = $1 AND v.run_by_actor_id = $2) AS is_verification_runner`,
    [siteId, signerActorId, siteId, role, MIGRATION_MODULE],
  );
  const legs = r.rows[0] as Record<string, boolean>;
  if (legs['holds_role'] !== true) {
    return new AppError(
      403,
      MIGRATION_GOLIVE_ERROR_CODES.FUNCTION_ACCESS_DENIED,
      `A ${role} write assignment on module ${MIGRATION_MODULE} reaching this site is required for the ${signoffType} sign-off`,
      {
        site_id: siteId,
        signoff_type: signoffType,
        required_roles: [role],
        required_module: MIGRATION_MODULE,
      },
    );
  }
  const conflicts: Array<[string, string]> = [
    ['is_migration_lead', 'migration_lead'],
    ['is_loader', 'migration_loader'],
    ['is_promoter', 'opening_stock_promoter'],
    ['is_verification_runner', 'verification_runner'],
  ];
  for (const [flag, conflictingRole] of conflicts) {
    if (legs[flag] === true) {
      return new AppError(
        403,
        MIGRATION_GOLIVE_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT,
        `An actor who is ${conflictingRole.replace(/_/g, ' ')} for this site cannot give the ${signoffType} sign-off (SOD-07)`,
        { site_id: siteId, signoff_type: signoffType, conflicting_role: conflictingRole },
      );
    }
  }
  const other = signoffs[otherSignoffType(signoffType)];
  if (other && other.signed_off_by_actor_id.toLowerCase() === signerActorId.toLowerCase()) {
    return new AppError(
      403,
      MIGRATION_GOLIVE_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT,
      `The actor who gave the ${other.signoff_type} sign-off cannot also give the ${signoffType} sign-off; the two final sign-offs must come from two people`,
      {
        site_id: siteId,
        signoff_type: signoffType,
        conflicting_role: 'other_final_signoff',
        other_signoff_type: other.signoff_type,
        other_source_event_id: other.source_event_id,
      },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GoLiveGateEvaluation {
  signoffs: GoLiveSignoffs;
  data_activity: SiteDataActivity;
  variances: OpeningStockVariance[];
  unexplained: OpeningStockVariance[];
  /** Opening-stock stage for the site; null when no stage row exists (nothing loaded yet). */
  opening_stock_stage: 'staging' | 'dry_run' | null;
  domain_statuses: DomainVerificationStatus[];
  refusal: AppError | null;
}

/**
 * One evaluation serves the gate (route pre-check, applier under lock) AND the report, so the
 * report's `gate.blocking` is the same refusal the unblock route would return. The order is the
 * module comment's (a) to (e); the first failing check is the refusal.
 */
export async function evaluateGoLiveGate(
  siteId: string,
  client: PoolClient,
): Promise<GoLiveGateEvaluation> {
  const signoffs = await loadGoLiveSignoffs(siteId, client);
  const dataActivity = await loadSiteDataActivity(siteId, client);
  const variances = await computeOpeningStockVariances(siteId, client);
  const unexplained = variances.filter((v) => v.status !== 'explained');
  const stageRow = (
    await client.query(
      `SELECT stage FROM migration_stage WHERE site_id = $1 AND domain = 'opening_stock'`,
      [siteId],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  const openingStockStage = (stageRow?.['stage'] as 'staging' | 'dry_run' | undefined) ?? null;
  const domainStatuses = await getDomainVerificationStatuses(siteId, client);

  const missing = GOLIVE_SIGNOFF_TYPES.filter((t) => signoffs[t] === null);
  const stale = GOLIVE_SIGNOFF_TYPES.filter((t) => signoffs[t]?.stale === true);
  const unverified = domainStatuses.filter((s) => s.status !== 'verified').map((s) => s.domain);
  let refusal: AppError | null = null;
  if (missing.length > 0) {
    refusal = new AppError(
      409,
      MIGRATION_GOLIVE_ERROR_CODES.APPROVAL_REQUIRED,
      'Go-live requires both the department-head and the finance final sign-off before it can be unblocked',
      {
        site_id: siteId,
        missing_signoffs: missing,
        recorded_signoffs: GOLIVE_SIGNOFF_TYPES.filter((t) => signoffs[t] !== null),
      },
    );
  } else if (stale.length > 0) {
    refusal = new AppError(
      409,
      MIGRATION_GOLIVE_ERROR_CODES.SIGNOFF_STALE,
      `${stale.length} final sign-off(s) predate the site's latest migration load or ERP snapshot and must be re-attested`,
      {
        site_id: siteId,
        stale_signoffs: stale.map((t) => ({
          signoff_type: t,
          source_event_id: signoffs[t]!.source_event_id,
          signed_off_by_actor_id: signoffs[t]!.signed_off_by_actor_id,
          occurred_at: signoffs[t]!.occurred_at,
        })),
        latest_import_at: dataActivity.latest_import_at,
        latest_snapshot_at: dataActivity.latest_snapshot_at,
      },
    );
  } else if (unexplained.length > 0) {
    refusal = new AppError(
      409,
      MIGRATION_GOLIVE_ERROR_CODES.VARIANCE_UNRESOLVED,
      `${unexplained.length} opening-stock variance(s) are not explained; go-live stays blocked (SM-48)`,
      {
        site_id: siteId,
        unexplained_count: unexplained.length,
        unexplained: unexplained.map((v) => ({
          variance_key: v.variance_key,
          source_system: v.source_system,
          location_code: v.location_code,
          sku: v.sku,
          lot_number: v.lot_number,
          serial_number: v.serial_number,
          kind: v.kind,
          quantity_delta: v.quantity_delta,
          variance_value: v.variance_value,
          status: v.status,
          explanation_id: v.explanation_id,
        })),
      },
    );
  } else if (openingStockStage !== 'dry_run') {
    refusal = new AppError(
      409,
      MIGRATION_GOLIVE_ERROR_CODES.PROMOTION_REQUIRED,
      'Opening stock must be promoted before go-live can be unblocked',
      { site_id: siteId, domain: 'opening_stock', stage: openingStockStage },
    );
  } else if (unverified.length > 0) {
    refusal = new AppError(
      409,
      MIGRATION_GOLIVE_ERROR_CODES.DOMAIN_UNVERIFIED,
      `${unverified.length} document domain(s) in the wave are not verified; go-live stays blocked`,
      { site_id: siteId, unverified_domains: unverified },
    );
  }
  return {
    signoffs,
    data_activity: dataActivity,
    variances,
    unexplained,
    opening_stock_stage: openingStockStage,
    domain_statuses: domainStatuses,
    refusal,
  };
}

// ---------------------------------------------------------------------------
// Appliers
// ---------------------------------------------------------------------------

/**
 * The audit row keeps a bounded copy of the refusal: the HTTP response lists every unexplained
 * variance (AC 3), the audit log the first MAX_AUDIT_VARIANCE_ENTRIES plus the count.
 */
function auditDetailsOf(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const listed = details['unexplained'];
  if (!Array.isArray(listed) || listed.length <= MAX_AUDIT_VARIANCE_ENTRIES) return details;
  return {
    ...details,
    unexplained: listed.slice(0, MAX_AUDIT_VARIANCE_ENTRIES),
    unexplained_listed: MAX_AUDIT_VARIANCE_ENTRIES,
    unexplained_truncated: true,
  };
}

async function refuse(
  err: AppError,
  auditCtx: AuditCtx | undefined,
  eventId: string | null,
): Promise<never> {
  if (auditCtx) {
    await logRejectionAudit({
      ...auditCtx,
      event_id: eventId,
      http_status: err.statusCode,
      error_code: err.errorCode,
      details: auditDetailsOf(err.details),
    });
  }
  throw err;
}

export async function applyMigrationGoLiveProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: AuditCtx,
): Promise<void> {
  switch (envelope.event_type) {
    case 'migration.signoff.recorded':
      await applySignoffRecorded(envelope, client, eventId, auditCtx);
      return;
    case 'migration.golive.unblocked':
      await applyGoLiveUnblocked(envelope, client, eventId, auditCtx);
      return;
    default:
      return;
  }
}

async function applySignoffRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx: AuditCtx | undefined,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationSignoffRecordedPayload;
  // The envelope's authenticated actor is the trusted signer identity (the shape assert has
  // already proved the payload restates it), and the role written is the type's canonical role.
  const signerActorId = envelope.metadata.actor.user_id;
  // The opening-stock stage row is the site's migration lock: sign-offs, promotion and the unblock
  // all serialise on it, so two sign-offs of one type cannot race past the already-signed check.
  await lockMigrationStage(p.site_id, OPENING_STOCK_DOMAIN, client);
  const refusal = await assertGoLiveSignoffAllowed(
    p.site_id,
    p.signoff_type,
    signerActorId,
    client,
  );
  if (refusal) await refuse(refusal, auditCtx, null);
  await client.query(
    `INSERT INTO migration_golive_signoff
       (site_id, signoff_type, signed_off_by_actor_id, signed_off_role, source_event_id, occurred_at, business_date)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::date)`,
    [
      p.site_id,
      p.signoff_type,
      signerActorId,
      GOLIVE_SIGNOFF_ROLES[p.signoff_type],
      eventId,
      envelope.metadata.occurred_at,
      p.business_date,
    ],
  );
}

async function applyGoLiveUnblocked(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx: AuditCtx | undefined,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationGoLiveUnblockedPayload;
  const siteId = p.site_id;
  await lockMigrationStage(siteId, OPENING_STOCK_DOMAIN, client);
  const existing = await loadGoLiveStatus(siteId, client);
  if (existing) {
    await refuse(
      new AppError(
        409,
        MIGRATION_GOLIVE_ERROR_CODES.INVALID_STATE,
        'Go-live is already unblocked for this site',
        { site_id: siteId, reason: 'already_unblocked', event_id: existing.unblocked_event_id },
      ),
      auditCtx,
      null,
    );
  }
  const gate = await evaluateGoLiveGate(siteId, client);
  if (gate.refusal) await refuse(gate.refusal, auditCtx, null);
  // The gate proved both rows exist; the payload's event ids must name THOSE rows, so a replayed
  // or hand-built event cannot cite a sign-off other than the one the gate was satisfied by.
  const head = gate.signoffs.department_head_final!;
  const finance = gate.signoffs.finance_final!;
  if (
    head.source_event_id.toLowerCase() !== p.department_head_signoff_event_id.toLowerCase() ||
    finance.source_event_id.toLowerCase() !== p.finance_signoff_event_id.toLowerCase()
  ) {
    await refuse(
      new AppError(
        409,
        MIGRATION_GOLIVE_ERROR_CODES.INVALID_STATE,
        'The sign-off event ids on the unblock do not match the recorded sign-offs',
        {
          site_id: siteId,
          reason: 'signoff_event_mismatch',
          recorded: {
            department_head_signoff_event_id: head.source_event_id,
            finance_signoff_event_id: finance.source_event_id,
          },
        },
      ),
      auditCtx,
      null,
    );
  }
  await client.query(
    `INSERT INTO migration_golive_status
       (site_id, unblocked_at, unblocked_event_id, unblocked_by_actor_id, unblocked_by_role,
        department_head_signoff_event_id, finance_signoff_event_id, business_date)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::date)`,
    [
      siteId,
      envelope.metadata.occurred_at,
      eventId,
      envelope.metadata.actor.user_id,
      envelope.metadata.actor.role,
      head.source_event_id,
      finance.source_event_id,
      p.business_date,
    ],
  );
}

// ---------------------------------------------------------------------------
// The reconciliation report (AC 1)
// ---------------------------------------------------------------------------

export interface OpeningStockDomainReport {
  domain: 'opening_stock';
  /** Opening stock reconciles quantity and value per line (Story 13.1). */
  variance_basis: 'quantity_value';
  stage: 'staging' | 'dry_run';
  source_systems: string[];
  /** Rows in the latest ERP/legacy snapshot(s) for the site. */
  source_count: number;
  /** Live imported rows (status accepted or posted). */
  migrated_count: number;
  posted_count: number;
  load_count: number;
  loaded_row_count: number;
  accepted_count: number;
  rejected_count: number;
  superseded_count: number;
  variance_count: number;
  explained_count: number;
  pending_approval_count: number;
  stale_count: number;
  open_count: number;
  unexplained_count: number;
  /** NUMERIC string: sum of abs(variance_value) over every unexplained variance. */
  unexplained_value: string;
  variances: OpeningStockVariance[];
}

export interface DocumentDomainReport extends DomainVerificationStatus {
  /**
   * Document domains have no per-line quantity or value delta today (Story 13.2 verifies presence
   * and field equality): their "variance" is the reconciliation mismatch count, not a delta.
   */
  variance_basis: 'reconciliation_mismatch_count';
  /** Findings still `open` on the latest run; null when no run exists. */
  open_finding_count: number | null;
}

export type GoLiveDomainReport = OpeningStockDomainReport | DocumentDomainReport;

export interface GoLiveDiscrepancy {
  domain: string;
  kind:
    | 'unexplained_variance'
    | 'opening_stock_not_promoted'
    | 'domain_unverified'
    | 'open_findings'
    | 'quarantined_documents';
  /** Whether the gate refuses the unblock while this discrepancy stands. */
  blocks_golive: boolean;
  count?: number;
  variance_key?: string;
  variance_kind?: string;
  status?: string;
  quantity_delta?: string;
  variance_value?: string | null;
  latest_run_id?: string | null;
  stage?: string | null;
}

export interface GoLiveReconciliationReport {
  site_id: string;
  generated_at: string;
  wave_scope: string[];
  domains: GoLiveDomainReport[];
  signoffs: GoLiveSignoffs;
  data_activity: SiteDataActivity;
  golive: { unblocked: boolean } & Partial<GoLiveStatusRecord>;
  gate: {
    satisfied: boolean;
    blocking: { error_code: string; message: string; details: Record<string, unknown> } | null;
  };
  remaining_discrepancies: GoLiveDiscrepancy[];
}

/**
 * Source-side and load-side COUNTS for opening stock. The site/snapshot selection mirrors the
 * first three CTEs of VARIANCE_SQL (same site match, latest snapshot per source system) so the
 * count describes exactly the rows the variance computation compared; no variance logic is
 * re-derived here.
 */
const OPENING_STOCK_COUNTS_SQL = `
WITH site AS (
  SELECT location_id, location_code FROM location_register WHERE location_id = $1
),
src_all AS (
  SELECT b.source_system, b.snapshot_at
  FROM erp_stock_balance b, site s
  WHERE b.site_id = s.location_id OR (b.site_id IS NULL AND b.site_code_ext = s.location_code)
),
latest AS (
  SELECT source_system, max(snapshot_at) AS snapshot_at FROM src_all GROUP BY source_system
)
SELECT
  (SELECT count(*)::int FROM src_all a
     JOIN latest l ON l.source_system = a.source_system AND l.snapshot_at = a.snapshot_at) AS source_count,
  (SELECT COALESCE(array_agg(source_system ORDER BY source_system), '{}'::text[]) FROM latest) AS source_systems,
  (SELECT count(*)::int FROM migration_opening_stock_row r
     WHERE r.site_id = $1 AND r.status IN ('accepted', 'posted')) AS migrated_count,
  (SELECT count(*)::int FROM migration_opening_stock_row r
     WHERE r.site_id = $1 AND r.status = 'posted') AS posted_count,
  (SELECT count(*)::int FROM migration_import i
     WHERE i.site_id = $1 AND i.domain = 'opening_stock') AS load_count,
  (SELECT COALESCE(sum(row_count), 0)::int FROM migration_import i
     WHERE i.site_id = $1 AND i.domain = 'opening_stock') AS loaded_row_count,
  (SELECT COALESCE(sum(accepted_count), 0)::int FROM migration_import i
     WHERE i.site_id = $1 AND i.domain = 'opening_stock') AS accepted_count,
  (SELECT COALESCE(sum(rejected_count), 0)::int FROM migration_import i
     WHERE i.site_id = $1 AND i.domain = 'opening_stock') AS rejected_count,
  (SELECT COALESCE(sum(superseded_count), 0)::int FROM migration_import i
     WHERE i.site_id = $1 AND i.domain = 'opening_stock') AS superseded_count
`;

export async function computeGoLiveReconciliationReport(
  siteId: string,
  client: PoolClient,
): Promise<GoLiveReconciliationReport> {
  const gate = await evaluateGoLiveGate(siteId, client);
  const counts = (await client.query(OPENING_STOCK_COUNTS_SQL, [siteId])).rows[0] as Record<
    string,
    unknown
  >;
  const byStatus = { open: 0, pending_approval: 0, stale: 0, explained: 0 };
  for (const v of gate.variances) byStatus[v.status] += 1;
  const totals = summariseOpeningStockVariances(gate.variances);
  const openingStock: OpeningStockDomainReport = {
    domain: 'opening_stock',
    variance_basis: 'quantity_value',
    stage: gate.opening_stock_stage ?? 'staging',
    source_systems: counts['source_systems'] as string[],
    source_count: counts['source_count'] as number,
    migrated_count: counts['migrated_count'] as number,
    posted_count: counts['posted_count'] as number,
    load_count: counts['load_count'] as number,
    loaded_row_count: counts['loaded_row_count'] as number,
    accepted_count: counts['accepted_count'] as number,
    rejected_count: counts['rejected_count'] as number,
    superseded_count: counts['superseded_count'] as number,
    variance_count: gate.variances.length,
    explained_count: byStatus.explained,
    pending_approval_count: byStatus.pending_approval,
    stale_count: byStatus.stale,
    open_count: byStatus.open,
    unexplained_count: totals.open_count,
    unexplained_value: totals.open_value,
    variances: gate.variances,
  };

  const statuses = gate.domain_statuses;
  const runIds = statuses.map((s) => s.latest_run_id).filter((id): id is string => id !== null);
  const openByRun = new Map<string, number>();
  if (runIds.length > 0) {
    const f = await client.query(
      `SELECT run_id, count(*) FILTER (WHERE status = 'open')::int AS open_count
         FROM migration_domain_verification_finding
        WHERE run_id = ANY($1::uuid[])
        GROUP BY run_id`,
      [runIds],
    );
    for (const row of f.rows as Record<string, unknown>[]) {
      openByRun.set((row['run_id'] as string).toLowerCase(), row['open_count'] as number);
    }
  }
  const documents: DocumentDomainReport[] = statuses.map((s) => ({
    ...s,
    variance_basis: 'reconciliation_mismatch_count',
    open_finding_count:
      s.latest_run_id === null ? null : (openByRun.get(s.latest_run_id.toLowerCase()) ?? 0),
  }));

  const discrepancies: GoLiveDiscrepancy[] = gate.unexplained.map((v) => ({
    domain: 'opening_stock',
    kind: 'unexplained_variance',
    blocks_golive: true,
    variance_key: v.variance_key,
    variance_kind: v.kind,
    status: v.status,
    quantity_delta: v.quantity_delta,
    variance_value: v.variance_value,
  }));
  if (gate.opening_stock_stage !== 'dry_run') {
    discrepancies.push({
      domain: 'opening_stock',
      kind: 'opening_stock_not_promoted',
      blocks_golive: true,
      stage: gate.opening_stock_stage,
    });
  }
  for (const d of documents) {
    if (d.status !== 'verified') {
      discrepancies.push({
        domain: d.domain,
        kind: 'domain_unverified',
        blocks_golive: true,
        latest_run_id: d.latest_run_id,
      });
    }
    // A verified domain may still carry quarantined documents and waived findings (Story 13.2
    // signs off with waivers); they are surfaced, and the gate leaves them to the domain sign-off.
    if ((d.quarantined_count ?? 0) > 0) {
      discrepancies.push({
        domain: d.domain,
        kind: 'quarantined_documents',
        blocks_golive: false,
        count: d.quarantined_count!,
        latest_run_id: d.latest_run_id,
      });
    }
    if ((d.open_finding_count ?? 0) > 0) {
      discrepancies.push({
        domain: d.domain,
        kind: 'open_findings',
        blocks_golive: false,
        count: d.open_finding_count!,
        latest_run_id: d.latest_run_id,
      });
    }
  }

  const status = await loadGoLiveStatus(siteId, client);
  return {
    site_id: siteId,
    generated_at: new Date().toISOString(),
    wave_scope: [...GOLIVE_WAVE_SCOPE],
    domains: [openingStock, ...documents],
    signoffs: gate.signoffs,
    data_activity: gate.data_activity,
    golive: status ? { unblocked: true, ...status } : { unblocked: false },
    gate: {
      satisfied: gate.refusal === null,
      blocking: gate.refusal
        ? {
            error_code: gate.refusal.errorCode,
            message: gate.refusal.message,
            details: gate.refusal.details ?? {},
          }
        : null,
    },
    remaining_discrepancies: discrepancies,
  };
}
