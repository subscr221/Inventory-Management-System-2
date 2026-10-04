// Operations setup of a mock pack: everything a working day needs that has an API, created
// through the API as the right people, AFTER the go-live unblock (rehearse.ts). Idempotent: what
// exists is left alone, so it can be re-run.
//
//   local : node --env-file=.env.test --import tsx deploy/rehearsal/mock/setup-operations.ts --site-code MOCK-XXXX
//   remote: node --import tsx deploy/rehearsal/mock/setup-operations.ts --remote cfg.json --pack <dir>
//
// Creates: the purchase-order and sales-order snapshots (ERP sync, each ONE complete snapshot
// because the sync closes what a batch does not carry), DOA entries, maintenance SLA policies,
// assets with a meter each, approved suppliers, ownership agreements for consignment and VMI
// items, and an approved inspection plan per finished good. Not here, because no API exists:
// the location tree and pick sequence, job-work receipts and custody (seed.mjs), role
// assignments (src/cli/provision-roles.ts with the pack's roles.json).

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  HERE,
  approveAs,
  argOf,
  boot,
  listOf,
  must,
  packJson,
  printTable,
  step,
  uuid,
  type Ctx,
  type Json,
} from './ops-lib.js';

/** item_id of a SKU through the item API (any inventory reader). */
export async function itemIdOf(ctx: Ctx, sku: string, who = 'erp'): Promise<string> {
  const res = must(
    await ctx.request(
      'GET',
      `/api/v1/items/${encodeURIComponent(sku)}`,
      undefined,
      await ctx.as(who),
    ),
    200,
    `item ${sku}`,
  );
  return ((res['item'] as Json | undefined) ?? res)['item_id'] as string;
}

/** The released BOM of a finished good: ids of the BOM, its revision and its lines. */
export async function releasedBomOf(
  ctx: Ctx,
  sku: string,
  who = 'engineer',
): Promise<{ bomId: string; revisionId: string; detail: Json }> {
  const headers = await ctx.as(who);
  const itemId = await itemIdOf(ctx, sku);
  const list = listOf(
    must(
      await ctx.request(
        'GET',
        `/api/v1/boms?status=released&search=${encodeURIComponent(sku)}&limit=50`,
        undefined,
        headers,
      ),
      200,
      'list boms',
    ),
    'boms',
  );
  const hit =
    list.find((b) => b['parent_item_id'] === itemId || b['parent_sku'] === sku) ?? list[0];
  if (!hit)
    throw new Error(`no released BOM for ${sku}; did the rehearsal migrate the legacy kits?`);
  const bomId = hit['bom_id'] as string;
  const detail = must(
    await ctx.request('GET', `/api/v1/boms/${bomId}/structure`, undefined, headers),
    200,
    'get bom structure',
  );
  const bom = (detail['bom'] as Json | undefined) ?? detail;
  const revisionId = (bom['current_revision_id'] ??
    bom['released_revision_id'] ??
    bom['revision_id'] ??
    hit['current_revision_id'] ??
    hit['revision_id']) as string;
  return { bomId, revisionId, detail };
}

export async function setupOperations(ctx: Ctx): Promise<void> {
  const ops = ctx.ops;

  for (const [file, key] of [
    ['erp-sync-purchase-orders.json', 'purchase_orders'],
    ['erp-sync-sales-orders.json', 'sales_orders'],
  ] as const) {
    await step(`setup: ERP ${key} snapshot`, async () => {
      const body = packJson(ctx, file);
      const res = must(
        await ctx.request('POST', '/api/v1/erp/sync', body, await ctx.as('erp')),
        200,
        'erp sync',
      );
      const counts = res[key] as Record<string, number>;
      if (counts['failed']) throw new Error(`erp sync: ${JSON.stringify(res).slice(0, 400)}`);
      return `${counts['applied']} applied (full snapshot)`;
    });
  }

  await step('setup: DOA entries', async () => {
    const headers = await ctx.as('compliance');
    let created = 0;
    const entries = ops['doa_entries'] as Json[];
    for (const e of entries) {
      // There is no list route: resolve tells whether an active band already answers the type.
      const resolved = await ctx.request(
        'POST',
        '/api/v1/doa/resolve',
        { transaction_type: e['transaction_type'], value: 1 },
        headers,
      );
      if (!(resolved.status === 404 && resolved.body['error_code'] === 'NO_DOA_ENTRY_MATCH'))
        continue;
      must(
        await ctx.request('POST', '/api/v1/doa/entries', e, headers),
        201,
        `DOA ${String(e['transaction_type'])}`,
      );
      created += 1;
    }
    return `${created} created, ${entries.length - created} already answered by an active band`;
  });

  await step('setup: maintenance SLA policies (p1 to p4)', async () => {
    const headers = await ctx.as('maintsup');
    let created = 0;
    const policies = ops['sla_policies'] as Json[];
    for (const p of policies) {
      const res = await ctx.request(
        'POST',
        '/api/v1/maintenance/sla-policies',
        { ...p, idempotency_key: uuid() },
        headers,
      );
      if (res.status === 409 && res.body['error_code'] === 'DUPLICATE_SLA_POLICY') continue;
      must(res, 201, `SLA ${String(p['criticality_class'])}/${String(p['safety_flag'])}`);
      created += 1;
    }
    return `${created} created, ${policies.length - created} existed`;
  });

  await step('setup: assets and meters', async () => {
    const headers = await ctx.as('maintsup');
    let created = 0;
    const assets = ops['assets'] as Json[];
    for (const a of assets) {
      const { meter, ...asset } = a as { meter: Json } & Json;
      const found = listOf(
        must(
          await ctx.request(
            'GET',
            `/api/v1/assets?search=${encodeURIComponent(String(asset['asset_tag']))}&limit=50`,
            undefined,
            headers,
          ),
          200,
          'list assets',
        ),
        'assets',
      ).find((x) => x['asset_tag'] === asset['asset_tag']);
      if (found) continue;
      const made = must(
        await ctx.request('POST', '/api/v1/assets', asset, headers),
        201,
        `asset ${String(asset['asset_tag'])}`,
      );
      const assetId = (made['asset'] as Json)['asset_id'] as string;
      must(
        await ctx.request(
          'POST',
          '/api/v1/maintenance/meters',
          { asset_id: assetId, ...meter },
          headers,
        ),
        201,
        `meter ${String(meter['meter_code'])}`,
      );
      created += 1;
    }
    return `${created} created with a meter each, ${assets.length - created} existed`;
  });

  await step('setup: suppliers onboarded and approved', async () => {
    const officer = await ctx.as('indent');
    const notes: string[] = [];
    for (const { onboarding_documents: documents, ...s } of ops['suppliers'] as Json[]) {
      const list = listOf(
        must(
          await ctx.request(
            'GET',
            `/api/v1/suppliers?search=${encodeURIComponent(String(s['legal_name']))}`,
            undefined,
            officer,
          ),
          200,
          'list suppliers',
        ),
        'suppliers',
      );
      let supplier = list.find(
        (x) =>
          x['owner_party_code'] === s['owner_party_code'] || x['legal_name'] === s['legal_name'],
      );
      if (!supplier)
        supplier = must(
          await ctx.request('POST', '/api/v1/suppliers', s, officer),
          201,
          `supplier ${String(s['owner_party_code'])}`,
        )['supplier'] as Json;
      const id = supplier['supplier_id'] as string;
      if (supplier['status'] === 'onboarding' || supplier['status'] === 'draft') {
        const submitted = await ctx.request(
          'POST',
          `/api/v1/suppliers/${id}/onboarding/submit`,
          { documents },
          officer,
        );
        must(submitted, [200, 201, 202], `submit ${String(s['owner_party_code'])}`);
        const details = (submitted.body['details'] ?? submitted.body) as Json;
        const approved = await approveAs(
          ctx,
          'depthead',
          { role: 'department_head', module: 'procurement' },
          (headers) =>
            ctx.request('POST', `/api/v1/suppliers/${id}/onboarding/approve`, {}, headers),
          (details['approver_actor_id'] as string | undefined) ?? null,
        );
        must(approved, [200, 201], `approve ${String(s['owner_party_code'])}`);
        notes.push(`${String(s['owner_party_code'])} approved`);
      } else notes.push(`${String(s['owner_party_code'])} ${String(supplier['status'])}`);
    }
    return notes.join(', ');
  });

  await step('setup: ownership agreements (consignment, VMI)', async () => {
    const headers = await ctx.as('invctl');
    const agreements = ops['ownership_agreements'] as Json[];
    const codes = ops['ownership_agreement_locations'] as string[];
    for (const code of codes) {
      const location = must(
        await ctx.request(
          'GET',
          `/api/v1/locations/${encodeURIComponent(code)}`,
          undefined,
          headers,
        ),
        200,
        `location ${code}`,
      );
      const locationId = ((location['location'] as Json | undefined) ?? location)[
        'location_id'
      ] as string;
      for (const a of agreements) {
        const { sku, stock_class, ...body } = a;
        must(
          await ctx.request(
            'PUT',
            `/api/v1/ownership-agreements/${encodeURIComponent(String(sku))}/${locationId}/${String(stock_class)}`,
            { ...body, active: true },
            headers,
          ),
          [200, 201],
          `agreement ${String(sku)} at ${code}`,
        );
      }
    }
    return `${agreements.length} items x ${codes.length} locations (receiving docks and storage bins)`;
  });

  await step('setup: inspection plans for finished goods, approved by the QC head', async () => {
    const author = await ctx.as('qc');
    const notes: string[] = [];
    for (const plan of ops['inspection_plans'] as Json[]) {
      const { sku, ...body } = plan;
      const itemId = await itemIdOf(ctx, String(sku));
      const { revisionId } = await releasedBomOf(ctx, String(sku));
      const existing = listOf(
        must(
          await ctx.request(
            'GET',
            `/api/v1/qc/inspection-plans?item_id=${itemId}&bom_revision_id=${revisionId}&limit=50`,
            undefined,
            author,
          ),
          200,
          'list plans',
        ),
        'plans',
        'inspection_plans',
      );
      if (existing.length > 0) {
        notes.push(`${String(sku)} existed`);
        continue;
      }
      const made = must(
        await ctx.request(
          'POST',
          '/api/v1/qc/inspection-plans',
          {
            ...body,
            item_id: itemId,
            bom_revision_id: revisionId,
            effective_from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
          },
          author,
        ),
        201,
        `plan ${String(sku)}`,
      );
      const planRow = (made['plan'] as Json | undefined) ?? made;
      const version = (made['version'] as Json | undefined) ?? planRow;
      const planId = (planRow['plan_id'] ?? made['plan_id']) as string;
      const versionId = (version['plan_version_id'] ?? made['plan_version_id']) as string;
      must(
        await approveAs(ctx, 'qchead', { role: 'qc_head', module: 'qc' }, (headers) =>
          ctx.request(
            'POST',
            `/api/v1/qc/inspection-plans/${planId}/versions/${versionId}/approve`,
            { idempotency_key: uuid() },
            headers,
          ),
        ),
        [200, 201],
        `approve plan ${String(sku)}`,
      );
      notes.push(`${String(sku)} approved`);
    }
    return notes.join(', ');
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let ok = false;
  let crashed = false;
  let ctx: Ctx | null = null;
  try {
    const siteCode = argOf('--site-code', '');
    ctx = await boot(
      siteCode ? { siteCode, pack: argOf('--pack', join(HERE, 'out', siteCode)) } : null,
    );
    await setupOperations(ctx);
  } catch (error) {
    crashed = true;
    console.error(`\nstopped: ${(error as Error).message}`);
  }
  ok = printTable(`Operations setup (${ctx?.siteCode ?? '?'})`);
  await ctx?.close();
  process.exit(ok && !crashed ? 0 : 1);
}
