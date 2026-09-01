import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundCycles } from '../../src/server.js';
import { config } from '../../src/config/index.js';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Story 8.7 code review (2026-09-02), deferred-work follow-up.
 *
 * Every in-process background cycle used to be scheduled by an inline `setInterval` inside
 * `startServer`, which also binds a port - so nothing could assert the schedule, and deleting a
 * registration left the whole suite green while the cycle silently never ran in production. Two of
 * the five drive statutory obligations: the QC retention-sample sweep (Story 8.4 AC 5) and the BIS
 * licence expiry sweep (Story 8.7 AC 2, the 90/60/30-day alerts and the expiry flip).
 *
 * `backgroundCycles()` is the seam that made the schedule a value. This test pins it. A cycle
 * removed from the registry, renamed, or wired to the wrong config knob fails here.
 */
describe('in-process background cycle registry', () => {
  const EXPECTED: Array<{ name: string; intervalMs: () => number; why: string }> = [
    {
      name: 'dispatch',
      intervalMs: () => config.notify.dispatchIntervalMs,
      why: 'notifications are never delivered',
    },
    {
      name: 'escalation',
      intervalMs: () => config.notify.escalationIntervalMs,
      why: 'unacknowledged notifications never escalate',
    },
    {
      name: 'expiry',
      intervalMs: () => config.notify.expiryIntervalMs,
      why: 'notifications never expire',
    },
    {
      name: 'qc retention expiry',
      intervalMs: () => config.quality.retentionExpiryIntervalMs,
      why: 'retention samples are never marked expired (Story 8.4 AC 5)',
    },
    {
      name: 'bis licence expiry',
      intervalMs: () => config.quality.bisLicenceExpiryIntervalMs,
      why: 'BIS licences never alert at 90/60/30 days and never flip to expired (Story 8.7 AC 2)',
    },
  ];

  it('registers exactly the expected cycles, in order', () => {
    const registered = backgroundCycles().map((c) => c.name);
    assert.deepStrictEqual(
      registered,
      EXPECTED.map((e) => e.name),
      'a cycle was added or removed - if deliberate, update EXPECTED and say why in the commit',
    );
  });

  for (const expected of EXPECTED) {
    it(`schedules "${expected.name}" on its configured interval - without it, ${expected.why}`, () => {
      const cycle = backgroundCycles().find((c) => c.name === expected.name);
      assert.ok(cycle, `the "${expected.name}" cycle is not registered`);
      assert.strictEqual(
        cycle.intervalMs,
        expected.intervalMs(),
        `"${expected.name}" is wired to the wrong config knob`,
      );
      assert.strictEqual(typeof cycle.cycle, 'function');
    });
  }

  it('gives every cycle a positive interval, so none is a tick storm or a dead timer', () => {
    for (const cycle of backgroundCycles()) {
      assert.ok(
        Number.isInteger(cycle.intervalMs) && cycle.intervalMs > 0,
        `${cycle.name} has a non-positive interval: ${cycle.intervalMs}`,
      );
      // Node clamps anything above 2^31-1 to 1ms - an hourly sweep would become a busy loop.
      assert.ok(
        cycle.intervalMs <= 2_147_483_647,
        `${cycle.name} exceeds the setInterval bound and would fire every millisecond`,
      );
    }
  });

  it('names every cycle distinctly, so a failure log identifies which one failed', () => {
    const names = backgroundCycles().map((c) => c.name);
    assert.strictEqual(new Set(names).size, names.length, 'two cycles share a name');
  });

  /**
   * The in-process assertions above cannot tell two knobs apart when their VALUES coincide - and
   * several of these default to 3_600_000, so wiring the BIS sweep to the retention interval passes
   * them all. That is the "asserted the config against itself" failure this repo has hit before.
   * This probe gives every knob a distinct value in a child process and checks each cycle picked up
   * its OWN one, which is the only way a mis-wiring becomes visible.
   */
  it('binds each cycle to its own config knob, proven with distinct values', () => {
    const distinct = {
      NOTIFY_DISPATCH_INTERVAL_MS: '11000',
      NOTIFY_ESCALATION_INTERVAL_MS: '12000',
      NOTIFY_EXPIRY_INTERVAL_MS: '13000',
      QC_RETENTION_EXPIRY_INTERVAL_MS: '14000',
      QC_BIS_LICENCE_EXPIRY_INTERVAL_MS: '15000',
    };
    const result = spawnSync(
      process.execPath,
      [
        '--env-file=.env.test',
        '--import',
        'tsx',
        '-e',
        "import('./src/server.ts').then((m) => console.log(JSON.stringify(m.backgroundCycles().map((c) => [c.name, c.intervalMs]))));",
      ],
      {
        cwd: root,
        env: { ...process.env, ...distinct },
        encoding: 'utf-8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
    );
    assert.strictEqual(result.status, 0, `${result.stderr}${result.stdout}`);
    const line = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.startsWith('['))
      .pop();
    assert.ok(line, `no registry line in child output: ${result.stdout}`);
    assert.deepStrictEqual(JSON.parse(line), [
      ['dispatch', 11000],
      ['escalation', 12000],
      ['expiry', 13000],
      ['qc retention expiry', 14000],
      ['bis licence expiry', 15000],
    ]);
  });
});
