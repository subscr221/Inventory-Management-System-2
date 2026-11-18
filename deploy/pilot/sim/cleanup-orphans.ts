// One-time pilot cleanup: close the orphan task backlog on staging as the pilot's own
// people, through the real API, before users start. Standing on the pilot-day harness
// (sim-day.sh conventions): remote Keycloak users only, no local DB writes, event-sourced
// completions only. What it closes:
//   1. open putaway tasks (unassigned, age > TASK_UNOWNED_AGE_H) - completed into BIN-A03 by
//      store1, the pack's putaway bin, with idempotency_key "pilot-cleanup-<task-id>".
//   2. open QC tasks at qc_hold - the extra-flows.qcRelease chain (sample, inspect, disposition
//      by qchead, retention sample in QCH-BIN-01, release).
// Run: OPS_PW=1234 node --import tsx deploy/pilot/sim/cleanup-orphans.ts
//      --remote deploy/pilot/sim/staging-sim.json --pack docs/migration/pilot-mock-extract
import { randomUUID } from 'node:crypto';
import {
  boot,
  flow,
  listOf,
  must,
  printTable,
  step,
  type Ctx,
  type Json,
} from '../../rehearsal/mock/ops-lib.js';

/** The location_id of a bin code (mirrors extra-flows.ts). */
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

async function cleanupPutaway(ctx: Ctx): Promise<void> {
  const store = await ctx.as('store');
  const res = must(
    await ctx.request(
      'GET',
      `/api/v1/putaway-tasks?site_id=${ctx.siteId}&status=ready&limit=200`,
      undefined,
      await ctx.as('invctl'),
    ),
    200,
    'list open putaway tasks',
  );
  const rows = listOf(res, 'tasks');
  const bin = ctx.ops['putaway_bin'] as string;
  const binId = await locationIdOf(ctx, bin);
  let done = 0;
  const left: string[] = [];
  await flow(
    rows.map((t): [string, () => Promise<string | void>] => [
      `putaway ${(t['putaway_task_id'] as string).slice(0, 8)} ${String(t['sku'])} ${String(t['quantity'])}`,
      async () => {
        const id = t['putaway_task_id'] as string;
        const r = await ctx.request(
          'POST',
          `/api/v1/putaway-tasks/${id}/complete`,
          {
            actual_location_id: binId,
            override_reason_code: 'OPERATOR_CHOICE',
            override_confidence: 'certain',
            idempotency_key: `pilot-cleanup-${id}`,
          },
          store,
        );
        if (r.status === 200) {
          done += 1;
          return `completed into ${bin}`;
        }
        left.push(`${id.slice(0, 8)}: ${r.status} ${r.text.slice(0, 200)}`);
        throw new Error(`${r.status} ${r.text.slice(0, 300)}`);
      },
    ]),
  );
  await step('putaway summary', async () => `${done}/${rows.length} completed into ${bin}`);
  if (left.length > 0) throw new Error(`left open: ${left.join('; ')}`);
}

async function cleanupQc(ctx: Ctx): Promise<void> {
  const qc = await ctx.as('qc');
  const res = must(
    await ctx.request(
      'GET',
      `/api/v1/qc/tasks?site_id=${ctx.siteId}&task_status=open&gate_status=qc_hold&limit=50`,
      undefined,
      qc,
    ),
    200,
    'list open QC tasks',
  );
  const rows = listOf(res, 'tasks');
  for (const task of rows) {
    const taskId = task['task_id'] as string;
    const path = (tail: string) => `/api/v1/qc/tasks/${taskId}/${tail}`;
    const lot = `${String(task['lot_number'])} (${String(task['quantity'])} ${String(task['sku'])})`;
    await flow([
      [
        `qc sample+inspect ${lot}`,
        async () => {
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
          const sampling = must(
            await ctx.request('POST', path('sampling'), {}, qc),
            [200, 201],
            'sampling',
          )['sampling'] as Json;
          const size = Number(sampling['sample_size']);
          for (const c of characteristics) {
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
          return `inspected, sample of ${size}`;
        },
      ],
      [
        `qc disposition+release ${lot}`,
        async () => {
          const body = {
            disposition: 'accept',
            justification: 'Pilot cleanup: inspected, all conform',
          };
          must(
            await ctx.request('POST', path('disposition'), body, await ctx.as('qchead')),
            201,
            'disposition by QC head',
          );
          const bin = ctx.ops['quarantine_bin'] as string;
          const logged = await ctx.request(
            'POST',
            path('retention-sample'),
            {
              quantity: '1',
              uom: String(task['uom'] ?? 'EA'),
              location_id: await locationIdOf(ctx, bin),
            },
            qc,
          );
          must(logged, [200, 201], 'retention sample');
          must(await ctx.request('POST', path('release'), {}, qc), [200, 201], 'release');
          return `accepted by QC head, 1 ${String(task['uom'] ?? 'EA')} kept in ${bin}, released`;
        },
      ],
    ]);
  }
  await step('qc summary', async () => `${rows.length} open tasks released`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--remote'))
    throw new Error(
      'staging only: pass --remote deploy/pilot/sim/staging-sim.json --pack docs/migration/pilot-mock-extract',
    );
  const ctx = await boot(null);
  try {
    await cleanupPutaway(ctx);
    await cleanupQc(ctx);
  } finally {
    await ctx.close();
  }
  const ok = printTable('Pilot cleanup (orphan tasks closed as the pilot people)');
  if (!ok) process.exitCode = 1;
  void randomUUID;
}

await main();
