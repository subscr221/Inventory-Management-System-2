import type { PoolClient } from 'pg';
import { getLocationWithHierarchyPath } from '../read/projections/location_register.js';

async function resolveShipFrom(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT ship_from_site_id, ship_from_site_code_ext FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  if (result.rows.length === 0) return 'Unknown Site';
  const { ship_from_site_id, ship_from_site_code_ext } = result.rows[0];
  const location = await getLocationWithHierarchyPath(ship_from_site_id, client);
  return location?.hierarchy_path || ship_from_site_code_ext || 'Unknown Site';
}

async function resolveConsignee(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT ship_to_ext FROM erp_sales_order WHERE id = $1`, [
    dispatchOrderId,
  ]);
  if (result.rows.length === 0) return 'Unknown';
  return result.rows[0].ship_to_ext || 'Unknown';
}

async function resolvePackingLines(
  dispatchOrderId: string,
  client: PoolClient,
): Promise<
  Array<{
    sku: string;
    packed_qty: string;
    lot_number: string;
    lot_expiry: string | null;
  }>
> {
  const result = await client.query(
    `SELECT pr.sku, pr.packed_qty,
            lm.lot_number, to_char(lm.expiry_date, 'YYYY-MM-DD') AS expiry_date
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE pr.dispatch_order_id = $1
     ORDER BY pr.sku`,
    [dispatchOrderId],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    sku: r['sku'] as string,
    packed_qty: String(r['packed_qty']),
    lot_number: r['lot_number'] as string,
    lot_expiry: r['expiry_date'] ? (r['expiry_date'] as string) : null,
  }));
}

async function resolveTotals(
  dispatchOrderId: string,
  client: PoolClient,
): Promise<{ totalCartonCount: number; totalWeightKg: string | null }> {
  const result = await client.query(
    `SELECT COALESCE(SUM(carton_count), 0) AS total_cartons,
            COALESCE(SUM(actual_weight_kg)::text, NULL) AS total_weight
     FROM packing_record
     WHERE dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  return {
    totalCartonCount: Number(result.rows[0].total_cartons),
    totalWeightKg: result.rows[0].total_weight as string | null,
  };
}

export async function renderBOL(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const soResult = await client.query(
    `SELECT so_number_ext, quantity, sku FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  const soNumber = soResult.rows.length > 0 ? (soResult.rows[0].so_number_ext as string) : 'N/A';
  const shipFrom = await resolveShipFrom(dispatchOrderId, client);
  const consignee = await resolveConsignee(dispatchOrderId, client);
  const lines = await resolvePackingLines(dispatchOrderId, client);
  const totals = await resolveTotals(dispatchOrderId, client);

  const content = `BILL OF LADING
================
SO Number: ${soNumber}
Ship From: ${shipFrom}
Consignee: ${consignee}
Carrier: TBD (Phase 2 / Epic 15)

Line Items:
${lines.map((l, i) => `  ${i + 1}. SKU: ${l.sku}  Qty: ${l.packed_qty}  Lot: ${l.lot_number}${l.lot_expiry ? `  Exp: ${l.lot_expiry}` : ''}`).join('\n')}

Total Cartons: ${totals.totalCartonCount}
Total Weight: ${totals.totalWeightKg ?? 'N/A'} kg

Issued without recourse. E. & O. E.
`;

  return content;
}

export async function renderPackingSlip(
  dispatchOrderId: string,
  client: PoolClient,
): Promise<string> {
  const soResult = await client.query(`SELECT so_number_ext FROM erp_sales_order WHERE id = $1`, [
    dispatchOrderId,
  ]);
  const soNumber = soResult.rows.length > 0 ? (soResult.rows[0].so_number_ext as string) : 'N/A';
  const shipFrom = await resolveShipFrom(dispatchOrderId, client);
  const lines = await resolvePackingLines(dispatchOrderId, client);
  const totals = await resolveTotals(dispatchOrderId, client);

  const content = `PACKING SLIP
=============
SO Number: ${soNumber}
Ship From: ${shipFrom}

Contents:
${lines.map((l, i) => `  ${i + 1}. SKU: ${l.sku}  Packed Qty: ${l.packed_qty}  Lot: ${l.lot_number}${l.lot_expiry ? `  Exp: ${l.lot_expiry}` : ''}`).join('\n')}

Total Cartons: ${totals.totalCartonCount}
Total Weight: ${totals.totalWeightKg ?? 'N/A'} kg

--- Please verify contents before accepting delivery ---
--- Returnable carton acknowledgment: carton count to be verified at destination ---
`;

  return content;
}

// invoiceDate must be a deterministic caller-supplied value (e.g. the persisted event's
// metadata.occurred_at) — never generated inside the renderer, per Task 5.6's determinism requirement.
export async function renderCommercialInvoice(
  dispatchOrderId: string,
  client: PoolClient,
  invoiceDate?: string,
): Promise<string> {
  const soResult = await client.query(
    `SELECT so_number_ext, sku, quantity FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  const soNumber = soResult.rows.length > 0 ? (soResult.rows[0].so_number_ext as string) : 'N/A';
  const shipFrom = await resolveShipFrom(dispatchOrderId, client);
  const consignee = await resolveConsignee(dispatchOrderId, client);
  const lines = await resolvePackingLines(dispatchOrderId, client);
  const totals = await resolveTotals(dispatchOrderId, client);
  const totalQuantity = lines.reduce((sum, l) => {
    const n = Number(l.packed_qty);
    return sum + (Number.isNaN(n) ? 0 : n);
  }, 0);

  const content = `COMMERCIAL INVOICE
===================
Invoice No: ${soNumber}
Date: ${invoiceDate ?? 'N/A'}
Seller: ${shipFrom}
Buyer: ${consignee}

Line Items:
${lines.map((l, i) => `  ${i + 1}. SKU: ${l.sku}  Qty: ${l.packed_qty}  Unit Price: TBD  Lot: ${l.lot_number}`).join('\n')}

Total Quantity: ${totalQuantity}
Total Weight: ${totals.totalWeightKg ?? 'N/A'} kg

Terms: Goods sold on open account. Payment terms per agreement. E. & O. E.
`;

  return content;
}

export async function renderLabels(dispatchOrderId: string, client: PoolClient): Promise<string[]> {
  const soResult = await client.query(
    `SELECT so_number_ext, ship_from_site_code_ext FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  const soNumber = soResult.rows.length > 0 ? (soResult.rows[0].so_number_ext as string) : 'N/A';
  const siteCode =
    soResult.rows.length > 0 ? (soResult.rows[0].ship_from_site_code_ext as string) : 'N/A';

  // Task 5.5: labels must include the correct SKU and lot number per carton — group cartons by
  // their own packing record rather than stamping every carton with the first lot found.
  const recordResult = await client.query(
    `SELECT pr.sku, lm.lot_number, pr.carton_count
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE pr.dispatch_order_id = $1
     ORDER BY pr.sku, lm.lot_number`,
    [dispatchOrderId],
  );
  const records = recordResult.rows.map((r: Record<string, unknown>) => ({
    sku: r['sku'] as string,
    lot_number: r['lot_number'] as string,
    carton_count: Number(r['carton_count']),
  }));

  const totalCartons = records.reduce((sum, r) => sum + r.carton_count, 0);

  const labels: string[] = [];
  let cartonNumber = 0;
  for (const record of records) {
    for (let i = 1; i <= record.carton_count; i++) {
      cartonNumber += 1;
      labels.push(
        `[${siteCode}] SO: ${soNumber} | Carton ${cartonNumber}/${totalCartons} | SKU: ${record.sku} | Lot: ${record.lot_number}`,
      );
    }
  }

  return labels;
}
