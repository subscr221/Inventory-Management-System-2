import type { PoolClient } from 'pg';

async function resolveShipFrom(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT lr.hierarchy_path, eso.ship_from_site_code_ext
     FROM erp_sales_order eso
     LEFT JOIN location_register lr ON lr.location_id = eso.ship_from_site_id
     WHERE eso.id = $1`,
    [dispatchOrderId],
  );
  if (result.rows.length === 0) return 'Unknown Site';
  return result.rows[0].hierarchy_path || result.rows[0].ship_from_site_code_ext || 'Unknown Site';
}

async function resolveConsignee(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT ship_to_ext FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  if (result.rows.length === 0) return 'Unknown';
  return result.rows[0].ship_to_ext || 'Unknown';
}

async function resolvePackingLines(
  dispatchOrderId: string,
  client: PoolClient,
): Promise<Array<{
  sku: string;
  packed_qty: string;
  lot_number: string;
  lot_expiry: string | null;
}>> {
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
  const soNumber = soResult.rows.length > 0 ? soResult.rows[0].so_number_ext as string : 'N/A';
  const shipFrom = await resolveShipFrom(dispatchOrderId, client);
  const consignee = await resolveConsignee(dispatchOrderId, client);
  const lines = await resolvePackingLines(dispatchOrderId, client);
  const totals = await resolveTotals(dispatchOrderId, client);
  const date = new Date().toISOString().slice(0, 10);

  let content = `BILL OF LADING
================
Date: ${date}
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

export async function renderPackingSlip(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const soResult = await client.query(
    `SELECT so_number_ext FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  const soNumber = soResult.rows.length > 0 ? soResult.rows[0].so_number_ext as string : 'N/A';
  const shipFrom = await resolveShipFrom(dispatchOrderId, client);
  const lines = await resolvePackingLines(dispatchOrderId, client);
  const totals = await resolveTotals(dispatchOrderId, client);
  const date = new Date().toISOString().slice(0, 10);

  let content = `PACKING SLIP
=============
Date: ${date}
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

export async function renderCommercialInvoice(dispatchOrderId: string, client: PoolClient): Promise<string> {
  const soResult = await client.query(
    `SELECT so_number_ext, sku, quantity FROM erp_sales_order WHERE id = $1`,
    [dispatchOrderId],
  );
  const soNumber = soResult.rows.length > 0 ? soResult.rows[0].so_number_ext as string : 'N/A';
  const shipFrom = await resolveShipFrom(dispatchOrderId, client);
  const consignee = await resolveConsignee(dispatchOrderId, client);
  const lines = await resolvePackingLines(dispatchOrderId, client);
  const totals = await resolveTotals(dispatchOrderId, client);
  const date = new Date().toISOString().slice(0, 10);

  let content = `COMMERCIAL INVOICE
===================
Date: ${date}
Invoice No: ${soNumber}
Seller: ${shipFrom}
Buyer: ${consignee}

Line Items:
${lines.map((l, i) => `  ${i + 1}. SKU: ${l.sku}  Qty: ${l.packed_qty}  Unit Price: TBD  Lot: ${l.lot_number}`).join('\n')}

Total Quantity: ${lines.reduce((sum, l) => sum + Number(l.packed_qty), 0)}
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
  const soNumber = soResult.rows.length > 0 ? soResult.rows[0].so_number_ext as string : 'N/A';
  const siteCode = soResult.rows.length > 0 ? soResult.rows[0].ship_from_site_code_ext as string : 'N/A';
  const date = new Date().toISOString().slice(0, 10);

  const cartonResult = await client.query(
    `SELECT SUM(carton_count) AS total_cartons
     FROM packing_record
     WHERE dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  const totalCartons = Number(cartonResult.rows[0].total_cartons ?? 0);

  const labels: string[] = [];
  for (let i = 1; i <= totalCartons; i++) {
    labels.push(`[${siteCode}] SO: ${soNumber} | Carton ${i}/${totalCartons} | Date: ${date}`);
  }

  return labels;
}
