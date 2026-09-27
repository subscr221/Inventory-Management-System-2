import type { Page } from '@playwright/test';

/**
 * Story 8.9: the fetch stub behind the damage specs, in the pattern of employee-base-stub.ts. One
 * bootstrap per persona; the damage lists, the case detail with a stub `allowed_actions`, the
 * action POSTs and the photo store are answered in the page, statefully for the life of the page.
 * The real authorization rules are owned by test/integration/story-8-9.test.ts; this stub only
 * has to hand the screen an `allowed_actions` the way the server would, so the specs prove the
 * screen renders exactly what it is given. `/api/v1/edge/events` throws offline, so captures stay
 * queued.
 */
export const SITE_ID = '55555555-5555-4555-8555-555555555555';

export const PERSONAS = {
  reporter: { userId: '66666666-6666-4666-8666-666666666666', name: 'Arif Ansari', role: 'employee' },
  qc_inspector: { userId: '71111111-1111-4111-8111-111111111111', name: 'Qasim Inspector', role: 'qc_inspector' },
  qc_head: { userId: '72222222-2222-4222-8222-222222222222', name: 'Quratulain Head', role: 'qc_head' },
  finance: { userId: '73333333-3333-4333-8333-333333333333', name: 'Farah Accounts', role: 'finance_controller' },
  ceo: { userId: '74444444-4444-4444-8444-444444444444', name: 'Chandra Rao', role: 'ceo' },
  stores: { userId: '75555555-5555-4555-8555-555555555555', name: 'Sunil Stores', role: 'store_assistant' },
} as const;
export type Persona = keyof typeof PERSONAS;

export const BASE_NAVIGATION = ['Dashboard', 'Frontline', 'New requisition', 'Check stock', 'My requests'];

/** The seeded cases; ids are stable so specs can deep link. */
export const CASES = {
  arrival: { id: 'd0000000-0000-4000-8000-000000000001', number: 'DMG-2026-0001' },
  financeKey: { id: 'd0000000-0000-4000-8000-000000000002', number: 'DMG-2026-0002' },
  escalated: { id: 'd0000000-0000-4000-8000-000000000003', number: 'DMG-2026-0003' },
  qcKey: { id: 'd0000000-0000-4000-8000-000000000004', number: 'DMG-2026-0004' },
  overdue: { id: 'd0000000-0000-4000-8000-000000000005', number: 'DMG-2026-0005' },
} as const;

export interface DamageStubOptions {
  persona?: Persona;
  navigation?: string[];
  /** 403 makes the workbench answer FUNCTION_ACCESS_DENIED. */
  workbenchStatus?: 200 | 403;
  /** Milliseconds each action POST waits before answering (in-flight evidence). */
  actionDelayMs?: number;
}

export async function provisionDamage(page: Page, options: DamageStubOptions = {}) {
  const persona = options.persona ?? 'reporter';
  const config = {
    persona,
    personas: PERSONAS,
    cases: CASES,
    navigation:
      options.navigation ??
      [
        ...BASE_NAVIGATION,
        'Report damage',
        ...(persona === 'reporter' ? [] : ['Damage cases']),
      ],
    workbenchStatus: options.workbenchStatus ?? (persona === 'reporter' ? 403 : 200),
    actionDelayMs: options.actionDelayMs ?? 0,
    siteId: SITE_ID,
  };
  await page.addInitScript((cfg) => {
    type Row = Record<string, unknown> & { report_id: string; status: string };
    const me = cfg.personas[cfg.persona as keyof typeof cfg.personas];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const error = (status: number, error_code: string) =>
      json({ error_code, message: 'server message never shown', details: {}, trace_id: 'trace-8-9' }, status);

    const base = (overrides: Record<string, unknown>): Row =>
      ({
        site_id: cfg.siteId,
        reporter_user_id: cfg.personas.reporter.userId,
        reporter_display_name: cfg.personas.reporter.name,
        reported_at: '2026-09-27T04:30:00.000Z',
        source: 'report',
        source_grn_line_id: null,
        sku: 'PCB-CTRL-01',
        lot_number: 'LOT-7',
        quantity: '4',
        uom: 'EA',
        found_at: 'stock',
        bin_code: 'CMF-STORE-A1',
        reason_code: 'DEAD_ON_ARRIVAL',
        reason_note: null,
        photo_attachment_id: 'a0000000-0000-4000-8000-000000000001',
        photo_status: 'stored',
        hold_mode: 'quarantined',
        hold_note: null,
        physical_state: 'in_qc_hold',
        arrived_at: null,
        external_destination: null,
        external_sent_at: null,
        external_expected_return_date: null,
        external_result_ref_ext: null,
        whole_lot_requested: false,
        whole_lot_decision: null,
        status: 'on_hold',
        confirmed_quantity: null,
        defect_code: null,
        qc_key_status: 'pending',
        finance_key_status: 'pending',
        qc_key_user_id: null,
        finance_key_user_id: null,
        qc_key_outcome: null,
        finance_key_outcome: null,
        qc_key_price_reduction_pct: null,
        finance_key_price_reduction_pct: null,
        qc_key_at: null,
        finance_key_at: null,
        qc_key_display_name: null,
        finance_key_display_name: null,
        final_outcome: null,
        final_price_reduction_pct: null,
        decided_by: null,
        escalation_display_name: null,
        erp_document_ref_ext: null,
        replacement_indent_id: null,
        replacement_indent_number: null,
        replacement_status: null,
        ...overrides,
      }) as unknown as Row;

    const qcHead = cfg.personas.qc_head;
    const finance = cfg.personas.finance;
    const reports: Row[] = [
      base({
        report_id: cfg.cases.arrival.id,
        report_number: cfg.cases.arrival.number,
        physical_state: 'awaiting_arrival',
        whole_lot_requested: true,
        replacement_indent_id: 'e0000000-0000-4000-8000-000000000001',
        replacement_indent_number: 'IND-2026-0107',
        replacement_status: 'raised',
      }),
      base({
        report_id: cfg.cases.financeKey.id,
        report_number: cfg.cases.financeKey.number,
        sku: 'VALVE-SS-25',
        quantity: '2',
        status: 'awaiting_keys',
        confirmed_quantity: '2',
        defect_code: 'FUNCTIONAL',
        qc_key_status: 'turned',
        qc_key_user_id: qcHead.userId,
        qc_key_display_name: qcHead.name,
        qc_key_outcome: 'debit_note',
        qc_key_at: '2026-09-27T06:00:00.000Z',
        reported_at: '2026-09-26T04:30:00.000Z',
      }),
      base({
        report_id: cfg.cases.escalated.id,
        report_number: cfg.cases.escalated.number,
        sku: 'MOTOR-1HP',
        quantity: '1',
        status: 'escalated',
        confirmed_quantity: '1',
        defect_code: 'ASSEMBLY',
        qc_key_status: 'turned',
        qc_key_user_id: qcHead.userId,
        qc_key_display_name: qcHead.name,
        qc_key_outcome: 'write_off',
        qc_key_at: '2026-09-25T06:00:00.000Z',
        finance_key_status: 'disagreed',
        finance_key_user_id: finance.userId,
        finance_key_display_name: finance.name,
        finance_key_outcome: 'debit_note',
        finance_key_at: '2026-09-25T08:00:00.000Z',
        reported_at: '2026-09-25T04:30:00.000Z',
      }),
      base({
        report_id: cfg.cases.qcKey.id,
        report_number: cfg.cases.qcKey.number,
        sku: 'GASKET-40',
        quantity: '6',
        status: 'awaiting_keys',
        confirmed_quantity: '5',
        defect_code: 'DIMENSIONAL',
        photo_status: 'pending',
        reported_at: '2026-09-24T04:30:00.000Z',
      }),
      base({
        report_id: cfg.cases.overdue.id,
        report_number: cfg.cases.overdue.number,
        sku: 'SENSOR-PT100',
        quantity: '3',
        status: 'on_hold',
        physical_state: 'at_external_check',
        external_destination: 'NABL lab, Noida',
        external_sent_at: '2026-08-25T05:00:00.000Z',
        external_expected_return_date: '2026-09-01',
        reported_at: '2026-08-24T04:30:00.000Z',
      }),
    ];
    const history: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of reports) {
      history[row.report_id] = [
        {
          action: 'reported',
          actor_user_id: cfg.personas.reporter.userId,
          actor_role: 'employee',
          actor_display_name: cfg.personas.reporter.name,
          at: row['reported_at'],
          detail: {},
        },
      ];
    }
    const posts: Array<{ path: string; body: unknown }> = [];
    const puts: Array<{ id: string; type: string | null; size: number }> = [];
    (window as unknown as Record<string, unknown>)['__damagePosts'] = posts;
    (window as unknown as Record<string, unknown>)['__attachmentPuts'] = puts;

    const role = me.role;
    const isQc = role === 'qc_inspector' || role === 'qc_head';
    const isStores = role === 'store_assistant';
    function allowed(r: Row): string[] {
      const names: string[] = [];
      const physical = r['physical_state'];
      if (role === 'qc_inspector' && r.status === 'on_hold') names.push('inspect');
      if (role === 'qc_head' && r['whole_lot_requested'] === true && r['whole_lot_decision'] === null) {
        names.push('decide_whole_lot');
      }
      if (isQc || isStores) {
        if (['awaiting_arrival', 'with_reporter', 'not_held'].includes(String(physical))) names.push('mark_arrived');
        if (physical === 'in_qc_hold' && r.status !== 'closed') names.push('send_external');
        if (physical === 'at_external_check') names.push('mark_returned');
      }
      const keyActions = (key: 'qc' | 'finance') => {
        const mine = r[`${key}_key_status`];
        const other = r[`${key === 'qc' ? 'finance' : 'qc'}_key_status`];
        if (r.status !== 'awaiting_keys') return;
        if (mine === 'pending') names.push(`turn_${key}_key`);
        if (mine === 'turned' && other !== 'turned') names.push(`withdraw_${key}_key`);
        if (mine === 'pending' && other === 'turned') names.push(`disagree_${key}`);
      };
      if (role === 'qc_head') keyActions('qc');
      if (role === 'finance_controller') {
        keyActions('finance');
        if (r.status === 'outcome_final' && physical !== 'at_external_check') names.push('record_outcome');
      }
      if (role === 'ceo' && r.status === 'escalated') names.push('decide_escalation');
      const order = [
        'inspect',
        'decide_whole_lot',
        'mark_arrived',
        'send_external',
        'mark_returned',
        'turn_qc_key',
        'withdraw_qc_key',
        'disagree_qc',
        'turn_finance_key',
        'withdraw_finance_key',
        'disagree_finance',
        'decide_escalation',
        'record_outcome',
      ];
      return order.filter((name) => names.includes(name));
    }

    const HISTORY_OF: Record<string, string> = {
      inspection: 'inspected',
      'whole-lot': 'whole_lot_decided',
      'custody/arrived': 'units_arrived',
      'custody/sent-external': 'sent_for_external_check',
      'custody/returned': 'returned_from_external_check',
      'escalation/decide': 'escalation_decided',
      outcome: 'outcome_recorded',
    };

    function apply(r: Row, route: string, body: Record<string, unknown>): Response | null {
      const now = new Date().toISOString();
      const key = /^keys\/(qc|finance)\//.exec(route)?.[1] as 'qc' | 'finance' | undefined;
      switch (route) {
        case 'inspection': {
          const confirmed = String(body['confirmed_quantity']);
          r['confirmed_quantity'] = confirmed;
          r['defect_code'] = body['defect_code'] ?? null;
          r.status = Number(confirmed) === 0 ? 'cleared' : 'awaiting_keys';
          break;
        }
        case 'whole-lot':
          r['whole_lot_decision'] = body['decision'];
          break;
        case 'custody/arrived':
          r['physical_state'] = 'in_qc_hold';
          r['arrived_at'] = now;
          break;
        case 'custody/sent-external':
          r['physical_state'] = 'at_external_check';
          r['external_destination'] = body['destination'];
          r['external_sent_at'] = now;
          r['external_expected_return_date'] = body['expected_return_date'] ?? null;
          break;
        case 'custody/returned':
          r['physical_state'] = 'in_qc_hold';
          r['external_result_ref_ext'] = body['external_result_ref_ext'] ?? null;
          break;
        case 'escalation/decide':
          r.status = 'outcome_final';
          r['final_outcome'] = body['outcome'];
          r['final_price_reduction_pct'] = body['price_reduction_pct'] ?? null;
          r['decided_by'] = 'escalation';
          r['escalation_display_name'] = me.name;
          break;
        case 'outcome':
          r.status = 'closed';
          r['erp_document_ref_ext'] = body['erp_document_ref_ext'];
          break;
        default: {
          if (!key) return error(404, 'NOT_FOUND');
          const other = key === 'qc' ? 'finance' : 'qc';
          if (route.endsWith('/turn')) {
            if (r[`${other}_key_status`] === 'turned' && r[`${other}_key_outcome`] !== body['outcome']) {
              return error(409, 'DAMAGE_OUTCOME_MISMATCH');
            }
            r[`${key}_key_status`] = 'turned';
            r[`${key}_key_outcome`] = body['outcome'];
            r[`${key}_key_price_reduction_pct`] = body['price_reduction_pct'] ?? null;
            r[`${key}_key_user_id`] = me.userId;
            r[`${key}_key_display_name`] = me.name;
            r[`${key}_key_at`] = now;
            if (r[`${other}_key_status`] === 'turned') {
              r.status = 'outcome_final';
              r['final_outcome'] = body['outcome'];
              r['final_price_reduction_pct'] = body['price_reduction_pct'] ?? null;
              r['decided_by'] = 'concurrence';
            }
          } else if (route.endsWith('/withdraw')) {
            r[`${key}_key_status`] = 'pending';
            r[`${key}_key_outcome`] = null;
            r[`${key}_key_user_id`] = null;
          } else {
            r[`${key}_key_status`] = 'disagreed';
            r[`${key}_key_outcome`] = body['proposed_outcome'];
            r[`${key}_key_user_id`] = me.userId;
            r[`${key}_key_display_name`] = me.name;
            r[`${key}_key_at`] = now;
            r.status = 'escalated';
          }
        }
      }
      history[r.report_id]!.push({
        action:
          HISTORY_OF[route] ??
          (route.endsWith('/turn') ? 'key_turned' : route.endsWith('/withdraw') ? 'key_withdrawn' : 'disagreed'),
        actor_user_id: me.userId,
        actor_role: role,
        actor_display_name: me.name,
        at: now,
        detail: {},
      });
      return null;
    }

    // 1x1 transparent PNG.
    const PNG = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
      (c) => c.charCodeAt(0),
    );

    const indents = [
      {
        indent_id: 'e0000000-0000-4000-8000-000000000001',
        indent_number_ext: 'IND-2026-0107',
        requester_user_id: cfg.personas.reporter.userId,
        status: 'raised',
        need_by_date: '2026-09-27',
        approver_actor_id: null,
        created_at: '2026-09-27T04:31:00.000Z',
      },
    ];

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      if (path.pathname === '/api/v1/edge/bootstrap') {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({
          user_id: me.userId,
          user_name: me.name,
          site_id: cfg.siteId,
          site_name: 'CMF Aligarh',
          role,
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/edge/events') throw new TypeError('offline');
      if (path.pathname === '/api/v1/indents') {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({ indents });
      }
      const attachment = /^\/api\/v1\/attachments\/([^/]+)$/.exec(path.pathname);
      if (attachment) {
        if (!navigator.onLine) throw new TypeError('offline');
        if ((init?.method ?? 'GET') === 'PUT') {
          const body = init?.body as Blob;
          puts.push({
            id: decodeURIComponent(attachment[1]!),
            type: new Headers(init?.headers).get('Content-Type'),
            size: body.size,
          });
          return json({ attachment_id: attachment[1], sha256: 'x', byte_size: body.size }, 201);
        }
        return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (path.pathname === '/api/v1/damage-reports') {
        if (!navigator.onLine) throw new TypeError('offline');
        const view = path.searchParams.get('view');
        if (view === 'mine') {
          return json({ reports: reports.filter((r) => r['reporter_user_id'] === me.userId) });
        }
        if (cfg.workbenchStatus === 403) return error(403, 'FUNCTION_ACCESS_DENIED');
        return json({ reports });
      }
      const detail = /^\/api\/v1\/damage-reports\/([^/]+)(?:\/(.+))?$/.exec(path.pathname);
      if (detail) {
        if (!navigator.onLine) throw new TypeError('offline');
        const row = reports.find((r) => r.report_id === decodeURIComponent(detail[1]!));
        if (!row) return error(404, 'DAMAGE_REPORT_NOT_FOUND');
        const route = detail[2];
        if (!route) {
          return json({ report: row, allowed_actions: allowed(row), history: history[row.report_id] });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        posts.push({ path: route, body });
        if (cfg.actionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, cfg.actionDelayMs));
        const refused = apply(row, route, body);
        if (refused) return refused;
        return json({ event_id: crypto.randomUUID(), report: row }, 201);
      }
      return nativeFetch(input, init);
    };
  }, config);
}

/** A small JPEG-typed payload for the photo input (the stub never decodes it). */
export const PHOTO_FILE = {
  name: 'damage.jpg',
  mimeType: 'image/jpeg',
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]),
};
