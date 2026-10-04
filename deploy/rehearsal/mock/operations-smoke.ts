// Operations smoke test of a mock pack: one normal working day through the real router, as the
// right distinct people, with a PASS/FAIL line per action.
//
//   local : node --env-file=.env.test --import tsx deploy/rehearsal/mock/operations-smoke.ts
//           (runs rehearse.ts for a fresh site first, then setup-operations, then the day;
//            --site-code MOCK-XXXX reuses a site that is already live)
//   remote: node --import tsx deploy/rehearsal/mock/operations-smoke.ts --remote cfg.json --pack <dir>
//           (the site must be live, roles.json applied, setup-operations.ts run; --with-setup
//            runs the setup first)
//
// The day: gate entry, weighbridge, GRN of a plain, a lot and a consignment item, putaway into a storage bin,
// a job-work challan receipt (no PO, no ticket) and its duplicate refused,
// cycle count with approval by another person, pick + pack (a wrong lot refused first) + IRN + documents + dispatch of a
// seeded sales order, a production order for a seeded BOM (release, stage, issue,
// complete against the inspection plan), an indent raised and approved, a maintenance fault
// through work order to completion. A separate leg (Story 3.12) drives a second vehicle through
// gate and weighbridge with double the ordered weight and checks the tolerance breach reaches the
// unloading supervisor's in-app notifications. Every record is permanent (append-only platform):
// a remote run consumes one sales order and a little stock each time, and leaves one open gate
// event with a breach weighment behind.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HERE,
  ROOT,
  approveAs,
  argOf,
  boot,
  flow,
  hasFlag,
  listOf,
  must,
  packJson,
  printTable,
  skip,
  step,
  uuid,
  type Ctx,
  type Json,
} from './ops-lib.js';
import { itemIdOf, releasedBomOf, setupOperations } from './setup-operations.js';

const today = () => new Date().toISOString().slice(0, 10);
const nextYear = () => `${new Date().getFullYear() + 1}-12-31`;

/** Bins that hold available stock of a SKU at this site, richest first (GET /api/v1/stock/:sku). */
export async function stockOf(ctx: Ctx, sku: string, who: string): Promise<Json[]> {
  const res = must(
    await ctx.request(
      'GET',
      `/api/v1/stock/${encodeURIComponent(sku)}`,
      undefined,
      await ctx.as(who),
    ),
    200,
    `stock ${sku}`,
  );
  return (res['locations'] as Json[])
    .filter(
      (l) =>
        (l['stock_class'] ?? 'owned') === 'owned' &&
        Number(l['available'] ?? l['quantity'] ?? l['on_hand'] ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        Number(b['available'] ?? b['quantity'] ?? 0) - Number(a['available'] ?? a['quantity'] ?? 0),
    );
}

export async function inbound(ctx: Ctx): Promise<void> {
  const po = ctx.ops['operations_po'] as string;
  const dock = ctx.ops['receiving_dock'] as string;
  const bin = ctx.ops['putaway_bin'] as string;
  const lot = `LOT-SMOKE-${ctx.run.toUpperCase()}`;
  let token = '';
  const tasks: string[] = [];
  let jobworkOrderId = '';
  let challan: Json | null = null;
  let countId = '';
  let adjustment: Json = {};

  const grn = async (lineNo: number, sku: string, qty: number, extra: Json) => {
    const res = must(
      await ctx.request(
        'POST',
        '/api/v1/grn-lines',
        {
          correlation_id: token,
          po_ref_ext: po,
          line_no: lineNo,
          sku,
          received_qty: qty,
          source_document: 'PO',
          target_location_code: dock,
          // Story 3.11: every smoke receipt is a part delivery of its PO line, and a GOOD line that
          // leaves the PO line short must say why.
          reason_code: 'SHORT',
          reason_detail: 'PART_DELIVERY_BALANCE_TO_FOLLOW',
          ...extra,
        },
        await ctx.as('store'),
      ),
      201,
      `GRN ${sku}`,
    );
    const task = res['putaway_task'] as Json | null;
    if (task?.['putaway_task_id']) tasks.push(task['putaway_task_id'] as string);
    return `${qty} ${sku} at ${dock}, line ${String((res['grn_line'] as Json)['status'])}, putaway task ${String(task?.['status'])}`;
  };

  await flow([
    [
      'inbound: gate entry',
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/gate-events',
            {
              gate_event_id: uuid(),
              site_code_ext: ctx.siteCode,
              po_ref_ext: po,
              vehicle_reg_ext: 'UP81AB1234',
              challan_photo_ref: `photo://smoke/${ctx.run}`,
              challan_number_ext: `CH-${ctx.run}`,
              driver_name: 'Smoke Driver',
              gate_id: 'GATE-1',
              entered_at: new Date().toISOString(),
            },
            await ctx.as('gate'),
          ),
          201,
          'gate event',
        );
        token = res['correlation_id'] as string;
        return `binding ${String(res['binding_status'])} to ${po}`;
      },
    ],
    [
      'inbound: weighbridge (net within the PO line band)',
      async () => {
        // The band is the ordered quantity of the weighed PO line: line 2, the coil in KG.
        // A driver that fed today's PO itself (deploy/pilot/sim/pilot-day.ts) leaves it in
        // ops.operations_po_snapshot; otherwise the pack's snapshot holds the PO.
        const orders = (
          ctx.ops['operations_po_snapshot']
            ? [ctx.ops['operations_po_snapshot']]
            : packJson(ctx, 'erp-sync-purchase-orders.json')['purchase_orders']
        ) as {
          po_number_ext: string;
          lines: { line_no: number; ordered_qty: number }[];
        }[];
        const ordered = orders
          .find((o) => o.po_number_ext === po)!
          .lines.find((l) => l.line_no === 2)!.ordered_qty;
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/weighbridge-events',
            {
              correlation_id: token,
              tare_kg: 7000,
              gross_kg: 7000 + ordered,
              po_ref_ext: po,
              line_no: 2,
              device_id: 'WB-1',
              capture_method: 'MANUAL',
            },
            await ctx.as('weighbridge'),
          ),
          201,
          'weighbridge event',
        );
        if (res['status'] !== 'accepted') throw new Error(`weighment ${String(res['status'])}`);
        return `net ${String(res['net_kg'])} kg accepted`;
      },
    ],
    ['inbound: GRN plain item', () => grn(1, 'BRG-6204', 50, {})],
    [
      'inbound: GRN lot item',
      () => grn(2, 'RM-COIL-2MM', 100, { lot_id: lot, expiry_date: nextYear() }),
    ],
    [
      'inbound: GRN consignment item (ownership agreement)',
      () =>
        grn(4, 'FAST-M8-BOLT', 500, {
          lot_id: `${lot}-C`,
          stock_class: 'consignment',
          owner_party_code: 'SUP-NORTHERN-FAST',
        }),
    ],
    [
      'inbound: putaway into a storage bin',
      async () => {
        for (const id of tasks) {
          must(
            await ctx.request(
              'POST',
              `/api/v1/putaway-tasks/${id}/complete`,
              {
                actual_location_code: bin,
                override_reason_code: 'OPERATOR_CHOICE',
                override_confidence: 'certain',
                idempotency_key: uuid(),
              },
              await ctx.as('store'),
            ),
            200,
            'putaway complete',
          );
        }
        const here = (await stockOf(ctx, 'BRG-6204', 'invctl')).find(
          (l) => l['location_code'] === bin,
        );
        if (!here) throw new Error(`BRG-6204 is not in ${bin} after putaway`);
        return `${tasks.length} tasks completed into ${bin}`;
      },
    ],
    [
      'job-work: receive customer material against the challan (no PO, no ticket)',
      async () => {
        // The seeded order JW-MK-0001 (a tagged pack suffixes the number). The pack's job-work
        // orders are migrated in with no kit BOM, which the challan receipt refuses unless
        // JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM is true (owner ruling 2026-09-22): staging sets it, and
        // local mode sets it below before the app boots.
        const orders = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/service-orders?site_id=${ctx.siteId}&status=in_process&limit=200`,
              undefined,
              await ctx.as('depthead'),
            ),
            200,
            'list service orders',
          ),
          'service_orders',
        );
        const order = orders.find((o) => String(o['order_number_ext']).startsWith('JW-MK-0001'));
        if (!order) throw new Error(`no in-process order JW-MK-0001 at ${ctx.siteCode}`);
        jobworkOrderId = order['service_order_id'] as string;
        challan = {
          source_document: 'JOBWORK_CHALLAN',
          stock_class: 'job_work',
          service_order_id: jobworkOrderId,
          challan_number_ext: `DC-SMOKE-${ctx.run.toUpperCase()}`,
          challan_date: today(),
          challan_qty: 120,
          sku: 'CUST-SHEET-3MM',
          lot_id: `HEAT-SMOKE-${ctx.run.toUpperCase()}`,
          target_location_code: dock,
          received_qty: 120,
          idempotency_key: uuid(),
        };
        const res = must(
          await ctx.request('POST', '/api/v1/grn-lines', challan, await ctx.as('store')),
          201,
          'challan receipt',
        );
        const grn = res['grn'] as Json;
        if (grn['po_ref_ext'] !== null)
          throw new Error(`the challan GRN carries a purchase order: ${String(grn['po_ref_ext'])}`);
        const receipts = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/service-orders/${jobworkOrderId}/receipts`,
              undefined,
              await ctx.as('depthead'),
            ),
            200,
            'list receipts',
          ),
          'receipts',
        );
        const number = String(challan['challan_number_ext']);
        const mine = receipts.find((r) => r['challan_number_ext'] === number);
        if (!mine) throw new Error(`no receipt row for challan ${number}`);
        return `${String(challan['received_qty'])} ${String(challan['sku'])} of ${String(order['order_number_ext'])} at ${dock}, receipt ${String(mine['receipt_id'])}, no PO, no ticket`;
      },
    ],
    [
      'job-work: the same challan and lot again is refused',
      async () => {
        if (!challan) throw new Error('nothing was received');
        const res = await ctx.request(
          'POST',
          '/api/v1/grn-lines',
          { ...challan, idempotency_key: uuid() },
          await ctx.as('store'),
        );
        if (res.status !== 409 || res.body['error_code'] !== 'JOBWORK_CHALLAN_DUPLICATE')
          throw new Error(
            `expected 409 JOBWORK_CHALLAN_DUPLICATE, got ${res.status} ${res.text.slice(0, 300)}`,
          );
        return `JOBWORK_CHALLAN_DUPLICATE for ${String(challan['challan_number_ext'])}`;
      },
    ],
    [
      'count: cycle count with a variance',
      async () => {
        const here = (await stockOf(ctx, 'BRG-6204', 'invctl')).find(
          (l) => l['location_code'] === bin,
        )!;
        const system = Number(here['available'] ?? here['quantity']);
        const made = must(
          await ctx.request(
            'POST',
            '/api/v1/cycle-counts',
            {
              location_id: here['location_id'],
              sku_scope: ['BRG-6204'],
              count_type: 'cycle',
              business_date: today(),
              business_stream: 'production',
            },
            await ctx.as('invctl'),
          ),
          [200, 201],
          'create count',
        );
        countId = made['cycle_count_id'] as string;
        const submitted = must(
          await ctx.request(
            'POST',
            `/api/v1/cycle-counts/${countId}/submit`,
            { lines: [{ sku: 'BRG-6204', counted_quantity: system - 1 }], idempotency_key: uuid() },
            await ctx.as('invctl'),
          ),
          [200, 201],
          'submit count',
        );
        adjustment = (submitted['lines'] as Json[]).find((l) => l['adjustment_id']) ?? {};
        if (!adjustment['adjustment_id'])
          throw new Error(`no adjustment raised: ${JSON.stringify(submitted).slice(0, 300)}`);
        return `system ${system}, counted ${system - 1}, adjustment pending`;
      },
    ],
    [
      'count: counter cannot approve, another person approves',
      async () => {
        const path = `/api/v1/cycle-counts/${countId}/adjustments/${String(adjustment['adjustment_id'])}/approve`;
        const self = await ctx.request(
          'PATCH',
          path,
          { reason_code: 'shrinkage' },
          await ctx.as('invctl'),
        );
        if (self.status >= 200 && self.status < 300)
          throw new Error('the counter approved the own adjustment');
        const approved = await approveAs(
          ctx,
          'whmanager',
          { role: 'warehouse_manager', module: 'inventory' },
          (headers) => ctx.request('PATCH', path, { reason_code: 'shrinkage' }, headers),
          (adjustment['approver_actor_id'] as string | undefined) ?? null,
        );
        must(approved, 200, 'approve adjustment');
        return `self-approval refused (${String(self.body['error_code'] ?? self.status)}), approved by the warehouse manager`;
      },
    ],
  ]);
}

/** Every path to a number-typed value in `value` (Story 1.15: availability carries no quantity). */
function numericPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => numericPaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Json).flatMap(([k, v]) => numericPaths(v, `${path}.${k}`));
  return [];
}

const EMPLOYEE_SKU = 'BRG-6204';
const EMPLOYEE_STEPS = [
  'employee: availability shows in stock and no quantity',
  'employee: raise a requisition from the base role',
  'employee: own requisition listed with mine=true',
  'employee: bootstrap advertises the three base entries',
];

/**
 * Story 1.15: the base hat end to end as `operations.actors.employee`, a person with no
 * procurement and no inventory grant. Its own flow so a failure does not SKIP the rest of the day.
 * A pack without the actor, or a site without stock of the SKU, is a named SKIP, never a crash.
 */
export async function employeeRequisition(ctx: Ctx): Promise<void> {
  let headers: Headers;
  try {
    headers = await ctx.as('employee');
  } catch (error) {
    for (const name of EMPLOYEE_STEPS) skip(name, `no employee actor: ${(error as Error).message}`);
    return;
  }
  const stocked = await stockOf(ctx, EMPLOYEE_SKU, 'invctl').catch(() => [] as Json[]);
  if (stocked.length === 0) {
    for (const name of EMPLOYEE_STEPS) skip(name, `no available ${EMPLOYEE_SKU} at the site`);
    return;
  }
  let indentId = '';
  await flow([
    [
      EMPLOYEE_STEPS[0]!,
      async () => {
        const res = must(
          await ctx.request(
            'GET',
            `/api/v1/stock/${encodeURIComponent(EMPLOYEE_SKU)}/availability`,
            undefined,
            headers,
          ),
          200,
          'availability',
        );
        const numbers = numericPaths(res);
        if (numbers.length > 0)
          throw new Error(`numeric values in the body: ${numbers.join(', ')}`);
        if (res['in_stock'] !== true) throw new Error(`in_stock ${String(res['in_stock'])}`);
        const denied = await ctx.request(
          'GET',
          `/api/v1/stock/${encodeURIComponent(EMPLOYEE_SKU)}`,
          undefined,
          headers,
        );
        if (denied.status !== 403 || denied.body['error_code'] !== 'MODULE_ACCESS_DENIED')
          throw new Error(
            `stock detail answered ${denied.status}, expected 403 MODULE_ACCESS_DENIED`,
          );
        return `${(res['locations'] as Json[]).length} location(s), detail refused`;
      },
    ],
    [
      EMPLOYEE_STEPS[1]!,
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/indents',
            {
              site_id: ctx.siteId,
              department_code: 'MAINT',
              business_stream: 'production',
              need_by_date: nextYear(),
              urgent: false,
              reason: 'Operations smoke test (employee base role)',
              confirm_duplicate: true,
              lines: [
                {
                  sku: EMPLOYEE_SKU,
                  item_category: 'spares',
                  requested_qty: 2,
                  uom: 'EA',
                  unit_price_estimate: 150,
                },
              ],
            },
            headers,
          ),
          201,
          'raise indent (employee)',
        );
        const indent = (res['indent'] ?? {}) as Json;
        indentId = indent['indent_id'] as string;
        const me = must(
          await ctx.request('GET', '/api/v1/edge/bootstrap', undefined, headers),
          200,
          'bootstrap (employee)',
        );
        if (indent['requester_user_id'] !== me['user_id'])
          throw new Error(`requester ${String(indent['requester_user_id'])} is not the caller`);
        return `${String(indent['indent_number_ext'])} raised by the base role`;
      },
    ],
    [
      EMPLOYEE_STEPS[2]!,
      async () => {
        const res = must(
          await ctx.request('GET', '/api/v1/indents?mine=true', undefined, headers),
          200,
          'my requests',
        );
        const ids = (res['indents'] as Json[]).map((i) => i['indent_id']);
        if (!ids.includes(indentId)) throw new Error(`indent ${indentId} not in own list`);
        return `${ids.length} own requisition(s)`;
      },
    ],
    [
      EMPLOYEE_STEPS[3]!,
      async () => {
        const res = must(
          await ctx.request('GET', '/api/v1/edge/bootstrap', undefined, headers),
          200,
          'bootstrap (employee)',
        );
        const navigation = res['navigation'] as string[];
        for (const name of ['New requisition', 'Check stock', 'My requests'])
          if (!navigation.includes(name))
            throw new Error(`navigation lacks "${name}": ${navigation.join(', ')}`);
        return navigation.join(', ');
      },
    ],
  ]);
}

const SITE_HEAD_STEPS = [
  'site head: reads the job-work clocks of the site',
  'site head: a jobwork writer without the hat is refused',
  'site head: the holder passes the classification gate',
];

/**
 * Story 1.16: `operations.actors.sitehead` holds `site_head` at the site. The hat is proven on the
 * one action gated on it today, the challan classification correction, and no clock is changed:
 * the correction is sent with the class the clock already has, which the platform answers 200
 * without writing. The refused attempt is a refused statutory correction, so each run leaves one
 * audit row for it. A pack without one of the three actors, or a site without a job-work clock, is
 * a named SKIP.
 */
export async function siteHead(ctx: Ctx): Promise<void> {
  let headers: Awaited<ReturnType<Ctx['as']>>;
  let withoutHat: Awaited<ReturnType<Ctx['as']>>;
  let baseRole: Awaited<ReturnType<Ctx['as']>>;
  try {
    headers = await ctx.as('sitehead');
    withoutHat = await ctx.as('depthead');
    baseRole = await ctx.as('employee');
  } catch (error) {
    for (const name of SITE_HEAD_STEPS)
      skip(name, `an actor of the site head flow is unavailable: ${(error as Error).message}`);
    return;
  }
  let clock: Json | null = null;
  const read = await step(SITE_HEAD_STEPS[0]!, async () => {
    const path = `/api/v1/jobwork/reports/aging?site_id=${ctx.siteId}`;
    const res = must(await ctx.request('GET', path, undefined, headers), 200, 'aging report');
    const rows = listOf(res, 'rows');
    clock = rows.find((row) => row['site_id'] === ctx.siteId) ?? null;
    const denied = await ctx.request('GET', path, undefined, baseRole);
    if (denied.status !== 403)
      throw new Error(`the base role read the report: ${denied.status}, expected 403`);
    return `${rows.length} clock(s) with exposure at the site, the base role refused`;
  });
  if (!read) {
    for (const name of SITE_HEAD_STEPS.slice(1)) skip(name, `needs "${SITE_HEAD_STEPS[0]!}"`);
    return;
  }
  if (clock === null) {
    for (const name of SITE_HEAD_STEPS.slice(1)) skip(name, 'no job-work clock at the site');
    return;
  }
  const target = clock as Json;
  const correction = (as: Awaited<ReturnType<Ctx['as']>>) =>
    ctx.request(
      'PATCH',
      `/api/v1/jobwork/clocks/${String(target['clock_id'])}/classification`,
      { idempotency_key: uuid(), challan_class: target['challan_class'] },
      as,
    );
  await flow([
    [
      SITE_HEAD_STEPS[1]!,
      async () => {
        const res = await correction(withoutHat);
        const required = ((res.body['details'] ?? {}) as Json)['required_roles'];
        if (res.status !== 403 || res.body['error_code'] !== 'FUNCTION_ACCESS_DENIED')
          throw new Error(
            `answered ${res.status} ${String(res.body['error_code'])}, expected 403 FUNCTION_ACCESS_DENIED`,
          );
        if (!Array.isArray(required) || !required.includes('site_head'))
          throw new Error(`required_roles ${JSON.stringify(required)} does not name site_head`);
        return `${ctx.emailOf('depthead')} refused, required ${required.join(', ')}`;
      },
    ],
    [
      SITE_HEAD_STEPS[2]!,
      async () => {
        const res = must(await correction(headers), 200, 'classification (site head)');
        const after = (res['return_clock'] ?? {}) as Json;
        if (after['clock_id'] !== target['clock_id'])
          throw new Error(`answered clock ${String(after['clock_id'])}`);
        if (after['challan_class'] !== target['challan_class'])
          throw new Error(`class changed to ${String(after['challan_class'])}`);
        return `${ctx.emailOf('sitehead')} passed, class still ${String(after['challan_class'])}`;
      },
    ],
  ]);
}

const DAMAGE_STEPS = [
  'damage: upload a photo as taken',
  'damage: report 1 unit at a bin with a replacement',
  'damage: raise the linked replacement requisition',
  'damage: stores marks the units arrived in QC hold',
  'damage: QC inspects and confirms the damage',
  'damage: QC head turns the QC key',
  'damage: finance turns the finance key',
  'damage: finance records the ERP reference and closes',
];
const DAMAGE_ESCALATION_STEPS = [
  'damage escalation: report and inspect a second case',
  'damage escalation: QC key, then finance disagrees',
  'damage escalation: the CEO decides',
  'damage escalation: finance records the ERP reference',
];

/** A small JPEG-shaped body: the photo store checks the magic bytes, not the picture. */
function smokeJpeg(): Buffer {
  const out = randomBytes(2048);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  out[3] = 0xe0;
  return out;
}

/** A bin holding owned stock of the SKU that is not the QC hold area, or null. */
async function damageBin(ctx: Ctx, sku: string): Promise<string | null> {
  const quarantine = new Set([ctx.ops['qc_hold_zone'], ctx.ops['quarantine_bin']]);
  const stocked = await stockOf(ctx, sku, 'invctl').catch(() => [] as Json[]);
  // damageReport() opens two separate 1-unit reports against this same bin (the main flow, then
  // the escalation flow), so the bin must cover both or the second report silently falls back to
  // record_only instead of quarantined.
  const bin = stocked.find(
    (l) =>
      typeof l['location_code'] === 'string' &&
      !quarantine.has(l['location_code']) &&
      Number(l['available'] ?? l['quantity'] ?? l['on_hand'] ?? 0) >= 2,
  );
  return (bin?.['location_code'] as string | undefined) ?? null;
}

/** A DOA-resolved damage decision as the configured actor, or the person the registry resolved. */
async function damageDecision(
  ctx: Ctx,
  who: string,
  grant: { role: string; module: string },
  reportId: string,
  path: string,
  body: Json,
): Promise<Json> {
  const res = await approveAs(ctx, who, grant, async (headers) =>
    ctx.request('POST', `/api/v1/damage-reports/${reportId}/${path}`, body, headers),
  );
  return (must(res, [200, 201], `damage ${path} (${who})`)['report'] ?? {}) as Json;
}

/**
 * Story 8.9: report damage end to end - the base hat reports with a photo and a linked
 * replacement, stores marks the units arrived, QC inspects, the two DOA keys concur and finance
 * records the ERP reference. A second case drives a disagreement to the CEO. A pack without an
 * actor or without stock of the SKU at a bin is a named SKIP, never a crash. Records are
 * permanent: each run books two units of the SKU into the QC hold area and leaves them held
 * (both cases close as write-offs).
 */
export async function damageReport(ctx: Ctx): Promise<void> {
  let headers: Headers;
  try {
    headers = await ctx.as('employee');
    for (const who of ['store', 'qc', 'qchead', 'compliance', 'ceo']) await ctx.as(who);
  } catch (error) {
    for (const name of [...DAMAGE_STEPS, ...DAMAGE_ESCALATION_STEPS])
      skip(name, `missing actor: ${(error as Error).message}`);
    return;
  }
  const bin = await damageBin(ctx, EMPLOYEE_SKU);
  if (bin === null) {
    for (const name of [...DAMAGE_STEPS, ...DAMAGE_ESCALATION_STEPS])
      skip(name, `no owned ${EMPLOYEE_SKU} at a non-quarantine bin`);
    return;
  }
  for (const [transactionType, value] of [
    ['damage.qc_concurrence', 0],
    ['damage.finance_concurrence', 0],
    ['damage.escalation', 0],
  ] as const) {
    const res = await ctx.request(
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: transactionType, value },
      await ctx.as('compliance'),
    );
    if (res.status !== 200) {
      for (const name of [...DAMAGE_STEPS, ...DAMAGE_ESCALATION_STEPS])
        skip(name, `no active DOA band for ${transactionType}`);
      return;
    }
  }
  const photoId = uuid();
  const indentId = uuid();
  let reportId = '';
  const report = async (extra: Json): Promise<Json> =>
    (must(
      await ctx.request(
        'POST',
        '/api/v1/damage-reports',
        {
          site_id: ctx.siteId,
          sku: EMPLOYEE_SKU,
          quantity: '1',
          found_at: 'stock',
          bin_code: bin,
          reason_code: 'DAMAGED_COMPONENT',
          photo_attachment_id: photoId,
          ...extra,
        },
        headers,
      ),
      201,
      'report damage',
    )['report'] ?? {}) as Json;
  const qcKey = { role: 'qc_head', module: 'qc' };
  const financeKey = { role: 'finance_controller', module: 'compliance' };
  const inspect = async (id: string): Promise<Json> =>
    (must(
      await ctx.request(
        'POST',
        `/api/v1/damage-reports/${id}/inspection`,
        { confirmed_quantity: '1', defect_code: 'FUNCTIONAL' },
        await ctx.as('qc'),
      ),
      [200, 201],
      'inspect',
    )['report'] ?? {}) as Json;

  await flow([
    [
      DAMAGE_STEPS[0]!,
      async () => {
        const res = must(
          await ctx.request('PUT', `/api/v1/attachments/${photoId}`, smokeJpeg(), {
            ...headers,
            'Content-Type': 'image/jpeg',
          }),
          [200, 201],
          'photo upload',
        );
        return `${String(res['byte_size'])} bytes, sha256 ${String(res['sha256']).slice(0, 12)}`;
      },
    ],
    [
      DAMAGE_STEPS[1]!,
      async () => {
        const r = await report({ replacement_indent_id: indentId });
        reportId = r['report_id'] as string;
        if (r['hold_mode'] !== 'quarantined')
          throw new Error(`hold_mode ${String(r['hold_mode'])} (${String(r['hold_note'])})`);
        if (r['photo_status'] !== 'stored')
          throw new Error(`photo_status ${String(r['photo_status'])}`);
        return `${String(r['report_number'])} at ${bin}, booked into QC hold`;
      },
    ],
    [
      DAMAGE_STEPS[2]!,
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/indents',
            {
              indent_id: indentId,
              damage_report_id: reportId,
              site_id: ctx.siteId,
              department_code: 'MAINT',
              business_stream: 'production',
              need_by_date: today(),
              urgent: true,
              reason: 'Replacement for damaged units (operations smoke test)',
              confirm_duplicate: true,
              lines: [{ sku: EMPLOYEE_SKU, item_category: 'spares', requested_qty: 1, uom: 'EA' }],
            },
            headers,
          ),
          201,
          'replacement indent',
        );
        const indent = (res['indent'] ?? {}) as Json;
        if (indent['damage_report_id'] !== reportId)
          throw new Error(`indent links ${String(indent['damage_report_id'])}`);
        return `${String(indent['indent_number_ext'])} linked to the report`;
      },
    ],
    [
      DAMAGE_STEPS[3]!,
      async () => {
        const r = (must(
          await ctx.request(
            'POST',
            `/api/v1/damage-reports/${reportId}/custody/arrived`,
            {},
            await ctx.as('store'),
          ),
          [200, 201],
          'mark arrived',
        )['report'] ?? {}) as Json;
        if (r['physical_state'] !== 'in_qc_hold')
          throw new Error(`physical_state ${String(r['physical_state'])}`);
        return 'in QC hold';
      },
    ],
    [
      DAMAGE_STEPS[4]!,
      async () => {
        const r = await inspect(reportId);
        if (r['status'] !== 'awaiting_keys') throw new Error(`status ${String(r['status'])}`);
        return 'damage confirmed: 1 of 1';
      },
    ],
    [
      DAMAGE_STEPS[5]!,
      async () => {
        const r = await damageDecision(ctx, 'qchead', qcKey, reportId, 'keys/qc/turn', {
          outcome: 'write_off',
        });
        return `qc key ${String(r['qc_key_status'])}`;
      },
    ],
    [
      DAMAGE_STEPS[6]!,
      async () => {
        const r = await damageDecision(
          ctx,
          'compliance',
          financeKey,
          reportId,
          'keys/finance/turn',
          { outcome: 'write_off' },
        );
        if (r['status'] !== 'outcome_final') throw new Error(`status ${String(r['status'])}`);
        return `final ${String(r['final_outcome'])} by ${String(r['decided_by'])}`;
      },
    ],
    [
      DAMAGE_STEPS[7]!,
      async () => {
        const r = await damageDecision(ctx, 'compliance', financeKey, reportId, 'outcome', {
          erp_document_ref_ext: `JV-SMOKE-${ctx.run}`.slice(0, 64),
        });
        if (r['status'] !== 'closed') throw new Error(`status ${String(r['status'])}`);
        return `closed, ERP ${String(r['erp_document_ref_ext'])}`;
      },
    ],
  ]);

  let secondId = '';
  await flow([
    [
      DAMAGE_ESCALATION_STEPS[0]!,
      async () => {
        const r = await report({ photo_attachment_id: uuid() });
        secondId = r['report_id'] as string;
        if (r['hold_mode'] !== 'quarantined')
          throw new Error(`hold_mode ${String(r['hold_mode'])} (${String(r['hold_note'])})`);
        const inspected = await inspect(secondId);
        if (inspected['status'] !== 'awaiting_keys')
          throw new Error(`status ${String(inspected['status'])}`);
        return `${String(r['report_number'])} awaiting keys`;
      },
    ],
    [
      DAMAGE_ESCALATION_STEPS[1]!,
      async () => {
        await damageDecision(ctx, 'qchead', qcKey, secondId, 'keys/qc/turn', {
          outcome: 'write_off',
        });
        const r = await damageDecision(
          ctx,
          'compliance',
          financeKey,
          secondId,
          'keys/finance/disagree',
          { proposed_outcome: 'debit_note', reason: 'Supplier fault (operations smoke test)' },
        );
        if (r['status'] !== 'escalated') throw new Error(`status ${String(r['status'])}`);
        return 'escalated to the CEO';
      },
    ],
    [
      DAMAGE_ESCALATION_STEPS[2]!,
      async () => {
        const r = await damageDecision(
          ctx,
          'ceo',
          { role: 'ceo', module: 'employee' },
          secondId,
          'escalation/decide',
          { outcome: 'write_off', reason: 'QC is right (operations smoke test)' },
        );
        if (r['decided_by'] !== 'escalation')
          throw new Error(`decided_by ${String(r['decided_by'])}`);
        return `final ${String(r['final_outcome'])} by escalation`;
      },
    ],
    [
      DAMAGE_ESCALATION_STEPS[3]!,
      async () => {
        const r = await damageDecision(ctx, 'compliance', financeKey, secondId, 'outcome', {
          erp_document_ref_ext: `JV-SMOKE-ESC-${ctx.run}`.slice(0, 64),
        });
        if (r['status'] !== 'closed') throw new Error(`status ${String(r['status'])}`);
        return `closed, ERP ${String(r['erp_document_ref_ext'])}`;
      },
    ],
  ]);
}

/**
 * Story 3.12: a tolerance breach must reach a person who holds the owner role at pilot. Kept as
 * its own flow so a failure here does not SKIP the rest of the day. Leaves one open gate event with
 * a breach weighment per run (records are permanent).
 */
export async function inboundBreach(ctx: Ctx): Promise<void> {
  const po = ctx.ops['operations_po'] as string;
  let token = '';
  let weighbridgeEventId = '';
  let breachReason = '';

  await flow([
    [
      'inbound: weighbridge breach reaches the unloading supervisor - gate entry',
      async () => {
        // A fresh vehicle and challan: ctx.run is stable per site on remote re-runs, so the day's
        // challan (CH-<run>) would collide with the inbound leg.
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/gate-events',
            {
              gate_event_id: uuid(),
              site_code_ext: ctx.siteCode,
              po_ref_ext: po,
              vehicle_reg_ext: 'UP81BR0001',
              challan_photo_ref: `photo://smoke/${ctx.run}/breach`,
              challan_number_ext: `CH-BR-${uuid().slice(0, 8)}`,
              driver_name: 'Smoke Driver 2',
              gate_id: 'GATE-1',
              entered_at: new Date().toISOString(),
            },
            await ctx.as('gate'),
          ),
          201,
          'gate event (breach vehicle)',
        );
        token = res['correlation_id'] as string;
        if (!token) throw new Error('gate event (breach vehicle) returned no correlation_id');
        return `binding ${String(res['binding_status'])} to ${po}`;
      },
    ],
    [
      'inbound: weighbridge breach reaches the unloading supervisor - weighment out of band',
      async () => {
        const orders = (
          ctx.ops['operations_po_snapshot']
            ? [ctx.ops['operations_po_snapshot']]
            : packJson(ctx, 'erp-sync-purchase-orders.json')['purchase_orders']
        ) as {
          po_number_ext: string;
          lines: { line_no: number; ordered_qty: number }[];
        }[];
        const orderLine2 = orders
          .find((o) => o.po_number_ext === po)
          ?.lines.find((l) => l.line_no === 2);
        if (!orderLine2) throw new Error(`PO ${po} has no line 2 for the breach leg`);
        const ordered = orderLine2.ordered_qty;
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/weighbridge-events',
            {
              correlation_id: token,
              tare_kg: 7000,
              // Net is double the ordered quantity: far above any tolerance band.
              gross_kg: 7000 + ordered * 2,
              po_ref_ext: po,
              line_no: 2,
              device_id: 'WB-1',
              capture_method: 'MANUAL',
            },
            await ctx.as('weighbridge'),
          ),
          201,
          'weighbridge event (breach)',
        );
        if (res['status'] !== 'tolerance_breach')
          throw new Error(`weighment ${String(res['status'])}, expected tolerance_breach`);
        if (typeof res['tolerance_breach_reason'] !== 'string' || !res['tolerance_breach_reason'])
          throw new Error('tolerance_breach_reason missing on the breach response');
        weighbridgeEventId = res['weighbridge_event_id'] as string;
        breachReason = res['tolerance_breach_reason'];
        return `net ${String(res['net_kg'])} kg flagged: ${breachReason}`;
      },
    ],
    [
      'inbound: weighbridge breach reaches the unloading supervisor - notification with the reason',
      async () => {
        // Local mode boots the router only (no dispatcher interval): run one cycle by hand. Remote
        // mode relies on the app's interval (NOTIFY_DISPATCH_INTERVAL_MS, default 5000).
        if (!ctx.remote) {
          const { runDispatchCycle } = await import('../../../src/notify/dispatch.js');
          await runDispatchCycle();
        }
        const deadline = Date.now() + 30_000;
        let seen = 0;
        for (;;) {
          const res = must(
            await ctx.request(
              'GET',
              '/api/v1/notifications?type=weighbridge_tolerance_breach',
              undefined,
              await ctx.as('unloading'),
            ),
            200,
            'unloading supervisor notifications',
          );
          const list = listOf(res, 'notifications');
          seen = list.length;
          const mine = list.find((n) => n['object_id'] === weighbridgeEventId);
          if (mine) {
            if (mine['next_step'] !== breachReason)
              throw new Error(
                `next_step "${String(mine['next_step'])}" differs from the breach reason "${breachReason}"`,
              );
            return `${ctx.emailOf('unloading')} sees the breach: ${breachReason}`;
          }
          if (Date.now() >= deadline)
            throw new Error(
              `no breach notification for ${weighbridgeEventId} after 30 s (${seen} breach notifications in the inbox)`,
            );
          await new Promise((r) => setTimeout(r, 2000));
        }
      },
    ],
  ]);
}

export async function outbound(ctx: Ctx): Promise<void> {
  let lines: Json[] = [];
  let taskIds: string[] = [];
  const picked: { orderId: string; sku: string; lotId: string | null; qty: string }[] = [];

  await flow([
    [
      'outbound: generate picks for a seeded sales order',
      async () => {
        const open = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/erp/sales-orders?site=${encodeURIComponent(ctx.siteCode)}&status=open&limit=200`,
              undefined,
              await ctx.as('whmanager'),
            ),
            200,
            'list sales orders',
          ),
          'sales_orders',
        );
        // The list does not carry the dispatch-order id pick generation needs
        // (src/api/v1/erp-projections.ts:210): locally it is read from the table, remotely from the
        // file seed.mjs --sales-order-ids wrote, or from ops.sales_order_ids a driver filled.
        if (open.some((l) => !l['id'])) {
          const known = ctx.ops['sales_order_ids']
            ? (ctx.ops['sales_order_ids'] as Json[])
            : ctx.sql
              ? await ctx.sql(
                  `SELECT id, so_number_ext, line_no FROM erp_sales_order WHERE ship_from_site_code_ext = $1`,
                  [ctx.siteCode],
                )
              : argOf('--sales-order-ids', '')
                ? ((JSON.parse(readFileSync(argOf('--sales-order-ids', ''), 'utf8')) as Json)[
                    'sales_orders'
                  ] as Json[])
                : null;
          if (!known)
            throw new Error(
              'GET /api/v1/erp/sales-orders returns no id; pass --sales-order-ids <file written by seed.mjs --sales-order-ids>',
            );
          for (const l of open)
            l['id'] = known.find(
              (k) =>
                k['so_number_ext'] === l['so_number_ext'] &&
                Number(k['line_no']) === Number(l['line_no']),
            )?.['id'];
        }
        const orders = [...new Set(open.map((l) => l['so_number_ext'] as string))].sort();
        const refusals: string[] = [];
        for (const so of orders) {
          const candidate = open.filter((l) => l['so_number_ext'] === so);
          const res = await ctx.request(
            'POST',
            '/api/v1/pick-tasks/generate',
            { strategy: 'single', dispatchOrderLineIds: candidate.map((l) => l['id']) },
            await ctx.as('whmanager'),
          );
          if (res.status === 201) {
            lines = candidate;
            taskIds = res.body['pickTaskIds'] as string[];
            return `${so}: ${candidate.map((l) => `${String(l['quantity'])} ${String(l['sku'])}`).join(' + ')}, ${taskIds.length} task(s)`;
          }
          refusals.push(
            `${so} ${String(res.body['error_code'])}: ${String(res.body['message']).slice(0, 80)}`,
          );
        }
        throw new Error(
          `no open sales order could be picked (${orders.length} open): ${refusals.join('; ').slice(0, 400)}`,
        );
      },
    ],
    [
      'outbound: confirm pick lines (lot item FEFO, plain item)',
      async () => {
        const notes: string[] = [];
        for (const taskId of taskIds) {
          const task = must(
            await ctx.request(
              'GET',
              `/api/v1/pick-tasks/${taskId}`,
              undefined,
              await ctx.as('picker'),
            ),
            200,
            'get pick task',
          );
          const pickLines = listOf(task, 'lines', 'pick_lines').length
            ? listOf(task, 'lines', 'pick_lines')
            : listOf((task['task'] ?? task['pick_task'] ?? {}) as Json, 'lines', 'pick_lines');
          if (pickLines.length === 0)
            throw new Error(`pick task without lines: ${JSON.stringify(task).slice(0, 300)}`);
          for (const l of pickLines) {
            const lotId = (l['directed_lot_id'] ?? null) as string | null;
            const qty = String(Number(l['directed_quantity'])); // at most 3 decimals are accepted
            must(
              await ctx.request(
                'POST',
                `/api/v1/pick-tasks/${taskId}/lines/${String(l['pick_line_id'] ?? l['id'])}/confirm`,
                {
                  confirmedLotId: lotId,
                  confirmedQuantity: qty,
                  captureMethod: 'PWA',
                  idempotency_key: uuid(),
                },
                await ctx.as('picker'),
              ),
              200,
              'confirm pick line',
            );
            picked.push({
              orderId: (l['dispatch_order_line_id'] ?? l['dispatch_order_id']) as string,
              sku: l['sku'] as string,
              lotId,
              qty,
            });
            notes.push(
              `${qty} ${String(l['sku'])}${lotId ? ' (lot)' : ''} from ${String(l['location_code'] ?? l['from_location_code'] ?? l['location_id'])}`,
            );
          }
          // The last confirmed line completes the task by itself; the explicit call is for a task left open.
          const done = await ctx.request(
            'POST',
            `/api/v1/pick-tasks/${taskId}/complete`,
            {},
            await ctx.as('whmanager'),
          );
          if (done.body['error_code'] !== 'PICK_TASK_ALREADY_COMPLETED')
            must(done, [200, 201], 'complete pick task');
        }
        return notes.join(', ');
      },
    ],
    [
      'outbound: pack refuses a lot that was not picked',
      async () => {
        const line = picked.find((p) => p.lotId) ?? picked[0];
        if (!line) throw new Error('nothing was picked');
        const res = await ctx.request(
          'POST',
          `/api/v1/dispatch/${line.orderId}/pack`,
          {
            dispatchOrderId: line.orderId,
            packingLines: [
              {
                sku: line.sku,
                packed_qty: line.qty,
                lot_id: uuid(),
                carton_count: 1,
                actual_weight_kg: 12.5,
                label_ref: null,
              },
            ],
          },
          await ctx.as('dispatch'),
        );
        if (res.status !== 409 || res.body['error_code'] !== 'PACKED_LINE_NOT_PICKED')
          throw new Error(
            `expected 409 PACKED_LINE_NOT_PICKED, got ${res.status} ${res.text.slice(0, 300)}`,
          );
        const records = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/dispatch/${line.orderId}/packing-records`,
              undefined,
              await ctx.as('dispatch'),
            ),
            200,
            'packing records',
          ),
          'packingRecords',
        );
        if (records.length !== 0)
          throw new Error(`${records.length} packing record(s) exist after the refusal`);
        return `PACKED_LINE_NOT_PICKED for ${line.sku} with a lot that was not picked, no packing record`;
      },
    ],
    [
      'outbound: pack',
      async () => {
        for (const line of lines) {
          const mine = picked.filter((p) => p.orderId === line['id']);
          if (mine.length === 0)
            throw new Error(
              `nothing picked for line ${String(line['id'])}: ${JSON.stringify(picked).slice(0, 300)}`,
            );
          must(
            await ctx.request(
              'POST',
              `/api/v1/dispatch/${String(line['id'])}/pack`,
              {
                dispatchOrderId: line['id'],
                packingLines: mine.map((p) => ({
                  sku: p.sku,
                  packed_qty: p.qty,
                  lot_id: p.lotId,
                  carton_count: 1,
                  actual_weight_kg: 12.5,
                  label_ref: null,
                })),
              },
              await ctx.as('dispatch'),
            ),
            200,
            'pack',
          );
        }
        return `${lines.length} dispatch order lines packed`;
      },
    ],
    [
      'outbound: IRN, shipping documents',
      async () => {
        const [first, ...rest] = lines.map((l) => l['id'] as string);
        must(
          await ctx.request(
            'POST',
            `/api/v1/dispatch/${first}/irn`,
            {
              idempotency_key: uuid(),
              invoice_number_ext: `INV-${ctx.run.toUpperCase()}`,
              irn_ext: randomBytes(32).toString('hex'),
              irp_acknowledged_at: new Date(Date.now() - 60000).toISOString(),
              also_covers: rest,
            },
            await ctx.as('dispatch'),
          ),
          [200, 201],
          'record IRN',
        );
        let documents = 0;
        for (const id of [first!, ...rest]) {
          const res = must(
            await ctx.request(
              'POST',
              `/api/v1/dispatch/${id}/generate-documents`,
              { dispatchOrderId: id },
              await ctx.as('dispatch'),
            ),
            200,
            'generate documents',
          );
          documents += (res['documentIds'] as unknown[]).length;
        }
        return `one IRN covers ${lines.length} lines, ${documents} documents`;
      },
    ],
    [
      'outbound: dispatch',
      async () => {
        for (const line of lines)
          must(
            await ctx.request(
              'POST',
              `/api/v1/dispatch/${String(line['id'])}/dispatch`,
              { dispatchOrderId: line['id'] },
              await ctx.as('dispatch'),
            ),
            200,
            'dispatch',
          );
        return `${lines.length} lines dispatched`;
      },
    ],
  ]);
}

export async function production(ctx: Ctx): Promise<void> {
  const plan = ctx.ops['production'] as { output_sku: string; order_quantity: string };
  let orderId = '';
  let bom: Awaited<ReturnType<typeof releasedBomOf>> | null = null;
  const stages: { stageId: string; qty: string }[] = [];

  await flow([
    [
      'production: planner reads stock, creates the order',
      async () => {
        await stockOf(ctx, 'BRG-6204', 'planner');
        bom = await releasedBomOf(ctx, plan.output_sku, 'planner');
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/production-orders',
            {
              output_item_id: await itemIdOf(ctx, plan.output_sku, 'planner'),
              order_quantity: plan.order_quantity,
              plant_location_id: ctx.siteId,
              bom_id: bom.bomId,
              business_stream: 'production',
              source_reference_type: 'manual',
              source_reference_id: `SMOKE-${ctx.run}`,
              idempotency_key: uuid(),
            },
            await ctx.as('planner'),
          ),
          201,
          'create production order',
        );
        const order = (res['order'] ?? res['production_order'] ?? res) as Json;
        orderId = (order['order_id'] ?? order['production_order_id']) as string;
        return `${plan.order_quantity} x ${plan.output_sku}`;
      },
    ],
    [
      'production: release',
      async () => {
        const gate = must(
          await ctx.request(
            'GET',
            `/api/v1/production-orders/${orderId}/release-gate`,
            undefined,
            await ctx.as('planner'),
          ),
          200,
          'release gate',
        );
        const g = (gate['gate'] ?? gate) as Json;
        const released = must(
          await ctx.request(
            'POST',
            `/api/v1/production-orders/${orderId}/release`,
            {
              idempotency_key: uuid(),
              ...(g['released_revision_id']
                ? { released_revision_id: g['released_revision_id'] }
                : {}),
            },
            await ctx.as('planner'),
          ),
          [200, 201],
          `release (gate ${JSON.stringify(g).slice(0, 200)})`,
        );
        return `status ${String(((released['order'] ?? released) as Json)['status'])}`;
      },
    ],
    [
      'production: stage components from storage bins',
      async () => {
        const detail = bom!.detail;
        const bomLines = listOf(detail, 'lines', 'bom_lines').length
          ? listOf(detail, 'lines', 'bom_lines')
          : listOf((detail['bom'] ?? {}) as Json, 'lines', 'bom_lines');
        if (bomLines.length === 0)
          throw new Error(`BOM without lines: ${JSON.stringify(detail).slice(0, 300)}`);
        const staged: Json[] = [];
        for (const l of bomLines) {
          const sku = (l['component_sku'] ?? l['sku']) as string;
          const need = Number(l['quantity_per']) * Number(plan.order_quantity);
          // The stock view is per bin; the lot of a lot-controlled component comes from select-lot (FEFO).
          const lotControlled =
            ((ctx.world['items'] as Json[]).find((it) => it['sku'] === sku) ?? {})[
              'lot_controlled'
            ] === true;
          let from: Json | undefined;
          let lotNumber: string | null = null;
          for (const candidate of (await stockOf(ctx, sku, 'planner')).filter(
            (s) => Number(s['available']) >= need,
          )) {
            if (lotControlled) {
              const chosen = await ctx.request(
                'POST',
                `/api/v1/stock/${encodeURIComponent(sku)}/select-lot`,
                { location_id: candidate['location_id'], quantity: need },
                await ctx.as('planner'),
              );
              if (chosen.status !== 200) continue;
              lotNumber = chosen.body['lot_number'] as string;
            }
            from = candidate;
            break;
          }
          if (!from)
            throw new Error(`no bin holds ${need} of ${sku}${lotControlled ? ' in one lot' : ''}`);
          staged.push({
            bom_line_id: l['bom_line_id'],
            source_location_id: from['location_id'],
            lot_number: lotNumber,
          });
          stages.push({ stageId: '', qty: String(need) });
        }
        const res = must(
          await ctx.request(
            'POST',
            `/api/v1/production-orders/${orderId}/material-staging`,
            { idempotency_key: uuid(), lines: staged },
            await ctx.as('planner'),
          ),
          [200, 201],
          'stage',
        );
        const made = listOf(res, 'stages', 'staging', 'lines');
        made.forEach((s, i) => (stages[i]!.stageId = (s['stage_id'] ?? s['staging_id']) as string));
        if (stages.some((s) => !s.stageId))
          throw new Error(`staging answer without stage ids: ${JSON.stringify(res).slice(0, 300)}`);
        return `${stages.length} lines staged`;
      },
    ],
    [
      'production: issue components',
      async () => {
        for (const s of stages)
          must(
            await ctx.request(
              'POST',
              `/api/v1/production-orders/${orderId}/material-issues`,
              { idempotency_key: uuid(), stage_id: s.stageId, quantity: s.qty },
              await ctx.as('planner'),
            ),
            [200, 201],
            'issue',
          );
        must(
          await ctx.request(
            'POST',
            `/api/v1/production-orders/${orderId}/transition`,
            { new_status: 'in_process', idempotency_key: uuid() },
            await ctx.as('planner'),
          ),
          [200, 201],
          'start the order',
        );
        // No confirmation: the migrated kits have directed-issue lines only (409 NO_BACKFLUSH_LINES).
        return `${stages.length} components issued, order in process`;
      },
    ],
    [
      'production: complete (inspection plan resolved)',
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            `/api/v1/production-orders/${orderId}/completions`,
            { idempotency_key: uuid(), primary_quantity: plan.order_quantity },
            await ctx.as('planner'),
          ),
          [200, 201],
          'completion',
        );
        const c = (res['completion'] ?? res) as Json;
        return `lot ${String(c['lot_number'] ?? c['output_lot_number'] ?? c['lot_id'] ?? '?')}, QC ${String(c['qc_gate_status'] ?? c['inspection_status'] ?? 'task raised')}`;
      },
    ],
  ]);
}

export async function indent(ctx: Ctx): Promise<void> {
  let indentId = '';
  let approverId: string | null = null;
  await flow([
    [
      'indent: raise',
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/indents',
            {
              site_id: ctx.siteId,
              department_code: 'STORES',
              business_stream: 'production',
              need_by_date: nextYear(),
              urgent: false,
              reason: 'Operations smoke test',
              confirm_duplicate: true,
              lines: [
                {
                  sku: 'CON-GLOVES',
                  item_category: 'consumable',
                  requested_qty: 100,
                  uom: 'EA',
                  unit_price_estimate: 29.25,
                },
              ],
            },
            await ctx.as('indent'),
          ),
          201,
          'raise indent',
        );
        const details = (res['details'] ?? {}) as Json;
        indentId = (details['indent_id'] ??
          (res['indent'] as Json | undefined)?.['indent_id']) as string;
        approverId = (details['approver_actor_id'] as string | undefined) ?? null;
        return `approval required from ${approverId ?? 'nobody (no DOA band)'}`;
      },
    ],
    [
      'indent: raiser cannot approve, department head approves',
      async () => {
        const self = await ctx.request(
          'POST',
          `/api/v1/indents/${indentId}/approve`,
          {},
          await ctx.as('indent'),
        );
        if (self.status >= 200 && self.status < 300)
          throw new Error('the raiser approved the own indent');
        must(
          await approveAs(
            ctx,
            'depthead',
            { role: 'department_head', module: 'procurement' },
            (headers) => ctx.request('POST', `/api/v1/indents/${indentId}/approve`, {}, headers),
            approverId,
          ),
          [200, 201],
          'approve indent',
        );
        return `self-approval refused (${String(self.body['error_code'] ?? self.status)}), approved`;
      },
    ],
  ]);
}

export async function maintenance(ctx: Ctx): Promise<void> {
  const asset = (ctx.ops['assets'] as Json[])[0]!;
  let faultId = '';
  let workOrderId = '';
  await flow([
    [
      'maintenance: technician reports a fault',
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/maintenance/fault-reports',
            {
              asset_tag: asset['asset_tag'],
              description: `Smoke ${ctx.run}: oil leak at the ram seal`,
              safety_flag: false,
            },
            await ctx.as('maint'),
          ),
          201,
          'fault report',
        );
        faultId = (res['fault_report'] as Json)['fault_report_id'] as string;
        return `on ${String(asset['asset_tag'])}`;
      },
    ],
    [
      'maintenance: supervisor accepts, work order with SLA',
      async () => {
        const res = must(
          await ctx.request(
            'POST',
            `/api/v1/maintenance/fault-reports/${faultId}/accept`,
            {},
            await ctx.as('maintsup'),
          ),
          201,
          'accept fault',
        );
        const wo = res['work_order'] as Json;
        workOrderId = wo['work_order_id'] as string;
        return `priority ${String(wo['priority'])}, resolution due ${String(wo['sla_resolution_due_at'])}`;
      },
    ],
    [
      'maintenance: technician works and completes',
      async () => {
        // A breakdown work order closes only with a fault, cause and remedy code of the configured catalogue.
        const catalogue = must(
          await ctx.request(
            'GET',
            '/api/v1/maintenance/closure-codes',
            undefined,
            await ctx.as('maint'),
          ),
          200,
          'closure codes',
        );
        const first = (list: unknown) => {
          const x = (list as unknown[])[0];
          return typeof x === 'string' ? x : String((x as Json)['code']);
        };
        const codes = {
          fault_code: first(catalogue['fault']),
          cause_code: first(catalogue['cause']),
          remedy_code: first(catalogue['remedy']),
        };
        must(
          await ctx.request(
            'POST',
            `/api/v1/maintenance/work-orders/${workOrderId}/status`,
            { new_status: 'in_progress', note: 'Seal kit replaced' },
            await ctx.as('maint'),
          ),
          [200, 201],
          'start work',
        );
        const res = must(
          await ctx.request(
            'POST',
            `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
            { labor_cost: '250.00', parts_cost: '0.00', ...codes, idempotency_key: uuid() },
            await ctx.as('maint'),
          ),
          200,
          'complete work order',
        );
        return `status ${String((res['work_order'] as Json)['status'])}`;
      },
    ],
  ]);
}

/** After go-live every lot-controlled stock row must have its lot in lot_master, or FEFO skips it. Local only. */
export async function lotMasterCheck(ctx: Ctx): Promise<void> {
  if (!ctx.sql) return;
  await step('check: every lot in stock exists in lot_master (FEFO)', async () => {
    const rows = await ctx.sql!(
      `SELECT count(*) FILTER (WHERE lm.lot_id IS NULL) AS missing, count(*) FILTER (WHERE lm.quality_hold_status <> 'none') AS held,
              count(*) FILTER (WHERE lm.expiry_date < CURRENT_DATE) AS expired, count(*) FILTER (WHERE lm.expiry_date IS NOT NULL) AS dated, count(*) AS total
       FROM stock_balance sb JOIN location_register lr ON lr.location_id = sb.location_id
       JOIN item_master im ON im.sku = sb.sku AND im.lot_controlled
       LEFT JOIN lot_master lm ON lm.lot_number = sb.lot_id AND lm.sku = sb.sku
       WHERE lr.site_id = $1 AND sb.lot_id IS NOT NULL`,
      [ctx.siteId],
    );
    const r = rows[0]!;
    if (Number(r['missing']) > 0 || Number(r['held']) > 0 || Number(r['expired']) > 0)
      throw new Error(JSON.stringify(r));
    return `${String(r['total'])} lot balances, ${String(r['dated'])} with an expiry date, none missing, held or expired`;
  });
}

async function main(): Promise<void> {
  let ok = false;
  let crashed = false;
  let ctx: Ctx | null = null;
  try {
    let siteCode = argOf('--site-code', '');
    const remote = hasFlag('--remote');
    // The pack's job-work orders are migrated in with no kit BOM. Local mode boots the app itself,
    // so it takes the pilot setting staging runs with (owner ruling 2026-09-22) unless the shell
    // already chose one; remote mode drives whatever the stack was started with.
    if (!remote && process.env['JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM'] === undefined)
      process.env['JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM'] = 'true';
    if (!remote && !siteCode) {
      const out = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(HERE, 'rehearse.ts'),
          '--seed',
          argOf('--seed', '42'),
          '--lines',
          argOf('--lines', '300'),
        ],
        { cwd: ROOT, env: process.env, encoding: 'utf8' },
      );
      siteCode = /Planted defects \((MOCK-[A-Z0-9]+)\)/.exec(out)?.[1] ?? '';
      console.log(
        out
          .split('\n')
          .filter((l) => /^(PASS|FAIL): /.test(l))
          .join('\n') + `  (rehearse.ts, site ${siteCode})`,
      );
    }
    ctx = await boot(
      remote ? null : { siteCode, pack: argOf('--pack', join(HERE, 'out', siteCode)) },
    );
    if (!remote || hasFlag('--with-setup')) await setupOperations(ctx);
    await lotMasterCheck(ctx);
    await inbound(ctx);
    await inboundBreach(ctx);
    await outbound(ctx);
    await production(ctx);
    await indent(ctx);
    await employeeRequisition(ctx);
    await siteHead(ctx);
    await damageReport(ctx);
    await maintenance(ctx);
  } catch (error) {
    crashed = true;
    console.error(`\nstopped: ${(error as Error).stack ?? (error as Error).message}`);
  }
  ok = printTable(
    `Operations smoke test (${ctx?.siteCode ?? '?'}, ${ctx?.remote ? 'remote' : 'local'})`,
  );
  await ctx?.close();
  process.exit(ok && !crashed ? 0 : 1);
}

// Runs only as a script; deploy/pilot/sim/pilot-day.ts imports the flows above.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
