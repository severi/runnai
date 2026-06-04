import { weekdayFromDateKey } from "./format.js";

export interface DateDiffResult {
  today: string;            // Actual today, for reference
  from_date: string;        // "YYYY-MM-DD" — defaults to today
  from_weekday: string;     // Authoritative weekday of from_date
  target_date: string;
  target_weekday: string;   // Authoritative weekday of target_date
  days_difference: number;  // target - from (calendar days; negative = target is earlier)
  weeks_difference: number;
  is_past: boolean;
  is_future: boolean;
  is_same_day: boolean;
  human_readable: string;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" → local-midnight ms, or null if malformed/invalid. */
function localMidnightMs(dateKey: string): number | null {
  if (!DATE_KEY_RE.test(dateKey)) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  // Reject rollovers like 2026-13-40.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Calendar-day difference between two "YYYY-MM-DD" dates, parsed as local
 * calendar days. `fromDate` defaults to today — pass it to measure the gap
 * between any two events (run vs race, illness vs workout, ...).
 */
export function computeDateDiff(
  targetDate: string,
  fromDate?: string,
  today: Date = new Date()
): DateDiffResult | { error: string } {
  const todayKey = toDateKey(today);
  const fromKey = fromDate ?? todayKey;

  const fromMs = localMidnightMs(fromKey);
  if (fromMs === null) {
    return { error: `Invalid from_date: ${fromKey}. Use YYYY-MM-DD.` };
  }
  const targetMs = localMidnightMs(targetDate);
  if (targetMs === null) {
    return { error: `Invalid target_date: ${targetDate}. Use YYYY-MM-DD.` };
  }

  // Both timestamps are local midnight; Math.round absorbs DST hour shifts.
  const diffDays = Math.round((targetMs - fromMs) / 86_400_000);
  const diffWeeks = Math.round(diffDays / 7);
  const absDays = Math.abs(diffDays);
  const absWeeks = Math.abs(diffWeeks);

  const fromWeekday = weekdayFromDateKey(fromKey);
  const targetWeekday = weekdayFromDateKey(targetDate);

  let humanReadable: string;
  if (diffDays === 0) {
    humanReadable = fromDate === undefined ? "Today" : "Same day";
  } else if (fromDate === undefined) {
    humanReadable = diffDays < 0
      ? `${absDays} days ago (${absWeeks} weeks ago)`
      : `${diffDays} days from now (${diffWeeks} weeks away)`;
  } else {
    humanReadable = diffDays < 0
      ? `${absDays} days from ${targetWeekday} ${targetDate} to ${fromWeekday} ${fromKey} (target is earlier)`
      : `${diffDays} days from ${fromWeekday} ${fromKey} to ${targetWeekday} ${targetDate}`;
  }

  return {
    today: todayKey,
    from_date: fromKey,
    from_weekday: fromWeekday,
    target_date: targetDate,
    target_weekday: targetWeekday,
    days_difference: diffDays,
    weeks_difference: diffWeeks,
    is_past: diffDays < 0,
    is_future: diffDays > 0,
    is_same_day: diffDays === 0,
    human_readable: humanReadable,
  };
}
