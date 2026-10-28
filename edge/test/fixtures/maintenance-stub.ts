import type { Page } from '@playwright/test';

/**
 * Story 7.8: the fetch stub behind the maintenance e2e specs. Bootstrap, PowerSync credentials,
 * the worklist refresh route, and the five capture routes are answered in the page. The worklist
 * state is kept in the page so selections and captures move between components as the real app does.
 */
export const SITE_ID = '55555555-5555-4555-8555-555555555555';
export const USER_ID = '33333333-3333-4333-8333-333333333333';
export const MAINTENANCE_NAVIGATION = [
  'Dashboard',
  'Frontline',
  'Maintenance worklist',
  'Report fault',
];

export interface WorkOrder {
  work_order_id: string;
  asset_id: string;
  asset_tag: string;
  asset_name: string;
  origin: 'breakdown' | 'preventive';
  status: 'open' | 'in_progress' | 'on_hold' | 'completed';
  priority: 'high' | 'normal' | 'low' | null;
  due_date: string;
  warranty_flagged: boolean;
  stream_version: number;
  meters: Array<{ meter_id: string; meter_code: string; unit: string; current_reading: string }>;
  reservations: Array<{ reservation_id: string; sku: string; quantity: string; location_id: string; stream_version: number }>;
  recent_closures: Array<{ work_order_id: string; origin: string; fault_code: string; cause_code: string; remedy_code: string; closed_at: string }>;
}

export interface MaintenanceStubOptions {
  /** The bootstrap `navigation` array; the default advertises the maintenance screens. */
  navigation?: string[];
  /** Work orders to return in the worklist. */
  workOrders?: WorkOrder[];
  /** 403 makes the worklist answer MODULE_ACCESS_DENIED. */
  worklistStatus?: 200 | 403;
  /** When set, every capture answers this error envelope. */
  captureError?: { status: number; error_code: string; details?: Record<string, unknown> };
}

const DEFAULT_WORK_ORDERS: WorkOrder[] = [
  {
    work_order_id: 'wo-0001',
    asset_id: 'asset-001',
    asset_tag: 'PUMP-001',
    asset_name: 'Cooling Water Pump A',
    origin: 'breakdown',
    status: 'open',
    priority: 'high',
    due_date: '2026-10-30',
    warranty_flagged: false,
    stream_version: 5,
    meters: [
      { meter_id: 'meter-001', meter_code: 'RUN_HOURS', unit: 'hrs', current_reading: '12500' },
      { meter_id: 'meter-002', meter_code: 'VIBRATION', unit: 'mm/s', current_reading: '2.5' },
    ],
    reservations: [
      { reservation_id: 'res-001', sku: 'BEARING-6205', quantity: '2', location_id: 'loc-001', stream_version: 3 },
      { reservation_id: 'res-002', sku: 'SEAL-KIT-PUMP', quantity: '1', location_id: 'loc-001', stream_version: 2 },
    ],
    recent_closures: [
      { work_order_id: 'wo-0001', origin: 'breakdown', fault_code: 'BRG_FAIL', cause_code: 'LACK_LUBE', remedy_code: 'REPL_BRG', closed_at: '2026-09-15T10:00:00.000Z' },
    ],
  },
  {
    work_order_id: 'wo-0002',
    asset_id: 'asset-002',
    asset_tag: 'COMP-001',
    asset_name: 'Air Compressor #1',
    origin: 'preventive',
    status: 'in_progress',
    priority: 'normal',
    due_date: '2026-11-05',
    warranty_flagged: true,
    stream_version: 3,
    meters: [
      { meter_id: 'meter-003', meter_code: 'RUN_HOURS', unit: 'hrs', current_reading: '8750' },
    ],
    reservations: [
      { reservation_id: 'res-003', sku: 'FILTER-AIR', quantity: '1', location_id: 'loc-002', stream_version: 1 },
    ],
    recent_closures: [],
  },
  {
    work_order_id: 'wo-0003',
    asset_id: 'asset-003',
    asset_tag: 'CONV-001',
    asset_name: 'Conveyor Belt #3',
    origin: 'breakdown',
    status: 'on_hold',
    priority: 'low',
    due_date: '2026-11-10',
    warranty_flagged: false,
    stream_version: 2,
    meters: [],
    reservations: [],
    recent_closures: [
      { work_order_id: 'wo-0003', origin: 'preventive', fault_code: '', cause_code: '', remedy_code: '', closed_at: '2026-08-20T14:00:00.000Z' },
    ],
  },
];

export async function provisionMaintenance(page: Page, options: MaintenanceStubOptions = {}) {
  const worklistState = {
    workOrders: (options.workOrders ?? DEFAULT_WORK_ORDERS).map((wo) => ({ ...wo })),
    closureCatalogue: {
      fault: ['BRG_FAIL', 'SEAL_LEAK', 'VIB_HIGH', 'OVERHEAT', 'NOISE', 'OTHER'],
      cause: ['LACK_LUBE', 'WRONG_INSTALL', 'MATERIAL_DEFECT', 'AGE_WEAR', 'OPER_ERROR', 'OTHER'],
      remedy: ['REPL_BRG', 'REPL_SEAL', 'REALIGN', 'REBUILD', 'ADJUST', 'OTHER'],
    },
  };

  const config = {
    navigation: options.navigation ?? MAINTENANCE_NAVIGATION,
    workOrders: options.workOrders ?? DEFAULT_WORK_ORDERS,
    worklistState,
    worklistStatus: options.worklistStatus ?? 200,
    captureError: options.captureError ?? null,
    siteId: SITE_ID,
    userId: USER_ID,
  };

  await page.addInitScript((cfg) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const error = (status: number, error_code: string, details: Record<string, unknown> = {}) =>
      json({ error_code, message: 'server message never shown', details, trace_id: 'trace-7-8' }, status);

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // Bootstrap
      if (url.endsWith('/api/v1/edge/bootstrap')) {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({
          user_id: cfg.userId,
          user_name: 'Arif Maintenance Tech',
          site_id: cfg.siteId,
          site_name: 'CMF Aligarh',
          role: 'maintenance_technician',
          navigation: cfg.navigation,
        });
      }

      // PowerSync credentials
      if (url.endsWith('/api/v1/edge/powersync-credentials')) {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }

      // Worklist refresh
      if (url.includes('/api/v1/edge/maintenance/worklist')) {
        if (!navigator.onLine) throw new TypeError('offline');
        if (cfg.worklistStatus === 403) return error(403, 'MODULE_ACCESS_DENIED');
        return json({
          fetched_at: new Date().toISOString(),
          total: cfg.workOrders.length,
          truncated: false,
          closure_codes: cfg.worklistState.closureCatalogue,
          work_orders: cfg.worklistState.workOrders.map((wo) => ({
            work_order_id: wo.work_order_id,
            origin: wo.origin,
            status: wo.status,
            priority: wo.priority,
            due_date: wo.due_date,
            sla_resolution_due_at: null,
            warranty_flagged: wo.warranty_flagged,
            stream_version: wo.stream_version,
            asset: {
              asset_id: wo.asset_id,
              asset_tag: wo.asset_tag,
              name: wo.asset_name,
              criticality: 'high',
            },
            recent_closures: wo.recent_closures,
            reservations: wo.reservations,
            meters: wo.meters,
          })),
        });
      }

      // Capture endpoints - all go to /api/v1/edge/events
      if (url.endsWith('/api/v1/edge/events')) {
        if (!navigator.onLine) throw new TypeError('offline');
        if (cfg.captureError) {
          return error(cfg.captureError.status, cfg.captureError.error_code, cfg.captureError.details);
        }
        // Accept any capture - return a fake event ID
        return json({ event_id: crypto.randomUUID() });
      }

      return nativeFetch(input, init);
    };
  }, config);
}