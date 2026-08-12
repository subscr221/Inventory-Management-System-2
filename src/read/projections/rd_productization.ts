import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';

/**
 * R&D productization gate accessors (Story 5.4, FR-B-11). Follows the
 * release_gate_checklist.ts precedent exactly: getProductizationChecklist is a COMPUTED read over
 * bom, bom_line, and rd_productization_signoff - no stored checklist table and no migrate.ts
 * entry, because a stored checklist goes stale the moment a sign-off is replaced or a placeholder
 * is added. evaluateProductizationGate is the SINGLE predicate shared by the checklist and the
 * rd_draft.productized applier (src/compliance/rd-bom.ts) so the two can never disagree - the
 * same rule that binds isApprovedEcoConditionMet to the release gate.
 */

export const RD_GATE_FUNCTIONS = ['engineering', 'procurement', 'qc'] as const;
export type RdGateFunction = (typeof RD_GATE_FUNCTIONS)[number];

export interface RdSignoffRow {
  signoff_id: string;
  bom_id: string;
  gate_function: RdGateFunction;
  signed_by: string;
  signed_at: string;
  approver_actor_id: string;
  doa_entry_id: string | null;
  notes: string | null;
  source_event_id: string;
  created_at: string;
}

export interface ProductizationChecklistSignoff {
  gate_function: RdGateFunction;
  signed: boolean;
  signed_by: string | null;
  signed_at: string | null;
  approver_actor_id: string | null;
}

export interface ProductizationChecklist {
  bom_id: string;
  bom_type: string;
  eligible: boolean;
  signoffs: ProductizationChecklistSignoff[];
  missing_signoffs: string[];
  placeholder_line_nos: number[];
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSignoffs(bomId: string, client?: PoolClient): Promise<RdSignoffRow[]> {
  if (!UUID_REGEX.test(bomId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM rd_productization_signoff WHERE bom_id = $1 ORDER BY gate_function ASC`,
    [bomId],
  );
  return result.rows as RdSignoffRow[];
}

export async function upsertSignoff(
  row: Omit<RdSignoffRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  // A re-sign REPLACES the row (uq_rd_signoff_function), mirroring the Story 5.3 disposition
  // upsert - the gate has exactly one live sign-off per function.
  await client.query(
    `INSERT INTO rd_productization_signoff (signoff_id, bom_id, gate_function, signed_by, signed_at, approver_actor_id, doa_entry_id, notes, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (bom_id, gate_function) DO UPDATE SET
       signoff_id = EXCLUDED.signoff_id,
       signed_by = EXCLUDED.signed_by,
       signed_at = EXCLUDED.signed_at,
       approver_actor_id = EXCLUDED.approver_actor_id,
       doa_entry_id = EXCLUDED.doa_entry_id,
       notes = EXCLUDED.notes,
       source_event_id = EXCLUDED.source_event_id`,
    [
      row.signoff_id,
      row.bom_id,
      row.gate_function,
      row.signed_by,
      row.signed_at,
      row.approver_actor_id,
      row.doa_entry_id,
      row.notes,
      row.source_event_id,
    ],
  );
}

/**
 * The shared gate predicate: which sign-offs are missing and which current-revision lines are
 * still placeholders. Callers pass the transaction client when evaluating inside the
 * rd_draft.productized applier so the derivation is transactional.
 */
export async function evaluateProductizationGate(
  bomId: string,
  currentRevisionId: string | null,
  client?: PoolClient,
): Promise<{ missingSignoffs: string[]; placeholderLineNos: number[] }> {
  const r = runner(client);

  const signoffResult = await r.query(
    `SELECT gate_function FROM rd_productization_signoff WHERE bom_id = $1`,
    [bomId],
  );
  const signed = new Set(signoffResult.rows.map((row) => row.gate_function as string));
  const missingSignoffs = RD_GATE_FUNCTIONS.filter((fn) => !signed.has(fn));

  let placeholderLineNos: number[] = [];
  if (currentRevisionId) {
    const placeholderResult = await r.query(
      `SELECT line_no FROM bom_line WHERE revision_id = $1 AND is_placeholder = true ORDER BY line_no`,
      [currentRevisionId],
    );
    placeholderLineNos = placeholderResult.rows.map((row) => Number(row.line_no));
  }

  return { missingSignoffs: [...missingSignoffs], placeholderLineNos };
}

export async function getProductizationChecklist(
  bomId: string,
  client?: PoolClient,
): Promise<ProductizationChecklist | null> {
  if (!UUID_REGEX.test(bomId)) return null;
  const r = runner(client);

  const bomResult = await r.query(
    'SELECT bom_id, bom_type, current_revision_id FROM bom WHERE bom_id = $1',
    [bomId],
  );
  if (bomResult.rows.length === 0) return null;
  const bom = bomResult.rows[0] as {
    bom_id: string;
    bom_type: string;
    current_revision_id: string | null;
  };

  // The productization regime belongs to R&D drafts only: every mutation on this surface rejects
  // bom_type <> 'rnd' (RD_BUILD_NOT_PERMITTED), so the checklist must agree - the checklist and
  // the gate can never disagree (Story 5.2 binding rule, extended to the regime bar in Story 5.4).
  if (bom.bom_type !== 'rnd') {
    throw new AppError(
      409,
      'RD_BUILD_NOT_PERMITTED',
      'The productization gate belongs to the R&D draft regime only',
      { bom_id: bom.bom_id, bom_type: bom.bom_type },
    );
  }

  const signoffRows = await getSignoffs(bomId, client);
  const byFunction = new Map(signoffRows.map((row) => [row.gate_function, row]));

  const gate = await evaluateProductizationGate(bomId, bom.current_revision_id, client);

  // All three gate functions are ALWAYS present; unsigned ones carry signed: false and nulls.
  const signoffs: ProductizationChecklistSignoff[] = RD_GATE_FUNCTIONS.map((fn) => {
    const row = byFunction.get(fn);
    return {
      gate_function: fn,
      signed: row !== undefined,
      signed_by: row?.signed_by ?? null,
      signed_at: row?.signed_at ?? null,
      approver_actor_id: row?.approver_actor_id ?? null,
    };
  });

  return {
    bom_id: bom.bom_id,
    bom_type: bom.bom_type,
    eligible: gate.missingSignoffs.length === 0 && gate.placeholderLineNos.length === 0,
    signoffs,
    missing_signoffs: gate.missingSignoffs,
    placeholder_line_nos: gate.placeholderLineNos,
  };
}
