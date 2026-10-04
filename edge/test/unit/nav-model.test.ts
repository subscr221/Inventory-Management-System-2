import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_ENTRIES, entriesFor } from '../../src/components/navigation/nav-model';

const messages = JSON.parse(
  readFileSync(join(process.cwd(), 'src', 'messages', 'en.json'), 'utf-8'),
) as Record<string, unknown>;

function message(key: string): unknown {
  return messages[key];
}

/** Story 1.15 (AC 5, D7): the three employee base entries the bootstrap may advertise. */
describe('Story 1.15 nav model', () => {
  it('registers the three base entries with real paths and catalog labels', () => {
    for (const [name, href, label] of [
      ['New requisition', '/requisitions/new', 'nav.newRequisition'],
      ['Check stock', '/stock', 'nav.checkStock'],
      ['My requests', '/requests', 'nav.myRequests'],
    ] as const) {
      const entry = NAV_ENTRIES.find((e) => e.name === name);
      assert.deepEqual(entry, { name, href, label });
      assert.equal(typeof message(label), 'string', `${label} missing from en.json`);
    }
  });

  it('Story 8.9 (Task 11.1): registers Report damage and Damage cases with real paths', () => {
    for (const [name, href, label] of [
      ['Report damage', '/damage/new', 'nav.reportDamage'],
      ['Damage cases', '/damage/cases', 'nav.damageCases'],
    ] as const) {
      const entry = NAV_ENTRIES.find((e) => e.name === name);
      assert.deepEqual(entry, { name, href, label });
      assert.equal(typeof message(label), 'string', `${label} missing from en.json`);
    }
    // After My requests, in the order the server advertises them.
    const names = NAV_ENTRIES.map((e) => e.name);
    assert.equal(names.indexOf('Report damage'), names.indexOf('My requests') + 1);
    assert.equal(names.indexOf('Damage cases'), names.indexOf('Report damage') + 1);
  });

  it('renders only what the server advertised, in server order', () => {
    const names = entriesFor([
      'Dashboard',
      'Frontline',
      'New requisition',
      'Check stock',
      'My requests',
      'Report damage',
      'Not an entry',
    ]).map((e) => e.name);
    assert.deepEqual(names, [
      'Dashboard',
      'Frontline',
      'New requisition',
      'Check stock',
      'My requests',
      'Report damage',
    ]);
  });
});
