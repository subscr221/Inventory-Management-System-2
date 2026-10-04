// Story 8.9 (Tables 11 and 14): the pure half of the damage cases workbench. Grouping is display
// only; which actions a person may take always comes from the server's `allowed_actions` (D11,
// the Story 1.14 rule that the edge never decides authorization).

export type DamageStatus =
  | 'on_hold'
  | 'cleared'
  | 'awaiting_keys'
  | 'escalated'
  | 'outcome_final'
  | 'closed';

export type KeyStatus = 'pending' | 'turned' | 'disagreed';

/** The report fields the screens read; every other field the API sends is ignored. */
export interface DamageReport {
  report_id: string;
  report_number: string;
  site_id: string;
  reporter_user_id: string;
  reporter_display_name?: string | null;
  reported_at: string;
  source: 'report' | 'receipt';
  source_grn_line_id?: string | null;
  sku: string;
  lot_number?: string | null;
  quantity: string;
  uom?: string | null;
  found_at?: string | null;
  bin_code?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  photo_attachment_id?: string | null;
  photo_status?: 'pending' | 'stored' | null;
  hold_mode: string;
  hold_note?: string | null;
  physical_state: string;
  arrived_at?: string | null;
  external_destination?: string | null;
  external_sent_at?: string | null;
  external_expected_return_date?: string | null;
  external_result_ref_ext?: string | null;
  whole_lot_requested: boolean;
  whole_lot_decision: string | null;
  status: DamageStatus;
  confirmed_quantity?: string | null;
  defect_code?: string | null;
  qc_key_status: KeyStatus;
  finance_key_status: KeyStatus;
  qc_key_user_id?: string | null;
  finance_key_user_id?: string | null;
  qc_key_outcome?: string | null;
  finance_key_outcome?: string | null;
  qc_key_price_reduction_pct?: string | null;
  finance_key_price_reduction_pct?: string | null;
  qc_key_at?: string | null;
  finance_key_at?: string | null;
  qc_key_display_name?: string | null;
  finance_key_display_name?: string | null;
  final_outcome?: string | null;
  final_price_reduction_pct?: string | null;
  decided_by?: 'concurrence' | 'escalation' | null;
  escalation_display_name?: string | null;
  erp_document_ref_ext?: string | null;
  replacement_indent_id?: string | null;
  replacement_indent_number?: string | null;
  replacement_status?: string | null;
}

export interface DamageHistoryEntry {
  action: string;
  actor_user_id: string;
  actor_role: string | null;
  actor_display_name: string | null;
  at: string;
}

const STATUSES: readonly string[] = [
  'on_hold',
  'cleared',
  'awaiting_keys',
  'escalated',
  'outcome_final',
  'closed',
];

/** Reject a malformed report before it reaches a React key (Story 1.14 review). */
export function isDamageReport(value: unknown): value is DamageReport {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.report_id === 'string' &&
    typeof row.report_number === 'string' &&
    typeof row.sku === 'string' &&
    typeof row.quantity === 'string' &&
    typeof row.status === 'string' &&
    STATUSES.includes(row.status) &&
    typeof row.reported_at === 'string' &&
    !Number.isNaN(Date.parse(row.reported_at))
  );
}

export function isHistoryEntry(value: unknown): value is DamageHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.action === 'string' &&
    typeof row.at === 'string' &&
    !Number.isNaN(Date.parse(row.at))
  );
}

// ---------------------------------------------------------------------------------------------
// Actions and panels
// ---------------------------------------------------------------------------------------------

/** Table 11: the action names `allowed_actions` may carry. */
export const DAMAGE_ACTION_NAMES = [
  'inspect',
  'decide_whole_lot',
  'mark_arrived',
  'send_external',
  'mark_returned',
  'mark_returned_to_stock',
  'turn_qc_key',
  'withdraw_qc_key',
  'disagree_qc',
  'turn_finance_key',
  'withdraw_finance_key',
  'disagree_finance',
  'decide_escalation',
  'record_outcome',
] as const;
export type DamageActionName = (typeof DAMAGE_ACTION_NAMES)[number];

export function isDamageActionName(value: string): value is DamageActionName {
  return (DAMAGE_ACTION_NAMES as readonly string[]).includes(value);
}

/** Table 14: the action panels, in the order the case panel shows its cards. */
export type DamagePanel = 'whole_lot' | 'custody' | 'inspection' | 'keys' | 'escalation' | 'outcome';

const PANEL_ORDER: readonly DamagePanel[] = [
  'whole_lot',
  'custody',
  'inspection',
  'keys',
  'escalation',
  'outcome',
];

const PANEL_OF: Record<DamageActionName, DamagePanel> = {
  inspect: 'inspection',
  decide_whole_lot: 'whole_lot',
  mark_arrived: 'custody',
  send_external: 'custody',
  mark_returned: 'custody',
  mark_returned_to_stock: 'custody',
  turn_qc_key: 'keys',
  withdraw_qc_key: 'keys',
  disagree_qc: 'keys',
  turn_finance_key: 'keys',
  withdraw_finance_key: 'keys',
  disagree_finance: 'keys',
  decide_escalation: 'escalation',
  record_outcome: 'outcome',
};

/** The panels to render for the names the server allowed; unknown names are ignored. */
export function panelsFor(allowed: readonly string[]): DamagePanel[] {
  const panels = new Set<DamagePanel>();
  for (const name of allowed) if (isDamageActionName(name)) panels.add(PANEL_OF[name]);
  return PANEL_ORDER.filter((panel) => panels.has(panel));
}

const ROUTE_OF: Record<DamageActionName, string> = {
  inspect: 'inspection',
  decide_whole_lot: 'whole-lot',
  mark_arrived: 'custody/arrived',
  send_external: 'custody/sent-external',
  mark_returned: 'custody/returned',
  mark_returned_to_stock: 'custody/returned-to-stock',
  turn_qc_key: 'keys/qc/turn',
  withdraw_qc_key: 'keys/qc/withdraw',
  disagree_qc: 'keys/qc/disagree',
  turn_finance_key: 'keys/finance/turn',
  withdraw_finance_key: 'keys/finance/withdraw',
  disagree_finance: 'keys/finance/disagree',
  decide_escalation: 'escalation/decide',
  record_outcome: 'outcome',
};

export function actionPath(reportId: string, action: DamageActionName): string {
  return `/api/v1/damage-reports/${encodeURIComponent(reportId)}/${ROUTE_OF[action]}`;
}

// ---------------------------------------------------------------------------------------------
// Workbench grouping (Table 11)
// ---------------------------------------------------------------------------------------------

export const WORKBENCH_GROUPS = [
  'to_inspect',
  'whole_lot',
  'awaiting_your_key',
  'sent_on',
  'with_ceo',
  'record_erp',
  'units_to_move',
  'closed',
] as const;
export type WorkbenchGroup = (typeof WORKBENCH_GROUPS)[number];

export function isExternalCheckOverdue(report: DamageReport, today: string): boolean {
  return (
    report.physical_state === 'at_external_check' &&
    typeof report.external_expected_return_date === 'string' &&
    report.external_expected_return_date < today
  );
}

function callerTurnedAKey(report: DamageReport, callerUserId: string): boolean {
  return report.qc_key_user_id === callerUserId || report.finance_key_user_id === callerUserId;
}

/** Released units still sit in quarantine until stores moves them back (Table 11 "Units to move"). */
function releasedInQuarantine(report: DamageReport): boolean {
  const released =
    report.status === 'cleared' ||
    (report.status === 'closed' && report.final_outcome === 'accept_as_is_price_reduction');
  return released && report.hold_mode === 'quarantined' && report.physical_state === 'in_qc_hold';
}

/**
 * Every group in Table 11 order, each with its cases in API order. A case sits in exactly one
 * status group and may also appear under "Whole-lot hold requested" and "Units to move", which are
 * parallel tasks for other people. "Awaiting your key" versus "Sent on" is told apart by whether
 * the caller already turned a key on the case; overdue external checks lead "Units to move".
 */
export function groupWorkbench(
  reports: readonly DamageReport[],
  callerUserId: string,
  today: string,
): Array<{ group: WorkbenchGroup; reports: DamageReport[] }> {
  const buckets = new Map<WorkbenchGroup, DamageReport[]>(WORKBENCH_GROUPS.map((g) => [g, []]));
  const add = (group: WorkbenchGroup, report: DamageReport) => buckets.get(group)!.push(report);
  const overdue: DamageReport[] = [];
  const moving: DamageReport[] = [];
  for (const report of reports) {
    switch (report.status) {
      case 'on_hold':
        add('to_inspect', report);
        break;
      case 'awaiting_keys':
        add(callerTurnedAKey(report, callerUserId) ? 'sent_on' : 'awaiting_your_key', report);
        break;
      case 'escalated':
        add(callerTurnedAKey(report, callerUserId) ? 'sent_on' : 'with_ceo', report);
        break;
      case 'outcome_final':
        add('record_erp', report);
        break;
      case 'cleared':
      case 'closed':
        add('closed', report);
        break;
    }
    if (report.whole_lot_requested && report.whole_lot_decision === null) add('whole_lot', report);
    if (isExternalCheckOverdue(report, today)) overdue.push(report);
    else if (
      report.physical_state === 'awaiting_arrival' ||
      report.physical_state === 'at_external_check' ||
      releasedInQuarantine(report)
    ) {
      moving.push(report);
    }
  }
  buckets.set('units_to_move', [...overdue, ...moving]);
  return WORKBENCH_GROUPS.map((group) => ({ group, reports: buckets.get(group)! }));
}

export function concurredCount(report: DamageReport): number {
  return (
    (report.qc_key_status === 'turned' ? 1 : 0) + (report.finance_key_status === 'turned' ? 1 : 0)
  );
}

/** Table 6: the four outcomes. */
export const DAMAGE_OUTCOMES = [
  'debit_note',
  'return_for_replacement',
  'write_off',
  'accept_as_is_price_reduction',
] as const;
export type DamageOutcome = (typeof DAMAGE_OUTCOMES)[number];

/** The server's defect catalogue (config.qc.defectCodes, Story 8.5). */
export const DEFECT_CODES = [
  'DIMENSIONAL',
  'SURFACE_FINISH',
  'MATERIAL_NONCONFORMITY',
  'CONTAMINATION',
  'ASSEMBLY',
  'FUNCTIONAL',
  'MARKING_LABELLING',
  'PACKAGING',
  'CORROSION',
  'DOCUMENTATION',
] as const;

// Same rule as the server (src/compliance/damage.ts PCT_REGEX).
const PCT_REGEX = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;

/** accept-as-is needs a percentage above 0 and at most 100; the other outcomes none. */
export function isPriceReductionPct(value: string): boolean {
  if (!PCT_REGEX.test(value)) return false;
  const n = Number(value);
  return n > 0 && n <= 100;
}
