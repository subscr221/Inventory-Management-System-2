import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { NAV_ENTRIES } from '../../src/components/navigation/nav-model';

// Each persona's navigation mirrors what NAVIGATION_CAPABILITIES in src/api/v1/edge.ts sends for
// that role's grants. Enterprise entries (Workflows, Access control, Reports) are added for the
// department head, as the enterprise stub does.
const PERSONAS: Record<string, { role: string; navigation: string[] }> = {
  employee: {
    role: 'employee',
    navigation: ['Dashboard', 'Frontline', 'New requisition', 'Check stock', 'My requests',
      'Report damage', 'Standing grants'],
  },
  storekeeper: {
    role: 'storekeeper',
    navigation: ['Dashboard', 'Frontline', 'Check stock', 'Report damage', 'Damage cases', 'Stores',
      'Stores issue', 'Floor tasks'],
  },
  warehouse_operator: {
    role: 'warehouse_operator',
    navigation: ['Dashboard', 'Frontline', 'Report damage', 'Damage cases', 'Stores issue',
      'Floor tasks'],
  },
  gate_officer: {
    role: 'gate_officer',
    navigation: ['Dashboard', 'Frontline', 'Report damage', 'Gate entry'],
  },
  supervisor: {
    role: 'warehouse_supervisor',
    navigation: ['Dashboard', 'Frontline', 'Refused captures', 'Check stock', 'Report damage',
      'Damage cases', 'Floor tasks', 'Standing grants'],
  },
  department_head: {
    role: 'department_head',
    navigation: ['Dashboard', 'Frontline', 'Refused captures', 'New requisition', 'Check stock',
      'My requests', 'Report damage', 'Damage cases', 'Stores', 'Stores issue', 'Floor tasks',
      'Standing grants', 'Workflows', 'Access control', 'Reports'],
  },
};

const VIEWPORTS = {
  desktop: { width: 1366, height: 768, hasTouch: false, isMobile: false },
  handheld: { width: 360, height: 640, hasTouch: true, isMobile: true },
} as const;

const BASE = process.env['UI_AUDIT_BASE_URL'];
if (BASE) test.use({ baseURL: BASE });

const OUT = process.env['UI_AUDIT_OUT'] ?? '/opt/cursor/artifacts/ui-audit';

async function provision(page: Page, persona: { role: string; navigation: string[] }) {
  await page.addInitScript((p) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/v1/edge/bootstrap')) {
        return new Response(JSON.stringify({
          user_id: '11111111-1111-4111-8111-111111111111',
          user_name: 'Audit ' + p.role,
          site_id: '55555555-5555-4555-8555-555555555555',
          site_name: 'CMF Aligarh',
          site_code_ext: 'CMF-ALIGARH',
          role: p.role,
          navigation: p.navigation,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/v1/edge/powersync-credentials')) {
        return new Response(JSON.stringify({ endpoint: 'http://127.0.0.1:1', token: 't' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/v1/')) throw new TypeError('offline');
      return nativeFetch(input, init);
    };
  }, persona);
}

interface Finding { persona: string; viewport: string; route: string; kind: string; detail: string }
const findings: Finding[] = [];

async function layoutChecks(page: Page, touch: boolean) {
  return page.evaluate((isTouch) => {
    const out: { kind: string; detail: string }[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      out.push({ kind: 'horizontal-overflow', detail: `page ${doc.scrollWidth}px > viewport ${doc.clientWidth}px` });
    }
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}"`;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], [role=tab]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 || r.left < -1) {
        out.push({ kind: 'offscreen-control', detail: describe(el) });
      }
      const min = isTouch ? 44 : 24;
      const isInlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
      if (!isInlineLink && (r.height < min || r.width < min) && el.getAttribute('type') !== 'checkbox' && el.getAttribute('type') !== 'radio') {
        out.push({ kind: 'small-target', detail: `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)} (<${min})` });
      }
    }
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || el.children.length > 0 || !(el.textContent ?? '').trim()) continue;
      const s = getComputedStyle(el);
      if (s.overflow === 'visible' && el.scrollWidth > el.clientWidth + 2 && s.display !== 'inline') {
        out.push({ kind: 'text-overflow', detail: describe(el) });
      }
      if (!s.fontFamily.includes('Lato') && !/mono/i.test(s.fontFamily) && el.tagName !== 'svg' && el.tagName !== 'CODE') {
        out.push({ kind: 'non-lato-font', detail: `${describe(el)} ${s.fontFamily}` });
      }
    }
    for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
      if (!visible(h)) continue;
      const fs = parseFloat(getComputedStyle(h).fontSize);
      if (fs > 28) out.push({ kind: 'oversized-heading', detail: `${describe(h)} ${fs}px` });
    }
    if (document.querySelectorAll('h1').length !== 1) {
      out.push({ kind: 'h1-count', detail: `${document.querySelectorAll('h1').length} h1 elements` });
    }
    return out;
  }, touch);
}

for (const [personaName, persona] of Object.entries(PERSONAS)) {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    test.describe(`${personaName} @ ${vpName}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.hasTouch, isMobile: vp.isMobile });

      const routes = persona.navigation
        .map((name) => NAV_ENTRIES.find((e) => e.name === name))
        .filter((e): e is NonNullable<typeof e> => !!e && e.href.startsWith('/'));

      test('navigation shows exactly the role menu', async ({ page }) => {
        await provision(page, persona);
        await page.goto('/');
        await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 });
        if (!(await page.getByText('Audit ' + persona.role).first().isVisible())) {
          findings.push({ persona: personaName, viewport: vpName, route: '/', kind: 'identity-hidden', detail: 'signed-in user name not visible on home' });
        }
        await page.waitForTimeout(400);
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: `${OUT}/${personaName}-${vpName}-home.png` });
        const nav = page.getByRole('navigation');
        if (vpName === 'handheld') {
          const more = page.getByRole('button', { name: /more/i });
          if (await more.count()) {
            await more.first().click();
            await page.waitForTimeout(200);
            await page.screenshot({ path: `${OUT}/${personaName}-${vpName}-more-menu.png` });
            await page.keyboard.press('Escape');
          }
        }
        const linkHrefs = await page.locator('nav a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
        for (const r of routes) {
          if (!linkHrefs.includes(r.href)) {
            findings.push({ persona: personaName, viewport: vpName, route: '/', kind: 'missing-nav-entry', detail: r.name });
          }
        }
        await expect(nav.first()).toBeAttached();
      });

      for (const r of routes) {
        test(`page ${r.href}`, async ({ page }) => {
          const errors: string[] = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await provision(page, persona);
          await page.goto(r.href);
          await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(600);
          const safe = r.href.replace(/\//g, '_');
          await page.screenshot({ path: `${OUT}/${personaName}-${vpName}${safe}.png`, fullPage: true });
          for (const f of await layoutChecks(page, vp.hasTouch)) {
            findings.push({ persona: personaName, viewport: vpName, route: r.href, ...f });
          }
          const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
          for (const v of axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
            findings.push({ persona: personaName, viewport: vpName, route: r.href, kind: `axe:${v.id}`,
              detail: `${v.nodes.length} node(s): ${v.nodes[0]?.target.join(' ')}` });
          }
          for (const e of errors) findings.push({ persona: personaName, viewport: vpName, route: r.href, kind: 'page-error', detail: e.slice(0, 120) });
        });
      }
    });
  }
}

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/findings-${process.pid}.json`, JSON.stringify(findings, null, 2));
});
