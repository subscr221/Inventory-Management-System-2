// One simulated pilot day on staging, as the pilot's people, through the real API. Stands in for
// the pilot week the site has no staff to run (decided 2026-09-23). Run it through
// deploy/pilot/sim-day.sh, which adds the password-grant client first and removes it after.
//
//   node --import tsx deploy/pilot/sim/pilot-day.ts --remote <cfg.json> --pack <pack dir>
//        [--ssh root@host] [--ssh-port 2222] [--ssh-key <file>] [--report-dir <dir>]
//
// The day, in order:
//   1. Morning ERP feed as the ERP service account: today's purchase order (a copy of the pack's
//      operations PO) and today's sales order, sent as one snapshot each. The sync closes every
//      order the snapshot leaves out, the same as the real ERP's daily full export would.
//   2. The operations day of operations-smoke.ts (inbound, job-work, count, outbound, production,
//      indent, maintenance) against today's orders.
//   3. The flows the smoke test does not cover (extra-flows.ts), when that file is present.
// The sales-order list carries no dispatch-order id (README of the mock pack, item 1), so the ids
// of today's order are read over SSH with one SELECT on the box.
//
// Writes <report-dir>/<yyyy-mm-dd-HHMM>.json and prints the PASS/FAIL table. Exit 0 when no step FAILED (a SKIP is allowed).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  argOf,
  boot,
  must,
  packJson,
  printTable,
  results,
  step,
  type Ctx,
  type Json,
} from '../../rehearsal/mock/ops-lib.js';
import {
  inbound,
  indent,
  maintenance,
  outbound,
  production,
} from '../../rehearsal/mock/operations-smoke.js';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12); // yymmddHHMM, UTC
const poNumber = `MK-PO-D${stamp}`;
const soNumber = `MK-SO-D${stamp}`;

/** Runs one read-only SELECT against the app database on the box; rows come back pipe-separated. */
function boxQuery(sql: string): string[][] {
  const target = argOf('--ssh', 'root@103.160.106.127');
  const port = argOf('--ssh-port', '2222');
  const key = argOf(
    '--ssh-key',
    join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', '.ssh', 'ims_vps_automation'),
  );
  const remote =
    `cd /opt/ims/deploy/compose && docker compose exec -T postgres sh -c ` +
    `'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtF "|" -v ON_ERROR_STOP=1'`;
  const out = execFileSync(
    'ssh',
    ['-p', port, '-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, remote],
    { input: sql, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));
}

async function morningFeed(ctx: Ctx): Promise<boolean> {
  const operationsPo = ctx.ops['operations_po'] as string;
  const template = (
    packJson(ctx, 'erp-sync-purchase-orders.json')['purchase_orders'] as Json[]
  ).find((o) => o['po_number_ext'] === operationsPo);
  const soTemplate = (packJson(ctx, 'erp-sync-sales-orders.json')['sales_orders'] as Json[]).filter(
    (l) => l['so_number_ext'] === 'MK-SO-0001',
  );
  if (!template || soTemplate.length === 0) {
    await step("ERP feed: today's orders", async () => {
      throw new Error(`pack has no ${operationsPo} or MK-SO-0001 to copy`);
    });
    return false;
  }
  const po: Json = {
    ...template,
    po_number_ext: poNumber,
    lines: (template['lines'] as Json[]).map((l) => ({ ...l, open_qty: l['ordered_qty'] })),
  };
  const soLines = soTemplate.map((l) => ({ ...l, so_number_ext: soNumber }));

  const poOk = await step(`ERP feed: purchase order ${poNumber}`, async () => {
    const res = must(
      await ctx.request('POST', '/api/v1/erp/sync', { purchase_orders: [po] }, await ctx.as('erp')),
      200,
      'erp sync purchase order',
    );
    const counts = res['purchase_orders'] as Record<string, number>;
    if (counts['failed']) throw new Error(JSON.stringify(res).slice(0, 400));
    return `${counts['applied']} applied, ${(po['lines'] as Json[]).length} lines`;
  });
  const soOk = await step(`ERP feed: sales order ${soNumber}`, async () => {
    const res = must(
      await ctx.request('POST', '/api/v1/erp/sync', { sales_orders: soLines }, await ctx.as('erp')),
      200,
      'erp sync sales order',
    );
    const counts = res['sales_orders'] as Record<string, number>;
    if (counts['failed']) throw new Error(JSON.stringify(res).slice(0, 400));
    const rows = boxQuery(
      `SELECT id, so_number_ext, line_no FROM erp_sales_order WHERE so_number_ext = '${soNumber}' ORDER BY line_no;`,
    );
    if (rows.length !== soLines.length)
      throw new Error(
        `expected ${soLines.length} dispatch-order ids on the box, found ${rows.length}`,
      );
    ctx.ops['sales_order_ids'] = rows.map(([id, so, line]) => ({
      id,
      so_number_ext: so,
      line_no: Number(line),
    }));
    return `${counts['applied']} applied, ${rows.length} dispatch-order ids read on the box`;
  });
  if (poOk) {
    ctx.ops['operations_po'] = poNumber;
    ctx.ops['operations_po_snapshot'] = po;
  }
  return poOk && soOk;
}

async function main(): Promise<void> {
  let crashed = false;
  let ctx: Ctx | null = null;
  const started = new Date();
  try {
    ctx = await boot(null);
    await morningFeed(ctx);
    await inbound(ctx);
    await outbound(ctx);
    await production(ctx);
    await indent(ctx);
    await maintenance(ctx);
    const extra = resolve(ROOT, 'deploy/pilot/sim/extra-flows.ts');
    if (existsSync(extra) && !process.env['SIM_SKIP_EXTRA']) {
      const mod = (await import(pathToFileURL(extra).href)) as {
        extraFlows?: (c: Ctx) => Promise<void>;
      };
      if (mod.extraFlows) await mod.extraFlows(ctx);
    }
  } catch (error) {
    crashed = true;
    console.error(`\nstopped: ${(error as Error).stack ?? (error as Error).message}`);
  }
  printTable(`Simulated pilot day (${ctx?.siteCode ?? '?'}, ${started.toISOString()})`);
  const dir = resolve(argOf('--report-dir', join(ROOT, '_bmad-output', 'pilot-sim')));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${started.toISOString().slice(0, 16).replace(/[T:]/g, '-')}-api.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        started: started.toISOString(),
        finished: new Date().toISOString(),
        site: ctx?.siteCode ?? null,
        purchase_order: poNumber,
        sales_order: soNumber,
        crashed,
        steps: results(),
      },
      null,
      2,
    ),
  );
  console.log(`report: ${file}`);
  await ctx?.close();
  // A SKIP is a flow the day could not reach yet (listed with its reason), not a defect: the day
  // passes when nothing FAILED. printTable's own verdict counts skips as not passed.
  const failed = results().filter((l) => l.result === 'FAIL').length;
  process.exit(failed === 0 && !crashed ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
