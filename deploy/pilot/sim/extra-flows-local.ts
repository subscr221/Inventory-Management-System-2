// Local runner of extra-flows.ts against the .env.test database, for a mock site that is already
// live (run deploy/rehearsal/mock/operations-smoke.ts once first; it prints the site code).
//
//   node --env-file=.env.test --import tsx deploy/pilot/sim/extra-flows-local.ts --site-code MOCK-XXXX
//
// The pack's roles.json holds a cfo, but world.json names no logical actor for it; this runner adds
// 'cfo' when roles.json has exactly one holder of the role, as the pilot driver must.

import { join } from 'node:path';
import { HERE, argOf, boot, packJson, printTable, type Ctx } from '../../rehearsal/mock/ops-lib.js';
import { extraFlows } from './extra-flows.js';

let ok = false;
let crashed = false;
let ctx: Ctx | null = null;
try {
  const siteCode = argOf('--site-code', '');
  if (!siteCode)
    throw new Error('--site-code MOCK-XXXX is required (a site operations-smoke.ts took live)');
  ctx = await boot({ siteCode, pack: argOf('--pack', join(HERE, 'out', siteCode)) });
  const actors = ctx.ops['actors'] as Record<string, string>;
  const cfos = [
    ...new Set(
      ((packJson(ctx, 'roles.json')['roles'] ?? []) as { role: string; holder: string }[])
        .filter((r) => r.role === 'cfo')
        .map((r) => r.holder),
    ),
  ];
  if (!actors['cfo'] && cfos.length === 1) actors['cfo'] = cfos[0]!;
  await extraFlows(ctx);
} catch (error) {
  crashed = true;
  console.error(`\nstopped: ${(error as Error).stack ?? (error as Error).message}`);
}
ok = printTable(`Pilot extra flows (${ctx?.siteCode ?? '?'}, local)`);
await ctx?.close();
process.exit(ok && !crashed ? 0 : 1);
