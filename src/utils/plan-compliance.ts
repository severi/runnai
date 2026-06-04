import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";
import { parsePlan, findCurrentWeekNumber, type ParsedWorkout } from "./plan-parser.js";
import { getDb } from "./activities-db.js";
import { listPlanSlugs, getPlanFile } from "./plan-paths.js";
import { parseFrontmatter } from "./plan-frontmatter.js";
import { weekdayFromDateKey } from "./format.js";
import type { WeeklyComplianceResult, ComplianceEntry, ComplianceActivity } from "../types/index.js";

export interface ActivePlan {
  filePath: string;
  slug: string;
  content: string;        // body only — frontmatter stripped
  rawContent: string;     // full file including frontmatter
}

/**
 * Find the most recently modified plan directory in data/plans/.
 * Reads plan.md and strips frontmatter for `content`.
 */
export async function findActivePlan(): Promise<ActivePlan | null> {
  const slugs = await listPlanSlugs();
  if (slugs.length === 0) return null;

  let bestSlug = slugs[0];
  let bestMtime = 0;
  for (const slug of slugs) {
    const filePath = getPlanFile(slug);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue; // Plan dir without a plan.md — skip.
    }
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      bestSlug = slug;
    }
  }

  const filePath = getPlanFile(bestSlug);
  const rawContent = await fs.readFile(filePath, "utf-8");
  const { body } = parseFrontmatter(rawContent);
  return { filePath, slug: bestSlug, content: body, rawContent };
}

export interface ActivityRow {
  id: number;
  name: string;
  distance: number;
  moving_time: number;
  run_type: string | null;
  start_date_local: string;
}

function toComplianceActivity(row: ActivityRow): ComplianceActivity {
  const distanceKm = Math.round((row.distance / 1000) * 100) / 100;
  const paceSecPerKm = row.distance > 0 ? (row.moving_time / row.distance) * 1000 : 0;
  return {
    id: row.id,
    name: row.name,
    distance_km: distanceKm,
    pace_sec_per_km: Math.round(paceSecPerKm),
    run_type: row.run_type,
    start_date_local: row.start_date_local,
    weekday: weekdayFromDateKey(row.start_date_local),
  };
}

function pickBestActivityForWorkout(rows: ActivityRow[]): ActivityRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  // Multiple activities on the same day (e.g., a double): pick the longest by distance.
  return rows.reduce((best, r) => (r.distance > best.distance ? r : best));
}

function splitPrimaryAndExtras(rows: ActivityRow[]): { primary: ActivityRow | null; extras: ActivityRow[] } {
  const primary = pickBestActivityForWorkout(rows);
  if (!primary) return { primary: null, extras: [] };
  const extras = rows
    .filter(r => r.id !== primary.id)
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));
  return { primary, extras };
}

function todayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function plannedDateMs(workout: ParsedWorkout): number {
  // workout.date is "YYYY-MM-DDT00:00:00" — local midnight
  const [datePart] = workout.date.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Pure matching logic: join parsed workouts to activity rows by date, compute status.
 * Extracted for testability — no DB or filesystem dependencies.
 */
export function buildComplianceEntries(
  workouts: ParsedWorkout[],
  activities: ActivityRow[],
  today: Date = new Date()
): ComplianceEntry[] {
  // Group activities by date prefix for fast lookup
  const byDate = new Map<string, ActivityRow[]>();
  for (const row of activities) {
    const key = row.start_date_local.slice(0, 10);
    const list = byDate.get(key);
    if (list) list.push(row);
    else byDate.set(key, [row]);
  }

  const todayStartMs = todayMs(today);

  // First pass: build entries with status. completedRunIndex is assigned in a
  // second pass so it reflects true date order among completed runs.
  let completedSoFar = 0;
  return workouts.map(w => {
    const dateKey = w.date.slice(0, 10);
    const matches = byDate.get(dateKey) ?? [];
    const { primary, extras } = splitPrimaryAndExtras(matches);
    const actual = primary ? toComplianceActivity(primary) : null;
    const extrasOut = extras.map(toComplianceActivity);

    let status: ComplianceEntry["status"];
    if (actual) {
      status = "completed";
    } else if (plannedDateMs(w) >= todayStartMs) {
      status = "upcoming";
    } else {
      status = "missed";
    }

    const completedRunIndex = status === "completed" ? ++completedSoFar : null;

    // Both timestamps are local midnight; Math.round absorbs DST hour shifts.
    const daysFromToday = Math.round((plannedDateMs(w) - todayStartMs) / 86_400_000);

    return {
      planned: {
        date: dateKey,
        weekday: weekdayFromDateKey(dateKey),
        daysFromToday,
        sessionName: w.sessionName,
        details: w.details,
        weekNumber: w.weekNumber,
      },
      actual,
      extras: extrasOut,
      status,
      completedRunIndex,
    };
  });
}

/**
 * Compare a training plan week against actual logged activities.
 * Returns each planned (non-rest) workout joined to the matching activity by date.
 *
 * @param weekNumber Optional plan week number. Defaults to the current week.
 * @param today Reference date for "current week" detection and upcoming/missed status.
 * @param plan Optional pre-loaded plan to avoid re-reading the file.
 */
export async function getWeeklyPlanCompliance(
  weekNumber?: number,
  today: Date = new Date(),
  plan?: ActivePlan
): Promise<WeeklyComplianceResult | null> {
  const activePlan = plan ?? (await findActivePlan());
  if (!activePlan) return null;

  const week = weekNumber ?? findCurrentWeekNumber(activePlan.content, today);
  if (week === null || week === undefined) return null;

  const workouts = parsePlan(activePlan.content, activePlan.slug, [week]);
  const plannedKm = extractWeekTargetKm(activePlan.content, week);
  if (workouts.length === 0) {
    return {
      weekNumber: week,
      planSlug: activePlan.slug,
      entries: [],
      summary: { completed: 0, missed: 0, upcoming: 0, total: 0, completedKm: 0, plannedKm },
    };
  }

  // Date range for the SQL query
  const dates = workouts.map(w => w.date.slice(0, 10)).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, name, distance, moving_time, run_type, start_date_local
     FROM activities
     WHERE type = 'Run'
       AND (trainer = 0 OR trainer IS NULL)
       AND date(start_date_local) BETWEEN date(?) AND date(?)
     ORDER BY start_date_local ASC`
  ).all(minDate, maxDate) as ActivityRow[];

  const entries = buildComplianceEntries(workouts, rows, today);

  const completed = entries.filter(e => e.status === "completed").length;
  const missed = entries.filter(e => e.status === "missed").length;
  const upcoming = entries.filter(e => e.status === "upcoming").length;
  const completedKm = entries.reduce((sum, e) => {
    const primaryKm = e.actual?.distance_km ?? 0;
    const extrasKm = e.extras.reduce((s, x) => s + x.distance_km, 0);
    return sum + primaryKm + extrasKm;
  }, 0);

  return {
    weekNumber: week,
    planSlug: activePlan.slug,
    entries,
    summary: {
      completed,
      missed,
      upcoming,
      total: entries.length,
      completedKm: Math.round(completedKm * 10) / 10,
      plannedKm,
    },
  };
}

/**
 * Pull the **Target Volume:** km figure for a given week from the plan markdown.
 * Sums multiple km values on the line so race weeks like "14km + 100km" report 114.
 */
export function extractWeekTargetKm(planContent: string, weekNumber: number): number | null {
  const lines = planContent.split("\n");
  let inWeek = false;
  for (const line of lines) {
    const weekMatch = line.match(/^##\s+Week\s+(\d+)\b/i);
    if (weekMatch) {
      if (inWeek) return null;
      inWeek = parseInt(weekMatch[1], 10) === weekNumber;
      continue;
    }
    if (!inWeek) continue;
    const m = line.match(/\*\*Target Volume:\*\*\s*(.+)/i);
    if (!m) continue;
    const segment = m[1].split("|")[0];
    const nums = [...segment.matchAll(/(\d+(?:\.\d+)?)\s*km/gi)].map(x => parseFloat(x[1]));
    if (nums.length === 0) return null;
    return Math.round(nums.reduce((a, b) => a + b, 0));
  }
  return null;
}
