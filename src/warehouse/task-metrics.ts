import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import type { WarehouseTaskType } from '../events/schema.js';
import { priorityRankSql, type TaskPriority } from '../read/projections/pick_task.js';
import { getSlaConfig } from '../read/projections/task_sla_config.js';

/**
 * Story 3.8: pure aggregation module for the warehouse task board (FR-W-07).
 *
 * Three responsibilities, all read-only: normalize every open task across the four Phase-1 domains
 * into one shape and flag SLA breaches (AC1); roll up confirmation rate and task duration per
 * operator and per zone (AC2); and compute the per-shift gate-dwell median with its drill-through
 * list of breaching vehicles (AC3).
 *
 * Two rules hold throughout:
 *  - Every interval, age, duration, and percentile is computed in PostgreSQL, never in JavaScript.
 *    An age computed after the round trip would drift with request latency, and a median computed
 *    over JS floats would not be reproducible.
 *  - Every threshold comparison uses exact decimal-string comparison (compareDecimal), never JS
 *    float comparison. `4.1 > 4.0` is trustworthy in floats; `0.1 + 0.2 > 0.3` is not, and an SLA
 *    breach flag is a statement about the business, not an approximation.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** AC3 / SM-13: the median gate dwell target. Strictly greater than this breaches. */
export const GATE_DWELL_TARGET_MINUTES = 4;

/**
 * Bounds on the unified task board. The query was previously unbounded and the handler materialized
 * the result twice more, so a large backlog had no ceiling on response size. The default is large
 * enough to cover a realistic shift's open work; the maximum is the hard cap a caller cannot exceed.
 */
export const OPEN_TASK_DEFAULT_LIMIT = 500;
export const OPEN_TASK_MAX_LIMIT = 2000;

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Exact ordering for two non-negative decimal strings as PostgreSQL NUMERIC would order them.
 * Returns -1, 0 or 1. Used instead of Number() comparison so a breach decision never depends on
 * binary floating-point rounding. Handles differing scales ('4' vs '4.00' compare equal).
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): { neg: boolean; whole: string; frac: string } => {
    const t = s.trim();
    const neg = t.startsWith('-');
    const unsigned = neg ? t.slice(1) : t;
    const dot = unsigned.indexOf('.');
    const whole = (dot === -1 ? unsigned : unsigned.slice(0, dot)).replace(/^0+(?=\d)/, '');
    const frac = (dot === -1 ? '' : unsigned.slice(dot + 1)).replace(/0+$/, '');
    return { neg, whole: whole === '' ? '0' : whole, frac };
  };
  const x = parse(a);
  const y = parse(b);
  const xZero = x.whole === '0' && x.frac === '';
  const yZero = y.whole === '0' && y.frac === '';
  // -0 and 0 are the same number; treating them as differently signed would invert the comparison.
  const xNeg = x.neg && !xZero;
  const yNeg = y.neg && !yZero;
  if (xNeg !== yNeg) return xNeg ? -1 : 1;
  const flip = (r: -1 | 0 | 1): -1 | 0 | 1 => (xNeg ? ((-r) as -1 | 0 | 1) : r);
  if (x.whole.length !== y.whole.length) return flip(x.whole.length > y.whole.length ? 1 : -1);
  if (x.whole !== y.whole) return flip(x.whole > y.whole ? 1 : -1);
  const width = Math.max(x.frac.length, y.frac.length);
  const xf = x.frac.padEnd(width, '0');
  const yf = y.frac.padEnd(width, '0');
  if (xf === yf) return 0;
  return flip(xf > yf ? 1 : -1);
}

/**
 * The SLA-breach decision, isolated so it is directly testable and stated exactly once.
 *
 * A null threshold means "no SLA configured for this task type/zone", which is NOT a breach - and
 * must not be silently turned into one by substituting a default. Age must strictly exceed the
 * threshold: a task sitting at exactly its threshold has not yet breached it.
 */
export function isSlaBreached(ageMinutesExact: string, thresholdMinutes: string | null): boolean {
  if (thresholdMinutes === null) return false;
  return compareDecimal(ageMinutesExact, thresholdMinutes) > 0;
}

/**
 * The AC3 exception decision: a shift breaches when its MEDIAN dwell exceeds the target. Strictly
 * greater than, per AC3's wording ("the shift median exceeds 4 minutes") - a median of exactly 4
 * minutes is on target, not over it. A null median means the shift has no resolved dwell to measure
 * (no vehicle reached weighbridge acceptance or GRN yet), which is not an exception either.
 */
export function exceedsGateDwellTarget(medianMinutes: string | null, targetMinutes: number = GATE_DWELL_TARGET_MINUTES): boolean {
  if (medianMinutes === null) return false;
  return compareDecimal(medianMinutes, String(targetMinutes)) > 0;
}

// ---------------------------------------------------------------------------
// AC1: unified open-task board
// ---------------------------------------------------------------------------

export interface OpenTask {
  task_type: WarehouseTaskType;
  task_id: string;
  /**
   * Null only for a pick or packing task whose dispatch order is not present in erp_sales_order.
   * The join is a LEFT JOIN so such a task still appears on an unscoped board instead of silently
   * vanishing from it, from the summary counts, and from the productivity denominator at once - a
   * task board whose failure mode is "the aging task quietly stops being on the board" inverts its
   * own purpose. A site-scoped read still cannot show it, because there is no site to authorize it
   * against.
   */
  site_id: string | null;
  zone_id: string | null;
  assigned_to: string | null;
  priority: TaskPriority;
  status: string;
  created_at: string;
  /** Age in minutes, computed in SQL. Exact NUMERIC text; also surfaced as a number for display. */
  age_minutes: number;
  age_minutes_exact: string;
  /** The applicable threshold (zone-specific, else site-wide default), or null when none is set. */
  sla_threshold_minutes: string | null;
  breached: boolean;
  /** AC1 requires the breached threshold to be shown. Null unless `breached` is true. */
  breached_threshold_minutes: string | null;
}

export interface ListOpenTasksFilters {
  taskType?: WarehouseTaskType | null;
  assignedTo?: string | null;
  zoneId?: string | null;
  siteId?: string | null;
  /** Sites the caller may read. Ignored when `allowAllSites` is true. */
  siteAny?: string[] | null;
  /**
   * Set only for a caller whose role assignment grants every location ('*'). Task 7.4 requires the
   * cross-domain aggregate to be site-scoped by default so that a known site-isolation gap in an
   * underlying table cannot leak through it; an unscoped read therefore has to be asked for
   * explicitly rather than being what happens when the scope resolution is forgotten.
   */
  allowAllSites?: boolean;
  /** Bounded by OPEN_TASK_MAX_LIMIT; defaults to OPEN_TASK_DEFAULT_LIMIT. */
  limit?: number;
}

/**
 * The four Phase-1 task sources, each normalized into the common board shape. Kept as data rather
 * than a hard-coded UNION so Story 3.9's replenishment tasks (and anything after it) can join the
 * board by appending one entry, with no change to the query builder or the response contract.
 *
 * `site_id` resolution differs per source: putaway_task carries it directly; pick_task and
 * packing_record resolve it through the Story 2.9 sales-order projection (the same
 * `eso.id = <source>.dispatch_order_id` join listPickTasks already uses); grn_line resolves it
 * through its GRN header.
 *
 * `zone_id` is not universal either: pick_task and putaway_task carry it, while grn_line and
 * packing_record have no zone column at all and report null. Those two therefore resolve their SLA
 * threshold against the site-wide default row rather than a zone-specific one.
 */
interface TaskSource {
  taskType: WarehouseTaskType;
  sql: string;
}

const AGE_MINUTES_SQL = (column: string): string =>
  `ROUND((EXTRACT(EPOCH FROM (now() - ${column})) / 60.0)::numeric, 6)`;

const TASK_SOURCES: readonly TaskSource[] = [
  {
    taskType: 'picking',
    sql: `SELECT 'picking'::text AS task_type,
                 pt.pick_task_id AS task_id,
                 eso.ship_from_site_id AS site_id,
                 pt.zone_id,
                 pt.assigned_to,
                 pt.priority,
                 pt.status,
                 pt.created_at,
                 ${AGE_MINUTES_SQL('pt.created_at')} AS age_minutes
            FROM pick_task pt
            LEFT JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
           WHERE pt.status NOT IN ('completed', 'cancelled')`,
  },
  {
    taskType: 'putaway',
    sql: `SELECT 'putaway'::text AS task_type,
                 put.putaway_task_id AS task_id,
                 put.site_id,
                 put.zone_id,
                 put.assigned_to,
                 put.priority,
                 put.status,
                 put.created_at,
                 ${AGE_MINUTES_SQL('put.created_at')} AS age_minutes
            FROM putaway_task put
           WHERE put.status = 'ready'`,
  },
  {
    // A quarantined GRN line is the closest existing analog to an open receiving task: it is work
    // sitting in the yard waiting on a QC decision. grn_line carries neither an assignee nor a
    // priority column, so both report their neutral value.
    taskType: 'receiving',
    sql: `SELECT 'receiving'::text AS task_type,
                 gl.grn_line_id AS task_id,
                 g.site_id,
                 NULL::uuid AS zone_id,
                 NULL::uuid AS assigned_to,
                 'normal'::text AS priority,
                 gl.status,
                 gl.created_at,
                 ${AGE_MINUTES_SQL('gl.created_at')} AS age_minutes
            FROM grn_line gl
            JOIN grn g ON g.grn_id = gl.grn_id
           WHERE gl.status = 'quarantined'`,
  },
  {
    // A packing record that is packed but not yet documented/dispatched is open packing work. Its
    // operator attribution is packed_by - packing_record has no separate assignment column.
    taskType: 'packing',
    sql: `SELECT 'packing'::text AS task_type,
                 pr.packing_record_id AS task_id,
                 eso.ship_from_site_id AS site_id,
                 NULL::uuid AS zone_id,
                 pr.packed_by AS assigned_to,
                 'normal'::text AS priority,
                 pr.status,
                 pr.packed_at AS created_at,
                 ${AGE_MINUTES_SQL('pr.packed_at')} AS age_minutes
            FROM packing_record pr
            LEFT JOIN erp_sales_order eso ON eso.id = pr.dispatch_order_id
           WHERE pr.status = 'packed'`,
  },
  {
    // Story 3.9: both site_id and zone_id are direct columns here - no LEFT JOIN erp_sales_order
    // and no zone-ancestor walk needed, unlike picking/putaway/packing - because the task is
    // generated directly against a forward-pick zone that is itself the SLA-grouping unit.
    taskType: 'replenishment',
    sql: `SELECT 'replenishment'::text AS task_type,
                 rt.replenishment_task_id AS task_id,
                 rt.site_id,
                 rt.zone_id,
                 rt.assigned_to,
                 rt.priority,
                 rt.status,
                 rt.created_at,
                 ${AGE_MINUTES_SQL('rt.created_at')} AS age_minutes
            FROM replenishment_task rt
           WHERE rt.status = 'ready'`,
  },
];

export const SUPPORTED_TASK_TYPES: readonly WarehouseTaskType[] = TASK_SOURCES.map((s) => s.taskType);

function assertSiteScoped(filters: { siteId?: string | null; siteAny?: string[] | null; allowAllSites?: boolean }): void {
  if (filters.allowAllSites === true) return;
  if (filters.siteId) return;
  if (filters.siteAny && filters.siteAny.length > 0) return;
  throw new AppError(403, 'LOCATION_ACCESS_DENIED', 'No role assignment grants access to any site for this module');
}

export interface OpenTaskBoard {
  tasks: OpenTask[];
  /** True when the database was queried with a row cap and the cap could have been hit. */
  truncated: boolean;
  /** The cap actually applied at the database. */
  limit: number;
}

/**
 * AC1: every open task across the four Phase-1 domains, grouped-ready and SLA-flagged.
 *
 * Ordering is most-urgent-first then oldest-first, so the row a supervisor should act on next is at
 * the top regardless of which domain it came from.
 */
export async function listOpenTasks(filters: ListOpenTasksFilters = {}, client?: PoolClient): Promise<OpenTaskBoard> {
  assertSiteScoped(filters);

  const sources = filters.taskType
    ? TASK_SOURCES.filter((s) => s.taskType === filters.taskType)
    : TASK_SOURCES;
  if (sources.length === 0) return { tasks: [], truncated: false, limit: 0 };

  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('t.site_id = ?', filters.siteId);
  else if (!filters.allowAllSites && filters.siteAny) add('t.site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.assignedTo) add('t.assigned_to = ?', filters.assignedTo);
  if (filters.zoneId) add('t.zone_id = ?', filters.zoneId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // The board is bounded. The UNION ALL previously ran unbounded and the handler then materialized
  // the full array twice more, so a site with a large backlog had no ceiling on its response size at
  // all. The cap is applied after ordering, so what survives is always the most urgent and oldest
  // work - the rows a supervisor should act on first - never an arbitrary slice.
  const limit = Math.min(Math.max(filters.limit ?? OPEN_TASK_DEFAULT_LIMIT, 1), OPEN_TASK_MAX_LIMIT);
  values.push(limit);
  const limitClause = `LIMIT $${values.length}`;

  const result = await runner(client).query(
    `SELECT t.task_type, t.task_id, t.site_id, t.zone_id, t.assigned_to, t.priority, t.status,
            t.created_at, t.age_minutes::text AS age_minutes
       FROM (${sources.map((s) => s.sql).join('\n           UNION ALL\n')}) t
       ${where}
      ORDER BY ${priorityRankSql('t.priority')}, t.created_at ASC
      ${limitClause}`,
    values,
  );

  // Threshold resolution is memoized per (site_id, task_type, zone_id) triple rather than run per
  // row: a board of 500 tasks spans a handful of distinct triples, so this is a few queries, not
  // 500. site_id joined the key when it joined the SLA grain - without it, one site's cached
  // threshold would be served to another site's tasks inside the same request.
  const thresholdCache = new Map<string, string | null>();
  const resolveThreshold = async (
    taskType: WarehouseTaskType,
    siteId: string | null,
    zoneId: string | null,
  ): Promise<string | null> => {
    if (siteId === null) return null;
    const key = `${siteId}::${taskType}::${zoneId ?? ''}`;
    if (!thresholdCache.has(key)) {
      const config = await getSlaConfig(taskType, siteId, zoneId, client);
      thresholdCache.set(key, config ? config.threshold_minutes : null);
    }
    return thresholdCache.get(key) ?? null;
  };

  const tasks: OpenTask[] = [];
  for (const row of result.rows) {
    const taskType = row['task_type'] as WarehouseTaskType;
    const zoneId = (row['zone_id'] as string | null) ?? null;
    const rowSiteId = (row['site_id'] as string | null) ?? null;
    const ageExact = String(row['age_minutes']);
    const threshold = await resolveThreshold(taskType, rowSiteId, zoneId);
    // No configured threshold means "no SLA for this task type/zone", which is not a breach. It is
    // reported as a null threshold rather than silently substituting a default, so an unconfigured
    // task type is visibly unconfigured on the board instead of looking permanently healthy.
    const breached = isSlaBreached(ageExact, threshold);
    tasks.push({
      task_type: taskType,
      task_id: row['task_id'] as string,
      site_id: rowSiteId,
      zone_id: zoneId,
      assigned_to: (row['assigned_to'] as string | null) ?? null,
      priority: (row['priority'] as TaskPriority | null) ?? 'normal',
      status: row['status'] as string,
      created_at: row['created_at'] instanceof Date ? (row['created_at'] as Date).toISOString() : String(row['created_at']),
      age_minutes: Number(ageExact),
      age_minutes_exact: ageExact,
      sla_threshold_minutes: threshold,
      breached,
      breached_threshold_minutes: breached ? threshold : null,
    });
  }
  return { tasks, truncated: result.rows.length >= limit, limit };
}

/** Groups a board into the AC1 shape: by task type, and within that by operator. */
export function groupOpenTasks(tasks: OpenTask[]): Array<{
  task_type: WarehouseTaskType;
  open_count: number;
  breached_count: number;
  operators: Array<{ assigned_to: string | null; open_count: number; breached_count: number; tasks: OpenTask[] }>;
}> {
  const byType = new Map<WarehouseTaskType, Map<string, OpenTask[]>>();
  for (const task of tasks) {
    const operators = byType.get(task.task_type) ?? new Map<string, OpenTask[]>();
    const key = task.assigned_to ?? '';
    operators.set(key, [...(operators.get(key) ?? []), task]);
    byType.set(task.task_type, operators);
  }
  return [...byType.entries()].map(([taskType, operators]) => {
    const all = [...operators.values()].flat();
    return {
      task_type: taskType,
      open_count: all.length,
      breached_count: all.filter((t) => t.breached).length,
      operators: [...operators.entries()].map(([assignedTo, group]) => ({
        assigned_to: assignedTo === '' ? null : assignedTo,
        open_count: group.length,
        breached_count: group.filter((t) => t.breached).length,
        tasks: group,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// AC2: confirmation rate and productivity
// ---------------------------------------------------------------------------

export interface ProductivityRow {
  operator_id: string | null;
  zone_id: string | null;
  assigned_count: number;
  completed_count: number;
  /** completed_count / assigned_count, rounded to 4 decimal places in SQL. Null when nothing was assigned. */
  confirmation_rate: string | null;
  avg_duration_seconds: string | null;
  median_duration_seconds: string | null;
}

export interface ConfirmationRateFilters {
  periodStart: string;
  periodEnd: string;
  siteId?: string | null;
  siteAny?: string[] | null;
  allowAllSites?: boolean;
  zoneId?: string | null;
  operatorId?: string | null;
}

/**
 * The completion-bearing sources. AC2 needs no new event type: Stories 3.5, 3.6 and 3.7 already
 * record completion durably on their own projections, so this only reads and rolls them up.
 *
 * A task counts toward the denominator when it was attributed to an operator (assigned or
 * completed by one) and was CREATED inside the period. Anchoring the denominator on creation - not
 * on completion - is what makes the ratio meaningful: counting only tasks that completed inside the
 * window would make the rate identically 100% by construction.
 *
 * Two corrections from this story's code review:
 *
 * packing_record is deliberately NOT a source. It has no creation column, so the earlier revision
 * aliased packed_at to BOTH created_at and completed_at and hard-coded `true AS completed`. Every
 * packing row therefore added 1 to both numerator and denominator - the identically-100% trap this
 * very comment warns about - and contributed an exact 0 to the average and the median. An operator
 * who packed trended toward a perfect rate and a zero-second duration no matter how they actually
 * performed. Reintroducing packing requires a real start instant on packing_record first; until
 * then the metric covers the task types that can answer honestly rather than inventing an answer
 * for the one that cannot.
 *
 * Attribution prefers assigned_to over completed_by. The reverse order moved a task off its
 * assignee's ledger the moment someone else finished it, so an operator's assigned-but-unconfirmed
 * work - the only rows that could ever lower their rate - could not appear against them. Unassigned
 * work still attributes to whoever completed it.
 */
const COMPLETION_SOURCES = `
  SELECT COALESCE(pt.assigned_to, pt.completed_by) AS operator_id,
         pt.zone_id,
         eso.ship_from_site_id AS site_id,
         pt.created_at,
         pt.completed_at,
         (pt.status = 'completed') AS completed
    FROM pick_task pt
    LEFT JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
  UNION ALL
  SELECT COALESCE(put.assigned_to, put.completed_by) AS operator_id,
         put.zone_id,
         put.site_id,
         put.created_at,
         put.completed_at,
         (put.status = 'completed') AS completed
    FROM putaway_task put
`;

function buildProductivityQuery(
  groupBy: 'operator_id' | 'zone_id',
  filters: ConfirmationRateFilters,
): { sql: string; values: unknown[] } {
  const values: unknown[] = [filters.periodStart, filters.periodEnd];
  const clauses = ['s.created_at >= $1::timestamptz', 's.created_at < $2::timestamptz', 's.operator_id IS NOT NULL'];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('s.site_id = ?', filters.siteId);
  else if (!filters.allowAllSites && filters.siteAny) add('s.site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.zoneId) add('s.zone_id = ?', filters.zoneId);
  if (filters.operatorId) add('s.operator_id = ?', filters.operatorId);

  const selectedOperator = groupBy === 'operator_id' ? 's.operator_id' : 'NULL::uuid';
  const selectedZone = groupBy === 'zone_id' ? 's.zone_id' : 'NULL::uuid';

  // Duration and the median are both computed in SQL. percentile_cont is an ordered-set aggregate:
  // PostgreSQL 18 does NOT support ordered-set aggregates as window functions, so this uses a plain
  // GROUP BY and never `... OVER (PARTITION BY ...)`, despite that form appearing in many examples.
  const sql = `
    SELECT ${selectedOperator} AS operator_id,
           ${selectedZone} AS zone_id,
           COUNT(*)::int AS assigned_count,
           COUNT(*) FILTER (WHERE s.completed)::int AS completed_count,
           CASE WHEN COUNT(*) = 0 THEN NULL
                ELSE ROUND((COUNT(*) FILTER (WHERE s.completed))::numeric / COUNT(*)::numeric, 4)
           END::text AS confirmation_rate,
           ROUND(AVG(EXTRACT(EPOCH FROM (s.completed_at - s.created_at)))
                 FILTER (WHERE s.completed AND s.completed_at IS NOT NULL)::numeric, 3)::text AS avg_duration_seconds,
           ROUND(percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (s.completed_at - s.created_at))
                 ) FILTER (WHERE s.completed AND s.completed_at IS NOT NULL)::numeric, 3)::text AS median_duration_seconds
      FROM (${COMPLETION_SOURCES}) s
     WHERE ${clauses.join(' AND ')}
     GROUP BY ${groupBy === 'operator_id' ? 's.operator_id' : 's.zone_id'}
     -- Order by the actual selected group-by column, not the projection's NULL::uuid literal,
     -- which left the zone rollup's row order nondeterministic. NULLS LAST keeps a NULL operator
     -- or zone row out of the way of real values.
     ORDER BY ${groupBy === 'operator_id' ? 's.operator_id' : 's.zone_id'} NULLS LAST`;
  return { sql, values };
}

function mapProductivityRow(row: Record<string, unknown>): ProductivityRow {
  return {
    operator_id: (row['operator_id'] as string | null) ?? null,
    zone_id: (row['zone_id'] as string | null) ?? null,
    assigned_count: Number(row['assigned_count']),
    completed_count: Number(row['completed_count']),
    confirmation_rate: (row['confirmation_rate'] as string | null) ?? null,
    avg_duration_seconds: (row['avg_duration_seconds'] as string | null) ?? null,
    median_duration_seconds: (row['median_duration_seconds'] as string | null) ?? null,
  };
}

/**
 * AC2: confirmation rate and task duration, rolled up per operator and per zone for a period.
 * Both rollups run over the same normalized source set, so the two views of the same period always
 * agree on their totals.
 */
export async function computeConfirmationRate(
  filters: ConfirmationRateFilters,
  client?: PoolClient,
): Promise<{ by_operator: ProductivityRow[]; by_zone: ProductivityRow[] }> {
  assertSiteScoped(filters);
  const byOperator = buildProductivityQuery('operator_id', filters);
  const byZone = buildProductivityQuery('zone_id', filters);
  const [operatorResult, zoneResult] = await Promise.all([
    runner(client).query(byOperator.sql, byOperator.values),
    runner(client).query(byZone.sql, byZone.values),
  ]);
  return {
    by_operator: operatorResult.rows.map(mapProductivityRow),
    by_zone: zoneResult.rows.map(mapProductivityRow),
  };
}

// ---------------------------------------------------------------------------
// AC3: gate-dwell median and exception drill-through
// ---------------------------------------------------------------------------

export interface GateDwellBreachRow {
  gate_event_id: string;
  correlation_id: string;
  site_id: string;
  vehicle_reg_ext: string;
  po_ref_ext: string | null;
  gate_entered_at: string;
  resolved_at: string | null;
  resolution_source: 'weighbridge' | 'grn' | null;
  dwell_minutes: string;
  challan_photo_present: boolean;
  weighment_present: boolean;
  grn_fallback_used: boolean;
}

export interface GateDwellShift {
  business_date: string;
  site_id: string;
  vehicle_count: number;
  median_dwell_minutes: string | null;
  target_minutes: number;
  exceeded: boolean;
  /**
   * SM-C2 counter-metrics: a dwell improvement bought by skipping capture stays visible here.
   *
   * unresolved_count is vehicles still in the yard. They now carry an OPEN dwell against now() and
   * DO count toward the median, so a shift of stuck vehicles breaches instead of reporting clean.
   * clock_skew_count is vehicles whose resolution instant preceded their gate entry; those are
   * excluded from the median rather than allowed to drag it down with a negative interval.
   * challan_photo_present_count is always equal to vehicle_count under the current gate_event DDL
   * and is retained as an invariant tripwire - see the view definition for why.
   */
  capture_completeness: {
    challan_photo_present_count: number;
    weighment_present_count: number;
    grn_fallback_count: number;
    unresolved_count: number;
    clock_skew_count: number;
  };
  /** Populated only for a shift whose median exceeds the target (AC3's drill-through). */
  breaches: GateDwellBreachRow[];
}

export interface GateDwellFilters {
  businessDate?: string | null;
  siteId?: string | null;
  siteAny?: string[] | null;
  allowAllSites?: boolean;
}

/**
 * AC3: per-shift gate-dwell median with drill-through.
 *
 * "Shift" is a calendar business day per site. This is a deliberate Phase-1 scope decision, not an
 * oversight: no shift-register or shift-master entity exists anywhere in the codebase, and
 * gate_event already carries the IST-local `business_date` that Stories 3.3 and 3.4 bucket by. A
 * real shift register would change the GROUP BY key here and nothing else.
 *
 * The median uses `percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_interval)` under a plain
 * GROUP BY. It must not be written as `percentile_cont(...) WITHIN GROUP (...) OVER (PARTITION BY
 * ...)`: ordered-set aggregates are not valid window functions in PostgreSQL 18, whatever
 * third-party examples suggest. percentile_cont (interpolating) is correct for a continuous median;
 * percentile_disc would return an observed value instead and is the wrong choice.
 */
export async function computeGateDwellExceptions(
  filters: GateDwellFilters = {},
  client?: PoolClient,
): Promise<GateDwellShift[]> {
  assertSiteScoped(filters);

  const values: unknown[] = [];
  const clauses: string[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.businessDate) add('business_date = ?::date', filters.businessDate);
  if (filters.siteId) add('site_id = ?', filters.siteId);
  else if (!filters.allowAllSites && filters.siteAny) add('site_id = ANY(?::uuid[])', filters.siteAny);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const shifts = await runner(client).query(
    `SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date,
            site_id,
            COUNT(*)::int AS vehicle_count,
            COUNT(*) FILTER (WHERE challan_photo_present)::int AS challan_photo_present_count,
            COUNT(*) FILTER (WHERE weighment_present)::int AS weighment_present_count,
            COUNT(*) FILTER (WHERE grn_fallback_used)::int AS grn_fallback_count,
            -- dwell_open, not "dwell_interval IS NULL". Unresolved vehicles now carry an OPEN dwell
            -- measured against now() so they count toward the median rather than being skipped, and
            -- a NULL interval means clock skew instead. Counting them separately keeps both visible.
            COUNT(*) FILTER (WHERE dwell_open)::int AS unresolved_count,
            COUNT(*) FILTER (WHERE clock_skew_detected)::int AS clock_skew_count,
            ROUND((EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_interval)) / 60.0)::numeric, 6)::text
              AS median_dwell_minutes
       FROM gate_dwell_metric
       ${where}
      GROUP BY business_date, site_id
      ORDER BY business_date DESC, site_id`,
    values,
  );

  const results: GateDwellShift[] = [];
  // N+1 drill-through: identify every breaching shift up front, then run a SINGLE breach query
  // covering all (business_date, site_id) pairs, instead of one query per shift. A wildcard read
  // that returns N exceeding shifts no longer issues N extra round trips.
  const exceededKeys: Array<{ businessDate: string; siteId: string }> = [];
  for (const row of shifts.rows) {
    const median = (row['median_dwell_minutes'] as string | null) ?? null;
    const exceeded = exceedsGateDwellTarget(median);
    const businessDate = row['business_date'] as string;
    const siteId = row['site_id'] as string;
    if (exceeded) exceededKeys.push({ businessDate, siteId });
    results.push({
      business_date: businessDate,
      site_id: siteId,
      vehicle_count: Number(row['vehicle_count']),
      median_dwell_minutes: median,
      target_minutes: GATE_DWELL_TARGET_MINUTES,
      exceeded,
      capture_completeness: {
        challan_photo_present_count: Number(row['challan_photo_present_count']),
        weighment_present_count: Number(row['weighment_present_count']),
        grn_fallback_count: Number(row['grn_fallback_count']),
        unresolved_count: Number(row['unresolved_count']),
        clock_skew_count: Number(row['clock_skew_count']),
      },
      breaches: [],
    });
  }
  const breachesByKey = await listGateDwellBreachesBulk(exceededKeys, client);
  for (const shift of results) {
    if (!shift.exceeded) continue;
    shift.breaches = breachesByKey.get(`${shift.business_date}::${shift.site_id}`) ?? [];
  }
  return results;
}

/**
 * AC3 drill-through for a batch of (business_date, site_id) pairs in one query, so a wide read
 * does not fan out to one round trip per breaching shift. The result is keyed by the same
 * "business_date::site_id" string the caller uses to look it up.
 */
export async function listGateDwellBreachesBulk(
  keys: Array<{ businessDate: string; siteId: string }>,
  client?: PoolClient,
): Promise<Map<string, GateDwellBreachRow[]>> {
  const result = new Map<string, GateDwellBreachRow[]>();
  if (keys.length === 0) return result;
  const dates = [...new Set(keys.map((k) => k.businessDate))];
  const sites = [...new Set(keys.map((k) => k.siteId))];
  const rows = await runner(client).query(
    `SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date,
            site_id, gate_event_id, correlation_id, vehicle_reg_ext, po_ref_ext,
            gate_entered_at, resolved_at, resolution_source,
            ROUND((EXTRACT(EPOCH FROM dwell_interval) / 60.0)::numeric, 6)::text AS dwell_minutes,
            challan_photo_present, weighment_present, grn_fallback_used
       FROM gate_dwell_metric
      WHERE business_date = ANY($1::date[])
        AND site_id = ANY($2::uuid[])
        AND dwell_interval > make_interval(mins => $3)
      ORDER BY dwell_interval DESC`,
    [dates, sites, GATE_DWELL_TARGET_MINUTES],
  );
  for (const row of rows.rows) {
    const key = `${row['business_date'] as string}::${row['site_id'] as string}`;
    const list = result.get(key) ?? [];
    list.push({
      gate_event_id: row['gate_event_id'] as string,
      correlation_id: row['correlation_id'] as string,
      site_id: row['site_id'] as string,
      vehicle_reg_ext: row['vehicle_reg_ext'] as string,
      po_ref_ext: (row['po_ref_ext'] as string | null) ?? null,
      gate_entered_at: row['gate_entered_at'] instanceof Date ? (row['gate_entered_at'] as Date).toISOString() : String(row['gate_entered_at']),
      resolved_at: row['resolved_at'] ? (row['resolved_at'] instanceof Date ? (row['resolved_at'] as Date).toISOString() : String(row['resolved_at'])) : null,
      resolution_source: (row['resolution_source'] as 'weighbridge' | 'grn' | null) ?? null,
      dwell_minutes: String(row['dwell_minutes']),
      challan_photo_present: Boolean(row['challan_photo_present']),
      weighment_present: Boolean(row['weighment_present']),
      grn_fallback_used: Boolean(row['grn_fallback_used']),
    });
    result.set(key, list);
  }
  return result;
}

/**
 * The AC3 drill-through: every vehicle in the shift whose own dwell exceeded the target, each
 * carrying its correlation_id so a supervisor can trace back to the source gate, weighbridge, and
 * GRN events. Already site-scoped by construction - the caller passes a single resolved site.
 */
export async function listGateDwellBreaches(
  businessDate: string,
  siteId: string,
  client?: PoolClient,
): Promise<GateDwellBreachRow[]> {
  const result = await runner(client).query(
    `SELECT gate_event_id, correlation_id, site_id, vehicle_reg_ext, po_ref_ext,
            gate_entered_at, resolved_at, resolution_source,
            ROUND((EXTRACT(EPOCH FROM dwell_interval) / 60.0)::numeric, 6)::text AS dwell_minutes,
            challan_photo_present, weighment_present, grn_fallback_used
       FROM gate_dwell_metric
      WHERE business_date = $1::date
        AND site_id = $2
        AND dwell_interval > make_interval(mins => $3)
      ORDER BY dwell_interval DESC`,
    [businessDate, siteId, GATE_DWELL_TARGET_MINUTES],
  );
  return result.rows.map((row) => ({
    gate_event_id: row['gate_event_id'] as string,
    correlation_id: row['correlation_id'] as string,
    site_id: row['site_id'] as string,
    vehicle_reg_ext: row['vehicle_reg_ext'] as string,
    po_ref_ext: (row['po_ref_ext'] as string | null) ?? null,
    gate_entered_at: row['gate_entered_at'] instanceof Date ? (row['gate_entered_at'] as Date).toISOString() : String(row['gate_entered_at']),
    resolved_at: row['resolved_at'] ? (row['resolved_at'] instanceof Date ? (row['resolved_at'] as Date).toISOString() : String(row['resolved_at'])) : null,
    resolution_source: (row['resolution_source'] as 'weighbridge' | 'grn' | null) ?? null,
    dwell_minutes: String(row['dwell_minutes']),
    challan_photo_present: Boolean(row['challan_photo_present']),
    weighment_present: Boolean(row['weighment_present']),
    grn_fallback_used: Boolean(row['grn_fallback_used']),
  }));
}

// ---------------------------------------------------------------------------
// Filter validation (AC1 / Task 4.3)
// ---------------------------------------------------------------------------

/**
 * Rejects a malformed filter BEFORE any query runs, so a bad query parameter is a 400 INVALID_PARAMS
 * and never a raw PostgreSQL 22P02 surfacing as a 500. This is the exact defect class Story 3.6's
 * review found and fixed in its own list endpoints.
 */
export function assertValidTaskFilters(params: URLSearchParams): void {
  const taskType = params.get('task_type');
  if (taskType !== null && !SUPPORTED_TASK_TYPES.includes(taskType as WarehouseTaskType)) {
    throw new AppError(400, 'INVALID_PARAMS', `task_type must be one of: ${SUPPORTED_TASK_TYPES.join(', ')}`, { task_type: taskType });
  }
  // `site` is the accepted alias for `site_id` in every handler (`params.get('site_id') ?? ...`),
  // so it must be validated here too. Omitting it let a wildcard-scoped caller send `?site=abc`
  // straight into `t.site_id = $1` against a uuid column, which Postgres rejected as 22P02 and the
  // API surfaced as a 500 - precisely the failure this validator exists to prevent.
  for (const key of ['zone_id', 'assigned_to', 'site_id', 'site', 'operator_id'] as const) {
    const value = params.get(key);
    if (value !== null && !isUuid(value)) {
      throw new AppError(400, 'INVALID_PARAMS', `${key} must be a UUID`, { [key]: value });
    }
  }
  // Limit must be a positive integer, not a float / NaN / Infinity that the route's `Number()`
  // conversion would silently turn into 1 or NaN, and that could then reach SQL LIMIT as a 500
  // instead of this file's 400 INVALID_PARAMS. Anything non-integer is rejected up front.
  const limit = params.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > OPEN_TASK_MAX_LIMIT) {
      throw new AppError(400, 'INVALID_PARAMS', `limit must be a positive integer not exceeding ${OPEN_TASK_MAX_LIMIT}`, { limit });
    }
  }
  // Shape alone is not enough: `2026-13-45` matches the pattern and then raises Postgres 22008
  // (date/time field out of range) when bound as ::date, turning a bad request into a 500. The
  // round-trip check is what proves the calendar date actually exists.
  const businessDate = params.get('business_date');
  if (businessDate !== null) {
    const shaped = /^\d{4}-\d{2}-\d{2}$/.test(businessDate);
    const parsed = shaped ? new Date(`${businessDate}T00:00:00Z`) : null;
    const roundTrips =
      parsed !== null && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === businessDate;
    if (!roundTrips) {
      throw new AppError(400, 'INVALID_PARAMS', 'business_date must be an ISO calendar date (YYYY-MM-DD)', {
        business_date: businessDate,
      });
    }
  }
  for (const key of ['period_start', 'period_end'] as const) {
    const value = params.get(key);
    if (value === null) continue;
    // Date.parse accepts many non-ISO inputs (RFC 2822, etc) that PostgreSQL's timestamptz parser
    // does not. Reject anything that does not round-trip as a true ISO 8601 / RFC 3339 instant,
    // so a query that calls Date.parse OK but fails on ::timestamptz never reaches the database.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)
        || Number.isNaN(Date.parse(value))) {
      throw new AppError(400, 'INVALID_PARAMS', `${key} must be an ISO 8601 timestamp with timezone`, { [key]: value });
    }
  }
  const start = params.get('period_start');
  const end = params.get('period_end');
  if (start !== null && end !== null && Date.parse(start) >= Date.parse(end)) {
    throw new AppError(400, 'INVALID_PARAMS', 'period_start must be strictly before period_end', { period_start: start, period_end: end });
  }
}
