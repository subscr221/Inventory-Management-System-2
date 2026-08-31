import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeAdminPool, closePool, getAdminPool, getPool } from '../../src/config/db.js';
import { isRepeatDefect } from '../../src/compliance/quality.js';

/**
 * Story 8.5 (FR-Q-10, AC 4, Binding Scope Decision 12): the enterprise-wide repeat-defect
 * predicate at its boundaries. Real PostgreSQL rows in qc_ncr (the replenishment.test.ts
 * DB-backed-unit-test precedent) with the bounds passed as PARAMETERS - the Story 8.4
 * tautological-config lesson: asserting the predicate against the ambient config would pass for a
 * hard-coded rule.
 *
 * The window is the `windowDays` IST calendar days STRICTLY preceding the new NCR's business date
 * D: a predecessor exactly `windowDays` old (D-90) is OUTSIDE, one 89 days old is INSIDE, and a
 * predecessor raised on D itself is not "strictly preceding" and never counts.
 */

const run = randomUUID().slice(0, 8);
const D = '2026-06-30';
const D_MINUS_90 = '2026-04-01';
const D_MINUS_89 = '2026-04-02';

const insertedNcrIds: string[] = [];

/** IST noon of an IST calendar date, so the SQL +05:30 conversion lands on exactly that date. */
function istNoon(date: string): string {
  return `${date}T12:00:00.000+05:30`;
}

async function seedHoldNcr(sku: string, defectCode: string, businessDate: string): Promise<void> {
  const ncrId = randomUUID();
  insertedNcrIds.push(ncrId);
  await getPool().query(
    `INSERT INTO qc_ncr (ncr_id, lot_id, lot_number, site_id, sku, quantity, justification,
       raised_by, raised_at, source_event_id, origin, defect_code, capa_mandatory)
     VALUES ($1, $2, $3, $4, $5, 1, 'Story 8.5 repeat-defect fixture', $6, $7::timestamptz, $8,
             'hold', $9, false)`,
    [
      ncrId,
      randomUUID(),
      `LOT-8-5-RD-${run}-${insertedNcrIds.length}`,
      randomUUID(),
      sku,
      randomUUID(),
      istNoon(businessDate),
      randomUUID(),
      defectCode,
    ],
  );
}

describe('Story 8.5 repeat-defect window boundaries (AC 4)', () => {
  after(async () => {
    // app_user deliberately holds no DELETE on qc_ncr; fixture cleanup is an admin concern.
    if (insertedNcrIds.length > 0) {
      await getAdminPool().query(`DELETE FROM qc_ncr WHERE ncr_id = ANY($1::uuid[])`, [
        insertedNcrIds,
      ]);
    }
    await closePool();
    await closeAdminPool();
  });

  it('2 prior NCRs inside the window do not make a CAPA mandatory at threshold 3', async () => {
    const sku = `SKU-RD-A-${run}`;
    await seedHoldNcr(sku, 'DIMENSIONAL', '2026-06-29');
    await seedHoldNcr(sku, 'DIMENSIONAL', '2026-06-28');
    assert.strictEqual(await isRepeatDefect(sku, 'DIMENSIONAL', D, 3, 90), false);
  });

  it('exactly 3 prior NCRs inside the window make the next one CAPA-mandatory', async () => {
    const sku = `SKU-RD-B-${run}`;
    await seedHoldNcr(sku, 'DIMENSIONAL', '2026-06-29');
    await seedHoldNcr(sku, 'DIMENSIONAL', '2026-06-28');
    await seedHoldNcr(sku, 'DIMENSIONAL', '2026-06-27');
    assert.strictEqual(await isRepeatDefect(sku, 'DIMENSIONAL', D, 3, 90), true);
  });

  it('a third NCR exactly 90 days old is OUTSIDE the strict window', async () => {
    const sku = `SKU-RD-C-${run}`;
    await seedHoldNcr(sku, 'CONTAMINATION', '2026-06-29');
    await seedHoldNcr(sku, 'CONTAMINATION', '2026-06-28');
    await seedHoldNcr(sku, 'CONTAMINATION', D_MINUS_90);
    assert.strictEqual(await isRepeatDefect(sku, 'CONTAMINATION', D, 3, 90), false);
  });

  it('a third NCR 89 days old is INSIDE the window', async () => {
    const sku = `SKU-RD-D-${run}`;
    await seedHoldNcr(sku, 'CONTAMINATION', '2026-06-29');
    await seedHoldNcr(sku, 'CONTAMINATION', '2026-06-28');
    await seedHoldNcr(sku, 'CONTAMINATION', D_MINUS_89);
    assert.strictEqual(await isRepeatDefect(sku, 'CONTAMINATION', D, 3, 90), true);
  });

  it('same SKU with a DIFFERENT defect code never accumulates to the threshold', async () => {
    const sku = `SKU-RD-E-${run}`;
    await seedHoldNcr(sku, 'ASSEMBLY', '2026-06-29');
    await seedHoldNcr(sku, 'ASSEMBLY', '2026-06-28');
    await seedHoldNcr(sku, 'ASSEMBLY', '2026-06-27');
    assert.strictEqual(await isRepeatDefect(sku, 'FUNCTIONAL', D, 3, 90), false);
  });

  it('a predecessor raised on the SAME business date is not "strictly preceding"', async () => {
    const sku = `SKU-RD-F-${run}`;
    await seedHoldNcr(sku, 'CORROSION', D);
    assert.strictEqual(await isRepeatDefect(sku, 'CORROSION', D, 1, 90), false);
    await seedHoldNcr(sku, 'CORROSION', '2026-06-29');
    assert.strictEqual(await isRepeatDefect(sku, 'CORROSION', D, 1, 90), true);
  });
});
