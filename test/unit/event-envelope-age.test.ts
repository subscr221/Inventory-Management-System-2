import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { occurredAtBoundViolation, OCCURRED_AT_FUTURE_SKEW_MS } from '../../src/events/store.js';

/**
 * Pilot triage 2026-09-12 (ledger 11.5R-1): metadata.occurred_at now has a floor as well as a
 * ceiling. The check is pure so both bounds are pinned here with a driven clock; the integration
 * suites run with EVENT_OCCURRED_AT_MAX_AGE_DAYS=3650 (.env.test) because their fixtures carry
 * fixed calendar dates, so this file is the only place the production default is exercised.
 */
describe('occurredAtBoundViolation', () => {
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  const iso = (ms: number) => new Date(ms).toISOString();
  const DAY = 86_400_000;

  it('accepts an instant inside both bounds', () => {
    assert.equal(occurredAtBoundViolation(iso(now), now, 30), null);
    assert.equal(occurredAtBoundViolation(iso(now - 29 * DAY), now, 30), null);
    assert.equal(occurredAtBoundViolation(iso(now + OCCURRED_AT_FUTURE_SKEW_MS), now, 30), null);
  });

  it('refuses more than 5 minutes in the future', () => {
    const msg = occurredAtBoundViolation(iso(now + OCCURRED_AT_FUTURE_SKEW_MS + 1), now, 30);
    assert.match(msg ?? '', /5 minutes in the future/);
  });

  it('refuses older than the configured floor and names the knob', () => {
    assert.equal(occurredAtBoundViolation(iso(now - 30 * DAY), now, 30), null);
    const msg = occurredAtBoundViolation(iso(now - 30 * DAY - 1), now, 30);
    assert.match(msg ?? '', /30 days in the past/);
    assert.match(msg ?? '', /EVENT_OCCURRED_AT_MAX_AGE_DAYS/);
  });

  it('a wide floor admits the fixed-date fixtures the integration suites carry', () => {
    assert.equal(occurredAtBoundViolation('2026-07-13T00:00:00.000Z', now, 3650), null);
  });
});
