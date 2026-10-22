import type { Page } from '@playwright/test';

/**
 * Story 3.13: the fetch stub behind the gate-entry specs, in the pattern of damage-stub.ts. It
 * answers the bootstrap (with the Gate entry nav row, site_code_ext and gate_id), the PowerSync
 * credentials, and throws offline on the edge events door so captures stay queued. The real
 * authorization and contract rules are owned by test/integration/story-3-13.test.ts.
 */
export const SITE_ID = '55555555-5555-4555-8555-555555555555';
export const GATE_USER_ID = '66666666-6666-4666-8666-666666666666';
export const GATE_ROLE = 'gate_officer';
export const GATE_NAVIGATION = ['Dashboard', 'Frontline', 'Gate entry'];

export interface GateStubOptions {
  navigation?: string[];
  role?: string;
  siteCodeExt?: string;
  gateId?: string;
}

export async function provisionGate(page: Page, options: GateStubOptions = {}) {
  const config = {
    navigation: options.navigation ?? GATE_NAVIGATION,
    role: options.role ?? GATE_ROLE,
    siteCodeExt: options.siteCodeExt ?? 'site-A',
    gateId: options.gateId ?? 'GATE-01',
  };
  await page.addInitScript((cfg) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin);
      if (path.pathname === '/api/v1/edge/bootstrap') {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({
          user_id: '66666666-6666-4666-8666-666666666666',
          user_name: 'Gita Gate Officer',
          site_id: '55555555-5555-4555-8555-555555555555',
          site_name: 'North Gate',
          site_code_ext: cfg.siteCodeExt,
          gate_id: cfg.gateId,
          role: cfg.role,
          navigation: cfg.navigation,
        });
      }
      if (path.pathname === '/api/v1/edge/powersync-credentials') {
        return json({ endpoint: 'http://127.0.0.1:1', token: 'test-token' });
      }
      if (path.pathname === '/api/v1/edge/events') throw new TypeError('offline');
      if (path.pathname === '/api/v1/indents') {
        if (!navigator.onLine) throw new TypeError('offline');
        return json({ indents: [] });
      }
      return nativeFetch(input, init);
    };
  }, config);
}

/** A small JPEG-typed payload for the mandatory challan photo input. */
export const PHOTO_FILE = {
  name: 'challan.jpg',
  mimeType: 'image/jpeg',
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]),
};
