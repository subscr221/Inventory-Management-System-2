// Daily business flows the operations smoke (deploy/rehearsal/mock/operations-smoke.ts) does not
// cover, in the same style: one flow per business process, run as the right distinct people,
// expected refusals asserted by their exact error code. Quantities stay at 1 to 5 so a daily run
// does not drain stock; every reference carries ctx.run.
//
//   QC        : an open inspection task (the smoke's production completion raises one) is sampled,
//               inspected, dispositioned by the QC head (the inspector is refused), a retention
//               sample is logged in the quarantine bin (owner ruling 2026-09-22) and the lot released
//   bin move  : Ruling C same-site bin-to-bin move by the storekeeper; stock and valuation (Ruling A)
//   transfer  : transfer request, DOA approval by the warehouse manager, ship and receive (bin stamps)
//   replen.   : forward-pick replenishment check, one open task confirmed if any exists
//   refused   : the open refused-captures queue; at most one capture of somebody else resolved
//   offcut    : a CFO signature on a job-work offcut acquisition, only when a holding exists
//   meter     : a meter reading on a pack asset, and a reading that runs backwards refused
//
// Never touched here (forbidden in the pilot): calibration certificates, critical-spare min-max.

import {
  approveAs,
  flow,
  listOf,
  must,
  skip,
  step,
  uuid,
  type Ctx,
  type Json,
} from '../../rehearsal/mock/ops-lib.js';

type Stock = Json & { location_id: string; location_code: string };

/** Bins that hold available owned stock of a SKU at this site, richest first (GET /api/v1/stock/:sku). */
async function stockOf(ctx: Ctx, sku: string, who: string): Promise<Stock[]> {
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
  return ((res['locations'] ?? []) as Stock[])
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

const qtyOf = (l: Json | undefined) => Number(l?.['available'] ?? l?.['quantity'] ?? 0);

/** Owned stock of a SKU in one bin (all lots summed). */
async function inBin(ctx: Ctx, sku: string, code: string, who: string): Promise<number> {
  return (await stockOf(ctx, sku, who))
    .filter((l) => l.location_code === code)
    .reduce((n, l) => n + qtyOf(l), 0);
}

async function locationIdOf(ctx: Ctx, code: string, who = 'invctl'): Promise<string> {
  const res = must(
    await ctx.request(
      'GET',
      `/api/v1/locations/${encodeURIComponent(code)}`,
      undefined,
      await ctx.as(who),
    ),
    200,
    `location ${code}`,
  );
  return ((res['location'] as Json | undefined) ?? res)['location_id'] as string;
}

/** A refusal with exactly this status and error code, or an Error that says what came back. */
function refused(res: { status: number; body: Json; text: string }, status: number, code: string) {
  if (res.status !== status || res.body['error_code'] !== code)
    throw new Error(`expected ${status} ${code}, got ${res.status} ${res.text.slice(0, 300)}`);
  return code;
}

const storageBins = (ctx: Ctx) => (ctx.world['bins'] ?? []) as string[];
const items = (ctx: Ctx) =>
  (ctx.world['items'] ?? []) as {
    sku: string;
    lot_controlled?: boolean;
    serial_controlled?: boolean;
  }[];

/**
 * An owned SKU with at least `need` available in a storage bin, and another storage bin to go to.
 * Candidates rotate by the day, so daily runs do not keep moving the same stock.
 */
async function pickStock(
  ctx: Ctx,
  lotControlled: boolean,
  need: number,
): Promise<{ sku: string; from: Stock; to: string } | null> {
  const bins = storageBins(ctx);
  const pool = items(ctx).filter(
    (i) => Boolean(i.lot_controlled) === lotControlled && !i.serial_controlled,
  );
  const day = Math.floor(Date.now() / 86_400_000);
  for (let k = 0; k < pool.length; k += 1) {
    const sku = pool[(day + k) % pool.length]!.sku;
    const from = (await stockOf(ctx, sku, 'invctl')).find(
      (l) => bins.includes(l.location_code) && qtyOf(l) >= need,
    );
    if (!from) continue;
    const others = bins.filter((b) => b !== from.location_code);
    return { sku, from, to: others[day % others.length]! };
  }
  return null;
}

// ---------------------------------------------------------------- 1. QC inspection and release

async function qcRelease(ctx: Ctx): Promise<void> {
  const tasksIn = async (status: string) =>
    listOf(
      must(
        await ctx.request(
          'GET',
          `/api/v1/qc/tasks?site_id=${ctx.siteId}&task_status=${status}&gate_status=qc_hold&limit=50`,
          undefined,
          await ctx.as('qc'),
        ),
        200,
        'list QC tasks',
      ),
      'tasks',
    );
  const names = [
    'qc: sample and inspect an open task',
    'qc: the inspector cannot disposition, the QC head accepts',
    'qc: retention sample logged in the quarantine bin',
    'qc: release the lot',
  ];
  // An open task first; else one an earlier run inspected but did not get to release (resumed).
  const task = (await tasksIn('open'))[0] ?? (await tasksIn('inspected'))[0];
  if (!task) {
    for (const n of names)
      skip(
        n,
        'no open QC task at the site (a production completion raises one; run the smoke first)',
      );
    return;
  }
  const taskId = task['task_id'] as string;
  const path = (tail: string) => `/api/v1/qc/tasks/${taskId}/${tail}`;
  const resumed = task['task_status'] === 'inspected';
  await flow([
    [
      names[0]!,
      async () => {
        if (resumed)
          return `lot ${String(task['lot_number'])} was inspected by an earlier run, resumed from the disposition`;
        const qc = await ctx.as('qc');
        const version = must(
          await ctx.request(
            'GET',
            `/api/v1/qc/inspection-plans/${String(task['plan_id'])}/versions/${String(task['plan_version_id'])}`,
            undefined,
            qc,
          ),
          200,
          'plan version',
        );
        const characteristics = (version['characteristics'] ?? []) as Json[];
        if (characteristics.length === 0)
          throw new Error('the plan version has no characteristics');
        const sampling = must(
          await ctx.request('POST', path('sampling'), {}, qc),
          [200, 201],
          'sampling',
        )['sampling'] as Json;
        const size = Number(sampling['sample_size']);
        for (const c of characteristics) {
          if (c['result_kind'] && c['result_kind'] !== 'attribute')
            throw new Error(
              `characteristic ${String(c['characteristic_name'])} is not an attribute`,
            );
          must(
            await ctx.request(
              'POST',
              path('observations'),
              {
                characteristic_id: c['characteristic_id'],
                readings: Array.from({ length: size }, (_, i) => ({
                  sample_unit_no: i + 1,
                  attribute_conforms: true,
                })),
              },
              qc,
            ),
            201,
            `observations ${String(c['characteristic_name'])}`,
          );
        }
        must(await ctx.request('POST', path('inspection-completion'), {}, qc), 201, 'complete');
        return `lot ${String(task['lot_number'])} (${String(task['quantity'])} ${String(task['sku'])}), sample of ${size}, ${characteristics.length} characteristics conform`;
      },
    ],
    [
      names[1]!,
      async () => {
        const body = { disposition: 'accept', justification: `Pilot sim ${ctx.run}: all conform` };
        const earlier = await ctx.request(
          'GET',
          path('disposition'),
          undefined,
          await ctx.as('qc'),
        );
        const already = (earlier.body['disposition'] ?? null) as Json | null;
        if (earlier.status === 200 && already)
          return `already dispositioned by an earlier run: ${String(already['disposition'])}`;
        const self = await ctx.request('POST', path('disposition'), body, await ctx.as('qc'));
        const code = refused(self, 409, 'SOD_VIOLATION');
        must(
          await approveAs(ctx, 'qchead', { role: 'qc_head', module: 'qc' }, (headers) =>
            ctx.request('POST', path('disposition'), body, headers),
          ),
          201,
          'disposition',
        );
        return `the inspector who recorded the results refused (${code}), accepted by the QC head`;
      },
    ],
    [
      names[2]!,
      async () => {
        // The quarantine bin of the pack; a local mock site whose QC-hold zone went to an earlier
        // site (rehearse.ts warns about it) keeps the sample in the putaway bin instead.
        let code = ctx.ops['quarantine_bin'] as string;
        const probe = await ctx.request(
          'GET',
          `/api/v1/locations/${encodeURIComponent(code)}`,
          undefined,
          await ctx.as('invctl'),
        );
        if (probe.status === 404 && !ctx.remote) code = ctx.ops['putaway_bin'] as string;
        const logged = await ctx.request(
          'POST',
          path('retention-sample'),
          {
            quantity: '1',
            uom: String(task['uom'] ?? 'EA'),
            location_id: await locationIdOf(ctx, code),
          },
          await ctx.as('qc'),
        );
        if (resumed && logged.body['error_code'] === 'RETENTION_SAMPLE_EXISTS')
          return 'already logged by an earlier run';
        const res = must(logged, [200, 201], 'retention sample');
        return `1 ${String(task['uom'] ?? 'EA')} kept in ${code}, sample ${String(res['retention_sample_id'] ?? (res['retention_sample'] as Json | undefined)?.['retention_sample_id'] ?? '?')}`;
      },
    ],
    [
      names[3]!,
      async () => {
        must(
          await ctx.request('POST', path('release'), {}, await ctx.as('qc')),
          [200, 201],
          'release',
        );
        const release = must(
          await ctx.request('GET', path('release'), undefined, await ctx.as('qc')),
          200,
          'read release',
        );
        return `released (${JSON.stringify(release['release'] ?? release).slice(0, 120)})`;
      },
    ],
  ]);
}

// ---------------------------------------------------------------- 2. same-site bin move (Ruling C)

async function binMove(ctx: Ctx): Promise<void> {
  let pick: Awaited<ReturnType<typeof pickStock>> = null;
  const qty = 2;
  await flow([
    [
      'bin move: storekeeper moves stock to another storage bin (Ruling C)',
      async () => {
        pick = await pickStock(ctx, false, qty + 1);
        if (!pick) throw new Error(`no owned non-lot item holds ${qty + 1} in a storage bin`);
        const { sku, from, to } = pick;
        const valuation = async () =>
          must(
            await ctx.request(
              'GET',
              `/api/v1/stock/${encodeURIComponent(sku)}/valuation`,
              undefined,
              await ctx.as('invctl'),
            ),
            200,
            'valuation',
          );
        const before = { from: qtyOf(from), to: await inBin(ctx, sku, to, 'invctl') };
        const valueBefore = await valuation();
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/stock/bin-moves',
            {
              site_id: ctx.siteId,
              sku,
              from_location_code: from.location_code,
              to_location_code: to,
              quantity: qty,
              stock_class: 'owned',
              reason: `Pilot sim ${ctx.run}: re-slot`,
              idempotency_key: uuid(),
            },
            await ctx.as('store'),
          ),
          201,
          'bin move',
        );
        const after = {
          from: await inBin(ctx, sku, from.location_code, 'invctl'),
          to: await inBin(ctx, sku, to, 'invctl'),
        };
        if (after.from !== before.from - qty || after.to !== before.to + qty)
          throw new Error(
            `stock did not move: ${from.location_code} ${before.from} to ${after.from}, ${to} ${before.to} to ${after.to}`,
          );
        const valueAfter = await valuation();
        for (const k of ['quantity_on_hand', 'carrying_value'])
          if (Number(valueAfter[k]) !== Number(valueBefore[k]))
            throw new Error(
              `a same-site move changed ${k}: ${String(valueBefore[k])} to ${String(valueAfter[k])}`,
            );
        return `${qty} ${sku} ${from.location_code} (${before.from} to ${after.from}) to ${to} (${before.to} to ${after.to}), valuation unchanged at ${String(valueAfter['carrying_value'])}, move ${String(res['move_id'])}`;
      },
    ],
    [
      'bin move: more than the bin holds is refused',
      async () => {
        const { sku, from, to } = pick!;
        const holds = await inBin(ctx, sku, from.location_code, 'invctl');
        const res = await ctx.request(
          'POST',
          '/api/v1/stock/bin-moves',
          {
            site_id: ctx.siteId,
            sku,
            from_location_code: from.location_code,
            to_location_code: to,
            quantity: holds + 1,
            stock_class: 'owned',
            idempotency_key: uuid(),
          },
          await ctx.as('store'),
        );
        const code = refused(res, 409, 'BIN_MOVE_INSUFFICIENT_AVAILABLE');
        const still = await inBin(ctx, sku, from.location_code, 'invctl');
        if (still !== holds)
          throw new Error(`the refused move changed the bin: ${holds} to ${still}`);
        return `${holds + 1} of ${holds}: ${code}, bin unchanged`;
      },
    ],
  ]);
}

// ---------------------------------------------------------------- 3. transfer request

async function transfer(ctx: Ctx): Promise<void> {
  const qty = 2;
  let pick: Awaited<ReturnType<typeof pickStock>> = null;
  let lotUuid = '';
  let lotNumber = '';
  let transferId = '';
  let status = '';
  let approverId: string | null = null;
  let toBefore = 0;

  await flow([
    [
      'transfer: storekeeper requests a lot between two storage bins',
      async () => {
        pick = await pickStock(ctx, true, qty + 1);
        if (!pick) throw new Error(`no owned lot item holds ${qty + 1} in a storage bin`);
        const { sku, from, to } = pick;
        const lot = must(
          await ctx.request(
            'POST',
            `/api/v1/stock/${encodeURIComponent(sku)}/select-lot`,
            { location_id: from.location_id, quantity: qty },
            await ctx.as('invctl'),
          ),
          200,
          'select lot',
        );
        lotUuid = lot['lot_uuid'] as string;
        lotNumber = lot['lot_number'] as string;
        toBefore = await inBin(ctx, sku, to, 'invctl');
        const res = must(
          await ctx.request(
            'POST',
            '/api/v1/transfer-requests',
            {
              sku_id: sku,
              from_location_id: from.location_id,
              to_location_id: await locationIdOf(ctx, to),
              quantity: qty,
              business_stream: 'production',
              lot_id: lotUuid,
              notes: `Pilot sim ${ctx.run}`,
            },
            await ctx.as('store'),
          ),
          201,
          'create transfer',
        );
        transferId = res['transfer_request_id'] as string;
        status = res['status'] as string;
        approverId = (res['approver_actor_id'] as string | undefined) ?? null;
        return `${qty} ${sku} lot ${lotNumber} ${from.location_code} to ${to}, ${status}`;
      },
    ],
    [
      'transfer: no shipment before approval, the warehouse manager approves',
      async () => {
        if (status !== 'pending_approval')
          return `no DOA band answered transfer_request: created ${status}, nothing to approve`;
        const early = await ctx.request(
          'POST',
          `/api/v1/transfer-requests/${transferId}/ship`,
          { lot_id: lotUuid, shipped_quantity: qty },
          await ctx.as('store'),
        );
        const code = refused(early, 403, 'APPROVAL_REQUIRED');
        must(
          await approveAs(
            ctx,
            'whmanager',
            { role: 'warehouse_manager', module: 'inventory' },
            (headers) =>
              ctx.request(
                'PATCH',
                `/api/v1/transfer-requests/${transferId}/approve`,
                { notes: `Pilot sim ${ctx.run}` },
                headers,
              ),
            approverId,
          ),
          200,
          'approve transfer',
        );
        return `early ship refused (${code}), approved by the warehouse manager`;
      },
    ],
    [
      'transfer: ship and receive',
      async () => {
        const { sku, to } = pick!;
        must(
          await ctx.request(
            'POST',
            `/api/v1/transfer-requests/${transferId}/ship`,
            { lot_id: lotUuid, shipped_quantity: qty },
            await ctx.as('store'),
          ),
          201,
          'ship',
        );
        must(
          await ctx.request(
            'POST',
            `/api/v1/transfer-requests/${transferId}/receive`,
            { lot_id: lotUuid, received_quantity: qty },
            await ctx.as('store'),
          ),
          201,
          'receive',
        );
        const final = must(
          await ctx.request(
            'GET',
            `/api/v1/transfer-requests/${transferId}`,
            undefined,
            await ctx.as('invctl'),
          ),
          200,
          'read transfer',
        );
        const toAfter = await inBin(ctx, sku, to, 'invctl');
        if (toAfter !== toBefore + qty)
          throw new Error(`${to} holds ${toAfter} of ${sku}, expected ${toBefore + qty}`);
        const t = (final['transfer_request'] ?? final) as Json;
        return `status ${String(t['status'])}, ${to} ${toBefore} to ${toAfter}`;
      },
    ],
  ]);
}

// ---------------------------------------------------------------- 4. replenishment

async function replenishment(ctx: Ctx): Promise<void> {
  let open: Json[] = [];
  const ok = await step('replenishment: check the site and read the task board', async () => {
    const check = must(
      await ctx.request(
        'POST',
        '/api/v1/replenishment/check',
        { site_id: ctx.siteId },
        await ctx.as('whmanager'),
      ),
      200,
      'replenishment check',
    );
    const board = listOf(
      must(
        await ctx.request(
          'GET',
          `/api/v1/warehouse-tasks?site_id=${ctx.siteId}&task_type=replenishment`,
          undefined,
          await ctx.as('whmanager'),
        ),
        200,
        'task board',
      ),
      'tasks',
    );
    open = board.filter((t) => !['completed', 'cancelled', 'closed'].includes(String(t['status'])));
    return `${listOf(check, 'created').length} created by the check, ${open.length} open of ${board.length} on the board`;
  });
  const name = 'replenishment: operator confirms one task';
  if (!ok) return skip(name, 'needs "replenishment: check the site and read the task board"');
  if (open.length === 0)
    return skip(
      name,
      'no open replenishment task: the site has no forward-pick min/max configured (PUT /api/v1/replenishment/config is a planning decision, not a daily action)',
    );
  await step(name, async () => {
    const t = open[0]!;
    const id = (t['replenishment_task_id'] ?? t['task_id']) as string;
    const res = must(
      await ctx.request(
        'POST',
        `/api/v1/replenishment-tasks/${id}/confirm`,
        {
          ...(t['to_location_id'] ? { to_location_id: t['to_location_id'] } : {}),
          idempotency_key: uuid(),
        },
        await ctx.as('picker'),
      ),
      200,
      'confirm replenishment',
    );
    const task = (res['task'] ?? res) as Json;
    return `${String(task['quantity'])} ${String(task['sku'])}, ${String(task['status'])}`;
  });
}

// ---------------------------------------------------------------- 5. refused captures

async function refusedCaptures(ctx: Ctx): Promise<void> {
  let others: Json[] = [];
  const ok = await step('refused captures: department head reads the open queue', async () => {
    const headers = await ctx.as('depthead');
    const rows = listOf(
      must(
        await ctx.request(
          'GET',
          `/api/v1/edge/refused-captures?status=open&location_id=${ctx.siteId}`,
          undefined,
          headers,
        ),
        200,
        'refused captures',
      ),
      'refusals',
    );
    // Who the department head is: the edge bootstrap names the caller.
    const me = await ctx.request('GET', '/api/v1/edge/bootstrap', undefined, headers);
    const myId = me.status === 200 ? (me.body['user_id'] as string) : null;
    others = rows.filter((r) =>
      myId ? r['captured_by'] !== myId : r['captured_role'] !== 'department_head',
    );
    return `${rows.length} open at the site, ${others.length} captured by somebody else`;
  });
  const name = 'refused captures: resolve one captured by somebody else';
  if (!ok) return skip(name, 'needs "refused captures: department head reads the open queue"');
  if (others.length === 0)
    return skip(name, 'no open refused capture of another person at the site');
  await step(name, async () => {
    const row = others[0]!;
    const id = row['refusal_id'] as string;
    const res = must(
      await approveAs(
        ctx,
        'depthead',
        { role: 'department_head', module: String(row['stream_type']) },
        (headers) =>
          ctx.request(
            'POST',
            `/api/v1/edge/refused-captures/${id}/resolve`,
            {
              note: `Pilot sim ${ctx.run}: reviewed, re-entered by the owner`,
              idempotency_key: uuid(),
            },
            headers,
          ),
      ),
      200,
      'resolve',
    );
    return `${id.slice(0, 8)} (${String(row['error_code'])}, ${String(row['stream_type'])}) ${String((res['refusal'] as Json | undefined)?.['status'])}`;
  });
}

// ---------------------------------------------------------------- 6. offcut acquisition (CFO)

async function offcutAcquisition(ctx: Ctx): Promise<void> {
  const name = 'offcut: CFO signs a job-work offcut acquisition';
  let cfo = '';
  try {
    cfo = ctx.emailOf('cfo');
  } catch {
    cfo = '';
  }
  if (!cfo)
    return skip(
      name,
      "no logical actor 'cfo' (world.json operations.actors has none; the driver must add cfo: anupam@ancorlabs.org)",
    );
  let orderId = '';
  let holding: Json | undefined;
  const ok = await step('offcut: read the job-work order holdings', async () => {
    const orders = listOf(
      must(
        await ctx.request(
          'GET',
          `/api/v1/service-orders?site_id=${ctx.siteId}&limit=200`,
          undefined,
          await ctx.as('depthead'),
        ),
        200,
        'service orders',
      ),
      'service_orders',
    );
    const notes: string[] = [];
    for (const o of orders) {
      const res = await ctx.request(
        'GET',
        `/api/v1/service-orders/${String(o['service_order_id'])}/offcut-holdings`,
        undefined,
        await ctx.as('depthead'),
      );
      if (res.status !== 200) continue;
      const hit = listOf(res.body, 'holdings').find(
        (h) =>
          (h['pending_approval'] as Json | null)?.['kind'] === 'acquisition' ||
          (h['status'] === 'retained' && !h['pending_approval']),
      );
      notes.push(`${String(o['order_number_ext'])}: ${listOf(res.body, 'holdings').length}`);
      if (hit && !holding) {
        holding = hit;
        orderId = o['service_order_id'] as string;
      }
    }
    return `${orders.length} orders, holdings ${notes.join(', ') || 'none'}`;
  });
  if (!ok) return skip(name, 'needs "offcut: read the job-work order holdings"');
  if (!holding)
    return skip(
      name,
      'no retained offcut holding: capturing one needs consumption, output, QC release, dispatch and an ERP-acknowledged billing feed on the job-work order, none of which the pilot day does',
    );
  await step(name, async () => {
    let proposalId = (holding!['pending_approval'] as Json | null)?.['proposal_id'] as
      string | undefined;
    if (!proposalId) {
      const proposed = must(
        await ctx.request(
          'POST',
          `/api/v1/service-orders/${orderId}/offcut-disposals`,
          {
            holding_id: holding!['holding_id'],
            disposition: 'acquired',
            rate: String(holding!['indicative_rate'] ?? '1'),
            currency: 'INR',
            location_id: holding!['location_id'],
            idempotency_key: uuid(),
          },
          await ctx.as('compliance'),
        ),
        [200, 201],
        'propose acquisition',
      );
      if (proposed['status'] !== 'pending_approval')
        return `below the band: acquired without a CFO signature (${String(proposed['status'])})`;
      proposalId = proposed['proposal_id'] as string;
    }
    must(
      await ctx.request(
        'POST',
        `/api/v1/service-orders/${orderId}/offcut-acquisition-proposals/${proposalId}/approve`,
        { idempotency_key: uuid() },
        await ctx.as('cfo'),
      ),
      [200, 201],
      'CFO approval',
    );
    return `proposal ${proposalId.slice(0, 8)} approved by ${cfo}`;
  });
}

// ---------------------------------------------------------------- 7. meter reading

async function meterReading(ctx: Ctx): Promise<void> {
  const assets = (ctx.ops['assets'] ?? []) as Json[];
  const asset = assets[Math.floor(Date.now() / 86_400_000) % Math.max(assets.length, 1)];
  let meter: Json = {};
  let value = 0;
  if (!asset) return skip('meter: technician records a reading', 'the pack has no assets');
  await flow([
    [
      'meter: technician records a reading',
      async () => {
        const headers = await ctx.as('maint');
        const found = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/assets?search=${encodeURIComponent(String(asset['asset_tag']))}&limit=50`,
              undefined,
              headers,
            ),
            200,
            'assets',
          ),
          'assets',
        ).find((a) => a['asset_tag'] === asset['asset_tag']);
        if (!found) throw new Error(`asset ${String(asset['asset_tag'])} is not registered`);
        const meters = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/maintenance/meters?asset_id=${String(found['asset_id'])}`,
              undefined,
              headers,
            ),
            200,
            'meters',
          ),
          'meters',
        );
        meter = meters[0] ?? {};
        if (!meter['meter_id']) throw new Error(`no meter on ${String(asset['asset_tag'])}`);
        const current = Number(meter['current_reading'] ?? 0);
        value = current + (meter['unit'] === 'km' ? 5 : 8);
        must(
          await ctx.request(
            'POST',
            '/api/v1/maintenance/meter-readings',
            {
              meter_id: meter['meter_id'],
              reading_value: value,
              reading_at: new Date().toISOString(),
              idempotency_key: uuid(),
            },
            headers,
          ),
          201,
          'meter reading',
        );
        const readings = listOf(
          must(
            await ctx.request(
              'GET',
              `/api/v1/maintenance/meters/${String(meter['meter_id'])}/readings`,
              undefined,
              headers,
            ),
            200,
            'readings',
          ),
          'readings',
        );
        if (!readings.some((r) => Number(r['reading_value']) === value))
          throw new Error(`reading ${value} is not in the meter history`);
        return `${String(meter['meter_code'])} on ${String(asset['asset_tag'])}: ${current} to ${value} ${String(meter['unit'])}`;
      },
    ],
    [
      'meter: a reading below the current one is refused',
      async () => {
        const res = await ctx.request(
          'POST',
          '/api/v1/maintenance/meter-readings',
          { meter_id: meter['meter_id'], reading_value: value - 1, idempotency_key: uuid() },
          await ctx.as('maint'),
        );
        return `${value - 1} after ${value}: ${refused(res, 409, 'METER_READING_REGRESSION')}`;
      },
    ],
  ]);
}

/** The daily flows the operations smoke does not cover. Each flow records its own PASS/FAIL/SKIP lines. */
export async function extraFlows(ctx: Ctx): Promise<void> {
  await qcRelease(ctx);
  await binMove(ctx);
  await transfer(ctx);
  await replenishment(ctx);
  await refusedCaptures(ctx);
  await offcutAcquisition(ctx);
  await meterReading(ctx);
}
