/**
 * Business-day arithmetic for the supplier responsiveness metric (Story 4.2, AC4).
 *
 * This module is the ONLY source of business-day arithmetic in the codebase - no second copy in
 * the seam, the routes, the read accessors, or the tests. The working week is the IST calendar
 * Monday through Saturday; holidays are removed via the configured calendar
 * (config.scorecard.responsivenessHolidayCalendar). test/unit/business-days.test.ts is the
 * correctness oracle.
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
