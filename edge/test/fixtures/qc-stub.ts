import type { Page } from '@playwright/test';

export const QC_SITE_ID = '55555555-5555-4555-8555-555555555501';
export const QC_TASK_ID = '55555555-5555-4555-8555-555555555511';
export const QC_INSPECTED_TASK_ID = '55555555-5555-4555-8555-555555555512';
export const QC_LOT_ID = '55555555-5555-4555-8555-555555555521';
export const QC_LOT_NUMBER = 'LOT-QC-811';
export const QC_PLAN_ID = '55555555-5555-4555-8555-555555555531';
export const QC_PLAN_VERSION_ID = '55555555-5555-4555-8555-555555555532';
export const QC_HOLD_ID = '55555555-5555-4555-8555-555555555541';
export const QC_CHAR_1 = '55555555-5555-4555-8555-555555555551';
export const QC_CHAR_2 = '55555555-5555-4555-8555-555555555552';

export const QC_NAVIGATION = [
  'Dashboard',
  'Frontline',
  'Report damage',
  'Damage cases',
  'Standing grants',
  'QC inbox',
];

export interface QcStubOptions {
  role?: 'qc_head' | 'qc_inspector' | 'warehouse_operator';
  navigation?: string[];
  empty?: boolean;
  initialInspected?: boolean;
  requireRetention?: boolean;
}

export async function provisionQc(page: Page, options: QcStubOptions = {}) {
  const role = options.role ?? 'qc_head';
  const navigation =
    options.navigation ??
    (role === 'warehouse_operator'
      ? ['Dashboard', 'Frontline', 'Standing grants']
      : QC_NAVIGATION);
  const config = {
    role,
    navigation,
    empty: Boolean(options.empty),
    initialInspected: Boolean(options.initialInspected),
    requireRetention: Boolean(options.requireRetention),
    todayIso: new Date().toISOString(),
  };

  await page.addInitScript((cfg) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    (window as unknown as { __qcPosts: typeof posts }).__qcPosts = posts;

    let retentionPending = cfg.requireRetention;
    const tasks = new Map<
      string,
      {
        task_id: string;
        lot_id: string;
        lot_number: string;
        sku: string;
        quantity: string;
        uom: string;
        site_id: string;
        item_id: string;
        plan_id: string;
        plan_version_id: string;
        source_completion_type: string;
        task_status: 'open' | 'sampling_determined' | 'inspected';
        gate_status: string;
        disposition: 'accept' | 'reject' | 'split' | 'conditional_release' | null;
        disposition_at: string | null;
        released_at: string | null;
        inspect_on_opening: boolean;
        sampling: { sample_size: number; sampling_basis: string } | null;
        putaway: { status: string; hold_reason: string | null };
      }
    >();

    if (!cfg.empty) {
      tasks.set('55555555-5555-4555-8555-555555555511', {
        task_id: '55555555-5555-4555-8555-555555555511',
        lot_id: '55555555-5555-4555-8555-555555555521',
        lot_number: 'LOT-QC-811',
        sku: 'SKU-QC-1',
        quantity: '10',
        uom: 'EA',
        site_id: '55555555-5555-4555-8555-555555555501',
        item_id: '55555555-5555-4555-8555-555555555561',
        plan_id: '55555555-5555-4555-8555-555555555531',
        plan_version_id: '55555555-5555-4555-8555-555555555532',
        source_completion_type: 'goods_receipt',
        task_status: cfg.initialInspected ? 'inspected' : 'open',
        gate_status: 'qc_hold',
        disposition: null,
        disposition_at: null,
        released_at: null,
        inspect_on_opening: true,
        sampling: cfg.initialInspected ? { sample_size: 1, sampling_basis: 'aql' } : null,
        putaway: { status: 'held', hold_reason: 'qc_hold' },
      });
    }

    const results: Array<{
      characteristic_id: string;
      sample_unit_no: number;
      conforms: boolean;
      measured_value: string | null;
    }> = cfg.initialInspected
      ? [
          {
            characteristic_id: '55555555-5555-4555-8555-555555555551',
            sample_unit_no: 1,
            conforms: true,
            measured_value: null,
          },
          {
            characteristic_id: '55555555-5555-4555-8555-555555555552',
            sample_unit_no: 1,
            conforms: true,
            measured_value: null,
          },
        ]
      : [];

    const notes: Array<{
      note_id: string;
      note: string;
      attachment_id: string | null;
      recorded_by: string;
      recorded_at: string;
    }> = [];

    const holds = cfg.empty
      ? []
      : [
          {
            hold_id: '55555555-5555-4555-8555-555555555541',
            lot_id: '55555555-5555-4555-8555-555555555522',
            lot_number: 'LOT-HELD-9',
            sku: 'SKU-HELD-9',
            placed_by: 'Qadir Head',
            placed_at: '2026-11-20T04:00:00.000Z',
            status: 'open',
          },
        ];

    const damageReports = cfg.empty
      ? []
      : [
          {
            report_id: '55555555-5555-4555-8555-555555555571',
            report_number: 'DMG-811-1',
            lot_number: 'LOT-DMG-1',
            sku: 'SKU-DMG-1',
            whole_lot_requested: true,
            whole_lot_decision: null,
            status: 'on_hold',
            keys: [],
            created_at: cfg.todayIso,
          },
          {
            report_id: '55555555-5555-4555-8555-555555555572',
            report_number: 'DMG-811-2',
            lot_number: 'LOT-DMG-2',
            sku: 'SKU-DMG-2',
            whole_lot_requested: false,
            whole_lot_decision: null,
            status: 'escalated',
            keys: [],
            created_at: cfg.todayIso,
          },
        ];

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path.pathname === '/api/v1/edge/bootstrap') {
        return json({
          user_id: '55555555-5555-4555-8555-555555555502',
          user_name: cfg.role === 'qc_head' ? 'Qadir Head' : 'Qasim QC',
          site_id: '55555555-5555-4555-8555-555555555501',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: 'IB-01',
          role: cfg.role,
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/edge/events') {
        throw new TypeError('offline');
      }

      if (path.pathname === '/api/v1/qc/tasks' && method === 'GET') {
        const gateFilter = path.searchParams.get('gate_status');
        const statusFilter = path.searchParams.get('task_status');
        const list = [...tasks.values()].filter((item) => {
          if (gateFilter && item.gate_status !== gateFilter) return false;
          if (statusFilter && item.task_status !== statusFilter) return false;
          return true;
        });
        return json({ tasks: list });
      }

      if (path.pathname === '/api/v1/damage-reports' && method === 'GET') {
        return json({ reports: damageReports });
      }

      const taskMatch = path.pathname.match(/^\/api\/v1\/qc\/tasks\/([^/]+)$/);
      if (taskMatch && method === 'GET') {
        const task = tasks.get(decodeURIComponent(taskMatch[1]!));
        if (!task) return json({ error_code: 'QC_TASK_NOT_FOUND' }, 404);
        return json({
          task,
          sampling: task.sampling,
          disposition: task.disposition,
          receipt: {
            grn_number: 'GRN-811-1',
            supplier_name: 'Acme Metals',
            received_quantity: task.quantity,
            uom: task.uom,
            inspect_on_opening: task.inspect_on_opening,
          },
          putaway: task.putaway,
        });
      }

      if (
        path.pathname ===
          '/api/v1/qc/inspection-plans/55555555-5555-4555-8555-555555555531/versions/55555555-5555-4555-8555-555555555532' &&
        method === 'GET'
      ) {
        return json({
          characteristics: [
            {
              characteristic_id: '55555555-5555-4555-8555-555555555551',
              characteristic_name: 'Visual finish',
              characteristic_class: 'minor',
              result_kind: 'attribute',
              lower_limit: null,
              upper_limit: null,
              limit_uom: null,
              acceptance_criteria: 'No surface cracks',
            },
            {
              characteristic_id: '55555555-5555-4555-8555-555555555552',
              characteristic_name: 'Assembly completeness',
              characteristic_class: 'major',
              result_kind: 'attribute',
              lower_limit: null,
              upper_limit: null,
              limit_uom: null,
              acceptance_criteria: 'All fasteners present',
            },
          ],
        });
      }

      const taskAction = path.pathname.match(/^\/api\/v1\/qc\/tasks\/([^/]+)\/(.+)$/);
      if (taskAction) {
        const id = decodeURIComponent(taskAction[1]!);
        const action = taskAction[2]!;
        const task = tasks.get(id);
        if (!task) return json({ error_code: 'QC_TASK_NOT_FOUND' }, 404);

        if (action === 'results' && method === 'GET') {
          return json({ results, notes });
        }

        const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        posts.push({ path: path.pathname, body: rawBody });

        if (action === 'sampling' && method === 'POST') {
          task.sampling = { sample_size: 1, sampling_basis: 'aql' };
          task.task_status = 'sampling_determined';
          return json({ sampling: task.sampling });
        }
        if (action === 'observations' && method === 'POST') {
          const charId = String(rawBody.characteristic_id);
          const readings = (rawBody.readings ?? []) as Array<{
            sample_unit_no: number;
            attribute_conforms: boolean;
          }>;
          for (const r of readings) {
            const idx = results.findIndex(
              (x) => x.characteristic_id === charId && x.sample_unit_no === r.sample_unit_no,
            );
            const row = {
              characteristic_id: charId,
              sample_unit_no: r.sample_unit_no,
              conforms: Boolean(r.attribute_conforms),
              measured_value: null,
            };
            if (idx >= 0) results[idx] = row;
            else results.push(row);
          }
          return json({ results });
        }
        if (action === 'notes' && method === 'POST') {
          notes.push({
            note_id: `note-${notes.length + 1}`,
            note: String(rawBody.note ?? ''),
            attachment_id: (rawBody.attachment_id as string | undefined) ?? null,
            recorded_by: 'Qasim QC',
            recorded_at: cfg.todayIso,
          });
          return json({ notes }, 201);
        }
        if (action === 'inspection-completion' && method === 'POST') {
          task.task_status = 'inspected';
          return json({ task });
        }
        if (action === 'split' && method === 'POST') {
          const splitSpecs = (rawBody.splits ?? []) as Array<{ sequence: number; quantity: string }>;
          task.disposition = 'split';
          task.disposition_at = cfg.todayIso;
          task.gate_status = 'split';
          const out = splitSpecs.map((s) => {
            const childTaskId = `55555555-5555-4555-8555-5555555559${s.sequence}1`;
            const childLotId = `55555555-5555-4555-8555-5555555559${s.sequence}2`;
            tasks.set(childTaskId, {
              ...task,
              task_id: childTaskId,
              lot_id: childLotId,
              lot_number: `${task.lot_number}-${s.sequence}`,
              quantity: s.quantity,
              task_status: 'inspected',
              gate_status: 'qc_hold',
              disposition: null,
              disposition_at: null,
            });
            return {
              child_task_id: childTaskId,
              child_lot_id: childLotId,
              sequence: s.sequence,
              quantity: s.quantity,
            };
          });
          return json({ task, splits: out });
        }
        if (action === 'disposition' && method === 'POST') {
          task.disposition = rawBody.disposition;
          task.disposition_at = cfg.todayIso;
          task.gate_status = rawBody.disposition === 'accept' ? 'accepted' : 'rejected';
          return json({ task, disposition: rawBody.disposition });
        }
        if (action === 'release' && method === 'POST') {
          if (retentionPending) {
            return json({ error_code: 'RETENTION_SAMPLE_REQUIRED' }, 409);
          }
          task.released_at = cfg.todayIso;
          task.putaway = { status: 'ready', hold_reason: null };
          return json({ task });
        }
        if (action === 'retention-sample' && method === 'POST') {
          retentionPending = false;
          return json({ logged: true }, 201);
        }
      }

      if (path.pathname === '/api/v1/qc/holds' && method === 'GET') {
        const lotFilter = path.searchParams.get('lot_id');
        const statusFilter = path.searchParams.get('status');
        const out = holds.filter((h) => {
          if (lotFilter && h.lot_id !== lotFilter) return false;
          if (statusFilter && h.status !== statusFilter) return false;
          return true;
        });
        return json({ holds: out });
      }

      if (path.pathname === '/api/v1/qc/holds' && method === 'POST') {
        const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        posts.push({ path: path.pathname, body: rawBody });
        const existing = holds.find((h) => h.lot_id === rawBody.lot_id && h.status === 'open');
        if (existing) return json({ error_code: 'HOLD_EXISTS' }, 409);
        const created = {
          hold_id: `hold-${holds.length + 1}`,
          lot_id: String(rawBody.lot_id),
          lot_number: 'LOT-QC-811',
          sku: 'SKU-QC-1',
          placed_by: 'Qadir Head',
          placed_at: cfg.todayIso,
          status: 'open',
        };
        holds.push(created);
        return json({ hold: created }, 201);
      }

      const holdReleaseMatch = path.pathname.match(/^\/api\/v1\/qc\/holds\/([^/]+)\/release$/);
      if (holdReleaseMatch && method === 'POST') {
        const holdId = decodeURIComponent(holdReleaseMatch[1]!);
        const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        posts.push({ path: path.pathname, body: rawBody });
        const hold = holds.find((h) => h.hold_id === holdId);
        if (!hold) return json({ error_code: 'HOLD_NOT_FOUND' }, 404);
        hold.status = 'released';
        return json({ hold });
      }

      if (path.pathname.startsWith('/api/v1/attachments/')) {
        if (method === 'PUT') return json({ sha256: 'abc', byte_size: 10 }, 201);
        if (method === 'GET') {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
      }

      return nativeFetch(input, init);
    };
  }, config);
}
