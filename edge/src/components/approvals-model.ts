/**
 * Story 4.12 (Task 3.1): pure helpers for the approvals inbox and requisition approval detail.
 * Everything here is string and data shaping; the screen owns fetching and state.
 */

export interface ApproverBand {
  role: string;
  value_min: number | null;
  value_max: number | null;
}

/** A row of `GET /api/v1/indents?pending_for_me=true` or `?decided_by_me=true`. */
export interface ApprovalRow {
  indent_id: string;
  indent_number_ext: string;
  status: string;
  estimated_value: string | null;
  created_at: string;
  requester_display_name: string | null;
  pending_for_me_line_ids: string[];
  line_skus: string[];
  approved_line_count?: number;
  /** Story 4.13: the newest approver question; the row stays Waiting. */
  info_requested?: { question: string; asked_at: string } | null;
}

/** A line of `GET /api/v1/indents/:indentId` as the detail reads it. */
export interface ApprovalLine {
  indent_line_id: string;
  line_no: number;
  sku: string;
  requested_qty: string;
  uom: string;
  line_value: string;
  approval_route: 'doa' | 'standing_approval' | 'self_approval';
  line_status: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  decided_by_display_name: string | null;
  rejection_reason: string | null;
  standing_grant_ref: string | null;
  cap: string | null;
  month_to_date_issued: string | null;
  approver_band: ApproverBand | null;
}

/** An entry of `info_requests[]` on the indent detail, newest first (Story 4.13). */
export interface InfoRequest {
  info_request_id: string;
  line_ids: string[];
  question: string;
  asked_by: string | null;
  asked_at: string;
}

/** Ask for info only where a DOA approver holds a pending line (standing or self lines have none). */
export function canAskInfo(lines: ApprovalLine[], pendingIds: string[]): boolean {
  return lines.some((l) => pendingIds.includes(l.indent_line_id) && l.approval_route === 'doa');
}

export type RowStatus = 'waiting' | 'approved' | 'rejected';
export type Tab = 'waiting' | 'decided' | 'all';

export function isApprovalRow(value: unknown): value is ApprovalRow {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['indent_id'] === 'string' &&
    typeof r['indent_number_ext'] === 'string' &&
    Array.isArray(r['pending_for_me_line_ids']) &&
    Array.isArray(r['line_skus'])
  );
}

/** Waiting rows first, then decided ones not already listed; each half keeps the server order. */
export function mergeAll(waiting: ApprovalRow[], decided: ApprovalRow[]): ApprovalRow[] {
  const seen = new Set(waiting.map((r) => r.indent_id));
  return [...waiting, ...decided.filter((r) => !seen.has(r.indent_id))];
}

/**
 * Waiting while a line is pending for the caller; otherwise the header outcome.
 * shortcut: a header with some approved lines reads Approved even if the caller rejected theirs;
 * the detail shows each line's own outcome. Upgrade when the list carries per-line decisions.
 */
export function rowStatus(row: ApprovalRow): RowStatus {
  if (row.pending_for_me_line_ids.length > 0) return 'waiting';
  if (row.status === 'rejected') return 'rejected';
  return (row.approved_line_count ?? 0) > 0 || row.status === 'approved' ? 'approved' : 'rejected';
}

export function matchesSearch(row: ApprovalRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.indent_number_ext, row.requester_display_name ?? '', ...row.line_skus].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/** Rupees with Indian digit grouping (1,00,000), no paise when whole. */
export function formatRupees(value: string | number | null): string {
  if (value === null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);
}

/** Age as one unit: minutes under an hour, hours under a day, else days. */
export function ageOf(createdAt: string, now: number): { unit: 'm' | 'h' | 'd'; n: number } {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60000));
  if (minutes < 60) return { unit: 'm', n: minutes };
  if (minutes < 1440) return { unit: 'h', n: Math.floor(minutes / 60) };
  return { unit: 'd', n: Math.floor(minutes / 1440) };
}

/** A DOA role as people say it; unknown roles are shown with spaces for underscores. */
export function roleLabel(role: string): string {
  if (role.startsWith('department_head')) return 'head of department';
  if (role.startsWith('finance_controller')) return 'finance controller';
  return role.replace(/_/g, ' ');
}

export interface ChipDescriptor {
  kind: 'ok' | 'info' | 'warn';
  text: string;
}

/** Templates come from the catalogue so the model stays string-free. */
export interface ChipTemplates {
  standing: string; // "Standing approval {ref}"
  standingCap: string; // "{used} of {cap} used this month"
  selfLimit: string; // "Self-approval limit"
  doa: string; // "{role} approval"
  doaUnknown: string; // "DOA approval"
}

/** DESIGN.md:302-304: standing approval ok, self-approval limit info, DOA approval warn. */
export function routeChip(line: ApprovalLine, tpl: ChipTemplates): ChipDescriptor {
  if (line.approval_route === 'standing_approval') {
    const head = tpl.standing.replace('{ref}', line.standing_grant_ref ?? '');
    const cap =
      line.cap !== null
        ? ` - ${tpl.standingCap
            .replace('{used}', trimQty(line.month_to_date_issued ?? '0'))
            .replace('{cap}', trimQty(line.cap))}`
        : '';
    return { kind: 'ok', text: head + cap };
  }
  if (line.approval_route === 'self_approval') return { kind: 'info', text: tpl.selfLimit };
  const band = line.approver_band;
  if (!band) return { kind: 'warn', text: tpl.doaUnknown };
  const role = roleLabel(band.role);
  return { kind: 'warn', text: tpl.doa.replace('{role}', role[0]!.toUpperCase() + role.slice(1)) };
}

/** "6.000" reads "6". */
function trimQty(qty: string): string {
  const n = Number(qty);
  return Number.isFinite(n) ? String(n) : qty;
}

export interface BandTemplates {
  upTo: string; // "Your DOA band as {role}: up to Rs {max}"
  above: string; // "Your DOA band as {role}: above Rs {min}"
}

/** The inbox band line from the caller's held bands; null hides it. */
export function bandLine(bands: ApproverBand[], tpl: BandTemplates): string | null {
  const band = bands[0];
  if (!band) return null;
  const role = roleLabel(band.role);
  if (band.value_max !== null) {
    return tpl.upTo.replace('{role}', role).replace('{max}', formatRupees(band.value_max));
  }
  return tpl.above.replace('{role}', role).replace('{min}', formatRupees(band.value_min ?? 0));
}

export interface NoteTemplates {
  upTo: string; // "Routed to you as {role} by value band (up to Rs {max})"
  above: string; // "Routed to you as {role} by value band (above Rs {min})"
  headRole: string; // "the requester's head of department"
}

/**
 * The DOA note: why the requisition reached the caller, from the first line pending for them.
 * shortcut: a delegate reads the delegator's wording ("as the requester's head of department");
 * add an acting-for sentence when the UX owner supplies the copy.
 */
export function doaNote(
  lines: ApprovalLine[],
  pendingIds: string[],
  tpl: NoteTemplates,
): string | null {
  const band = lines.find((l) => pendingIds.includes(l.indent_line_id))?.approver_band;
  if (!band) return null;
  const role = band.role.startsWith('department_head') ? tpl.headRole : roleLabel(band.role);
  if (band.value_max !== null) {
    return tpl.upTo.replace('{role}', role).replace('{max}', formatRupees(band.value_max));
  }
  return tpl.above.replace('{role}', role).replace('{min}', formatRupees(band.value_min ?? 0));
}

/** Evidence total, summed as paise to avoid float drift. */
export function totalValue(lines: ApprovalLine[]): string {
  const paise = lines.reduce((sum, l) => sum + Math.round(Number(l.line_value) * 100), 0);
  return (paise / 100).toFixed(2);
}
