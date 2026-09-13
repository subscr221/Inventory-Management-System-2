import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { DB_SESSION_TIME_ZONE } from '../../src/config/db.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';

/**
 * The IST pin (deferred-work 215 and 616, applied 2026-09-13). Both pools open every session in
 * the business calendar's zone with ISO DateStyle, and a DATE column comes back as its YYYY-MM-DD
 * string. Pinned here so a driver upgrade, a pool refactor or a host with another clock cannot
 * silently move CURRENT_DATE away from toIstCalendarDate.
 */
describe('database session pin (IST calendar, ISO dates, DATE as string)', () => {
  after(async () => {
    await closePool();
    await closeAdminPool();
  });

  for (const [name, pool] of [
    ['app pool', getPool],
    ['admin pool', getAdminPool],
  ] as const) {
    it(`${name}: TimeZone is ${DB_SESSION_TIME_ZONE}, DateStyle is ISO, CURRENT_DATE is the IST calendar date`, async () => {
      const r = await pool().query(
        `SELECT current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds,
                CURRENT_DATE AS today, CURRENT_DATE::text AS today_text,
                '2026-01-01'::date AS fixed, now()::date AS now_date`,
      );
      const row = r.rows[0] as Record<string, unknown>;
      assert.equal(row['tz'], DB_SESSION_TIME_ZONE);
      assert.match(String(row['ds']), /^ISO/);
      // The DATE parser returns the string, never a Date the host would shift.
      assert.equal(typeof row['fixed'], 'string');
      assert.equal(row['fixed'], '2026-01-01');
      assert.equal(row['today'], row['today_text']);
      assert.equal(row['today'], toIstCalendarDate(new Date()));
      assert.equal(row['now_date'], toIstCalendarDate(new Date()));
    });
  }
});
