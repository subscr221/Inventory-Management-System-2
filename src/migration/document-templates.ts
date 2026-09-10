import { AppError } from '../middleware/error.js';
import type { MigrationDocumentDomain, MigrationDomain } from '../events/schema.js';

/**
 * Story 13.2 (FR-DM-02): the document-domain manifest template contracts.
 *
 * A manifest is the SOURCE side of a domain verification: the legacy extract listing what the
 * module epic's migration path should have produced. Column ORDER and NAMES are the version
 * (Story 13.1 Binding Decision 11): a file whose trimmed header does not match byte-for-byte is
 * refused whole with 400 TEMPLATE_VERSION_UNSUPPORTED. A second version is a second constant.
 *
 * The four pilot domains are a constant. A later wave (Epic 10 loan registers, Epic 4 native POs)
 * adds a source KIND behind the same domain name, not a new mechanism.
 */

export const MIGRATION_DOCUMENT_DOMAINS = [
  'active_boms',
  'open_pos',
  'jobwork_challans',
  'custody_registers',
] as const satisfies readonly MigrationDocumentDomain[];

export const MIGRATION_DOMAINS = [
  'opening_stock',
  ...MIGRATION_DOCUMENT_DOMAINS,
] as const satisfies readonly MigrationDomain[];

export type DocumentDomain = (typeof MIGRATION_DOCUMENT_DOMAINS)[number];

export function isDocumentDomain(value: unknown): value is DocumentDomain {
  return (
    typeof value === 'string' && (MIGRATION_DOCUMENT_DOMAINS as readonly string[]).includes(value)
  );
}

/**
 * Binding Decision 6: RBAC has no department; assignments have a module. The sign-off of a domain
 * requires the department-head role with a WRITE assignment on the module whose routes own the
 * documents, at the site (or '*'). An engineering head signs BOMs, a procurement head signs POs, a
 * job-work head signs challans and custody.
 */
export const DOMAIN_MODULE: Readonly<Record<DocumentDomain, string>> = {
  active_boms: 'engineering',
  open_pos: 'procurement',
  jobwork_challans: 'jobwork',
  custody_registers: 'jobwork',
};

export const DOMAIN_SIGNOFF_ROLES: Readonly<Record<DocumentDomain, ReadonlySet<string>>> = {
  active_boms: new Set(['department_head']),
  open_pos: new Set(['department_head']),
  jobwork_challans: new Set(['department_head']),
  custody_registers: new Set(['department_head']),
};

export const ACTIVE_BOMS_TEMPLATE_V1 = [
  'site_code',
  'kit_ref',
  'parent_sku',
  'revision_code',
  'component_sku',
  'quantity_per',
  'line_uom',
] as const;

export const OPEN_POS_TEMPLATE_V1 = [
  'site_code',
  'po_number_ext',
  'line_no',
  'sku',
  'supplier_ref_ext',
  'ordered_qty',
  'received_qty',
  'open_qty',
  'over_receipt_tolerance_pct',
  'under_receipt_tolerance_pct',
] as const;

export const JOBWORK_CHALLANS_TEMPLATE_V1 = [
  'site_code',
  'challan_number_ext',
  'challan_date',
  'order_number_ext',
  'customer_party_code',
  'sku',
  'challan_qty',
  'uom',
  'challan_class',
] as const;

export const CUSTODY_REGISTERS_TEMPLATE_V1 = [
  'site_code',
  'order_number_ext',
  'customer_party_code',
  'sku',
  'custody_qty',
  'uom',
] as const;

export const DOCUMENT_TEMPLATES: Readonly<
  Record<DocumentDomain, Readonly<Record<string, readonly string[]>>>
> = {
  active_boms: { v1: ACTIVE_BOMS_TEMPLATE_V1 },
  open_pos: { v1: OPEN_POS_TEMPLATE_V1 },
  jobwork_challans: { v1: JOBWORK_CHALLANS_TEMPLATE_V1 },
  custody_registers: { v1: CUSTODY_REGISTERS_TEMPLATE_V1 },
};

/** The line_ref separator for domains whose line identity is composite. */
export const LINE_REF_SEPARATOR = '|';

export const CHALLAN_CLASSES = new Set(['input', 'capital_goods']);

const NUMERIC_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_INT_REGEX = /^[1-9]\d{0,8}$/;

export function assertDocumentTemplateHeader(
  domain: DocumentDomain,
  templateVersion: unknown,
  header: readonly string[],
): readonly string[] {
  const templates = DOCUMENT_TEMPLATES[domain];
  const expected = typeof templateVersion === 'string' ? templates[templateVersion] : undefined;
  if (!expected) {
    throw new AppError(
      400,
      'TEMPLATE_VERSION_UNSUPPORTED',
      `template_version must be one of ${Object.keys(templates).join(', ')} for domain ${domain}`,
      {
        domain,
        template_version: templateVersion ?? null,
        supported_versions: Object.keys(templates),
      },
    );
  }
  const received = header.map((h) => h.trim());
  const matches =
    received.length === expected.length && received.every((h, i) => h === expected[i]);
  if (!matches) {
    throw new AppError(
      400,
      'TEMPLATE_VERSION_UNSUPPORTED',
      `The file header does not match template ${String(templateVersion)} for domain ${domain}`,
      {
        domain,
        template_version: templateVersion,
        expected_header: [...expected],
        received_header: received,
      },
    );
  }
  return expected;
}

export interface ManifestRowShape {
  site_code: string;
  document_ref_ext: string;
  line_ref: string;
  sku: string | null;
  quantity: string | null;
  attributes: Record<string, string | null>;
}

export type ManifestRowResult =
  | { ok: true; row: ManifestRowShape }
  | { ok: false; column: string | null; reason: string; extra?: Record<string, unknown> };

function cellsOf(columns: readonly string[], cells: readonly string[]): Record<string, string> {
  const row: Record<string, string> = {};
  columns.forEach((c, i) => {
    row[c] = (cells[i] ?? '').trim();
  });
  return row;
}

function bad(
  column: string | null,
  reason: string,
  extra?: Record<string, unknown>,
): ManifestRowResult {
  return extra ? { ok: false, column, reason, extra } : { ok: false, column, reason };
}

function requireNonEmpty(row: Record<string, string>, columns: string[]): ManifestRowResult | null {
  for (const c of columns) if (!row[c]) return bad(c, 'empty');
  return null;
}

function requireNumeric(
  row: Record<string, string>,
  column: string,
  opts: { positive?: boolean; optional?: boolean } = {},
): ManifestRowResult | null {
  const v = row[column] ?? '';
  if (!v) return opts.optional ? null : bad(column, 'empty');
  if (!NUMERIC_REGEX.test(v)) return bad(column, 'not_numeric');
  if (opts.positive && Number(v) <= 0) return bad(column, 'not_positive_numeric');
  return null;
}

/**
 * Typed parse of one manifest row for a domain. Only the CELL SHAPE is checked here (Binding
 * Decision 2): item, PO, order and challan references are resolved by the verification run so a
 * manifest row for a document the platform lacks is reported as `missing_in_platform`, never
 * silently rejected at import.
 */
export function toManifestRow(domain: DocumentDomain, cells: readonly string[]): ManifestRowResult {
  const columns = DOCUMENT_TEMPLATES[domain]['v1']!;
  const row = cellsOf(columns, cells);
  switch (domain) {
    case 'active_boms': {
      const missing = requireNonEmpty(row, [
        'site_code',
        'kit_ref',
        'parent_sku',
        'component_sku',
        'line_uom',
      ]);
      if (missing) return missing;
      const q = requireNumeric(row, 'quantity_per', { positive: true });
      if (q) return q;
      return {
        ok: true,
        row: {
          site_code: row['site_code']!,
          document_ref_ext: row['kit_ref']!,
          line_ref: row['component_sku']!,
          sku: row['component_sku']!,
          quantity: row['quantity_per']!,
          attributes: {
            parent_sku: row['parent_sku']!,
            revision_code: row['revision_code'] || null,
            line_uom: row['line_uom']!,
            quantity_per: row['quantity_per']!,
          },
        },
      };
    }
    case 'open_pos': {
      const missing = requireNonEmpty(row, ['site_code', 'po_number_ext', 'line_no', 'sku']);
      if (missing) return missing;
      if (!POSITIVE_INT_REGEX.test(row['line_no']!)) return bad('line_no', 'not_positive_integer');
      for (const c of ['ordered_qty', 'received_qty', 'open_qty']) {
        const r = requireNumeric(row, c);
        if (r) return r;
      }
      for (const c of ['over_receipt_tolerance_pct', 'under_receipt_tolerance_pct']) {
        const r = requireNumeric(row, c, { optional: true });
        if (r) return r;
      }
      return {
        ok: true,
        row: {
          site_code: row['site_code']!,
          document_ref_ext: row['po_number_ext']!,
          line_ref: String(Number(row['line_no'])),
          sku: row['sku']!,
          quantity: row['open_qty']!,
          attributes: {
            supplier_ref_ext: row['supplier_ref_ext'] || null,
            ordered_qty: row['ordered_qty']!,
            received_qty: row['received_qty']!,
            open_qty: row['open_qty']!,
            over_receipt_tolerance_pct: row['over_receipt_tolerance_pct'] || null,
            under_receipt_tolerance_pct: row['under_receipt_tolerance_pct'] || null,
          },
        },
      };
    }
    case 'jobwork_challans': {
      const missing = requireNonEmpty(row, [
        'site_code',
        'challan_number_ext',
        'challan_date',
        'order_number_ext',
        'customer_party_code',
        'sku',
        'uom',
        'challan_class',
      ]);
      if (missing) return missing;
      const d = row['challan_date']!;
      if (!DATE_REGEX.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
        return bad('challan_date', 'not_iso_date');
      }
      const q = requireNumeric(row, 'challan_qty', { positive: true });
      if (q) return q;
      if (!CHALLAN_CLASSES.has(row['challan_class']!)) {
        return bad('challan_class', 'unknown_class', { allowed: [...CHALLAN_CLASSES] });
      }
      return {
        ok: true,
        row: {
          site_code: row['site_code']!,
          document_ref_ext: row['challan_number_ext']!,
          line_ref: `${row['order_number_ext']}${LINE_REF_SEPARATOR}${row['sku']}`,
          sku: row['sku']!,
          quantity: row['challan_qty']!,
          attributes: {
            challan_date: d,
            order_number_ext: row['order_number_ext']!,
            customer_party_code: row['customer_party_code']!,
            challan_qty: row['challan_qty']!,
            uom: row['uom']!,
            challan_class: row['challan_class']!,
          },
        },
      };
    }
    case 'custody_registers': {
      const missing = requireNonEmpty(row, [
        'site_code',
        'order_number_ext',
        'customer_party_code',
        'sku',
        'uom',
      ]);
      if (missing) return missing;
      const q = requireNumeric(row, 'custody_qty');
      if (q) return q;
      return {
        ok: true,
        row: {
          site_code: row['site_code']!,
          document_ref_ext: row['order_number_ext']!,
          line_ref: row['sku']!,
          sku: row['sku']!,
          quantity: row['custody_qty']!,
          attributes: {
            customer_party_code: row['customer_party_code']!,
            custody_qty: row['custody_qty']!,
            uom: row['uom']!,
          },
        },
      };
    }
    default:
      return bad(null, 'unsupported_domain');
  }
}
