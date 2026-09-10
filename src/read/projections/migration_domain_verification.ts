import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  MigrationDocumentDomain,
  MigrationDomainFinding,
  MigrationFindingKind,
} from '../../events/schema.js';
import {
  LINE_REF_SEPARATOR,
  MIGRATION_DOCUMENT_DOMAINS,
  type DocumentDomain,
} from '../../migration/document-templates.js';

/**
 * Story 13.2 (FR-DM-02): domain verification, one dispatcher, one SQL block per domain, one shared
 * post-processor, and the ONE status derivation Story 13.3 imports.
 *
 * Source = the latest manifest load (migration_document_manifest_row). Platform = what the module
 * epic's migration path produced: legacy-kit `bom` rows (Story 5.2), `erp_purchase_order[_line]`
 * projections (Story 2.9), `jobwork_material_receipt` with its `jobwork_return_clock` (Stories
 * 9.2, 9.5) and the customer-ownership balance of `custody_ledger_entry` (Story 9.3).
 *
 * Quantities are compared as canonical decimal STRINGS (no JS floats): `canonicalNumeric` strips
 * the sign-less NUMERIC text PostgreSQL returns to a form where "1.0", "1.000" and "1" agree.
 *
 * A document with any `unknown_reference` finding is QUARANTINED: it is excluded from
 * migrated_count, its other findings are still listed, and quarantined_count counts documents
 * (distinct document_ref_ext + line_ref pairs), not findings. mismatch_count counts findings of
 * the other four kinds.
 */

type Queryable = Pick<PoolClient, 'query'>;

export interface DomainFindingsResult {
  source_count: number;
  migrated_count: number;
  quarantined_count: number;
  mismatch_count: number;
  findings: MigrationDomainFinding[];
}

export interface ComputeOptions {
  /**
   * Open Question 1: `bom` and `erp_purchase_order` carry no site, so `missing_in_source` for
   * those two domains is enterprise-wide unless the run names a document-reference prefix.
   */
  document_ref_prefix?: string | null;
}

export const DOC_LEVEL_LINE_REF = '-';

/** "1.500000" and "1.5" and "1" versus "1.0" compare equal; null stays null. */
export function canonicalNumeric(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [intRaw, fracRaw = ''] = body.split('.');
  const int = (intRaw ?? '').replace(/^0+(?=\d)/, '') || '0';
  const frac = fracRaw.replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return negative && out !== '0' ? `-${out}` : out;
}

function textEq(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function numEq(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalNumeric(a) === canonicalNumeric(b);
}

interface FindingInput {
  kind: MigrationFindingKind;
  document_ref_ext: string;
  line_ref: string;
  platform_ref?: string | null;
  field?: string | null;
  source_value?: string | null;
  platform_value?: string | null;
  details?: Record<string, unknown>;
}

class FindingSink {
  readonly findings: MigrationDomainFinding[] = [];
  private readonly seen = new Set<string>();

  add(input: FindingInput): void {
    const field = input.field ?? null;
    const key = [input.kind, input.document_ref_ext, input.line_ref, field ?? ''].join('');
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.findings.push({
      finding_id: randomUUID(),
      kind: input.kind,
      error_code:
        input.kind === 'unknown_reference' ? 'UNKNOWN_REFERENCE' : 'RECONCILIATION_MISMATCH',
      document_ref_ext: input.document_ref_ext,
      line_ref: input.line_ref,
      platform_ref: input.platform_ref ?? null,
      field,
      source_value: input.source_value ?? null,
      platform_value: input.platform_value ?? null,
      details: input.details ?? {},
    });
  }

  /** Records a field_mismatch when the two sides differ; `numeric` picks the comparison. */
  compare(
    base: Omit<FindingInput, 'kind' | 'field' | 'source_value' | 'platform_value'>,
    field: string,
    source: string | null | undefined,
    platform: string | null | undefined,
    numeric: boolean,
  ): void {
    const equal = numeric ? numEq(source, platform) : textEq(source, platform);
    if (equal) return;
    this.add({
      ...base,
      kind: 'field_mismatch',
      field,
      source_value: source ?? null,
      platform_value: platform ?? null,
    });
  }
}

interface ManifestRow {
  document_ref_ext: string;
  line_ref: string;
  sku: string | null;
  quantity: string | null;
  attributes: Record<string, string | null>;
}

async function loadManifest(loadId: string, client: Queryable): Promise<ManifestRow[]> {
  const r = await client.query(
    `SELECT document_ref_ext, line_ref, sku, quantity::text AS quantity, attributes
       FROM migration_document_manifest_row WHERE load_id = $1 ORDER BY line_no`,
    [loadId],
  );
  return r.rows as ManifestRow[];
}

function prefixClause(column: string, prefix: string | null | undefined, param: number): string {
  return prefix ? ` AND ${column} LIKE $${param} || '%'` : '';
}

// ---------------------------------------------------------------------------
// active_boms (Story 5.2 legacy kits)
// ---------------------------------------------------------------------------

async function computeActiveBoms(
  loadId: string,
  opts: ComputeOptions,
  client: Queryable,
  sink: FindingSink,
): Promise<{ source_count: number; documents: Map<string, string> }> {
  const manifest = await loadManifest(loadId, client);
  const kits = new Map<string, ManifestRow[]>();
  for (const row of manifest) {
    const list = kits.get(row.document_ref_ext) ?? [];
    list.push(row);
    kits.set(row.document_ref_ext, list);
  }
  const kitRefs = [...kits.keys()];
  const boms = await client.query(
    `SELECT b.bom_id, b.kit_ref, b.parent_sku, b.status, b.remediation_flag, b.current_revision_id,
            pim.status AS parent_item_status
       FROM bom b
       LEFT JOIN item_master pim ON pim.item_id = b.parent_item_id
      WHERE b.origin = 'legacy_kit' AND b.kit_ref = ANY($1::text[])
      ORDER BY b.created_at`,
    [kitRefs],
  );
  const lines = await client.query(
    `SELECT l.bom_id, l.component_sku, l.is_placeholder, l.quantity_per::text AS quantity_per,
            l.line_uom, l.component_item_id, im.status AS item_status
       FROM bom_line l
       JOIN bom b ON b.bom_id = l.bom_id AND l.revision_id = b.current_revision_id
       LEFT JOIN item_master im ON im.item_id = l.component_item_id
      WHERE b.origin = 'legacy_kit' AND b.kit_ref = ANY($1::text[])
      ORDER BY l.line_no`,
    [kitRefs],
  );
  const bomByKit = new Map<string, Record<string, unknown>>();
  for (const b of boms.rows as Record<string, unknown>[]) {
    const ref = b['kit_ref'] as string;
    if (!bomByKit.has(ref)) bomByKit.set(ref, b);
  }
  const linesByBom = new Map<string, Record<string, unknown>[]>();
  for (const l of lines.rows as Record<string, unknown>[]) {
    const id = l['bom_id'] as string;
    const list = linesByBom.get(id) ?? [];
    list.push(l);
    linesByBom.set(id, list);
  }

  const documents = new Map<string, string>();
  for (const [kitRef, rows] of kits) {
    documents.set(kitRef, DOC_LEVEL_LINE_REF);
    const bom = bomByKit.get(kitRef);
    const base = { document_ref_ext: kitRef, line_ref: DOC_LEVEL_LINE_REF };
    if (!bom) {
      sink.add({ ...base, kind: 'missing_in_platform', details: { origin: 'legacy_kit' } });
      continue;
    }
    const bomId = bom['bom_id'] as string;
    const withRef = { ...base, platform_ref: bomId };
    if (bom['parent_item_status'] !== 'active') {
      sink.add({
        ...withRef,
        kind: 'unknown_reference',
        details: { reference: 'parent_item_id', item_status: bom['parent_item_status'] ?? null },
      });
    }
    const platformLines = linesByBom.get(bomId) ?? [];
    for (const l of platformLines) {
      if (l['is_placeholder'] === true) continue;
      if (l['item_status'] !== 'active') {
        sink.add({
          ...withRef,
          kind: 'unknown_reference',
          details: {
            reference: 'component_item_id',
            component_sku: l['component_sku'] ?? null,
            item_status: l['item_status'] ?? null,
          },
        });
      }
    }
    if (bom['status'] !== 'released' || bom['remediation_flag'] === true) {
      sink.add({
        ...withRef,
        kind: 'state_mismatch',
        field: 'status',
        source_value: 'released',
        platform_value:
          bom['remediation_flag'] === true ? `${bom['status']}:remediation` : String(bom['status']),
        details: { remediation_flag: bom['remediation_flag'] === true },
      });
    }
    const parentSku = rows[0]?.attributes['parent_sku'] ?? null;
    sink.compare(withRef, 'parent_sku', parentSku, bom['parent_sku'] as string, false);
    const byComponent = new Map<string, Record<string, unknown>>();
    for (const l of platformLines) {
      const sku = l['component_sku'] as string | null;
      if (sku && !byComponent.has(sku)) byComponent.set(sku, l);
    }
    const manifestSkus = new Set<string>();
    for (const row of rows) {
      const sku = row.line_ref;
      manifestSkus.add(sku);
      const lineBase = { document_ref_ext: kitRef, line_ref: sku, platform_ref: bomId };
      const l = byComponent.get(sku);
      if (!l) {
        sink.add({
          ...lineBase,
          kind: 'field_mismatch',
          field: 'component_sku',
          source_value: sku,
          platform_value: null,
          details: { side: 'source_only' },
        });
        continue;
      }
      sink.compare(
        lineBase,
        'quantity_per',
        row.attributes['quantity_per'],
        l['quantity_per'] as string,
        true,
      );
      sink.compare(
        lineBase,
        'line_uom',
        row.attributes['line_uom'],
        l['line_uom'] as string,
        false,
      );
    }
    for (const [sku] of byComponent) {
      if (manifestSkus.has(sku)) continue;
      sink.add({
        document_ref_ext: kitRef,
        line_ref: sku,
        platform_ref: bomId,
        kind: 'field_mismatch',
        field: 'component_sku',
        source_value: null,
        platform_value: sku,
        details: { side: 'platform_only' },
      });
    }
  }

  const extra = await client.query(
    `SELECT bom_id, kit_ref FROM bom
      WHERE origin = 'legacy_kit' AND kit_ref IS NOT NULL AND kit_ref <> ALL($1::text[])
      ${prefixClause('kit_ref', opts.document_ref_prefix, 2)}
      ORDER BY created_at`,
    opts.document_ref_prefix ? [kitRefs, opts.document_ref_prefix] : [kitRefs],
  );
  for (const b of extra.rows as Record<string, unknown>[]) {
    sink.add({
      document_ref_ext: b['kit_ref'] as string,
      line_ref: DOC_LEVEL_LINE_REF,
      platform_ref: b['bom_id'] as string,
      kind: 'missing_in_source',
      details: { origin: 'legacy_kit' },
    });
  }
  return { source_count: kits.size, documents };
}

// ---------------------------------------------------------------------------
// open_pos (Story 2.9 ERP projection)
// ---------------------------------------------------------------------------

async function computeOpenPos(
  loadId: string,
  opts: ComputeOptions,
  client: Queryable,
  sink: FindingSink,
): Promise<{ source_count: number; documents: Map<string, string> }> {
  const r = await client.query(
    `SELECT m.document_ref_ext, m.line_ref, m.sku AS m_sku, m.attributes,
            l.sku AS p_sku, l.ordered_qty::text AS p_ordered_qty, l.open_qty::text AS p_open_qty,
            (l.ordered_qty - l.open_qty)::text AS p_received_qty,
            l.over_receipt_tolerance_pct::text AS p_over, l.under_receipt_tolerance_pct::text AS p_under,
            h.status AS h_status, h.supplier_ref_ext AS p_supplier, im.status AS item_status,
            (l.po_number_ext IS NOT NULL) AS has_line
       FROM migration_document_manifest_row m
       LEFT JOIN erp_purchase_order_line l
         ON l.po_number_ext = m.document_ref_ext AND l.line_no = m.line_ref::int
       LEFT JOIN erp_purchase_order h ON h.po_number_ext = l.po_number_ext
       LEFT JOIN item_master im ON im.sku = l.sku
      WHERE m.load_id = $1
      ORDER BY m.line_no`,
    [loadId],
  );
  const documents = new Map<string, string>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const ref = row['document_ref_ext'] as string;
    const lineRef = row['line_ref'] as string;
    documents.set(`${ref}${LINE_REF_SEPARATOR}${lineRef}`, lineRef);
    const attrs = row['attributes'] as Record<string, string | null>;
    const base = { document_ref_ext: ref, line_ref: lineRef, platform_ref: `${ref}:${lineRef}` };
    if (row['has_line'] !== true || row['h_status'] !== 'open') {
      sink.add({
        ...base,
        kind: 'missing_in_platform',
        details: { header_status: row['h_status'] ?? null },
      });
      continue;
    }
    if (row['item_status'] !== 'active') {
      sink.add({
        ...base,
        kind: 'unknown_reference',
        details: { reference: 'sku', sku: row['p_sku'], item_status: row['item_status'] ?? null },
      });
    }
    sink.compare(base, 'sku', row['m_sku'] as string, row['p_sku'] as string, false);
    sink.compare(base, 'ordered_qty', attrs['ordered_qty'], row['p_ordered_qty'] as string, true);
    sink.compare(base, 'open_qty', attrs['open_qty'], row['p_open_qty'] as string, true);
    sink.compare(
      base,
      'received_qty',
      attrs['received_qty'],
      row['p_received_qty'] as string,
      true,
    );
    sink.compare(
      base,
      'over_receipt_tolerance_pct',
      attrs['over_receipt_tolerance_pct'],
      row['p_over'] as string | null,
      true,
    );
    sink.compare(
      base,
      'under_receipt_tolerance_pct',
      attrs['under_receipt_tolerance_pct'],
      row['p_under'] as string | null,
      true,
    );
    sink.compare(
      base,
      'supplier_ref_ext',
      attrs['supplier_ref_ext'],
      row['p_supplier'] as string,
      false,
    );
  }
  const extra = await client.query(
    `SELECT l.po_number_ext, l.line_no
       FROM erp_purchase_order_line l
       JOIN erp_purchase_order h ON h.po_number_ext = l.po_number_ext AND h.status = 'open'
      WHERE NOT EXISTS (
              SELECT 1 FROM migration_document_manifest_row m
               WHERE m.load_id = $1 AND m.document_ref_ext = l.po_number_ext
                 AND m.line_ref = l.line_no::text)
      ${prefixClause('l.po_number_ext', opts.document_ref_prefix, 2)}
      ORDER BY l.po_number_ext, l.line_no`,
    opts.document_ref_prefix ? [loadId, opts.document_ref_prefix] : [loadId],
  );
  for (const l of extra.rows as Record<string, unknown>[]) {
    const ref = l['po_number_ext'] as string;
    const lineRef = String(l['line_no']);
    sink.add({
      document_ref_ext: ref,
      line_ref: lineRef,
      platform_ref: `${ref}:${lineRef}`,
      kind: 'missing_in_source',
      details: {},
    });
  }
  return { source_count: r.rows.length, documents };
}

// ---------------------------------------------------------------------------
// jobwork_challans (Stories 9.2, 9.5)
// ---------------------------------------------------------------------------

interface ReceiptRow {
  receipt_id: string;
  challan_number_ext: string;
  challan_date: string;
  challan_qty: string;
  uom: string;
  challan_class: string;
  sku: string;
  lot_id: string | null;
  service_order_id: string;
  order_number_ext: string | null;
  customer_party_code: string | null;
  item_status: string | null;
  lot_ok: boolean;
  grn_ok: boolean;
  clock_date: string | null;
}

async function computeJobworkChallans(
  siteId: string,
  loadId: string,
  client: Queryable,
  sink: FindingSink,
): Promise<{ source_count: number; documents: Map<string, string> }> {
  const manifest = await loadManifest(loadId, client);
  const receipts = await client.query(
    `SELECT r.receipt_id, r.challan_number_ext, r.challan_date::text AS challan_date,
            r.challan_qty::text AS challan_qty, r.uom, r.challan_class, r.sku, r.lot_id,
            r.service_order_id, so.order_number_ext, so.customer_party_code,
            im.status AS item_status,
            (r.lot_id IS NULL OR EXISTS (SELECT 1 FROM lot_master lm WHERE lm.lot_number = r.lot_id)) AS lot_ok,
            EXISTS (SELECT 1 FROM grn_line gl WHERE gl.grn_line_id = r.grn_line_id) AS grn_ok,
            c.challan_date::text AS clock_date
       FROM jobwork_material_receipt r
       LEFT JOIN service_order so ON so.service_order_id = r.service_order_id
       LEFT JOIN item_master im ON im.sku = r.sku
       LEFT JOIN jobwork_return_clock c ON c.receipt_id = r.receipt_id
      WHERE r.site_id = $1
      ORDER BY r.created_at`,
    [siteId],
  );
  const byKey = new Map<string, ReceiptRow>();
  const orphans: ReceiptRow[] = [];
  for (const row of receipts.rows as ReceiptRow[]) {
    if (row.order_number_ext === null) {
      orphans.push(row);
      continue;
    }
    const key = [row.challan_number_ext, row.order_number_ext, row.sku].join(LINE_REF_SEPARATOR);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const referentialFindings = (row: ReceiptRow, base: FindingInput): void => {
    if (row.item_status !== 'active') {
      sink.add({
        ...base,
        kind: 'unknown_reference',
        details: { reference: 'sku', sku: row.sku, item_status: row.item_status },
      });
    }
    if (!row.lot_ok) {
      sink.add({
        ...base,
        kind: 'unknown_reference',
        details: { reference: 'lot_id', lot_id: row.lot_id },
      });
    }
    if (!row.grn_ok) {
      sink.add({ ...base, kind: 'unknown_reference', details: { reference: 'grn_line_id' } });
    }
  };

  const documents = new Map<string, string>();
  const matched = new Set<string>();
  for (const m of manifest) {
    const key = `${m.document_ref_ext}${LINE_REF_SEPARATOR}${m.line_ref}`;
    documents.set(key, m.line_ref);
    const base: FindingInput = {
      kind: 'missing_in_platform',
      document_ref_ext: m.document_ref_ext,
      line_ref: m.line_ref,
    };
    const row = byKey.get(key);
    if (!row) {
      sink.add({ ...base, details: { order_number_ext: m.attributes['order_number_ext'] } });
      continue;
    }
    matched.add(row.receipt_id);
    const withRef = { ...base, platform_ref: row.receipt_id };
    referentialFindings(row, withRef);
    sink.compare(withRef, 'challan_date', m.attributes['challan_date'], row.challan_date, false);
    sink.compare(withRef, 'challan_qty', m.attributes['challan_qty'], row.challan_qty, true);
    sink.compare(withRef, 'uom', m.attributes['uom'], row.uom, false);
    sink.compare(withRef, 'challan_class', m.attributes['challan_class'], row.challan_class, false);
    sink.compare(
      withRef,
      'customer_party_code',
      m.attributes['customer_party_code'],
      row.customer_party_code,
      false,
    );
    if (row.clock_date === null || !textEq(row.clock_date, row.challan_date)) {
      sink.add({
        ...withRef,
        kind: 'state_mismatch',
        field: 'return_clock',
        source_value: m.attributes['challan_date'] ?? null,
        platform_value: row.clock_date,
        details: { reason: row.clock_date === null ? 'no_return_clock' : 'clock_date_differs' },
      });
    }
  }
  for (const row of byKey.values()) {
    if (matched.has(row.receipt_id)) continue;
    const lineRef = `${row.order_number_ext}${LINE_REF_SEPARATOR}${row.sku}`;
    const base: FindingInput = {
      kind: 'missing_in_source',
      document_ref_ext: row.challan_number_ext,
      line_ref: lineRef,
      platform_ref: row.receipt_id,
    };
    sink.add({ ...base, details: {} });
    referentialFindings(row, base);
  }
  for (const row of orphans) {
    sink.add({
      kind: 'unknown_reference',
      document_ref_ext: row.challan_number_ext,
      line_ref: `${DOC_LEVEL_LINE_REF}${LINE_REF_SEPARATOR}${row.sku}`,
      platform_ref: row.receipt_id,
      details: { reference: 'service_order_id', service_order_id: row.service_order_id },
    });
  }
  return { source_count: manifest.length, documents };
}

// ---------------------------------------------------------------------------
// custody_registers (Story 9.3 custody ledger, customer ownership)
// ---------------------------------------------------------------------------

async function computeCustodyRegisters(
  siteId: string,
  loadId: string,
  client: Queryable,
  sink: FindingSink,
): Promise<{ source_count: number; documents: Map<string, string> }> {
  const manifest = await loadManifest(loadId, client);
  const balances = await client.query(
    `SELECT so.service_order_id, so.order_number_ext, so.customer_party_code, e.sku,
            sum(e.quantity_delta)::text AS balance, min(e.uom) AS uom,
            bool_or(im.status IS DISTINCT FROM 'active') AS item_bad,
            bool_or(e.location_id IS NOT NULL AND lr.location_id IS NULL) AS location_bad
       FROM custody_ledger_entry e
       JOIN service_order so ON so.service_order_id = e.service_order_id
       LEFT JOIN item_master im ON im.sku = e.sku
       LEFT JOIN location_register lr ON lr.location_id = e.location_id
      WHERE e.site_id = $1 AND e.ownership = 'customer'
      GROUP BY so.service_order_id, so.order_number_ext, so.customer_party_code, e.sku
      ORDER BY so.order_number_ext, e.sku`,
    [siteId],
  );
  const orphans = await client.query(
    `SELECT e.service_order_id, e.sku, count(*)::int AS n
       FROM custody_ledger_entry e
      WHERE e.site_id = $1 AND e.ownership = 'customer'
        AND NOT EXISTS (SELECT 1 FROM service_order so WHERE so.service_order_id = e.service_order_id)
      GROUP BY e.service_order_id, e.sku`,
    [siteId],
  );
  const byKey = new Map<string, Record<string, unknown>>();
  for (const b of balances.rows as Record<string, unknown>[]) {
    byKey.set(`${b['order_number_ext']}${LINE_REF_SEPARATOR}${b['sku']}`, b);
  }
  const documents = new Map<string, string>();
  const matched = new Set<string>();
  const referential = (b: Record<string, unknown>, base: FindingInput): void => {
    if (b['item_bad'] === true) {
      sink.add({
        ...base,
        kind: 'unknown_reference',
        details: { reference: 'sku', sku: b['sku'] },
      });
    }
    if (b['location_bad'] === true) {
      sink.add({ ...base, kind: 'unknown_reference', details: { reference: 'location_id' } });
    }
  };
  for (const m of manifest) {
    const key = `${m.document_ref_ext}${LINE_REF_SEPARATOR}${m.line_ref}`;
    documents.set(key, m.line_ref);
    const base: FindingInput = {
      kind: 'missing_in_platform',
      document_ref_ext: m.document_ref_ext,
      line_ref: m.line_ref,
    };
    const b = byKey.get(key);
    if (!b) {
      sink.add({ ...base, details: { customer_party_code: m.attributes['customer_party_code'] } });
      continue;
    }
    matched.add(key);
    const withRef = { ...base, platform_ref: b['service_order_id'] as string };
    referential(b, withRef);
    sink.compare(withRef, 'custody_qty', m.attributes['custody_qty'], b['balance'] as string, true);
    sink.compare(withRef, 'uom', m.attributes['uom'], b['uom'] as string, false);
    sink.compare(
      withRef,
      'customer_party_code',
      m.attributes['customer_party_code'],
      b['customer_party_code'] as string,
      false,
    );
  }
  for (const [key, b] of byKey) {
    if (matched.has(key)) continue;
    if (canonicalNumeric(b['balance'] as string) === '0') continue;
    const base: FindingInput = {
      kind: 'missing_in_source',
      document_ref_ext: b['order_number_ext'] as string,
      line_ref: b['sku'] as string,
      platform_ref: b['service_order_id'] as string,
    };
    sink.add({ ...base, details: { balance: b['balance'] } });
    referential(b, base);
  }
  for (const o of orphans.rows as Record<string, unknown>[]) {
    sink.add({
      kind: 'unknown_reference',
      document_ref_ext: String(o['service_order_id']),
      line_ref: o['sku'] as string,
      platform_ref: String(o['service_order_id']),
      details: { reference: 'service_order_id', entry_count: o['n'] },
    });
  }
  return { source_count: manifest.length, documents };
}

// ---------------------------------------------------------------------------
// Dispatcher and shared post-processor
// ---------------------------------------------------------------------------

export async function computeDomainFindings(
  domain: DocumentDomain,
  siteId: string,
  loadId: string,
  client: Queryable,
  opts: ComputeOptions = {},
): Promise<DomainFindingsResult> {
  const sink = new FindingSink();
  let result: { source_count: number; documents: Map<string, string> };
  switch (domain) {
    case 'active_boms':
      result = await computeActiveBoms(loadId, opts, client, sink);
      break;
    case 'open_pos':
      result = await computeOpenPos(loadId, opts, client, sink);
      break;
    case 'jobwork_challans':
      result = await computeJobworkChallans(siteId, loadId, client, sink);
      break;
    case 'custody_registers':
      result = await computeCustodyRegisters(siteId, loadId, client, sink);
      break;
    default:
      throw new Error(`Unsupported migration document domain: ${String(domain)}`);
  }
  const findings = sink.findings;
  const quarantined = new Set<string>();
  const touched = new Set<string>();
  for (const f of findings) {
    const docKey =
      domain === 'active_boms'
        ? f.document_ref_ext
        : `${f.document_ref_ext}${LINE_REF_SEPARATOR}${f.line_ref}`;
    touched.add(docKey);
    if (f.kind === 'unknown_reference') quarantined.add(docKey);
  }
  let migrated = 0;
  for (const key of result.documents.keys()) if (!touched.has(key)) migrated += 1;
  return {
    source_count: result.source_count,
    migrated_count: migrated,
    quarantined_count: quarantined.size,
    mismatch_count: findings.filter((f) => f.kind !== 'unknown_reference').length,
    findings,
  };
}

/** SHA-256 over the canonical JSON of the findings sorted by key, finding_id excluded. */
export function findingsSha256(findings: readonly MigrationDomainFinding[]): string {
  const canonical = [...findings]
    .map((f) => ({
      kind: f.kind,
      error_code: f.error_code,
      document_ref_ext: f.document_ref_ext,
      line_ref: f.line_ref,
      platform_ref: f.platform_ref,
      field: f.field,
      source_value: f.source_value,
      platform_value: f.platform_value,
      details: f.details,
    }))
    .sort((a, b) =>
      [a.kind, a.document_ref_ext, a.line_ref, a.field ?? ''].join('') <
      [b.kind, b.document_ref_ext, b.line_ref, b.field ?? ''].join('')
        ? -1
        : 1,
    );
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Status derivation (Task 6.1) - the ONE rule Story 13.3 imports
// ---------------------------------------------------------------------------

export interface DomainVerificationStatus {
  domain: MigrationDocumentDomain;
  status: 'unverified' | 'verified';
  latest_load_id: string | null;
  latest_run_id: string | null;
  verified_run_id: string | null;
  verified_at: string | null;
  verified_by_actor_id: string | null;
  source_count: number | null;
  migrated_count: number | null;
  quarantined_count: number | null;
  mismatch_count: number | null;
  waived_count: number | null;
}

/**
 * `verified` iff a sign-off exists for the LATEST run of the LATEST manifest load; any later load
 * or run makes the domain `unverified` again (SM-48 says verified, not once-verified). A domain
 * with no stage row is `unverified`.
 */
export async function getDomainVerificationStatuses(
  siteId: string,
  client: Queryable,
): Promise<DomainVerificationStatus[]> {
  const r = await client.query(
    `SELECT d.domain, s.latest_load_id, s.latest_run_id, s.verified_run_id, s.verified_at,
            s.verified_by_actor_id, r.load_id AS latest_run_load_id, r.source_count,
            r.migrated_count, r.quarantined_count, r.mismatch_count, r.waived_count,
            (s.verified_run_id IS NOT NULL
             AND s.verified_run_id = s.latest_run_id
             AND r.load_id = s.latest_load_id) AS is_verified
       FROM unnest($2::text[]) WITH ORDINALITY AS d(domain, ord)
       LEFT JOIN migration_stage s ON s.site_id = $1 AND s.domain = d.domain
       LEFT JOIN migration_domain_verification r ON r.run_id = s.latest_run_id
      ORDER BY d.ord`,
    [siteId, [...MIGRATION_DOCUMENT_DOMAINS]],
  );
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    domain: row['domain'] as MigrationDocumentDomain,
    status: row['is_verified'] === true ? 'verified' : 'unverified',
    latest_load_id: (row['latest_load_id'] as string | null) ?? null,
    latest_run_id: (row['latest_run_id'] as string | null) ?? null,
    verified_run_id: (row['verified_run_id'] as string | null) ?? null,
    verified_at:
      row['verified_at'] instanceof Date
        ? (row['verified_at'] as Date).toISOString()
        : ((row['verified_at'] as string | null) ?? null),
    verified_by_actor_id: (row['verified_by_actor_id'] as string | null) ?? null,
    source_count: (row['source_count'] as number | null) ?? null,
    migrated_count: (row['migrated_count'] as number | null) ?? null,
    quarantined_count: (row['quarantined_count'] as number | null) ?? null,
    mismatch_count: (row['mismatch_count'] as number | null) ?? null,
    waived_count: (row['waived_count'] as number | null) ?? null,
  }));
}
