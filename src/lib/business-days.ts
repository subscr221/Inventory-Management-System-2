/**
 * Business-day arithmetic for the supplier responsiveness metric (Story 4.2, AC4) and the
 * maintenance spare return clock (Story 7.4, FR-M-08).
 *
 * This module is the ONLY source of business-day arithmetic in the codebase - no second copy in
 * the seam, the routes, the read accessors, the jobs, or the tests. The working week is the IST
 * calendar Monday through Saturday; holidays are removed via the configured calendar
 * (config.scorecard.responsivenessHolidayCalendar for responsiveness,
 * config.maintenance.spareReturnHolidayCalendar for spare returns).
 * test/unit/business-days.test.ts is the correctness oracle.
 */

/** en-CA + Asia/Kolkata reliably formats an instant as the IST YYYY-MM-DD calendar date. */
const IST_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The IST calendar date (YYYY-MM-DD) of a UTC instant. */
export function toIstCalendarDate(utc: Date): string {
  return IST_DATE_FORMAT.format(utc);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day-of-week (0 = Sunday .. 6 = Saturday) of a YYYY-MM-DD calendar date. */
function calendarDayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The calendar date one day after a YYYY-MM-DD date, computed in UTC (no DST in play). */
function nextCalendarDate(date: string): string {
  const next = new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS);
  return next.toISOString().slice(0, 10);
}

/**
 * Count of IST business days elapsed from startUtc to endUtc: iterate the IST calendar days
 * strictly between the start date and the end date (both endpoints excluded), counting every
 * Monday-Saturday day not present in holidayDates. Strict-between is what makes the AC4 anchor
 * cases hold: issued Friday / confirmed Monday is 1 business day (the Saturday), and issued
 * Saturday / confirmed Monday (a Sunday-only gap) is 0. Same IST calendar day returns 0 (the
 * confirmed-on-issuance case); an endUtc before startUtc returns 0 (clock-skew safety net - AC4
 * requires a non-negative integer, never a negative).
 */
export function businessDaysBetween(
  startUtc: Date,
  endUtc: Date,
  holidayDates: readonly string[],
): number {
  const startDate = toIstCalendarDate(startUtc);
  const endDate = toIstCalendarDate(endUtc);
  if (endDate <= startDate) return 0;

  const holidays = new Set(holidayDates);
  let count = 0;
  for (let day = nextCalendarDate(startDate); day < endDate; day = nextCalendarDate(day)) {
    const dow = calendarDayOfWeek(day);
    if (dow === 0) continue; // Sunday
    if (holidays.has(day)) continue;
    count += 1;
  }
  return count;
}

/**
 * The IST calendar date `days` business days after `startDate` (Story 7.4, FR-M-08). The start
 * date itself is never counted: issuing on a Thursday with days = 3 lands on the following Monday
 * (Friday 1, Saturday 2, Sunday skipped, Monday 3). Sundays and every date in `holidayDates` are
 * skipped, matching businessDaysBetween's Monday-to-Saturday working week, so the two functions
 * cannot disagree about what a business day is.
 *
 * `startDate` is a YYYY-MM-DD IST calendar date - use toIstCalendarDate to derive one from an
 * instant, never a bare slice(0, 10) on an ISO string, which silently shifts the date for any
 * instant in the 18:30-24:00 UTC window. `days` must be a non-negative integer; 0 returns the
 * start date unchanged. The loop is bounded with a generous ceiling (a full year of buffer over
 * the ordinary at-most-one-skipped-day-in-seven cadence) so a densely-holidayed span - a
 * multi-week plant shutdown where every day is a calendar holiday - still advances instead of
 * being a latent 500, and the guard makes a caller error (a non-integer or absurd `days`, or a
 * degenerate holiday calendar) a thrown Error rather than an infinite loop.
 */
export function addBusinessDays(
  startDate: string,
  days: number,
  holidayDates: readonly string[],
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error(`addBusinessDays: startDate must be YYYY-MM-DD, received "${startDate}"`);
  }
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new Error(`addBusinessDays: days must be an integer in [0, 3650], received "${days}"`);
  }
  if (days === 0) return startDate;

  const holidays = new Set(holidayDates);
  let remaining = days;
  let cursor = startDate;
  const maxSteps = days * 7 + 7 + 366;
  for (let step = 0; step < maxSteps && remaining > 0; step += 1) {
    cursor = nextCalendarDate(cursor);
    if (calendarDayOfWeek(cursor) === 0) continue; // Sunday
    if (holidays.has(cursor)) continue;
    remaining -= 1;
  }
  if (remaining > 0) {
    throw new Error(
      `addBusinessDays: could not advance ${days} business days from ${startDate} within ${maxSteps} calendar days`,
    );
  }
  return cursor;
}
