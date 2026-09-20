#!/usr/bin/env node
// Mock rehearsal pack generator (runbook section 3, mock pass).
//
// Writes a matched pair: the platform side (world.json, the two erp-sync bodies) and the legacy
// claim (the five v1 CSVs), with the defects of defects.json planted on purpose. The answer sheet
// is expected-outcomes.json. Deterministic: the same --seed gives the same pack.
//
//   node deploy/rehearsal/mock/generate.mjs --site-code CMF-ALIGARH --lines 300 --seed 42
//
// Formats: docs/migration/opening-stock-template-v1.md, docs/migration/document-manifest-templates-v1.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every mock BOM and PO reference starts with this; it is the verification run's document_ref_prefix.
const REF_PREFIX = 'MK-';

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
  const args = { siteCode: 'MOCK-SITE', lines: 300, seed: 42, countedOn: yesterday, out: null };
  for (let i = 2; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === '--site-code') args.siteCode = value;
    else if (argv[i] === '--lines') args.lines = Number(value);
    else if (argv[i] === '--seed') args.seed = Number(value);
    else if (argv[i] === '--counted-on') args.countedOn = value;
    else if (argv[i] === '--out') args.out = value;
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
const rand = prng(args.seed);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[int(0, list.length - 1)];
const pad = (n, width) => String(n).padStart(width, '0');
const qty = (n) => n.toFixed(6);
const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csv = (header, rows) => [header, ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';

// ---------------------------------------------------------------- master data

const bins = Array.from({ length: 10 }, (_, i) => `BIN-${'AABBCCJJRR'[i]}${pad((i % 2) + 1, 2)}`);

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
  ...['FG-PUMP-12', 'FG-FRAME-A', 'FG-BRACKET-H'].map((s, i) => item(s, 'EA', 'plain', 'owned', 4200 + i * 900)),
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
    lot_number: it.control === 'lot' ? `LOT-${pad(++lotSeq, 4)}` : '',
    serial_number: it.control === 'serial' ? `SN-${++serialSeq}` : '',
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
  const g = { location_code: pick(bins), sku: 'MTR-7.5KW', lot_number: '', serial_number: `SN-${++serialSeq}`, quantity: 1, expiry: '' };
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
const kits = ['FG-PUMP-12', 'FG-FRAME-A', 'FG-BRACKET-H'].map((parent, i) => ({
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
const challanDate = `${args.countedOn.slice(0, 4)}-${pad(Math.max(1, Number(args.countedOn.slice(5, 7)) - 1), 2)}-12`;
const serviceOrders = ['CUST-SHEET-3MM', 'CUST-PLATE-8MM', 'CUST-ROD-20MM'].map((sku, i) => {
  const challans = [1, 2].map((n) => ({ challan_number_ext: `DC-MK-${pad(i * 2 + n, 3)}`, challan_date: challanDate, sku, challan_qty: int(300, 1500), uom: 'KG', challan_class: 'input' }));
  const consumed = int(50, 250);
  return {
    order_number_ext: `JW-MK-${pad(i + 1, 4)}`,
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

/** Bump one numeric cell of a manifest row and record the field_mismatch it must produce. */
function bumpCell(rows, domain, defect, column, field, refOf, start) {
  times(defects[domain]?.[defect], (i) => {
    const row = rows[(start + i) % rows.length];
    const platformValue = row[column];
    row[column] = String(Number(platformValue) + 7);
    expected[domain].push({ defect, finding_kind: 'field_mismatch', field, document: refOf(row), source_value: row[column], platform_value: platformValue });
  });
}
bumpCell(bomRows, 'active_boms', 'quantity_per_off', 5, 'quantity_per', (r) => `${r[1]} / ${r[4]}`, 1);
bumpCell(poRows, 'open_pos', 'received_qty_off', 6, 'received_qty', (r) => `${r[1]} line ${r[2]}`, 0);
bumpCell(challanRows, 'jobwork_challans', 'challan_qty_off', 6, 'challan_qty', (r) => r[1], 2);
bumpCell(custodyRows, 'custody_registers', 'custody_qty_off', 4, 'custody_qty', (r) => r[1], 1);
times(defects.active_boms?.component_missing_in_platform, (i) => {
  const k = kits[i % kits.length];
  bomRows.push([site, k.kit_ref, k.parent_sku, k.revision_code, 'CON-GRIND-DISC', '2', 'EA']);
  expected.active_boms.push({ defect: 'component_missing_in_platform', finding_kind: 'missing_in_platform', document: `${k.kit_ref} / CON-GRIND-DISC` });
});
times(defects.open_pos?.po_missing_in_platform, (i) => {
  const ref = `${REF_PREFIX}PO-9${pad(i + 1, 3)}`;
  poRows.push([site, ref, '1', 'BRG-6204', 'SUP-ACME', '100', '0', '100', '', '']);
  expected.open_pos.push({ defect: 'po_missing_in_platform', finding_kind: 'missing_in_platform', document: ref });
});

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

// Platform side a seeder must create before any file is loaded
write('world.json', json({
  site_code: site,
  document_ref_prefix: REF_PREFIX,
  bins,
  items: items.map((it) => ({ sku: it.sku, uom: it.uom, lot_controlled: it.control === 'lot', serial_controlled: it.control === 'serial' })),
  suppliers: supplierRefs,
  legacy_kits: kits,
  service_orders: serviceOrders,
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
