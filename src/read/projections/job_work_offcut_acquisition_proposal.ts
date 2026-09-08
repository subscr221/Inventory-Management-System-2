import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.8 (extends Story 9.7 AC 7): the persisted acquisition PROPOSAL. An above-band offcut
 * acquisition is proposed here by the finance controller and executes nothing; the disposal effects
 * run only when the RESOLVED approver approves through their own authenticated request.
 *
 * `resolved_approver_actor_id` is frozen at propose time and NEVER re-resolved - see the header of
 * read/projections/job_work_offcut_acquisition_proposal.sql for why.
 *
 * Money is NUMERIC(18,4) text, never floated by a caller.
 *
 * Story 9.9 extends the SAME table to the above-band REVALUATION signature, discriminated by
 * `kind`. A revaluation proposal also freezes `supersedes_credit_note_id` - the document its delta
 * will chain off - because a below-band revaluation needs no signature and can land between propose
 * and approve (AC 5). See the .sql header for why this is one table and not two.
 */

export type JobWorkOffcutAcquisitionProposalStatus = 'pending' | 'approved' | 'superseded';
/** Story 9.9: which signature this row carries. Rows written before Story 9.9 are 'acquisition'. */
export type JobWorkOffcutProposalKind = 'acquisition' | 'revaluation';

export interface JobWorkOffcutAcquisitionProposalRow {
  proposal_id: string;
  service_order_id: string;
  holding_id: string;
  site_id: string;
  rate: string;
  currency: string;
  /** The offcut contract's indicative rate copied off the order, so the variance stays visible. */
  indicative_rate: string | null;
  /** quantity x rate at the money scale, as it stood when the band was matched. */
  proposed_value: string;
  doa_entry_id: string;
  kind: JobWorkOffcutProposalKind;
  /**
   * Story 9.9 (AC 5): the credit note this revaluation was priced against, frozen at propose time.
   * NULL on an acquisition proposal, which supersedes nothing.
   */
  supersedes_credit_note_id: string | null;
  /** Who resolveApprover named at PROPOSE time. The approve action compares the caller against it. */
  resolved_approver_actor_id: string;
  proposed_by: string;
  status: JobWorkOffcutAcquisitionProposalStatus;
  decided_at: string | null;
  decided_by: string | null;
  /** The `jobwork.offcut_acquisition_approved` event that executed the disposal. */
  disposal_event_id: string | null;
  /** Story 9.9: the `jobwork.offcut_revaluation_approved` event that raised the delta. */
  revaluation_event_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertOffcutAcquisitionProposalInput {
  proposal_id: string;
  service_order_id: string;
  holding_id: string;
  site_id: string;
  rate: string;
  currency: string;
  indicative_rate: string | null;
  proposed_value: string;
  doa_entry_id: string;
  resolved_approver_actor_id: string;
  proposed_by: string;
  source_event_id: string;
  /** Story 9.9. Omitted means 'acquisition', so the Story 9.8 call site is unchanged. */
  kind?: JobWorkOffcutProposalKind;
  /** Story 9.9: required on a revaluation proposal, refused by the schema on an acquisition. */
  supersedes_credit_note_id?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = `proposal_id, service_order_id, holding_id, site_id, rate::text AS rate,
  currency, indicative_rate::text AS indicative_rate, proposed_value::text AS proposed_value,
  doa_entry_id, kind, supersedes_credit_note_id, resolved_approver_actor_id, proposed_by, status,
  decided_at, decided_by, disposal_event_id, revaluation_event_id, source_event_id, created_at,
  updated_at`;

const toIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function mapRow(row: Record<string, unknown>): JobWorkOffcutAcquisitionProposalRow {
  return {
    ...(row as unknown as JobWorkOffcutAcquisitionProposalRow),
    decided_at: toIso(row['decided_at']),
    created_at: toIso(row['created_at']) as string,
    updated_at: toIso(row['updated_at']) as string,
  };
}

/**
 * Plain INSERT: a duplicate proposal id, a duplicate source event or a SECOND PENDING proposal for
 * the same holding all surface as 23505 for the seam to classify (the partial unique index is the
 * AC 4 refusal).
 */
export async function insertOffcutAcquisitionProposal(
  input: InsertOffcutAcquisitionProposalInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO job_work_offcut_acquisition_proposal (
       proposal_id, service_order_id, holding_id, site_id, rate, currency, indicative_rate,
       proposed_value, doa_entry_id, resolved_approver_actor_id, proposed_by, status,
       source_event_id, kind, supersedes_credit_note_id
     ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::numeric, $8::numeric, $9, $10, $11, 'pending',
               $12, $13, $14)`,
    [
      input.proposal_id,
      input.service_order_id,
      input.holding_id,
      input.site_id,
      input.rate,
      input.currency,
      input.indicative_rate,
      input.proposed_value,
      input.doa_entry_id,
      input.resolved_approver_actor_id,
      input.proposed_by,
      input.source_event_id,
      input.kind ?? 'acquisition',
      input.supersedes_credit_note_id ?? null,
    ],
  );
}

/** A malformed id is "not found", not a 22P02 500 (the getCreditNoteById precedent). */
export async function getOffcutAcquisitionProposalById(
  proposalId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<JobWorkOffcutAcquisitionProposalRow | null> {
  if (!UUID_REGEX.test(proposalId)) return null;
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_acquisition_proposal
      WHERE proposal_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [proposalId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/** Every proposal for an order, oldest first - the AC 7 read surface. */
export async function listOffcutAcquisitionProposalsByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<JobWorkOffcutAcquisitionProposalRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_acquisition_proposal
      WHERE service_order_id = $1 ORDER BY created_at ASC, proposal_id ASC`,
    [serviceOrderId],
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}

/** The single pending proposal on a holding, if one is awaiting signature (AC 7, AC 8). */
export async function getPendingProposalForHolding(
  holdingId: string,
  client?: PoolClient,
): Promise<JobWorkOffcutAcquisitionProposalRow | null> {
  if (!UUID_REGEX.test(holdingId)) return null;
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_acquisition_proposal
      WHERE holding_id = $1 AND status = 'pending'`,
    [holdingId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/** Guarded flip: matches only while the proposal is still pending, so a concurrent approve loses. */
export async function markOffcutAcquisitionProposalApproved(
  proposalId: string,
  decision: { decided_at: string; decided_by: string; disposal_event_id: string },
  client: PoolClient,
): Promise<boolean> {
  if (!UUID_REGEX.test(proposalId)) return false;
  const result = await client.query(
    `UPDATE job_work_offcut_acquisition_proposal
        SET status = 'approved', decided_at = $2::timestamptz, decided_by = $3::uuid,
            disposal_event_id = $4::uuid, updated_at = now()
      WHERE proposal_id = $1 AND status = 'pending' AND kind = 'acquisition'`,
    [proposalId, decision.decided_at, decision.decided_by, decision.disposal_event_id],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Story 9.9: the revaluation twin. Separate from the acquisition flip rather than parameterised on
 * a column name, so neither can ever write the other kind's event id - the lifecycle CHECK requires
 * EXACTLY ONE of the two, matching `kind`, and a shared writer would turn that into a 23514 500.
 * The `kind` predicate is part of the guard for the same reason.
 */
export async function markOffcutRevaluationProposalApproved(
  proposalId: string,
  decision: { decided_at: string; decided_by: string; revaluation_event_id: string },
  client: PoolClient,
): Promise<boolean> {
  if (!UUID_REGEX.test(proposalId)) return false;
  const result = await client.query(
    `UPDATE job_work_offcut_acquisition_proposal
        SET status = 'approved', decided_at = $2::timestamptz, decided_by = $3::uuid,
            revaluation_event_id = $4::uuid, updated_at = now()
      WHERE proposal_id = $1 AND status = 'pending' AND kind = 'revaluation'`,
    [proposalId, decision.decided_at, decision.decided_by, decision.revaluation_event_id],
  );
  return (result.rowCount ?? 0) === 1;
}
