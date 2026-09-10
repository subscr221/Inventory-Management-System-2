import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import type { EventEnvelope } from '../events/store.js';
import { logRejectionAudit, type AuditEntryPayload } from '../read/projections/audit_log.js';
import type {
  MigrationDocumentManifestLoadedPayload,
  MigrationDomainFinding,
  MigrationDomainVerificationRunPayload,
  MigrationDomainVerifiedPayload,
  MigrationFindingWaiver,
} from '../events/schema.js';
import { isDocumentDomain, MIGRATION_DOCUMENT_DOMAINS } from '../migration/document-templates.js';
import { lockMigrationStage } from './migration-opening-stock.js';

/**
 * Story 13.2 (FR-DM-02): write-path rules for the document-domain verification events.
 *
 * - `assertMigrationDocumentEventShape` is PURE and is reached from `assertMigrationEventShape`
 *   (one seam entry point, dispatching by type), so a malformed event never consumes an
 *   idempotency key.
 * - `applyMigrationDocumentProjection` is reached from `applyMigrationProjection`'s switch inside
 *   persistEvent's transaction. The sign-off gate (VERIFICATION_STALE / VERIFICATION_UNRESOLVED)
 *   and the SOD-07 identity check (SIGNOFF_ACTOR_CONFLICT) live HERE as well as in the route, and
 *   every refusal self-audits through auditCtx (the Story 11.2 applier-self-audit pattern).
 *
 * This module imports nothing that imports store.ts (the Story 13.1 ESM-cycle lesson).
 */

export const MIGRATION_DOCUMENT_EVENT_TYPES = [
  'migration.document_manifest.loaded',
  'migration.domain.verification_run',
  'migration.domain.verified',
] as const;

export const MIGRATION_DOCUMENT_ERROR_CODES = {
  MANIFEST_REQUIRED: 'MANIFEST_REQUIRED',
  VERIFICATION_STALE: 'VERIFICATION_STALE',
  VERIFICATION_UNRESOLVED: 'VERIFICATION_UNRESOLVED',
  SIGNOFF_ACTOR_CONFLICT: 'SIGNOFF_ACTOR_CONFLICT',
  DOMAIN_UNSUPPORTED: 'DOMAIN_UNSUPPORTED',
} as const;

export const MAX_EVENT_ARRAY_ENTRIES = 10_000;
export const MAX_WAIVER_NARRATIVE_CHARS = 2_000;

const FINDING_KINDS = new Set([
  'unknown_reference',
  'missing_in_platform',
  'missing_in_source',
  'field_mismatch',
  'state_mismatch',
]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;

type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_REGEX.test(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
function shapeError(eventType: string, message: string, details: Record<string, unknown> = {}) {
  return new AppError(400, 'INVALID_PARAMS', message, { event_type: eventType, ...details });
}

export function domainUnsupportedError(domain: unknown): AppError {
  return new AppError(
    400,
    MIGRATION_DOCUMENT_ERROR_CODES.DOMAIN_UNSUPPORTED,
    `domain must be one of ${MIGRATION_DOCUMENT_DOMAINS.join(', ')}`,
    { domain: domain ?? null, supported: [...MIGRATION_DOCUMENT_DOMAINS] },
  );
}

// ---------------------------------------------------------------------------
// Pre-transaction shape assert (pure)
// ---------------------------------------------------------------------------

export function assertMigrationDocumentEventShape(envelope: EventEnvelope): void {
  const type = envelope.event_type;
  const p = envelope.payload as Record<string, unknown>;
  if (!isDocumentDomain(p['domain'])) throw domainUnsupportedError(p['domain']);
  if ((p['site_id'] as string).toLowerCase() !== envelope.stream_id.toLowerCase()) {
    throw shapeError(type, 'site_id must equal the stream_id');
  }

  if (type === 'migration.document_manifest.loaded') {
    const q = p as Partial<MigrationDocumentManifestLoadedPayload>;
    if (!isUuid(q.load_id)) throw shapeError(type, 'load_id must be a UUID');
    if (!isNonEmptyString(q.template_version))
      throw shapeError(type, 'template_version is required');
    if (!SHA256_REGEX.test(String(q.file_sha256)))
      throw shapeError(type, 'file_sha256 must be a SHA-256 hex');
    if (!Array.isArray(q.rows) || q.rows.length === 0 || q.rows.length > MAX_EVENT_ARRAY_ENTRIES) {
      throw shapeError(type, `rows must carry 1 to ${MAX_EVENT_ARRAY_ENTRIES} entries`);
    }
    const seen = new Set<string>();
    for (const row of q.rows) {
      if (!Number.isInteger(row.line_no) || row.line_no < 1)
        throw shapeError(type, 'row line_no must be a positive integer');
      if (!isNonEmptyString(row.document_ref_ext))
        throw shapeError(type, 'row document_ref_ext is required', { line_no: row.line_no });
      if (!isNonEmptyString(row.line_ref))
        throw shapeError(type, 'row line_ref is required', { line_no: row.line_no });
      if (row.quantity !== null && !NUMERIC_REGEX.test(String(row.quantity))) {
        throw shapeError(type, 'row quantity must be a NUMERIC string or null', {
          line_no: row.line_no,
        });
      }
      if (!SHA256_REGEX.test(String(row.content_hash)))
        throw shapeError(type, 'row content_hash must be a SHA-256 hex', { line_no: row.line_no });
      if (!row.attributes || typeof row.attributes !== 'object' || Array.isArray(row.attributes)) {
        throw shapeError(type, 'row attributes must be an object', { line_no: row.line_no });
      }
      const key = `${row.document_ref_ext}${row.line_ref}`;
      if (seen.has(key))
        throw shapeError(type, 'duplicate manifest key in rows', { line_no: row.line_no });
      seen.add(key);
    }
    return;
  }

  if (type === 'migration.domain.verification_run') {
    const q = p as Partial<MigrationDomainVerificationRunPayload>;
    if (!isUuid(q.run_id)) throw shapeError(type, 'run_id must be a UUID');
    if (!isUuid(q.load_id)) throw shapeError(type, 'load_id must be a UUID');
    for (const c of [
      'source_count',
      'migrated_count',
      'quarantined_count',
      'mismatch_count',
    ] as const) {
      if (!Number.isInteger(q[c]) || (q[c] as number) < 0)
        throw shapeError(type, `${c} must be a non-negative integer`);
    }
    if (!SHA256_REGEX.test(String(q.findings_sha256)))
      throw shapeError(type, 'findings_sha256 must be a SHA-256 hex');
    if (!Array.isArray(q.findings) || q.findings.length > MAX_EVENT_ARRAY_ENTRIES) {
      throw shapeError(type, `findings must carry at most ${MAX_EVENT_ARRAY_ENTRIES} entries`);
    }
    for (const f of q.findings as Partial<MigrationDomainFinding>[]) {
      if (!isUuid(f.finding_id)) throw shapeError(type, 'finding_id must be a UUID');
      if (!FINDING_KINDS.has(String(f.kind)))
        throw shapeError(type, 'finding kind is not supported', { kind: f.kind });
      const expectedCode =
        f.kind === 'unknown_reference' ? 'UNKNOWN_REFERENCE' : 'RECONCILIATION_MISMATCH';
      if (f.error_code !== expectedCode)
        throw shapeError(type, 'finding error_code does not match its kind', { kind: f.kind });
      if (!isNonEmptyString(f.document_ref_ext) || !isNonEmptyString(f.line_ref)) {
        throw shapeError(type, 'finding document_ref_ext and line_ref are required');
      }
      if (!f.details || typeof f.details !== 'object')
        throw shapeError(type, 'finding details must be an object');
    }
    return;
  }

  if (type === 'migration.domain.verified') {
    const q = p as Partial<MigrationDomainVerifiedPayload>;
    if (!isUuid(q.run_id)) throw shapeError(type, 'run_id must be a UUID');
    if (!isUuid(q.signed_off_by_actor_id))
      throw shapeError(type, 'signed_off_by_actor_id must be a UUID');
    if (!isNonEmptyString(q.signed_off_role)) throw shapeError(type, 'signed_off_role is required');
    if (!Array.isArray(q.waivers) || q.waivers.length > MAX_EVENT_ARRAY_ENTRIES) {
      throw shapeError(type, `waivers must carry at most ${MAX_EVENT_ARRAY_ENTRIES} entries`);
    }
    const seen = new Set<string>();
    for (const w of q.waivers as Partial<MigrationFindingWaiver>[]) {
      if (!isUuid(w.finding_id)) throw shapeError(type, 'waiver finding_id must be a UUID');
      if (!isNonEmptyString(w.narrative) || w.narrative.length > MAX_WAIVER_NARRATIVE_CHARS) {
        throw shapeError(
          type,
          `waiver narrative must be 1 to ${MAX_WAIVER_NARRATIVE_CHARS} characters`,
          { finding_id: w.finding_id },
        );
      }
      const id = w.finding_id.toLowerCase();
      if (seen.has(id)) throw shapeError(type, 'duplicate waiver finding_id', { finding_id: id });
      seen.add(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Appliers
// ---------------------------------------------------------------------------

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
      details: err.details,
    });
  }
  throw err;
}

export async function applyMigrationDocumentProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: AuditCtx,
): Promise<void> {
  switch (envelope.event_type) {
    case 'migration.document_manifest.loaded':
      await applyManifestLoaded(envelope, client, eventId);
      return;
    case 'migration.domain.verification_run':
      await applyVerificationRun(envelope, client, eventId, auditCtx);
      return;
    case 'migration.domain.verified':
      await applyDomainVerified(envelope, client, eventId, auditCtx);
      return;
    default:
      return;
  }
}

async function applyManifestLoaded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationDocumentManifestLoadedPayload;
  await lockMigrationStage(p.site_id, p.domain, client);
  const occurredAt = envelope.metadata.occurred_at;
  for (const row of p.rows) {
    await client.query(
      `INSERT INTO migration_document_manifest_row
         (row_id, load_id, site_id, domain, line_no, document_ref_ext, line_ref, sku, quantity,
          attributes, content_hash, source_event_id, occurred_at, business_date)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::jsonb, $10, $11, $12::timestamptz, $13::date)`,
      [
        p.load_id,
        p.site_id,
        p.domain,
        row.line_no,
        row.document_ref_ext,
        row.line_ref,
        row.sku,
        row.quantity,
        JSON.stringify(row.attributes),
        row.content_hash,
        eventId,
        occurredAt,
        p.business_date,
      ],
    );
  }
  await client.query(
    `UPDATE migration_stage SET latest_load_id = $3, updated_at = now() WHERE site_id = $1 AND domain = $2`,
    [p.site_id, p.domain, p.load_id],
  );
}

async function applyVerificationRun(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx: AuditCtx | undefined,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationDomainVerificationRunPayload;
  await lockMigrationStage(p.site_id, p.domain, client);
  const stage = await client.query(
    `SELECT latest_load_id FROM migration_stage WHERE site_id = $1 AND domain = $2`,
    [p.site_id, p.domain],
  );
  const latestLoadId = (stage.rows[0]?.['latest_load_id'] as string | null) ?? null;
  if (latestLoadId === null) {
    await refuse(manifestRequiredError(p.site_id, p.domain), auditCtx, null);
  }
  if (latestLoadId!.toLowerCase() !== p.load_id.toLowerCase()) {
    await refuse(
      new AppError(
        409,
        MIGRATION_DOCUMENT_ERROR_CODES.VERIFICATION_STALE,
        'The verification run names a manifest load that is no longer the latest for this domain',
        { site_id: p.site_id, domain: p.domain, load_id: p.load_id, latest_load_id: latestLoadId },
      ),
      auditCtx,
      null,
    );
  }
  await client.query(
    `INSERT INTO migration_domain_verification
       (run_id, site_id, domain, load_id, source_count, migrated_count, quarantined_count,
        mismatch_count, waived_count, run_by_actor_id, findings_sha256, source_event_id,
        occurred_at, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12::timestamptz, $13::date)`,
    [
      p.run_id,
      p.site_id,
      p.domain,
      p.load_id,
      p.source_count,
      p.migrated_count,
      p.quarantined_count,
      p.mismatch_count,
      envelope.metadata.actor.user_id,
      p.findings_sha256,
      eventId,
      envelope.metadata.occurred_at,
      p.business_date,
    ],
  );
  for (const f of p.findings) {
    await client.query(
      `INSERT INTO migration_domain_verification_finding
         (finding_id, run_id, site_id, domain, kind, error_code, document_ref_ext, line_ref,
          platform_ref, field, source_value, platform_value, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'open')`,
      [
        f.finding_id,
        p.run_id,
        p.site_id,
        p.domain,
        f.kind,
        f.error_code,
        f.document_ref_ext,
        f.line_ref,
        f.platform_ref,
        f.field,
        f.source_value,
        f.platform_value,
        JSON.stringify(f.details),
      ],
    );
  }
  await client.query(
    `UPDATE migration_stage SET latest_run_id = $3, updated_at = now() WHERE site_id = $1 AND domain = $2`,
    [p.site_id, p.domain, p.run_id],
  );
}

export function manifestRequiredError(siteId: string, domain: string): AppError {
  return new AppError(
    409,
    MIGRATION_DOCUMENT_ERROR_CODES.MANIFEST_REQUIRED,
    'No manifest has been loaded for this domain; import one before running verification',
    { site_id: siteId, domain },
  );
}

interface RunRow {
  run_id: string;
  site_id: string;
  domain: string;
  load_id: string;
  quarantined_count: number;
  run_by_actor_id: string;
  loader_actor_id: string | null;
  latest_load_id: string | null;
  latest_run_id: string | null;
}

interface OpenFinding {
  finding_id: string;
  kind: string;
  document_ref_ext: string;
  line_ref: string;
  field: string | null;
  details: Record<string, unknown>;
}

/**
 * The sign-off gate, shared by the route (pre-check) and the applier (under the stage lock).
 * Returns the refusal instead of throwing so the applier can self-audit it.
 */
export async function assertDomainSignoffAllowed(
  siteId: string,
  domain: string,
  runId: string,
  waivers: readonly MigrationFindingWaiver[],
  signerActorId: string,
  client: Pick<PoolClient, 'query'>,
): Promise<AppError | null> {
  const r = await client.query(
    `SELECT v.run_id, v.site_id, v.domain, v.load_id, v.quarantined_count, v.run_by_actor_id,
            i.created_by_actor_id AS loader_actor_id, s.latest_load_id, s.latest_run_id
       FROM migration_domain_verification v
       LEFT JOIN migration_import i ON i.load_id = v.load_id
       LEFT JOIN migration_stage s ON s.site_id = v.site_id AND s.domain = v.domain
      WHERE v.run_id = $1`,
    [runId],
  );
  const run = r.rows[0] as RunRow | undefined;
  if (!run || run.site_id !== siteId || run.domain !== domain) {
    return new AppError(
      404,
      'NOT_FOUND',
      `Verification run "${runId}" not found for this site and domain`,
      {
        run_id: runId,
        site_id: siteId,
        domain,
      },
    );
  }
  if (run.latest_run_id !== run.run_id || run.latest_load_id !== run.load_id) {
    return new AppError(
      409,
      MIGRATION_DOCUMENT_ERROR_CODES.VERIFICATION_STALE,
      'Only the latest verification run of the latest manifest load can be signed off',
      {
        run_id: runId,
        latest_run_id: run.latest_run_id,
        load_id: run.load_id,
        latest_load_id: run.latest_load_id,
      },
    );
  }
  const signer = signerActorId.toLowerCase();
  if (signer === run.run_by_actor_id.toLowerCase()) {
    return new AppError(
      403,
      MIGRATION_DOCUMENT_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT,
      'The actor who ran the verification cannot sign it off (SOD-07)',
      { run_id: runId, conflicting_role: 'verification_runner' },
    );
  }
  if (run.loader_actor_id && signer === run.loader_actor_id.toLowerCase()) {
    return new AppError(
      403,
      MIGRATION_DOCUMENT_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT,
      'The actor who loaded the manifest cannot sign it off (SOD-07)',
      { run_id: runId, conflicting_role: 'manifest_loader' },
    );
  }
  const f = await client.query(
    `SELECT finding_id, kind, document_ref_ext, line_ref, field, details
       FROM migration_domain_verification_finding
      WHERE run_id = $1 AND status = 'open'
      ORDER BY kind, document_ref_ext, line_ref, field`,
    [runId],
  );
  const open = f.rows as OpenFinding[];
  const byId = new Map(open.map((x) => [x.finding_id.toLowerCase(), x]));
  const waived = new Set<string>();
  for (const w of waivers) {
    const id = w.finding_id.toLowerCase();
    const target = byId.get(id);
    if (!target) {
      return new AppError(
        400,
        'INVALID_PARAMS',
        'A waiver names a finding that is not open on this run',
        {
          finding_id: w.finding_id,
          run_id: runId,
        },
      );
    }
    if (target.kind === 'unknown_reference') {
      return new AppError(
        400,
        'INVALID_PARAMS',
        'A quarantined (UNKNOWN_REFERENCE) finding cannot be waived',
        {
          finding_id: w.finding_id,
        },
      );
    }
    waived.add(id);
  }
  const quarantined = open.filter((x) => x.kind === 'unknown_reference');
  if (quarantined.length > 0) {
    return new AppError(
      409,
      MIGRATION_DOCUMENT_ERROR_CODES.VERIFICATION_UNRESOLVED,
      'Quarantined documents remain on this run; fix the references at source and re-run',
      {
        run_id: runId,
        quarantined: quarantined.map((x) => ({
          finding_id: x.finding_id,
          document_ref_ext: x.document_ref_ext,
          line_ref: x.line_ref,
          details: x.details,
        })),
      },
    );
  }
  const unwaived = open.filter((x) => !waived.has(x.finding_id.toLowerCase()));
  if (unwaived.length > 0) {
    return new AppError(
      409,
      MIGRATION_DOCUMENT_ERROR_CODES.VERIFICATION_UNRESOLVED,
      'Every open finding must be waived with a narrative before the domain is signed off',
      {
        run_id: runId,
        unwaived: unwaived.map((x) => ({
          finding_id: x.finding_id,
          kind: x.kind,
          document_ref_ext: x.document_ref_ext,
          line_ref: x.line_ref,
          field: x.field,
        })),
      },
    );
  }
  return null;
}

async function applyDomainVerified(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx: AuditCtx | undefined,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationDomainVerifiedPayload;
  await lockMigrationStage(p.site_id, p.domain, client);
  const refusal = await assertDomainSignoffAllowed(
    p.site_id,
    p.domain,
    p.run_id,
    p.waivers,
    p.signed_off_by_actor_id,
    client,
  );
  if (refusal) await refuse(refusal, auditCtx, null);
  for (const w of p.waivers) {
    await client.query(
      `UPDATE migration_domain_verification_finding
          SET status = 'waived', waiver_narrative = $2, waived_event_id = $3
        WHERE finding_id = $1 AND run_id = $4`,
      [w.finding_id, w.narrative, eventId, p.run_id],
    );
  }
  await client.query(
    `UPDATE migration_domain_verification SET waived_count = $2 WHERE run_id = $1`,
    [p.run_id, p.waivers.length],
  );
  await client.query(
    `UPDATE migration_stage
        SET verified_run_id = $3, verified_at = $4::timestamptz, verified_event_id = $5,
            verified_by_actor_id = $6, updated_at = now()
      WHERE site_id = $1 AND domain = $2`,
    [
      p.site_id,
      p.domain,
      p.run_id,
      envelope.metadata.occurred_at,
      eventId,
      p.signed_off_by_actor_id,
    ],
  );
}
