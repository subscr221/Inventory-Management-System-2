import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { assertNotRdDraft, isApprovedEcoConditionMet } from '../../compliance/bom.js';

/**
 * Release-gate checklist (Story 5.2, AC 1). Deliberate divergence from the epics dev-note
 * wording "checklist projection": this is a COMPUTED read over bom, bom_line, and item_master,
 * not a stored table - a stored checklist goes stale the moment an item master deactivates,
 * and the gate itself re-derives truth transactionally anyway. No new table, no migrate entry.
 */

export interface ReleaseGateBlockingLine {
  bom_line_id: string;
  line_no: number;
  reason: string;
}

export interface ReleaseGateCondition {
  condition: string;
  /** null when the condition is staged (not yet evaluated by this story). */
  met: boolean | null;
  enforced: boolean;
  blocking_lines: ReleaseGateBlockingLine[];
}

export interface ReleaseGateChecklist {
  bom_id: string;
  revision_id: string | null;
  status: string;
  conditions: ReleaseGateCondition[];
  ready_to_release: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChecklistLineRow {
  bom_line_id: string;
  line_no: number;
  component_sku: string;
  scrap_percent: string | null;
  item_status: string | null;
}

export async function getReleaseGateChecklist(
  bomId: string,
  client?: PoolClient,
): Promise<ReleaseGateChecklist | null> {
  if (!UUID_REGEX.test(bomId)) return null;
  const r = runner(client);

  const bomResult = await r.query(
    'SELECT bom_id, bom_type, status, current_revision_id FROM bom WHERE bom_id = $1',
    [bomId],
  );
  if (bomResult.rows.length === 0) return null;
  const bom = bomResult.rows[0] as {
    bom_id: string;
    bom_type: string;
    status: string;
    current_revision_id: string | null;
  };

  // Story 5.4 (AC 2): an R&D draft gets a 409 RD_EXECUTION_BARRED, never a checklist. The
  // Story 5.2 binding rule is that the checklist and the gate can never disagree; that rule now
  // covers the R&D bar too.
  assertNotRdDraft({ bom_id: bom.bom_id, bom_type: bom.bom_type });

  let lines: ChecklistLineRow[] = [];
  if (bom.current_revision_id) {
    // Story 5.4: component_item_id is NULL on placeholder lines. They are unreachable here (the
    // R&D bar fired above and placeholders are barred from production BOMs), but the query stays
    // NULL-safe: a placeholder row must not be reported as "item not found".
    const lineResult = await r.query(
      `SELECT bl.bom_line_id, bl.line_no, bl.component_sku, bl.scrap_percent, im.status AS item_status
       FROM bom_line bl
       LEFT JOIN item_master im ON im.item_id = bl.component_item_id
       WHERE bl.revision_id = $1 AND bl.component_item_id IS NOT NULL
       ORDER BY bl.line_no`,
      [bom.current_revision_id],
    );
    lines = lineResult.rows as ChecklistLineRow[];
  }

  const inactiveLines: ReleaseGateBlockingLine[] = [];
  const scrapMissingLines: ReleaseGateBlockingLine[] = [];
  for (const line of lines) {
    if (line.item_status !== 'active') {
      inactiveLines.push({
        bom_line_id: line.bom_line_id,
        line_no: line.line_no,
        reason:
          line.item_status === null
            ? `Component item for line ${line.line_no} not found`
            : `Component item ${line.component_sku} is ${line.item_status}`,
      });
    }
    if (line.scrap_percent === null) {
      scrapMissingLines.push({
        bom_line_id: line.bom_line_id,
        line_no: line.line_no,
        reason: 'scrap_percent is not filled',
      });
    }
  }

  // Story 5.3: approved_eco is now a computed, enforced condition using the SAME predicate as
  // the release gate itself (src/compliance/bom.ts:isApprovedEcoConditionMet) - the checklist and
  // the gate can never disagree. Only reachable when a revision exists; a BOM header with no
  // current revision has nothing to check yet and reports the condition unmet (revision required
  // before release is possible in any case).
  const approvedEcoMet = bom.current_revision_id
    ? await isApprovedEcoConditionMet(bom.bom_id, bom.current_revision_id, r)
    : false;

  const conditions: ReleaseGateCondition[] = [
    {
      condition: 'bom_lines_present',
      met: lines.length > 0,
      enforced: true,
      blocking_lines: [],
    },
    {
      condition: 'component_item_masters_released',
      met: inactiveLines.length === 0,
      enforced: true,
      blocking_lines: inactiveLines,
    },
    {
      condition: 'scrap_percent_missing',
      met: scrapMissingLines.length === 0,
      enforced: true,
      blocking_lines: scrapMissingLines,
    },
    {
      condition: 'approved_eco',
      met: approvedEcoMet,
      enforced: true,
      blocking_lines: [],
    },
    // cost_rollup_complete remains staged (D4): flipped on by Story 5.6, surfaced here so the
    // payload shape does not change when it arrives.
    { condition: 'cost_rollup_complete', met: null, enforced: false, blocking_lines: [] },
  ];

  const readyToRelease =
    bom.status === 'draft' && conditions.every((c) => !c.enforced || c.met === true);

  return {
    bom_id: bom.bom_id,
    revision_id: bom.current_revision_id,
    status: bom.status,
    conditions,
    ready_to_release: readyToRelease,
  };
}
