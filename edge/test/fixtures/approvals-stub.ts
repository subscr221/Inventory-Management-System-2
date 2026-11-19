import type { Page } from '@playwright/test';

/**
 * Story 4.12: the fetch stub behind the approvals specs. The real authorization and contract
 * rules live in test/integration/story-4-12.test.ts; this only shapes the two list reads, the
 * detail read and the two decision posts. Decisions move the item to Decided inside the page.
 */
export const INDENT_ID = '44444444-4444-4444-8444-444444444441';
export const LINE_PENDING = '44444444-4444-4444-8444-444444444442';
export const LINE_GRANT = '44444444-4444-4444-8444-444444444443';
export const INDENT_ID_2 = '44444444-4444-4444-8444-444444444451';
const LINE_PENDING_2 = '44444444-4444-4444-8444-444444444452';
export const APPROVALS_NAVIGATION = ['Dashboard', 'Frontline', 'My requests', 'Approvals'];

export interface ApprovalsStubOptions {
  navigation?: string[];
  /** Answer the first decision post with 409 INDENT_LINE_ALREADY_DECIDED. */
  conflictFirst?: boolean;
  /** Start with nothing waiting. */
  empty?: boolean;
  /** Add a second waiting requisition (IND-2026-0043) that is never decided. */
  second?: boolean;
  /** Hold each decision post this long before answering. */
  decisionDelayMs?: number;
  /** Answer both list reads with 500. */
  listFails?: boolean;
}

export async function provisionApprovals(page: Page, options: ApprovalsStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? APPROVALS_NAVIGATION,
    conflictFirst: options.conflictFirst ?? false,
    empty: options.empty ?? false,
    second: options.second ?? false,
    decisionDelayMs: options.decisionDelayMs ?? 0,
    listFails: options.listFails ?? false,
    ids: {
      indent: INDENT_ID,
      pending: LINE_PENDING,
      grant: LINE_GRANT,
      second: INDENT_ID_2,
      pending2: LINE_PENDING_2,
    },
  };
  await page.addInitScript((cfg) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const state = {
      decided: null as null | 'approved' | 'rejected',
      reason: '',
      posts: [] as unknown[],
    };
    (window as unknown as { __approvalPosts: unknown[] }).__approvalPosts = state.posts;
    const created = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const bands = [{ role: 'department_head', value_min: null, value_max: 100000 }];
    const row = () => ({
      indent_id: cfg.ids.indent,
      indent_number_ext: 'IND-2026-0042',
      status: state.decided === 'rejected' ? 'rejected' : state.decided ? 'approved' : 'raised',
      estimated_value: '12400.00',
      created_at: created,
      requester_display_name: 'Maint One',
      pending_for_me_line_ids: state.decided ? [] : [cfg.ids.pending],
      line_skus: ['CON-GLOVES', 'CON-WELD-ROD'],
      approved_line_count: state.decided === 'approved' ? 2 : 1,
      line_count: 2,
    });
    const detail = () => ({
      indent: { ...row(), line_count: 2 },
      requester_display_name: 'Maint One',
      pending_for_me_line_ids: state.decided ? [] : [cfg.ids.pending],
      approver_bands: bands,
      lines: [
        {
          indent_line_id: cfg.ids.pending,
          line_no: 1,
          sku: 'CON-WELD-ROD',
          requested_qty: '20.000',
          uom: 'KG',
          line_value: '10000.00',
          approval_route: 'doa',
          line_status: state.decided ? (state.decided as string) : 'pending',
          decided_at: state.decided ? new Date().toISOString() : null,
          decided_by_display_name: state.decided ? 'Dee Head' : null,
          rejection_reason: state.decided === 'rejected' ? state.reason : null,
          standing_grant_ref: null,
          cap: null,
          month_to_date_issued: null,
          approver_band: bands[0],
        },
        {
          indent_line_id: cfg.ids.grant,
          line_no: 2,
          sku: 'CON-GLOVES',
          requested_qty: '2.000',
          uom: 'PR',
          line_value: '2400.00',
          approval_route: 'standing_approval',
          line_status: 'approved',
          decided_at: created,
          decided_by_display_name: null,
          rejection_reason: null,
          standing_grant_ref: 'SA-2026-004',
          cap: '6.000',
          month_to_date_issued: '4.000',
          approver_band: null,
        },
      ],
    });
    const secondRow = () => ({
      ...row(),
      indent_id: cfg.ids.second,
      indent_number_ext: 'IND-2026-0043',
      status: 'raised',
      pending_for_me_line_ids: [cfg.ids.pending2],
      approved_line_count: 0,
      line_count: 1,
    });
    const secondDetail = () => ({
      indent: secondRow(),
      requester_display_name: 'Maint One',
      pending_for_me_line_ids: [cfg.ids.pending2],
      approver_bands: bands,
      lines: [
        {
          ...detail().lines[0],
          indent_line_id: cfg.ids.pending2,
          line_status: 'pending',
          decided_at: null,
          decided_by_display_name: null,
          rejection_reason: null,
        },
      ],
    });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      if (path.pathname === '/api/v1/edge/bootstrap') {
        return json({
          user_id: '66666666-6666-4666-8666-666666666667',
          user_name: 'Dee Head',
          site_id: '55555555-5555-4555-8555-555555555555',
          site_name: 'North Site',
          site_code_ext: 'site-A',
          gate_id: 'GATE-01',
          inspection_bay_code: null,
          role: 'department_head',
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/indents') {
        if (cfg.listFails) return json({ error_code: 'INTERNAL_ERROR' }, 500);
        if (path.searchParams.get('pending_for_me') === 'true') {
          const waiting = [
            ...(!cfg.empty && !state.decided ? [row()] : []),
            ...(cfg.second ? [secondRow()] : []),
          ];
          return json({ indents: waiting, approver_bands: bands });
        }
        if (path.searchParams.get('decided_by_me') === 'true') {
          return json({ indents: state.decided ? [row()] : [], approver_bands: bands });
        }
      }
      if (path.pathname === `/api/v1/indents/${cfg.ids.indent}`) return json(detail());
      if (path.pathname === `/api/v1/indents/${cfg.ids.second}`) return json(secondDetail());
      const decision = /^\/api\/v1\/indents\/[^/]+\/(approve|reject)$/.exec(path.pathname);
      if (decision && init?.method === 'POST') {
        state.posts.push({ action: decision[1], body: JSON.parse(String(init.body)) });
        if (cfg.conflictFirst && state.posts.length === 1) {
          return json({ error_code: 'INDENT_LINE_ALREADY_DECIDED' }, 409);
        }
        if (cfg.decisionDelayMs) await new Promise((r) => setTimeout(r, cfg.decisionDelayMs));
        const body = JSON.parse(String(init.body)) as { rejection_reason?: string };
        state.decided = decision[1] === 'approve' ? 'approved' : 'rejected';
        state.reason = body.rejection_reason ?? '';
        return json({ event_id: 'e-1' });
      }
      return nativeFetch(input, init);
    };
  }, config);
}
