// F17 — statutory deadline arithmetic. 06-phase3-compliance.md §6,
// 03-schema.sql §10 (compliance_deadline's own comment: "PT working-day
// arithmetic belongs in application code against a maintained holiday
// calendar, not in SQL — holiday lists change yearly").
//
// Pure function, no DB — deliberately, so it's unit-testable standalone
// against a known calendar year (a completion date chosen so the naive
// "add 10 calendar days" answer and the holiday-aware answer disagree is
// the whole point of the exit-criterion check in
// apps/api/test/phase3-proof.mjs, §8 step 4).

import Holidays from "date-holidays";

export interface AddWorkingDaysOptions {
  /** ISO country code, e.g. "PT". */
  country: string;
  /**
   * date-holidays subdivision code for a município, e.g. "PT-11" for Lisboa
   * (tenant.municipality, 03-schema.sql §2a). Omit for national-holidays-only
   * arithmetic.
   */
  subdivision?: string;
}

/**
 * Returns whether `date` is a working day: not a Saturday/Sunday, and not a
 * public holiday. Only `type: "public"` holidays count — `date-holidays`
 * also returns `observance`/`optional`/`school`/`bank` entries (e.g.
 * Carnaval is `observance` in Portugal, not a statutory public holiday) and
 * those don't stop the statutory clock.
 */
function isWorkingDay(date: Date, hd: Holidays): boolean {
  const dayOfWeek = date.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const found = hd.isHoliday(date);
  if (found && found.some((h) => h.type === "public")) return false;

  return true;
}

/**
 * Adds `days` working days to `fromDate`, skipping weekends and PT public
 * holidays (national, plus a município's local holidays when `subdivision`
 * is given). Calendar-day arithmetic is done entirely in UTC-midnight steps
 * — never "+24h in wall-clock ms" — so a DST transition in the local
 * timezone can never cause a day to be silently skipped or repeated.
 *
 * Returns the date landing on the `days`-th working day strictly after
 * `fromDate` (the day `fromDate` itself falls on is never counted, matching
 * "within 10 working days of completion").
 */
export function addWorkingDays(fromDate: Date, days: number, options: AddWorkingDaysOptions): Date {
  const hd = options.subdivision
    ? new Holidays(options.country, options.subdivision)
    : new Holidays(options.country);

  let cursor = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())
  );

  let remaining = days;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isWorkingDay(cursor, hd)) {
      remaining -= 1;
    }
  }

  return cursor;
}
