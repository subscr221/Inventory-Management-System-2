#!/usr/bin/env node
// Mock rehearsal pack generator (runbook section 3, mock pass).
//
// Writes a matched pair: the platform side (world.json, the two erp-sync bodies) and the legacy
// claim (the five v1 CSVs), with the defects of defects.json planted on purpose. The answer sheet
// is expected-outcomes.json. Deterministic: the same --seed gives the same pack.
//
//   node deploy/rehearsal/mock/generate.mjs --site-code CMF-ALIGARH --lines 300 --seed 42
//
// --tag RUN1 makes every globally unique identifier run-scoped (bins, lots, serials, kit parents,
// kit/PO/challan/order references), so a second pack can be loaded into the same append-only
// database under another site code. rehearse.ts always passes one.
//
// The pack also carries an OPERATIONS layer, so a pilot user can work a normal day after go-live:
// the full location tree (site > zone > aisle > rack > bin) in world.json, roles.json in the format
// of src/cli/provision-roles.ts (pass --site-id, the site's location_id, for a file that can be
// applied as it is), one complete sales-order snapshot (erp-sync-sales-orders.json) and
// world.json operations: DOA entries, SLA policies, assets and meters, inspection plans, ownership
// agreements, suppliers. setup-operations.ts creates them through the API after the unblock.
//
// Formats: docs/migration/opening-stock-template-v1.md, docs/migration/document-manifest-templates-v1.md.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));


const OPENING_STOCK_HEADER =
  'site_code,location_code,sku,lot_number,serial_number,quantity,uom,stock_class,unit_cost,expiry_date,counted_on,pv_ref_ext,pv_line_ref_ext';
const MANIFEST_HEADERS = {
  active_boms: 'site_code,kit_ref,parent_sku,revision_code,component_sku,quantity_per,line_uom',
  open_pos:
    'site_code,po_number_ext,line_no,sku,supplier_ref_ext,ordered_qty,received_qty,open_qty,over_receipt_tolerance_pct,under_receipt_tolerance_pct',
  jobwork_challans:
    'site_code,challan_number_ext,challan_date,order_number_ext,customer_party_code,sku,challan_qty,uom,challan_class',
  custody_registers: 'site_code,order_number_ext,customer_party_code,sku,custody_qty,uom',
};

function parseArgs(argv) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const args = { siteCode: 'MOCK-SITE', lines: 300, seed: 42, countedOn: yesterday, out: null, tag: '', siteId: '00000000-0000-0000-0000-000000000000' };
  for (let i = 2; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === '--site-code') args.siteCode = value;
    else if (argv[i] === '--lines') args.lines = Number(value);
    else if (argv[i] === '--seed') args.seed = Number(value);
    else if (argv[i] === '--counted-on') args.countedOn = value;
    else if (argv[i] === '--out') args.out = value;
    else if (argv[i] === '--tag') args.tag = value;
    else if (argv[i] === '--site-id') args.siteId = value;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(args.lines) || args.lines < 50 || args.lines > 10_000) {
    throw new Error('--lines must be an integer between 50 and 10000 (the import cap)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.countedOn)) throw new Error('--counted-on must be YYYY-MM-DD');
  args.out ??= join(HERE, 'out', args.siteCode);
  return args;
}

// mulberry32: small seeded PRNG, enough for test data
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = parseArgs(process.argv);
/** Run-scope suffix for identifiers that are unique across the whole database. */
const T = args.tag ? `-${args.tag}` : '';
// Every mock BOM and PO reference starts with this; it is the verification run's document_ref_prefix.
const REF_PREFIX = args.tag ? `MK-${args.tag}-` : 'MK-';
const FG = ['FG-PUMP-12', 'FG-FRAME-A', 'FG-BRACKET-H'].map((s) => s + T);
const rand = prng(args.seed);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[int(0, list.length - 1)];
const pad = (n, width) => String(n).padStart(width, '0');
const qty = (n) => n.toFixed(6);
const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csv = (header, rows) => [header, ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';

// ---------------------------------------------------------------- master data

// The ten stock bins keep their codes and their order (the seeded draws depend on it); the tree
// below hangs each one under zone > aisle > rack, because a bin without a zone ancestor cannot be
// picked from (src/warehouse/pick-task-generator.ts:222) and a bin can never be re-parented.
const bins = Array.from({ length: 10 }, (_, i) => `BIN-${'AABBCCJJRR'[i]}${pad((i % 2) + 1, 2)}${T}`);

/**
 * Location tree below the site. ZONE-QC-HOLD is a LITERAL code the receiving module looks up
 * (src/compliance/receiving.ts:63), so it carries no run tag: one site per database can own it.
 */
const QC_HOLD_ZONE = 'ZONE-QC-HOLD';
const locations = [];
function zone(code, zoneType, flags, aisles) {
  locations.push({ location_code: code, level: 'zone', parent_code: null, zone_type: zoneType, ...flags });
  for (const [aisle, binCodes] of aisles) {
    const aisleCode = `${aisle}${T}`;
    const rackCode = `${aisle}-R1${T}`;
    locations.push({ location_code: aisleCode, level: 'aisle', parent_code: code, zone_type: zoneType, ...flags });
    locations.push({ location_code: rackCode, level: 'rack', parent_code: aisleCode, zone_type: zoneType, ...flags });
    for (const bin of binCodes) locations.push({ location_code: bin, level: 'bin', parent_code: rackCode, zone_type: zoneType, ...flags });
  }
}
const RECEIVING_DOCK = `RECV-DOCK${T}`;
const QUARANTINE_BIN = `QCH-BIN-01${T}`;
const DISPATCH_BIN = `DISP-STAGE-01${T}`;
const PUTAWAY_BIN = `BIN-A03${T}`; // empty at go-live: the smoke test puts its receipts away here
zone(`ZONE-RECV${T}`, 'staging', { quarantine: false }, [['RECV-A1', [RECEIVING_DOCK, `RECV-DOCK-02${T}`]]]);
zone(QC_HOLD_ZONE, 'quarantine', { quarantine: true }, [['QCH-A1', [QUARANTINE_BIN, `QCH-BIN-02${T}`]]]);
zone(`ZONE-STORE-A${T}`, 'general', { quarantine: false }, [
  ['STA-A', [bins[0], bins[1], PUTAWAY_BIN]],
  ['STA-B', [bins[2], bins[3]]],
  ['STA-C', [bins[4], bins[5]]],
]);
zone(`ZONE-STORE-B${T}`, 'general', { quarantine: false }, [
  ['STB-J', [bins[6], bins[7]]], // customer (job-work) material
  ['STB-R', [bins[8], bins[9]]],
]);
zone(`ZONE-DISPATCH${T}`, 'staging', { quarantine: false }, [['DISP-A1', [DISPATCH_BIN, `DISP-STAGE-02${T}`]]]);
locations.filter((l) => l.level === 'bin').forEach((l, i) => (l.pick_sequence = (i + 1) * 10));

/** control: 'lot' | 'serial' | 'plain' */
function item(sku, uom, control, stockClass, cost) {
  return { sku, uom, control, stock_class: stockClass, unit_cost: cost };
}
const items = [
  ...['COIL-2MM', 'COIL-3MM', 'SHEET-1MM', 'SHEET-2MM', 'ROD-12MM', 'ROD-16MM', 'PIPE-25NB', 'PLATE-6MM'].map(
    (s, i) => item(`RM-${s}`, 'KG', 'lot', 'owned', 62 + i * 7.5),
  ),
  ...['MTR-3.7KW', 'MTR-7.5KW', 'GEARBOX-40', 'VFD-5HP'].map((s, i) =>
    item(s, 'EA', 'serial', 'owned', 9500 + i * 4200),
  ),
  ...['PKG-CARTON-S', 'PKG-CARTON-L', 'PKG-PALLET', 'CON-GLOVES', 'CON-GRIND-DISC', 'BRG-6204', 'BRG-6306', 'SEAL-35MM'].map(
    (s, i) => item(s, 'EA', 'plain', 'owned', 8.25 + i * 21),
  ),
  ...['FAST-M8-BOLT', 'FAST-M10-NUT'].map((s) => item(s, 'EA', 'lot', 'consignment', null)),
  item('WELD-WIRE-1.2', 'KG', 'lot', 'vmi', null),
  ...['CUST-SHEET-3MM', 'CUST-PLATE-8MM', 'CUST-ROD-20MM'].map((s, i) => item(s, 'KG', 'lot', 'job_work', 58 + i * 6)),
  item('PROTO-BRKT-V3', 'EA', 'plain', 'prototype', null),
  ...FG.map((s, i) => item(s, 'EA', 'plain', 'owned', 4200 + i * 900)),
];
const bySku = new Map(items.map((it) => [it.sku, it]));
const stockable = items.filter((it) => !it.sku.startsWith('FG-'));

// ---------------------------------------------------------------- opening stock: the truth

/** One grain = bin + sku + lot + serial. The ERP snapshot holds the truth; the file is the claim. */
const grains = new Map();
const grainKey = (g) => `${g.location_code}|${g.sku}|${g.lot_number || '-'}|${g.serial_number || '-'}`;
let lotSeq = 0;
let serialSeq = 88_000;
while (grains.size < args.lines) {
  const it = pick(stockable);
  const g = {
    location_code: pick(bins),
    sku: it.sku,
    lot_number: it.control === 'lot' ? `LOT-${pad(++lotSeq, 4)}${T}` : '',
    serial_number: it.control === 'serial' ? `SN-${++serialSeq}${T}` : '',
    quantity: it.control === 'serial' ? 1 : it.uom === 'KG' ? int(20, 2500) + int(0, 9) / 10 : int(1, 800),
    expiry: it.control === 'lot' && rand() < 0.3 ? `${2027 + int(0, 1)}-${pad(int(1, 12), 2)}-28` : '',
  };
  if (!grains.has(grainKey(g))) grains.set(grainKey(g), g);
}

function stockRow(g, overrides = {}) {
  const it = bySku.get(g.sku);
  const cost = it?.stock_class === 'owned' || it?.stock_class === 'job_work' ? it.unit_cost.toFixed(4) : '';
  return {
    site_code: args.siteCode,
    location_code: g.location_code,
    sku: g.sku,
    lot_number: g.lot_number,
    serial_number: g.serial_number,
    quantity: g.serial_number ? '1' : qty(g.quantity),
    uom: it?.uom ?? 'EA',
    stock_class: it?.stock_class ?? 'owned',
    unit_cost: cost,
    expiry_date: g.expiry,
    counted_on: args.countedOn,
    ...overrides,
  };
}

const erpBalances = [...grains.values()].map((g) => ({ ...g }));
let fileRows = [...grains.values()].map((g) => ({ key: grainKey(g), row: stockRow(g) }));

// ---------------------------------------------------------------- planted defects

const defects = JSON.parse(readFileSync(join(HERE, 'defects.json'), 'utf8'));
const expected = { opening_stock: [], active_boms: [], open_pos: [], jobwork_challans: [], custody_registers: [] };
const touched = new Set();

/** An untouched file row matching the filter; every defect lands on its own row. */
function takeRow(filter = () => true) {
  const free = fileRows.filter((r) => !touched.has(r.key) && bySku.has(r.row.sku) && filter(bySku.get(r.row.sku), r.row));
  if (free.length === 0) throw new Error('not enough rows to plant every defect; raise --lines');
  const chosen = pick(free);
  touched.add(chosen.key);
  return chosen;
}
const dropRow = (chosen) => (fileRows = fileRows.filter((r) => r !== chosen));
const notSerial = (it) => it.control !== 'serial';
const times = (n, fn) => Array.from({ length: n ?? 0 }, (_, i) => fn(i));

const os = defects.opening_stock ?? {};
times(os.quantity_mismatch, () => {
  const r = takeRow(notSerial);
  const before = r.row.quantity;
  r.row.quantity = qty(Number(before) + pick([-25, -10, -1, 1, 5, 40]) + (Number(before) > 50 ? 0 : 60));
  expected.opening_stock.push({ defect: 'quantity_mismatch', variance_kind: 'quantity_mismatch', key: r.key, source: before, file: r.row.quantity });
});
times(os.missing_in_import, () => {
  const r = takeRow(notSerial);
  dropRow(r);
  expected.opening_stock.push({ defect: 'missing_in_import', variance_kind: 'missing_in_import', key: r.key });
});
times(os.serial_missing_in_import, () => {
  const r = takeRow((it) => it.control === 'serial');
  dropRow(r);
  expected.opening_stock.push({ defect: 'serial_missing_in_import', variance_kind: 'serial_missing_in_import', key: r.key });
});
times(os.missing_in_source, (i) => {
  const g = { location_code: pick(bins), sku: 'PKG-PALLET', lot_number: '', serial_number: '', quantity: 11 + i, expiry: '' };
  while (grains.has(grainKey(g))) g.location_code = pick(bins);
  grains.set(grainKey(g), g);
  touched.add(grainKey(g));
  fileRows.push({ key: grainKey(g), row: stockRow(g) });
  expected.opening_stock.push({ defect: 'missing_in_source', variance_kind: 'missing_in_source', key: grainKey(g) });
});
times(os.serial_missing_in_source, () => {
  const g = { location_code: pick(bins), sku: 'MTR-7.5KW', lot_number: '', serial_number: `SN-${++serialSeq}${T}`, quantity: 1, expiry: '' };
  touched.add(grainKey(g));
  fileRows.push({ key: grainKey(g), row: stockRow(g) });
  expected.opening_stock.push({ defect: 'serial_missing_in_source', variance_kind: 'serial_missing_in_source', key: grainKey(g) });
});
times(os.unknown_sku, (i) => {
  const g = { location_code: pick(bins), sku: `GHOST-${pad(i + 1, 3)}`, lot_number: '', serial_number: '', quantity: 5, expiry: '' };
  fileRows.push({ key: grainKey(g), row: stockRow(g, { unit_cost: '1.0000' }) });
  expected.opening_stock.push({ defect: 'unknown_sku', rejection_code: 'UNKNOWN_REFERENCE', key: grainKey(g) });
});
// The next three spoil a good row, so the row is rejected AND its grain shows up as missing_in_import.
times(os.wrong_uom, () => {
  const r = takeRow(notSerial);
  r.row.uom = r.row.uom === 'KG' ? 'EA' : 'KG';
  expected.opening_stock.push({ defect: 'wrong_uom', rejection_code: 'UNKNOWN_REFERENCE', variance_kind: 'missing_in_import', key: r.key });
});
times(os.owned_without_cost, () => {
  const r = takeRow((it) => it.stock_class === 'owned' && it.control !== 'serial');
  r.row.unit_cost = '';
  expected.opening_stock.push({ defect: 'owned_without_cost', rejection_code: 'MALFORMED_ROW', variance_kind: 'missing_in_import', key: r.key });
});
times(os.lot_missing_on_lot_item, () => {
  const r = takeRow((it) => it.control === 'lot');
  r.row.lot_number = '';
  expected.opening_stock.push({ defect: 'lot_missing_on_lot_item', rejection_code: 'MALFORMED_ROW', variance_kind: 'missing_in_import', key: r.key });
});
// Last, so the copy lands after its original: the original is accepted, the copy is refused.
times(os.duplicate_lot_serial, () => {
  const r = takeRow();
  fileRows.push({ key: r.key, row: { ...r.row }, duplicate: true });
  expected.opening_stock.push({ defect: 'duplicate_lot_serial', rejection_code: 'DUPLICATE_LOT_SERIAL', key: r.key });
});

// PV sheet references and file line numbers (line 1 is the header)
fileRows.forEach((r, i) => {
  r.row.pv_ref_ext = `PV-SHEET-${pad(Math.floor(i / 25) + 1, 2)}`;
  r.row.pv_line_ref_ext = String((i % 25) + 1);
  r.line_no = i + 2;
});
for (const e of expected.opening_stock) {
  const hits = fileRows.filter((r) => r.key === e.key);
  const hit = e.defect === 'duplicate_lot_serial' ? hits.find((r) => r.duplicate) : hits[0];
  if (hit) e.file_line_no = hit.line_no;
}

// ---------------------------------------------------------------- documents: platform side, then the claim

const supplierRefs = ['SUP-ACME', 'SUP-BHARAT-STEEL', 'SUP-NORTHERN-FAST'];
const kits = FG.map((parent, i) => ({
  kit_ref: `${REF_PREFIX}KIT-${pad(i + 1, 3)}`,
  parent_sku: parent,
  revision_code: 'R1',
  components: ['RM-ROD-12MM', 'BRG-6204', 'SEAL-35MM', 'RM-PLATE-6MM', 'FAST-M8-BOLT']
    .slice(i, i + 3)
    .map((sku, n) => ({ component_sku: sku, quantity_per: n + 1 + i, line_uom: bySku.get(sku).uom })),
}));
const purchaseOrders = Array.from({ length: 4 }, (_, i) => ({
  po_number_ext: `${REF_PREFIX}PO-${pad(i + 1, 4)}`,
  supplier_ref_ext: supplierRefs[i % supplierRefs.length],
  currency: 'INR',
  lines: Array.from({ length: int(1, 3) }, (_, n) => {
    const it = pick(items.filter((x) => x.stock_class === 'owned' && x.control !== 'serial' && !x.sku.startsWith('FG-')));
    const ordered = int(50, 500);
    return { line_no: n + 1, sku: it.sku, ordered_qty: ordered, open_qty: int(0, ordered), unit_price: it.unit_cost, over_receipt_tolerance_pct: 5, under_receipt_tolerance_pct: 5 };
  }),
}));
// The operations PO: open lines a pilot user can receive against on day one (a plain item, a lot
// item, a consignment item). It is in the snapshot AND in open_pos.csv, so it verifies clean. The
// PO sync is a FULL SNAPSHOT (src/adapters/erp/sync.ts:664): always send this whole file.
const OPS_PO = `${REF_PREFIX}PO-${pad(purchaseOrders.length + 1, 4)}`;
purchaseOrders.push({
  po_number_ext: OPS_PO,
  supplier_ref_ext: supplierRefs[0],
  currency: 'INR',
  lines: [
    ['BRG-6204', 400, bySku.get('BRG-6204').unit_cost],
    ['RM-COIL-2MM', 5000, bySku.get('RM-COIL-2MM').unit_cost],
    ['SEAL-35MM', 600, bySku.get('SEAL-35MM').unit_cost],
    ['FAST-M8-BOLT', 20000, 1.5],
  ].map(([sku, ordered, price], n) => ({ line_no: n + 1, sku, ordered_qty: ordered, open_qty: ordered, unit_price: price, over_receipt_tolerance_pct: 5, under_receipt_tolerance_pct: 5 })),
});
const challanDate = `${args.countedOn.slice(0, 4)}-${pad(Math.max(1, Number(args.countedOn.slice(5, 7)) - 1), 2)}-12`;
const serviceOrders = ['CUST-SHEET-3MM', 'CUST-PLATE-8MM', 'CUST-ROD-20MM'].map((sku, i) => {
  const challans = [1, 2].map((n) => ({ challan_number_ext: `DC-MK-${pad(i * 2 + n, 3)}${T}`, challan_date: challanDate, sku, challan_qty: int(300, 1500), uom: 'KG', challan_class: 'input' }));
  const consumed = int(50, 250);
  return {
    order_number_ext: `JW-MK-${pad(i + 1, 4)}${T}`,
    customer_party_code: ['ACME', 'ORBIT', 'ZENITH'][i],
    customer_name: ['Acme Fabrication Pvt Ltd', 'Orbit Engineering Works', 'Zenith Agro Implements'][i],
    challans,
    consumed_qty: consumed,
    custody_qty: challans.reduce((sum, c) => sum + c.challan_qty, 0) - consumed,
  };
});

const site = args.siteCode;
const bomRows = kits.flatMap((k) => k.components.map((c) => [site, k.kit_ref, k.parent_sku, k.revision_code, c.component_sku, String(c.quantity_per), c.line_uom]));
const poRows = purchaseOrders.flatMap((po) =>
  po.lines.map((l) => [site, po.po_number_ext, String(l.line_no), l.sku, po.supplier_ref_ext, String(l.ordered_qty), String(l.ordered_qty - l.open_qty), String(l.open_qty), '5', '5']),
);
const challanRows = serviceOrders.flatMap((so) =>
  so.challans.map((c) => [site, c.challan_number_ext, c.challan_date, so.order_number_ext, so.customer_party_code, c.sku, String(c.challan_qty), c.uom, c.challan_class]),
);
const custodyRows = serviceOrders.map((so) => [site, so.order_number_ext, so.customer_party_code, so.challans[0].sku, String(so.custody_qty), 'KG']);

/**
 * Bump one numeric cell of a manifest row and record the field_mismatch it must produce. refOf
 * gives the finding's [document_ref_ext, line_ref] as src/migration/document-templates.ts builds
 * them (the challan line_ref is order and sku joined by U+001F, written here as '|').
 */
function bumpCell(rows, domain, defect, column, field, refOf, start) {
  times(defects[domain]?.[defect], (i) => {
    const row = rows[(start + i) % rows.length];
    const platformValue = row[column];
    row[column] = String(Number(platformValue) + 7);
    const [document_ref_ext, line_ref] = refOf(row);
    expected[domain].push({ defect, finding_kind: 'field_mismatch', field, document_ref_ext, line_ref, source_value: row[column], platform_value: platformValue });
  });
}
bumpCell(bomRows, 'active_boms', 'quantity_per_off', 5, 'quantity_per', (r) => [r[1], r[4]], 1);
bumpCell(poRows, 'open_pos', 'received_qty_off', 6, 'received_qty', (r) => [r[1], r[2]], 0);
bumpCell(challanRows, 'jobwork_challans', 'challan_qty_off', 6, 'challan_qty', (r) => [r[1], `${r[3]}|${r[5]}`], 2);
bumpCell(custodyRows, 'custody_registers', 'custody_qty_off', 4, 'custody_qty', (r) => [r[1], r[3]], 1);
times(defects.active_boms?.component_missing_in_platform, (i) => {
  const k = kits[i % kits.length];
  bomRows.push([site, k.kit_ref, k.parent_sku, k.revision_code, 'CON-GRIND-DISC', '2', 'EA']);
  // The kit exists, so the platform reports the extra component as a field_mismatch on
  // component_sku (missing_in_platform is reserved for a whole document or PO line it lacks).
  expected.active_boms.push({ defect: 'component_missing_in_platform', finding_kind: 'field_mismatch', field: 'component_sku', document_ref_ext: k.kit_ref, line_ref: 'CON-GRIND-DISC' });
});
times(defects.open_pos?.po_missing_in_platform, (i) => {
  const ref = `${REF_PREFIX}PO-9${pad(i + 1, 3)}`;
  poRows.push([site, ref, '1', 'BRG-6204', 'SUP-ACME', '100', '0', '100', '', '']);
  expected.open_pos.push({ defect: 'po_missing_in_platform', finding_kind: 'missing_in_platform', document_ref_ext: ref, line_ref: '1' });
});

// ---------------------------------------------------------------- operations layer

// Sales orders: ONE complete snapshot, because the sync closes every open line it does not carry
// (src/adapters/erp/sync.ts:707). Quantities stay far below the clean opening stock of each SKU.
const cleanStock = new Map();
for (const r of fileRows) {
  if (touched.has(r.key) || r.row.stock_class !== 'owned' || r.row.serial_number) continue;
  cleanStock.set(r.row.sku, (cleanStock.get(r.row.sku) ?? 0) + Number(r.row.quantity));
}
const sellable = ['BRG-6204', 'RM-COIL-2MM', 'SEAL-35MM', 'RM-ROD-12MM', 'BRG-6306', 'RM-SHEET-1MM', 'PKG-CARTON-S', 'RM-PLATE-6MM'].filter((sku) => (cleanStock.get(sku) ?? 0) >= 200);
const requiredBy = `${Number(args.countedOn.slice(0, 4)) + 1}-03-31`;
const salesOrders = Array.from({ length: 6 }, (_, i) => {
  const pair = [sellable[i % sellable.length], sellable[(i + 1) % sellable.length]];
  return pair.map((sku, n) => ({
    so_number_ext: `${REF_PREFIX}SO-${pad(i + 1, 4)}`,
    line_no: n + 1,
    sku,
    quantity: bySku.get(sku).uom === 'KG' ? 10 + i : 2 + i,
    required_by: requiredBy,
    ship_to_ext: ['CUST-ACME', 'CUST-ORBIT', 'CUST-ZENITH'][i % 3],
    ship_from_site_code_ext: site,
  }));
}).flat();

// People. The real staging accounts first, then fictitious holders for duties nobody has. The file
// is COMPLETE on purpose: provision-roles REPLACES a person's assignments, so the migration grants
// of rehearse.ts are repeated here. Forbidden pairs (src/cli/verify-segregated-roles-core.ts:53,
// src/cli/provision-roles-core.ts:55) are respected: nobody holds two of migration_lead,
// department_head, finance_controller, cfo.
const DOMAIN = 'ancorlabs.org';
const W = 'write';
const R = 'read';
/** [local part, display name, fictitious?, [[role, module, scope, 'site' | '*'], ...]] */
const people = [
  ['info', 'Gagan Kumar', false, [['migration_lead', 'migration', W, 'site'], ['migration_lead', 'migration', R, 'site']]],
  ['accounts', 'Finance Controller', false, [['finance_controller', 'migration', W, '*'], ['finance_controller', 'jobwork', W, '*'], ['finance_controller', 'compliance', W, '*'], ['finance_controller', 'inventory', R, '*']]],
  ['subscr', 'Department Head', false, [...['migration', 'engineering', 'procurement', 'jobwork', 'custody', 'production', 'maintenance'].map((m) => ['department_head', m, W, 'site']), ['department_head', 'inventory', R, 'site']]],
  ['anupam', 'CFO', false, [['cfo', 'jobwork', W, '*'], ['cfo', 'migration', R, 'site']]],
  ['cmf_supervisor', 'Site Head', false, [['warehouse_manager', 'warehouse', W, 'site'], ['warehouse_manager', 'inventory', W, 'site'], ['warehouse_manager', 'receiving', W, 'site']]],
  ['dev1', 'Devender', false, [['engineering_admin', 'engineering', W, '*'], ['engineering_admin', 'engineering', R, '*']]],
  ['erp1', 'ERP adapter service', false, [['svc_erp_adapter', 'inventory', W, '*']]],
  ['gate1', 'Ramesh Yadav', false, [['gate_officer', 'inventory', W, 'site'], ['weighbridge_operator', 'inventory', W, 'site']]],
  ['store1', 'Suresh Verma', false, [['store_assistant', 'receiving', W, 'site'], ['store_assistant', 'inventory', W, 'site'], ['store_assistant', 'warehouse', W, 'site']]],
  ['unload1', 'Mahesh Tyagi', false, [['unloading_supervisor', 'receiving', W, 'site'], ['unloading_supervisor', 'inventory', R, 'site']]],
  ['qc1', 'Neha Saxena', false, [['qc_inspector', 'qc', W, 'site'], ['qc_inspector', 'quality', W, 'site'], ['qc_inspector', 'inventory', R, 'site']]],
  ['picker1', 'Imran Khan', false, [['warehouse_operator', 'warehouse', W, 'site'], ['warehouse_operator', 'inventory', R, 'site']]],
  ['invctl1', 'Pooja Sharma', false, [['inventory_controller', 'inventory', W, 'site'], ['inventory_controller', 'warehouse', W, 'site']]],
  ['planner1', 'Vikas Gupta', false, [['production_planner', 'production', W, 'site'], ['production_planner', 'inventory', R, 'site'], ['production_planner', 'engineering', R, 'site'], ['production_planner', 'qc', R, 'site']]],
  ['maint1', 'Arif Ansari', false, [['maintenance_technician', 'maintenance', W, 'site']]],
  ['maintsup1', 'Deepak Chauhan', false, [['maintenance_supervisor', 'maintenance', W, '*']]],
  ['indent1', 'Kavita Singh', false, [['procurement_officer', 'procurement', W, 'site'], ['procurement_officer', 'inventory', R, 'site']]],
  ['audit1', 'Rohit Mathur', false, [['internal_auditor', 'audit', R, '*'], ['internal_auditor', 'inventory', R, 'site']]],
  // fictitious: duties that had no holder in the first transaction test
  ['qchead1', 'Sunita Rawat', true, [['qc_head', 'qc', W, 'site'], ['qc_head', 'quality', W, 'site'], ['qc_head', 'inventory', R, 'site']]],
  ['dispatch1', 'Sanjay Mishra', true, [['dispatch_clerk', 'warehouse', W, 'site'], ['dispatch_clerk', 'inventory', R, 'site']]],
  ['notify1', 'Anita Joshi', true, [['notification_admin', 'notification', W, '*'], ['notification_admin', 'notification', R, '*']]],
].map(([local, display_name, fictitious, grants]) => ({ email: `${local}@${DOMAIN}`, display_name, fictitious, grants }));
const emailOf = (local) => `${local}@${DOMAIN}`;
const rolesFile = {
  site_id: args.siteId,
  people: Object.fromEntries(people.map((p) => [p.email, { display_name: p.display_name }])),
  roles: people.flatMap((p) => p.grants.map(([role, module, function_scope, location_id]) => ({ role, module, function_scope, location_id, holder: p.email }))),
};

const operations = {
  receiving_dock: RECEIVING_DOCK,
  qc_hold_zone: QC_HOLD_ZONE,
  quarantine_bin: QUARANTINE_BIN,
  putaway_bin: PUTAWAY_BIN,
  dispatch_staging_bin: DISPATCH_BIN,
  operations_po: OPS_PO,
  // Who does what in setup-operations.ts and operations-smoke.ts (logical actor -> person).
  actors: {
    erp: emailOf('erp1'), compliance: emailOf('accounts'), gate: emailOf('gate1'), weighbridge: emailOf('gate1'),
    store: emailOf('store1'), picker: emailOf('picker1'), invctl: emailOf('invctl1'), whmanager: emailOf('cmf_supervisor'),
    dispatch: emailOf('dispatch1'), planner: emailOf('planner1'), engineer: emailOf('dev1'), qc: emailOf('qc1'),
    qchead: emailOf('qchead1'), maint: emailOf('maint1'), maintsup: emailOf('maintsup1'), indent: emailOf('indent1'),
    depthead: emailOf('subscr'),
  },
  // One band per transaction type, no value limits. Every type a pilot flow resolves through
  // resolveApprover / findRoleHolder; calibration.escalation is left out (the runbook forbids
  // calibration work in the pilot) and migration.variance_explanation belongs to the rehearsal.
  doa_entries: [
    ['inventory.count_adjustment', 'warehouse_manager'],
    ['indent_approval', 'department_head'],
    ['purchase_order_approval', 'department_head'],
    ['supplier_onboarding', 'department_head'],
    ['transfer_request', 'warehouse_manager'],
    ['receiving.quarantine', 'warehouse_manager'],
    ['receiving.putaway_release', 'warehouse_manager'],
    ['qc.inspection_plan_approval', 'qc_head'],
    ['qc.conditional_release', 'qc_head'],
    ['qc.witnessed_inspection_waiver', 'qc_head'],
    ['compliance.label_master_approval', 'qc_head'],
    ['production_order.release_override', 'department_head'],
    ['production_order.over_completion', 'department_head'],
    ['production_order.short_close', 'department_head'],
    ['bom_substitution', 'department_head'],
    ['eco_approval', 'department_head'],
    ['maintenance.return_to_service', 'maintenance_supervisor'],
    ['maintenance.warranty_override', 'maintenance_supervisor'],
    ['maintenance.sync_conflict_resolution', 'maintenance_supervisor'],
    ['edge.refused_capture_resolution', 'warehouse_manager'],
    ['jobwork.over_norm_loss', 'finance_controller'],
    ['jobwork.offcut_acquisition', 'cfo'],
  ].map(([transaction_type, role]) => ({ transaction_type, role, value_min: null, value_max: null })),
  // Unique per (criticality_class, safety_flag); together they cover every priority p1 to p4.
  sla_policies: [
    ['critical', true, 'p1', 15, 4], ['critical', false, 'p1', 30, 8],
    ['high', true, 'p1', 30, 8], ['high', false, 'p2', 60, 24],
    ['medium', true, 'p2', 60, 24], ['medium', false, 'p3', 240, 72],
    ['low', true, 'p3', 240, 72], ['low', false, 'p4', 480, 168],
  ].map(([criticality_class, safety_flag, priority, response_minutes, resolution_hours]) => ({ criticality_class, safety_flag, priority, response_minutes, resolution_hours })),
  // No instruments and no critical spares: the runbook forbids calibration certificates and
  // re-levelling critical spare min-max in the pilot.
  assets: [
    ['AST-PRESS-01', 'Hydraulic press 100 T', 'high', 'hours'],
    ['AST-LATHE-02', 'CNC lathe', 'medium', 'hours'],
    ['AST-FORKLIFT-01', 'Forklift 3 T', 'medium', 'km'],
    ['AST-COMPRESSOR-01', 'Screw compressor', 'low', 'hours'],
  ].map(([tag, asset_name, criticality_class, unit]) => ({
    asset_tag: `${tag}${T}`, asset_name, criticality_class, manufacturer: 'Mock Machines Ltd', model: tag.slice(4),
    meter: { meter_code: `MTR-${tag.slice(4)}${T}`, unit, silent_after_days: 30, alert_role: 'maintenance_supervisor' },
  })),
  // One standard plan per finished good, bound to the released BOM revision at setup time.
  inspection_plans: FG.map((sku) => ({
    sku, scope: 'standard', aql: '1.000', inspection_level: 'II',
    characteristics: [
      { line_no: 1, characteristic_name: 'Visual finish', characteristic_class: 'minor', test_method_ref: 'WI-QC-001', instrument_type: null, result_kind: 'attribute', lower_limit: null, upper_limit: null, limit_uom: null, acceptance_criteria: 'No dents, burrs or rust', sample_handling: 'Return to lot' },
      { line_no: 2, characteristic_name: 'Assembly completeness', characteristic_class: 'major', test_method_ref: 'WI-QC-002', instrument_type: null, result_kind: 'attribute', lower_limit: null, upper_limit: null, limit_uom: null, acceptance_criteria: 'All components fitted per BOM', sample_handling: 'Return to lot' },
    ],
  })),
  // An agreement is matched on the EXACT location of a receipt (src/compliance/ownership.ts:255),
  // so each one is created at the receiving docks and at every storage bin.
  ownership_agreement_locations: [RECEIVING_DOCK, `RECV-DOCK-02${T}`, PUTAWAY_BIN, ...bins],
  ownership_agreements: items.filter((it) => it.stock_class === 'consignment' || it.stock_class === 'vmi').map((it) => ({
    sku: it.sku, stock_class: it.stock_class, business_stream: 'production', owner_party_code: 'SUP-NORTHERN-FAST',
    ...(it.stock_class === 'vmi' ? { vmi_min_qty: 50 } : {}),
  })),
  // Supplier master rows. Receiving and indents carry the supplier only as the ERP reference
  // string; the master is needed by platform purchase orders, supplier invoices and scorecards.
  suppliers: [
    ['SUP-ACME', 'Acme Industrial Supplies Pvt Ltd', '09AAACA1111A1Z5'],
    ['SUP-BHARAT-STEEL', 'Bharat Steel Traders', '09AAACB2222B1Z3'],
    ['SUP-NORTHERN-FAST', 'Northern Fasteners LLP', '09AAACN3333C1Z1'],
  ].map(([owner_party_code, legal_name, gstin_ext]) => ({ owner_party_code, legal_name, gstin_ext, credit_period_days: 30, contacts: [{ name: 'Accounts desk', email: `accounts@${owner_party_code.toLowerCase()}.example` }],
    // mock evidence: the hash is of no real file
    onboarding_documents: [{ type: 'gst_certificate', reference: `GST-${gstin_ext}`, file_hash: createHash('sha256').update(gstin_ext).digest('hex') }],
  })),
  production: { output_sku: FG[0], kit_ref: kits[0].kit_ref, order_quantity: '2' },
};

// ---------------------------------------------------------------- write the pack

mkdirSync(args.out, { recursive: true });
const write = (name, text) => writeFileSync(join(args.out, name), text, 'utf8');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const stockColumns = OPENING_STOCK_HEADER.split(',');

write('opening_stock.csv', csv(OPENING_STOCK_HEADER, fileRows.map((r) => stockColumns.map((c) => r.row[c] ?? ''))));
write('active_boms.csv', csv(MANIFEST_HEADERS.active_boms, bomRows));
write('open_pos.csv', csv(MANIFEST_HEADERS.open_pos, poRows));
write('jobwork_challans.csv', csv(MANIFEST_HEADERS.jobwork_challans, challanRows));
write('custody_registers.csv', csv(MANIFEST_HEADERS.custody_registers, custodyRows));

// Bodies for POST /api/v1/erp/sync (src/adapters/erp/sync.ts: ErpSyncBatch)
write('erp-sync-stock-balances.json', json({
  stock_balances: erpBalances.map((g) => ({
    source_system: 'ERP',
    site_code_ext: site,
    location_code: g.location_code,
    sku: g.sku,
    lot_number_ext: g.lot_number || null,
    serial_number_ext: g.serial_number || null,
    quantity: g.serial_number ? '1' : qty(g.quantity),
    unit_cost: bySku.get(g.sku).unit_cost?.toFixed(4) ?? null,
    snapshot_at: `${args.countedOn}T12:30:00.000Z`,
  })),
}));
write('erp-sync-purchase-orders.json', json({ purchase_orders: purchaseOrders }));
write('erp-sync-sales-orders.json', json({ sales_orders: salesOrders }));
write('roles.json', json(rolesFile));

// Platform side a seeder must create before any file is loaded
write('world.json', json({
  site_code: site,
  document_ref_prefix: REF_PREFIX,
  bins,
  locations,
  items: items.map((it) => ({ sku: it.sku, uom: it.uom, lot_controlled: it.control === 'lot', serial_controlled: it.control === 'serial' })),
  suppliers: supplierRefs,
  legacy_kits: kits,
  service_orders: serviceOrders,
  people: people.map((p) => ({ email: p.email, display_name: p.display_name, fictitious: p.fictitious, roles: [...new Set(p.grants.map((g) => g[0]))] })),
  operations,
}));
write('expected-outcomes.json', json({
  generated_with: { site_code: site, lines: args.lines, seed: args.seed, counted_on: args.countedOn },
  document_ref_prefix: REF_PREFIX,
  opening_stock: { file_rows: fileRows.length, source_grains: erpBalances.length, planted: expected.opening_stock },
  active_boms: { manifest_rows: bomRows.length, planted: expected.active_boms },
  open_pos: { manifest_rows: poRows.length, planted: expected.open_pos },
  jobwork_challans: { manifest_rows: challanRows.length, planted: expected.jobwork_challans },
  custody_registers: { manifest_rows: custodyRows.length, planted: expected.custody_registers },
}));

const planted = Object.values(expected).reduce((n, list) => n + list.length, 0);
console.log(`mock pack for ${site}: ${fileRows.length} opening-stock rows, ${planted} planted defects -> ${args.out}`);
