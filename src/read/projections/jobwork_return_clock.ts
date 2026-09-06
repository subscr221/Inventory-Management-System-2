import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.5 (FR-AC-11, FR-JW-14): the CGST Section 143 return clock, one row per Story 9.2
 * customer-material receipt. Two counters (reconciled_qty back to the principal, loss_qty accounted
 * waste under Section 143(5)), a statutory status lifecycle, the deemed-supply record frozen at
 * breach time, and the two alert-stage stamps the sweep reads. Every quantity is a NUMERIC(18,3)
 * string; every DATE is selected as text (the 9.1 DATE-vs-timezone gotcha).
 */

export type ChallanClass = 'input' | 'capital_goods';
export type ReturnClockStatus = 'open' | 'partially_reconciled' | 'reconciled' | 'breached';

export interface JobworkReturnClockRow {
  clock_id: string;
  receipt_id: string;
  service_order_id: string;
  sku: string;
  challan_qty: string;
  reconciled_qty: string;
  loss_qty: string;
  challan_class: ChallanClass;
  challan_date: string;
  expiry_date: string;
  status: ReturnClockStatus;
  deemed_supply_qty: string;
  deemed_supply_recorded_at: string | null;
  alert_90_sent_at: string | null;
  alert_30_sent_at: string | null;
  site_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = `clock_id, receipt_id, service_order_id, sku, challan_qty::text AS challan_qty,
  reconciled_qty::text AS reconciled_qty, loss_qty::text AS loss_qty, challan_class,
  to_char(challan_date, 'YYYY-MM-DD') AS challan_date, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
  status, deemed_supply_qty::text AS deemed_supply_qty, deemed_supply_recorded_at, alert_90_sent_at,
  alert_30_sent_at, site_id, created_at, updated_at`;

const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function mapRow(row: Record<string, unknown>): JobworkReturnClockRow {
  return {
    ...(row as unknown as JobworkReturnClockRow),
    deemed_supply_recorded_at: toIsoOrNull(row['deemed_supply_recorded_at']),
    alert_90_sent_at: toIsoOrNull(row['alert_90_sent_at']),
    alert_30_sent_at: toIsoOrNull(row['alert_30_sent_at']),
    created_at: toIsoOrNull(row['created_at']) as string,
    updated_at: toIsoOrNull(row['updated_at']) as string,
  };
}

export interface InsertJobworkReturnClockInput {
  clock_id: string;
  receipt_id: string;
  service_order_id: string;
  sku: string;
  challan_qty: string;
  challan_class: ChallanClass;
  challan_date: string;
  /** Calendar days from challan_date to expiry (365 inputs / 1095 capital goods), added IN SQL. */
  clock_days: number;
  site_id: string;
}

/**
 * Plain INSERT; a duplicate receipt_id surfaces as 23505 (uq_jobwork_return_clock_receipt) for the
 * seam to classify. expiry_date is challan_date + clock_days computed by PostgreSQL DATE
 * arithmetic, never by a JS Date across DST/timezone.
 */
export async function insertJobworkReturnClock(
  input: InsertJobworkReturnClockInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO jobwork_return_clock (
       clock_id, receipt_id, service_order_id, sku, challan_qty, challan_class, challan_date,
       expiry_date, site_id
     ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::date, ($7::date + make_interval(days => $8::int))::date, $9)`,
    [
      input.clock_id,
      input.receipt_id,
      input.service_order_id,
      input.sku,
      input.challan_qty,
      input.challan_class,
      input.challan_date,
      input.clock_days,
      input.site_id,
    ],
  );
}

/** Every clock on one order, oldest challan first (the order the aging view and the tests read). */
export async function listJobworkReturnClocksByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<JobworkReturnClockRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM jobwork_return_clock
      WHERE service_order_id = $1
      ORDER BY challan_date ASC, created_at ASC, clock_id ASC`,
    [serviceOrderId],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * The clocks for one (order, sku) with outstanding capacity, FIFO by challan_date then created_at,
 * locked FOR UPDATE. Called only under the order advisory lock the caller already holds (lock order:
 * advisory lock, order row, ledger rows, THEN clock rows - the 9.3/9.4 convention extended).
 * Breached clocks are included: a late return or dispatch still drains the physical balance and the
 * closure gate must stay reachable (the deemed-supply record stays frozen; see markReturnClockBreached).
 */
export async function lockReturnClocksWithCapacity(
  serviceOrderId: string,
  sku: string,
  client: PoolClient,
): Promise<JobworkReturnClockRow[]> {
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM jobwork_return_clock
      WHERE service_order_id = $1 AND sku = $2
        AND reconciled_qty + loss_qty < challan_qty
      ORDER BY challan_date ASC, created_at ASC, clock_id ASC
      FOR UPDATE`,
    [serviceOrderId, sku],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/** Writes the new counter values and status for one clock row (called with the row already locked). */
export async function updateReturnClockCounters(
  clockId: string,
  values: { reconciled_qty: string; loss_qty: string; status: ReturnClockStatus },
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE jobwork_return_clock
        SET reconciled_qty = $2::numeric, loss_qty = $3::numeric, status = $4, updated_at = now()
      WHERE clock_id = $1`,
    [clockId, values.reconciled_qty, values.loss_qty, values.status],
  );
}

/**
 * Sweep candidates (Story 9.5 Task 2.2): live clocks that are past expiry, or inside the outer
 * lead window with the matching stage stamp still unset. `today` is the IST calendar date the sweep
 * resolved once per tick (the 8.7 bis-licence-expiry idiom), so the whole tick agrees on "today".
 * FOR UPDATE SKIP LOCKED, exactly as the model this cycle is built on (`listQcRetentionSamplesDue
 * ForDisposal`, Story 8.4): a concurrent tick on another instance takes the NEXT unlocked clocks
 * instead of blocking, and - the reason this matters more here than there - a user posting a return
 * or dispatch takes its clock rows through `lockReturnClocksWithCapacity` in challan_date order
 * while the sweep walks them in expiry_date order, so a plain FOR UPDATE could deadlock a
 * legitimate movement against a background alert. The lead-window predicates are written as
 * `expiry_date <= today + lead` rather than `expiry_date - lead <= today` so idx_jobwork_return_
 * clock_sweep (status, expiry_date) can serve them as a range scan.
 */
export async function listReturnClocksDueForSweep(
  input: { today: string; leadDays1: number; leadDays2: number; batchSize: number },
  client: PoolClient,
): Promise<JobworkReturnClockReportRow[]> {
  const result = await client.query(
    `SELECT ${REPORT_SELECT} ${REPORT_FROM}
      WHERE c.status IN ('open', 'partially_reconciled')
        -- Story 9.7 AC 8: a closed order is normally out of scope - Story 9.5 closes only on a zero
        -- custody balance, so nothing is left to chase. Contractual OFFCUT is the exception, and it
        -- is the exception by design: capture drains the custody balance (which is what let the
        -- order close) while the material stays the CUSTOMER'S and its Section 143 clock keeps
        -- running. Without this arm, offcut retained past closure would age silently to a deemed
        -- supply nobody was ever told about.
        AND (
          o.status <> 'closed'
          OR EXISTS (
            SELECT 1 FROM job_work_offcut_holding h
             WHERE h.service_order_id = c.service_order_id
               AND h.sku = c.sku
               AND h.status = 'retained'
          )
        )
        AND (
          c.expiry_date < $1::date
          OR (c.expiry_date <= $1::date + $3::int AND c.alert_30_sent_at IS NULL)
          OR (c.expiry_date <= $1::date + $2::int AND c.alert_90_sent_at IS NULL)
        )
      ORDER BY c.expiry_date ASC, c.created_at ASC, c.clock_id ASC
      LIMIT $4
      FOR UPDATE OF c SKIP LOCKED`,
    [input.today, input.leadDays1, input.leadDays2, input.batchSize],
  );
  return result.rows.map((row) => mapReportRow(row as Record<string, unknown>));
}

/** Stamps one or both alert stages; the caller decides which (tightest-stage-wins). */
export async function stampReturnClockAlerts(
  clockId: string,
  stages: { alert_90: boolean; alert_30: boolean },
  sentAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE jobwork_return_clock
        SET alert_90_sent_at = CASE WHEN $2::boolean THEN COALESCE(alert_90_sent_at, $4::timestamptz) ELSE alert_90_sent_at END,
            alert_30_sent_at = CASE WHEN $3::boolean THEN COALESCE(alert_30_sent_at, $4::timestamptz) ELSE alert_30_sent_at END,
            updated_at = now()
      WHERE clock_id = $1`,
    [clockId, stages.alert_90, stages.alert_30, sentAt],
  );
}

/**
 * The breach flip: status 'breached', deemed_supply_qty frozen at the recorded value. Guarded on the
 * live statuses so a replayed or racing tick cannot re-record a deemed supply; returns whether THIS
 * call performed the flip.
 */
export async function markReturnClockBreached(
  clockId: string,
  deemedSupplyQty: string,
  recordedAt: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE jobwork_return_clock
        SET status = 'breached', deemed_supply_qty = $2::numeric,
            deemed_supply_recorded_at = $3::timestamptz, updated_at = now()
      WHERE clock_id = $1 AND status IN ('open', 'partially_reconciled')`,
    [clockId, deemedSupplyQty, recordedAt],
  );
  return (result.rowCount ?? 0) > 0;
}

/** One clock by id, for the classification-correction gate (no order scoping - the caller scopes). */
export async function getJobworkReturnClockById(
  clockId: string,
  client?: PoolClient,
): Promise<JobworkReturnClockRow | null> {
  if (!UUID_REGEX.test(clockId)) return null;
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM jobwork_return_clock WHERE clock_id = $1`,
    [clockId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Story 9.5 code review (chunk 1): the ONLY path that can move a clock off the `challan_class` it
 * was opened with. `challan_class` defaults to 'input' on the 9.2 receipt payload (Binding decision
 * 7, fail toward the shorter clock) and the receipt itself is immutable, so a capital good received
 * without the field would otherwise breach at day 365 instead of day 1095 and freeze a deemed supply
 * into ITC-04 two years early with no way back.
 *
 * `expiry_date` is recomputed by PostgreSQL from the STORED `challan_date`, never by a JS Date and
 * never from a caller-supplied date, so the class and the expiry cannot drift apart. Guarded on
 * `deemed_supply_recorded_at IS NULL`: once a deemed supply has been recorded the row is a tax
 * record and reclassification is no longer a correction, it is a rewrite - the caller gets false and
 * turns it into a domain refusal. Returns whether THIS call performed the update.
 *
 * Story 9.5 code review (chunk 2): the two alert stamps are CLEARED whenever the expiry moves
 * later. `dueClockSweepStage` suppresses a stage whose stamp is set, so a clock corrected from
 * input to capital_goods after it had already alerted would have gone silent for the whole extra
 * two years and surfaced only as `breached`. Clearing them re-arms both warning stages against the
 * new expiry. An expiry that moves EARLIER keeps its stamps: those warnings were about a deadline
 * that has only got closer, so re-sending them would be noise.
 */
export async function updateReturnClockClassification(
  clockId: string,
  challanClass: ChallanClass,
  clockDays: number,
  client?: PoolClient,
): Promise<boolean> {
  const result = await runner(client).query(
    `UPDATE jobwork_return_clock
        SET challan_class = $2,
            expiry_date = (challan_date + make_interval(days => $3::int))::date,
            alert_90_sent_at = CASE
              WHEN (challan_date + make_interval(days => $3::int))::date > expiry_date
                THEN NULL ELSE alert_90_sent_at END,
            alert_30_sent_at = CASE
              WHEN (challan_date + make_interval(days => $3::int))::date > expiry_date
                THEN NULL ELSE alert_30_sent_at END,
            updated_at = now()
      WHERE clock_id = $1
        AND deemed_supply_recorded_at IS NULL
        AND challan_class <> $2`,
    [clockId, challanClass, clockDays],
  );
  return (result.rowCount ?? 0) > 0;
}

/** One ITC-04 / aging row: the clock joined to its receipt and order (AD-14: projections only). */
export interface JobworkReturnClockReportRow extends JobworkReturnClockRow {
  order_number_ext: string;
  customer_party_code: string;
  customer_name: string;
  order_status: string;
  challan_number_ext: string;
  received_qty: string;
  uom: string;
  /** expiry_date - today in calendar days (negative once past due). */
  days_to_expiry: number;
}

const REPORT_SELECT = `c.clock_id, c.receipt_id, c.service_order_id, c.sku, c.challan_qty::text AS challan_qty,
  c.reconciled_qty::text AS reconciled_qty, c.loss_qty::text AS loss_qty, c.challan_class,
  to_char(c.challan_date, 'YYYY-MM-DD') AS challan_date, to_char(c.expiry_date, 'YYYY-MM-DD') AS expiry_date,
  c.status, c.deemed_supply_qty::text AS deemed_supply_qty, c.deemed_supply_recorded_at, c.alert_90_sent_at,
  c.alert_30_sent_at, c.site_id, c.created_at, c.updated_at,
  o.order_number_ext, o.customer_party_code, o.customer_name, o.status AS order_status,
  r.challan_number_ext, r.received_qty::text AS received_qty, r.uom,
  (c.expiry_date - $1::date)::int AS days_to_expiry`;

const REPORT_FROM = `FROM jobwork_return_clock c
  JOIN jobwork_material_receipt r ON r.receipt_id = c.receipt_id
  JOIN service_order o ON o.service_order_id = c.service_order_id`;

function mapReportRow(row: Record<string, unknown>): JobworkReturnClockReportRow {
  return {
    ...mapRow(row),
    order_number_ext: row['order_number_ext'] as string,
    customer_party_code: row['customer_party_code'] as string,
    customer_name: row['customer_name'] as string,
    order_status: row['order_status'] as string,
    challan_number_ext: row['challan_number_ext'] as string,
    received_qty: row['received_qty'] as string,
    uom: row['uom'] as string,
    days_to_expiry: Number(row['days_to_expiry']),
  };
}

/**
 * ITC-04 challan leg (Story 9.5 Task 4.1): every clock whose CHALLAN falls in [from, to], with its
 * return-clock accounting. `siteIds` null means every site (wildcard read scope); a list restricts
 * to the caller's permitted sites.
 *
 * Story 9.5 code review (chunks 3/4): this used to be one query UNIONing the challan-date window
 * with the deemed-supply-recorded window, and the route then picked deemed-supply records out of the
 * union with no date test of its own. Because expiry is always later than the challan date, a
 * challan dated inside the period that breached in a LATER one was filed as a deemed supply of this
 * period and again of the period it actually arose, and the period totals were summed over the union
 * so out-of-period challans inflated them. The two legs answer different questions and cannot share
 * one row set, so they are now two queries.
 */
export async function listReturnClocksForItc04(
  input: { today: string; from: string; to: string; siteIds: string[] | null },
  client?: PoolClient,
): Promise<JobworkReturnClockReportRow[]> {
  const result = await runner(client).query(
    `SELECT ${REPORT_SELECT} ${REPORT_FROM}
      WHERE c.challan_date >= $2::date AND c.challan_date <= $3::date
        AND ($4::uuid[] IS NULL OR c.site_id = ANY($4::uuid[]))
      ORDER BY c.challan_date ASC, o.order_number_ext ASC, c.sku ASC, c.created_at ASC`,
    [input.today, input.from, input.to, input.siteIds],
  );
  return result.rows.map((row) => mapReportRow(row as Record<string, unknown>));
}

/**
 * ITC-04 deemed-supply leg (Story 9.5 Task 4.1, Debug Log 7): every clock whose deemed supply was
 * RECORDED in [from, to], regardless of when its challan was issued - a deemed supply is reported in
 * the period it arose. Disjoint from the challan leg by construction, so nothing is double-filed.
 */
export async function listDeemedSuppliesForItc04(
  input: { today: string; from: string; to: string; siteIds: string[] | null },
  client?: PoolClient,
): Promise<JobworkReturnClockReportRow[]> {
  const result = await runner(client).query(
    `SELECT ${REPORT_SELECT} ${REPORT_FROM}
      WHERE c.deemed_supply_recorded_at IS NOT NULL
        AND c.deemed_supply_qty > 0
        AND (c.deemed_supply_recorded_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
        AND (c.deemed_supply_recorded_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
        AND ($4::uuid[] IS NULL OR c.site_id = ANY($4::uuid[]))
      ORDER BY c.deemed_supply_recorded_at ASC, o.order_number_ext ASC, c.sku ASC`,
    [input.today, input.from, input.to, input.siteIds],
  );
  return result.rows.map((row) => mapReportRow(row as Record<string, unknown>));
}

/**
 * Aging data set (Story 9.5 Task 4.2): every clock still carrying exposure. Keyed off the COUNTERS,
 * not `status`: `returnClockStatusAfter` deliberately pins a breached clock at 'breached' forever so
 * its deemed-supply record survives, so a `status <> 'reconciled'` filter would report a clock that
 * breached and was then fully returned as outstanding aging exposure for the rest of time. The
 * remaining-capacity predicate is the same one `lockReturnClocksWithCapacity` drains against, so the
 * report and the reconciliation agree by construction. A breached clock's frozen deemed supply is
 * reported by the ITC-04 data set, which does not filter on capacity.
 */
export async function listReturnClocksForAging(
  input: { today: string; siteIds: string[] | null },
  client?: PoolClient,
): Promise<JobworkReturnClockReportRow[]> {
  const result = await runner(client).query(
    `SELECT ${REPORT_SELECT} ${REPORT_FROM}
      WHERE c.reconciled_qty + c.loss_qty < c.challan_qty
        AND ($2::uuid[] IS NULL OR c.site_id = ANY($2::uuid[]))
      ORDER BY c.expiry_date ASC, o.order_number_ext ASC, c.sku ASC, c.created_at ASC`,
    [input.today, input.siteIds],
  );
  return result.rows.map((row) => mapReportRow(row as Record<string, unknown>));
}
