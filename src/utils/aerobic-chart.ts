import { getDb, parseTags, LOAD_TAGS } from "./activities-db.js";
import { getDataDir } from "./paths.js";
import { loadTrainingZones } from "./training-zones.js";
import { formatPaceRaw } from "./format.js";
import open from "open";
import * as path from "path";
import * as fs from "fs/promises";

// ---------------------------------------------------------------------------
// Aerobic trend: ONE cohort, ONE metric, ONE method.
//
// Every number the tool prints and every line the chart draws come from the
// same cohort selection and the same rolling-median series computed here in
// TypeScript. The Python side only draws. That is deliberate: the previous
// version computed "+38%" in the text (first month vs last month, first month
// = 3 runs) and "+24.7%" in the chart title (linear fit) from the same data,
// and the coach then quoted a third number. See the fitness-trend skill.
// ---------------------------------------------------------------------------

export interface AerobicRunRow {
  id: number;
  date: string; // YYYY-MM-DD
  avg_hr: number;
  avg_speed: number; // m/s
  pace_sec_per_km: number;
  distance_km: number;
  run_type: string;
  elev_per_km: number | null;
  trainer: number;
  /** Stream-analysis efficiency factor: NGP speed (m/s) per bpm. Null until backfilled. */
  stream_ef: number | null;
  cardiac_drift_pct: number | null;
  temp_c: number | null;
  weather_code: number | null;
  tags: string[];
}

export interface WeeklyVolumeRow {
  week_start: string; // Monday, YYYY-MM-DD
  km: number;
  runs: number;
}

export interface ChartAnnotation {
  date: string; // YYYY-MM-DD
  label: string;
}

export type ExclusionReason =
  | "hard_type" | "hr_out_of_band" | "treadmill" | "too_short" | "too_long" | "hilly" | "load_tag";

export interface CohortRun extends AerobicRunRow {
  /** Efficiency factor in m/min per bpm (NGP-based when the stream row exists, else raw speed). */
  ef: number;
  ef_source: "ngp" | "raw";
  /** Easy pace normalised to the band's reference HR, sec/km. */
  norm_pace_sec_per_km: number;
  /** Percent added to EF by the heat prior (0 when not applied or no weather). */
  heat_adj_pct: number;
  /** Flagged against the surrounding ±45-day median; drawn grey, excluded from every statistic. */
  outlier: boolean;
}

export interface CohortOptions {
  /** Confirmed LT1 (bpm). Band = [LT1*0.88, LT1], same as the fitness-drift detector. */
  lt1: number | null;
  /** Apply HEAT_PRIOR to runs above the threshold (needs a weather record). Default false. */
  heatAdjust?: boolean;
  maxElevPerKm?: number;
  minKm?: number;
  maxKm?: number;
}

export interface Cohort {
  runs: CohortRun[];
  hrBand: [number, number];
  refHr: number;
  excluded: Record<ExclusionReason, number>;
}

export interface RollingPoint {
  date: string;
  ef: number; // median EF of the trailing window
  q1: number;
  q3: number;
  n: number;
}

export interface TrendWindow {
  label: string;
  start: string;
  end: string;
  n: number;
  ef: number;
  pace_sec_per_km: number;
}

export interface MonthRow {
  month: string;
  n: number;
  ef: number; // median
  pace_sec_per_km: number; // at refHr
  avg_hr: number;
  avg_temp_c: number | null;
  subzero: number;
  outliers: number;
  raw_ef: number;
  km: number; // all running volume that month, not just cohort
}

export interface ChartResult {
  outputPath: string;
  runCount: number;
  summary: string;
}

const HARD_TYPES = new Set(["tempo", "intervals", "hill_repeat", "fartlek", "race", "threshold", "progression"]);

/**
 * Heat prior, from race data, not from this athlete: marathon fields slow by
 * roughly 0.1–0.3% per °C above an optimum near 10°C (Ely et al. 2007, WBGT
 * quartiles; El Helou et al. 2012, 1.8M finishers, quadratic; Davis 2025 refit
 * of Mantzios 2022, curve bottoming near 9°C). 0.2%/°C is the middle of that.
 * Easy running produces less heat than racing, so if anything this overstates
 * the correction. Cold has no usable coefficient (Sandsund 2012 found
 * performance flat down to about -4°C and worse at -14°C, n small, no snow),
 * so nothing is applied below the threshold — read winter against the
 * temperature and snow columns instead.
 */
export const HEAT_PRIOR = { threshold_c: 10, pct_per_c: 0.2 } as const;

/** Multiplicative EF correction for a run at `tempC`; 1 when no adjustment applies. */
export function heatAdjustFactor(tempC: number | null): number {
  if (tempC == null || tempC <= HEAT_PRIOR.threshold_c) return 1;
  return 1 + (HEAT_PRIOR.pct_per_c / 100) * (tempC - HEAT_PRIOR.threshold_c);
}
const ROLLING_DAYS = 90;
const OUTLIER_WINDOW_DAYS = 45;
const OUTLIER_LOW = 0.8;
const OUTLIER_HIGH = 1.25;
const MIN_WINDOW_N = 5;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Data queries
// ---------------------------------------------------------------------------

export function queryAerobicData(months: number): AerobicRunRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        a.id,
        date(a.start_date_local) as date,
        a.average_heartrate as avg_hr,
        a.average_speed as avg_speed,
        a.moving_time * 1000.0 / a.distance as pace_sec_per_km,
        a.distance / 1000.0 as distance_km,
        COALESCE(aa.run_type, a.run_type, 'unknown') as run_type,
        CASE WHEN a.total_elevation_gain IS NULL THEN NULL
             ELSE a.total_elevation_gain / (a.distance / 1000.0) END as elev_per_km,
        COALESCE(a.trainer, 0) as trainer,
        s.efficiency_factor as stream_ef,
        s.cardiac_drift_pct as cardiac_drift_pct,
        w.temp_c as temp_c,
        w.weather_code as weather_code,
        a.tags as tags_json
      FROM activities a
      LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
      LEFT JOIN activity_stream_analysis s ON s.activity_id = a.id
      LEFT JOIN activity_weather w ON w.activity_id = a.id
      WHERE a.type = 'Run'
        AND a.average_heartrate IS NOT NULL
        AND a.distance > 0
        AND date(a.start_date_local) >= date('now', '-' || ? || ' months')
      ORDER BY a.start_date_local ASC`
    )
    .all(months) as (Omit<AerobicRunRow, "tags"> & { tags_json: string | null })[];

  return rows.map(({ tags_json, ...r }) => ({ ...r, tags: parseTags(tags_json) }));
}

export function queryWeeklyVolume(months: number): WeeklyVolumeRow[] {
  return getDb()
    .prepare(
      `SELECT date(a.start_date_local, '-6 days', 'weekday 1') as week_start,
              round(sum(a.distance) / 1000.0, 1) as km,
              count(*) as runs
       FROM activities a
       WHERE a.type = 'Run'
         AND date(a.start_date_local) >= date('now', '-' || ? || ' months')
       GROUP BY week_start ORDER BY week_start`
    )
    .all(months) as WeeklyVolumeRow[];
}

export function queryMonthlyVolume(months: number): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT substr(a.start_date_local, 1, 7) as month, round(sum(a.distance) / 1000.0, 0) as km
       FROM activities a
       WHERE a.type = 'Run'
         AND date(a.start_date_local) >= date('now', '-' || ? || ' months')
       GROUP BY month`
    )
    .all(months) as { month: string; km: number }[];
  return Object.fromEntries(rows.map(r => [r.month, r.km]));
}

/** Races the DB already knows about: Strava workout_type 1 or a race classification. */
export function queryRaceAnnotations(months: number): ChartAnnotation[] {
  return (getDb()
    .prepare(
      `SELECT date(a.start_date_local) as date, a.name as label
       FROM activities a
       LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
       WHERE a.type = 'Run'
         AND (a.workout_type = 1 OR COALESCE(aa.run_type, a.run_type) = 'race')
         AND date(a.start_date_local) >= date('now', '-' || ? || ' months')
       ORDER BY a.start_date_local`
    )
    .all(months) as ChartAnnotation[]);
}

// ---------------------------------------------------------------------------
// Pure math (unit-tested)
// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function dayNum(date: string): number {
  return Date.parse(date + "T00:00:00Z") / DAY_MS;
}

function addDays(date: string, days: number): string {
  return new Date((dayNum(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** EF (m/min per bpm) at a heart rate → pace in sec/km. */
export function efToPace(ef: number, hr: number): number {
  return 60000 / (ef * hr);
}

export function selectAerobicCohort(rows: AerobicRunRow[], opts: CohortOptions): Cohort {
  const hrBand: [number, number] = opts.lt1
    ? [Math.round(opts.lt1 * 0.88), opts.lt1]
    : [135, 155];
  const refHr = Math.round((hrBand[0] + hrBand[1]) / 2);
  const maxElev = opts.maxElevPerKm ?? 15;
  const minKm = opts.minKm ?? 5;
  const maxKm = opts.maxKm ?? 35;
  const loadTags = new Set<string>(LOAD_TAGS);

  const excluded: Record<ExclusionReason, number> = {
    hard_type: 0, hr_out_of_band: 0, treadmill: 0, too_short: 0, too_long: 0, hilly: 0, load_tag: 0,
  };

  const kept: CohortRun[] = [];
  for (const r of rows) {
    if (r.trainer) { excluded.treadmill++; continue; }
    if (HARD_TYPES.has(r.run_type)) { excluded.hard_type++; continue; }
    if (r.tags.some(t => loadTags.has(t))) { excluded.load_tag++; continue; }
    if (r.distance_km < minKm) { excluded.too_short++; continue; }
    if (r.distance_km > maxKm) { excluded.too_long++; continue; }
    if (r.elev_per_km != null && r.elev_per_km > maxElev) { excluded.hilly++; continue; }
    if (r.avg_hr < hrBand[0] || r.avg_hr > hrBand[1]) { excluded.hr_out_of_band++; continue; }

    const ef_source: CohortRun["ef_source"] = r.stream_ef != null && r.stream_ef > 0 ? "ngp" : "raw";
    const baseEf = ef_source === "ngp" ? r.stream_ef! * 60 : (r.avg_speed * 60) / r.avg_hr;
    const factor = opts.heatAdjust ? heatAdjustFactor(r.temp_c) : 1;
    const ef = baseEf * factor;
    kept.push({
      ...r,
      ef,
      ef_source,
      norm_pace_sec_per_km: efToPace(ef, refHr),
      heat_adj_pct: (factor - 1) * 100,
      outlier: false,
    });
  }

  // Outliers: a run far from the EF of its own ±45-day neighbourhood is a
  // run-walk, a GPS glitch, or a day the HR strap lied. Drop it from the
  // statistics rather than let one 16:00/km walk pull a month.
  for (const r of kept) {
    const d = dayNum(r.date);
    const neigh = kept.filter(o => o !== r && Math.abs(dayNum(o.date) - d) <= OUTLIER_WINDOW_DAYS);
    if (neigh.length < MIN_WINDOW_N) continue;
    const med = median(neigh.map(o => o.ef));
    if (r.ef < med * OUTLIER_LOW || r.ef > med * OUTLIER_HIGH) r.outlier = true;
  }

  return { runs: kept, hrBand, refHr, excluded };
}

/** Trailing-window median EF at each (non-outlier) run date. */
export function rollingMedianSeries(runs: CohortRun[], windowDays: number = ROLLING_DAYS): RollingPoint[] {
  const clean = runs.filter(r => !r.outlier).sort((a, b) => a.date.localeCompare(b.date));
  const out: RollingPoint[] = [];
  for (let i = 0; i < clean.length; i++) {
    const end = dayNum(clean[i].date);
    const window: number[] = [];
    for (let j = i; j >= 0 && end - dayNum(clean[j].date) < windowDays; j--) window.push(clean[j].ef);
    if (window.length < MIN_WINDOW_N) continue;
    out.push({
      date: clean[i].date,
      ef: median(window),
      q1: quantile(window, 0.25),
      q3: quantile(window, 0.75),
      n: window.length,
    });
  }
  return out;
}

export interface CentredPoint extends RollingPoint {
  /** The ±window/2 span runs past the first or last run, so this is a one-sided estimate. */
  provisional: boolean;
}

/**
 * Centred-window median for the chart line: each point summarises the runs
 * ±window/2 days around it, so the line peaks where the good running was
 * instead of half a window later. Points within window/2 of either data edge
 * are flagged provisional (the chart draws them dashed). The summary windows
 * stay trailing, because "now" has to end today.
 */
export function centredMedianSeries(runs: CohortRun[], windowDays: number = ROLLING_DAYS): CentredPoint[] {
  const clean = runs.filter(r => !r.outlier).sort((a, b) => a.date.localeCompare(b.date));
  if (clean.length === 0) return [];
  const half = windowDays / 2;
  const first = dayNum(clean[0].date);
  const last = dayNum(clean[clean.length - 1].date);
  const out: CentredPoint[] = [];
  for (const r of clean) {
    const d = dayNum(r.date);
    const window = clean.filter(o => Math.abs(dayNum(o.date) - d) <= half).map(o => o.ef);
    if (window.length < MIN_WINDOW_N) continue;
    out.push({
      date: r.date,
      ef: median(window),
      q1: quantile(window, 0.25),
      q3: quantile(window, 0.75),
      n: window.length,
      provisional: d - first < half || last - d < half,
    });
  }
  return out;
}

function windowStats(runs: CohortRun[], start: string, end: string, label: string, refHr: number): TrendWindow | null {
  const inWin = runs.filter(r => !r.outlier && r.date >= start && r.date <= end);
  if (inWin.length < MIN_WINDOW_N) return null;
  const ef = median(inWin.map(r => r.ef));
  return { label, start, end, n: inWin.length, ef, pace_sec_per_km: efToPace(ef, refHr) };
}

export interface TrendSummary {
  start: TrendWindow | null;
  now: TrendWindow | null;
  peak: TrendWindow | null;
  yearAgo: TrendWindow | null;
}

export function computeTrendWindows(runs: CohortRun[], rolling: RollingPoint[], refHr: number): TrendSummary {
  const clean = runs.filter(r => !r.outlier).sort((a, b) => a.date.localeCompare(b.date));
  if (clean.length === 0) return { start: null, now: null, peak: null, yearAgo: null };
  const first = clean[0].date;
  const last = clean[clean.length - 1].date;

  const start = windowStats(clean, first, addDays(first, ROLLING_DAYS - 1), `first ${ROLLING_DAYS} days`, refHr);
  const now = windowStats(clean, addDays(last, -(ROLLING_DAYS - 1)), last, `last ${ROLLING_DAYS} days`, refHr);

  let peak: TrendWindow | null = null;
  for (const p of rolling) {
    if (p.n < 8) continue;
    if (!peak || p.ef > peak.ef) {
      peak = {
        label: `peak ${ROLLING_DAYS}-day window`,
        start: addDays(p.date, -(ROLLING_DAYS - 1)),
        end: p.date,
        n: p.n,
        ef: p.ef,
        pace_sec_per_km: efToPace(p.ef, refHr),
      };
    }
  }

  const yearAgo = windowStats(clean, addDays(last, -365 - 45), addDays(last, -365 + 45), "same time last year (±45 days)", refHr);

  return { start, now, peak, yearAgo };
}

export function monthlyRows(runs: CohortRun[], refHr: number, monthlyKm: Record<string, number>): MonthRow[] {
  const byMonth = new Map<string, CohortRun[]>();
  for (const r of runs) {
    const m = r.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(r);
  }
  const months = [...new Set([...byMonth.keys(), ...Object.keys(monthlyKm)])].sort();
  const out: MonthRow[] = [];
  for (const m of months) {
    const all = byMonth.get(m) ?? [];
    const clean = all.filter(r => !r.outlier);
    const temps = clean.map(r => r.temp_c).filter((t): t is number => t != null);
    if (clean.length === 0) {
      out.push({ month: m, n: 0, ef: 0, pace_sec_per_km: 0, avg_hr: 0, avg_temp_c: null, subzero: 0, outliers: all.length, raw_ef: 0, km: monthlyKm[m] ?? 0 });
      continue;
    }
    const ef = median(clean.map(r => r.ef));
    out.push({
      month: m,
      n: clean.length,
      ef,
      pace_sec_per_km: efToPace(ef, refHr),
      avg_hr: mean(clean.map(r => r.avg_hr)),
      avg_temp_c: temps.length ? mean(temps) : null,
      subzero: temps.filter(t => t <= 0).length,
      outliers: all.length - clean.length,
      raw_ef: clean.filter(r => r.ef_source === "raw").length,
      km: monthlyKm[m] ?? 0,
    });
  }
  return out;
}

function pct(a: number, b: number): string {
  const v = ((a - b) / b) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function buildSummary(args: {
  cohort: Cohort;
  rolling: RollingPoint[];
  trend: TrendSummary;
  months: MonthRow[];
  annotations: ChartAnnotation[];
  horizonMonths: number;
  heatAdjusted?: boolean;
  /** Windows computed WITH the prior, shown as a one-line check when the prior is off. */
  heatAlternative?: TrendSummary | null;
}): string {
  const { cohort, trend, months, annotations, horizonMonths, heatAdjusted, heatAlternative } = args;
  const clean = cohort.runs.filter(r => !r.outlier);
  const lines: string[] = [];
  const priorText = `+${HEAT_PRIOR.pct_per_c}%/°C above ${HEAT_PRIOR.threshold_c}°C, a literature prior from marathon race data (Ely 2007, El Helou 2012, Davis 2025), not calibrated on this athlete`;

  lines.push(
    `Aerobic trend over ${horizonMonths} months — ${clean.length} comparable easy runs (${cohort.runs.length - clean.length} outliers set aside).`,
    `Cohort: outdoor runs, avg HR ${cohort.hrBand[0]}–${cohort.hrBand[1]} bpm, 5–35 km, ≤15 m/km climb, not tempo/intervals/race, no load tags (${LOAD_TAGS.join("/")}).`,
    `Metric: efficiency factor = grade-adjusted speed per heartbeat (m/min per bpm). Paces below are that EF converted to pace at HR ${cohort.refHr}.`,
    `Method: median EF over trailing ${ROLLING_DAYS}-day windows. Quote THESE windows, not single months and not first-vs-last.`,
    `Chart line: centred ${ROLLING_DAYS}-day median, so it peaks where the good running was; dashed where the window is cut at the data edge (first/last ${ROLLING_DAYS / 2} days, one-sided estimate).`,
    heatAdjusted
      ? `Heat prior APPLIED: EF raised by ${priorText}. ${clean.filter(r => r.heat_adj_pct > 0).length} runs adjusted, largest +${Math.max(0, ...clean.map(r => r.heat_adj_pct)).toFixed(1)}%. Say "heat-adjusted" whenever you quote these numbers.`
      : `Heat prior NOT applied (default). Cold has no usable correction in the literature; winter is read against the temperature column.`,
    ``,
    `Windows (n = runs in window):`
  );
  const w = (t: TrendWindow | null) => t
    ? `${t.label}: EF ${t.ef.toFixed(3)} → ${formatPaceRaw(t.pace_sec_per_km)}/km at HR ${cohort.refHr} (n=${t.n}, ${t.start} to ${t.end})`
    : null;
  for (const t of [trend.start, trend.yearAgo, trend.peak, trend.now]) {
    const s = w(t);
    if (s) lines.push(`  ${s}`);
  }
  if (trend.now) {
    const parts: string[] = [];
    if (trend.start && trend.start.end < trend.now.start) parts.push(`vs first window ${pct(trend.now.ef, trend.start.ef)}`);
    if (trend.yearAgo) parts.push(`vs a year ago ${pct(trend.now.ef, trend.yearAgo.ef)}`);
    if (trend.peak) parts.push(`vs peak window ${pct(trend.now.ef, trend.peak.ef)} (peak ended ${trend.peak.end})`);
    if (parts.length) lines.push(`  Now ${parts.join(", ")}.`);
  } else {
    lines.push(`  Not enough comparable runs in the last ${ROLLING_DAYS} days (need ${MIN_WINDOW_N}).`);
  }
  lines.push(`  Month-to-month noise in this metric is roughly ±2–3%; treat differences inside that as flat.`);
  if (!heatAdjusted && heatAlternative?.now && heatAlternative.peak) {
    const warm = clean.filter(r => r.temp_c != null && r.temp_c > HEAT_PRIOR.threshold_c).length;
    lines.push(
      `  Heat prior check (${priorText}): ${warm} cohort runs were above ${HEAT_PRIOR.threshold_c}°C. ` +
      `With it applied, now vs peak would be ${pct(heatAlternative.now.ef, heatAlternative.peak.ef)}` +
      `${trend.now && trend.peak ? ` instead of ${pct(trend.now.ef, trend.peak.ef)}` : ""}` +
      `${heatAlternative.yearAgo ? `, and now vs a year ago ${pct(heatAlternative.now.ef, heatAlternative.yearAgo.ef)}` : ""}. ` +
      `Re-run with heat_adjusted=true to see that series; it is an estimate, not a measurement.`
    );
  }

  lines.push(``, `Monthly (median EF, pace at HR ${cohort.refHr}; km = all running that month):`);
  lines.push(`  month     n   EF     pace  HR     temp  sub0    km  notes`);
  for (const m of months) {
    const notes: string[] = [];
    if (m.outliers) notes.push(`${m.outliers} outlier${m.outliers > 1 ? "s" : ""}`);
    if (m.raw_ef) notes.push(`${m.raw_ef} raw-EF (no stream analysis)`);
    if (m.n === 0) {
      lines.push(`  ${m.month}  ${String(m.n).padStart(2)}   —      —     —   ${"—".padStart(6)}    —  ${String(m.km).padStart(4)}  no comparable easy runs`);
      continue;
    }
    lines.push(
      `  ${m.month}  ${String(m.n).padStart(2)}   ${m.ef.toFixed(3)}  ${formatPaceRaw(m.pace_sec_per_km)}  ${m.avg_hr.toFixed(0)}  ` +
      `${(m.avg_temp_c == null ? "—" : m.avg_temp_c.toFixed(1) + "°").padStart(6)}  ${String(m.subzero).padStart(3)}  ${String(m.km).padStart(4)}  ${notes.join(", ")}`
    );
  }

  const ex = cohort.excluded;
  lines.push(
    ``,
    `Excluded: ${ex.hard_type} hard sessions, ${ex.hr_out_of_band} outside the HR band, ${ex.hilly} hilly, ${ex.too_short} short, ${ex.too_long} long, ${ex.treadmill} treadmill, ${ex.load_tag} load-tagged (stroller etc.).`
  );
  const rawCount = clean.filter(r => r.ef_source === "raw").length;
  if (rawCount) {
    lines.push(`Data quality: ${rawCount} run(s) have no stream analysis and use raw speed/HR — run \`bun scripts/backfill-stream-analysis.ts\` to make the whole series grade-adjusted.`);
  }
  const noTemp = clean.filter(r => r.temp_c == null).length;
  if (noTemp) lines.push(`Data quality: ${noTemp} run(s) have no weather record; the temperature colouring is grey for them.`);
  const subzeroTotal = months.reduce((s, m) => s + m.subzero, 0);
  if (subzeroTotal) {
    lines.push(`Confounder: ${subzeroTotal} cohort runs were at or below 0°C. Cold, snow and ice slow pace at the same HR — read winter months against the temperature column, not as fitness lost.`);
  }
  lines.push(
    annotations.length
      ? `Events marked on the chart: ${annotations.map(a => `${a.date} ${a.label}`).join("; ")}.`
      : `No events marked. Pass annotations (races, illness, lab tests, big blocks) from memory to put the dips in context.`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Python chart script (embedded) — draws only, computes nothing statistical
// ---------------------------------------------------------------------------

const PYTHON_CHART_SCRIPT = `
import sys, json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
from matplotlib.ticker import FuncFormatter
from datetime import datetime, timedelta

data = json.loads(sys.stdin.read())
output_path = sys.argv[1]
runs = data['runs']
centred = data['centred']
weekly = data['weekly']
annotations = data.get('annotations', [])
ref_hr = data['ref_hr']
band = data['hr_band']
horizon = data['months']
heat_adjusted = data.get('heat_adjusted', False)
heat_prior = data.get('heat_prior', {})

if not runs:
    print("ERROR:No comparable easy runs to chart", file=sys.stderr)
    sys.exit(1)

def d2n(s):
    return mdates.date2num(datetime.strptime(s, '%Y-%m-%d'))

def pace_fmt(x, pos):
    m = int(x // 60); s = int(x % 60)
    return f'{m}:{s:02d}'

BG = '#fafafa'
C_TREND = '#2c3e50'
C_BAND = '#2c3e50'
C_VOL = '#b8c4d0'
C_VOL_LINE = '#5d6d7e'
C_MONTH = '#c0392b'
C_OUT = '#95a5a6'
C_EVENT = '#8e44ad'

clean = [r for r in runs if not r['outlier']]
outl = [r for r in runs if r['outlier']]
cd = np.array([d2n(r['date']) for r in clean])
cef = np.array([r['ef'] for r in clean])
cpace = np.array([r['norm_pace_sec_per_km'] for r in clean])
ckm = np.array([r['distance_km'] for r in clean])
ctemp = np.array([r['temp_c'] if r['temp_c'] is not None else np.nan for r in clean])
od = np.array([d2n(r['date']) for r in outl]) if outl else np.array([])
oef = np.array([r['ef'] for r in outl]) if outl else np.array([])
opace = np.array([r['norm_pace_sec_per_km'] for r in outl]) if outl else np.array([])

rd = np.array([d2n(p['date']) for p in centred]) if centred else np.array([])
ref = np.array([p['ef'] for p in centred]) if centred else np.array([])
rq1 = np.array([p['q1'] for p in centred]) if centred else np.array([])
rq3 = np.array([p['q3'] for p in centred]) if centred else np.array([])
rprov = np.array([p['provisional'] for p in centred]) if centred else np.array([], dtype=bool)
rpace = 60000.0 / (ref * ref_hr) if len(ref) else np.array([])
rpace_q1 = 60000.0 / (rq3 * ref_hr) if len(ref) else np.array([])
rpace_q3 = 60000.0 / (rq1 * ref_hr) if len(ref) else np.array([])

def draw_trend(ax, xs, ys, prov, label, lw=3.0):
    """Solid where the centred window is complete, dashed where it is cut at a data edge.
    Segments overlap by one point so the line has no gaps."""
    if len(xs) == 0:
        return
    runs_ = []
    start = 0
    for i in range(1, len(xs) + 1):
        if i == len(xs) or prov[i] != prov[start]:
            runs_.append((start, i, prov[start]))
            start = i
    labelled = {True: False, False: False}
    for a, b, p in runs_:
        lo = max(0, a - 1); hi = min(len(xs), b + 1)
        lbl = (label + (', provisional at the edges' if p else '')) if not labelled[p] else None
        labelled[p] = True
        ax.plot(xs[lo:hi], ys[lo:hi], '--' if p else '-', color=C_TREND, lw=lw * (0.8 if p else 1.0),
                alpha=0.75 if p else 1.0, zorder=4, label=lbl)

x_min = min(cd.min(), d2n(weekly[0]['week_start']) if weekly else cd.min()) - 3
x_max = max(cd.max(), d2n(weekly[-1]['week_start']) + 7 if weekly else cd.max()) + 3

fig = plt.figure(figsize=(15, 16))
gs = fig.add_gridspec(3, 1, hspace=0.42, height_ratios=[1.0, 1.35, 1.0], top=0.94, bottom=0.05)
heat_note = f"  |  HEAT-ADJUSTED (+{heat_prior.get('pct_per_c')}%/°C above {heat_prior.get('threshold_c')}°C, literature prior)" if heat_adjusted else ''
fig.suptitle(
    f'Aerobic trend, last {horizon} months  |  easy outdoor runs at HR {band[0]}-{band[1]}, 5-35 km, flat, no stroller  |  {len(clean)} runs{heat_note}',
    fontsize=13, fontweight='bold', y=0.99)

def draw_events(ax, at_top=True):
    for a in annotations:
        x = d2n(a['date'])
        if x < x_min or x > x_max:
            continue
        ax.axvline(x, color=C_EVENT, ls=':', lw=1.2, alpha=0.6, zorder=1)
        y = 0.97 if at_top else 0.03
        ax.text(x, y, ' ' + a['label'], transform=ax.get_xaxis_transform(), rotation=90,
                va='top' if at_top else 'bottom', ha='right', fontsize=7.5, color=C_EVENT, alpha=0.85, zorder=6)

def month_axis(ax):
    ax.set_xlim(x_min, x_max)
    ax.xaxis.set_major_locator(mdates.MonthLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %y'))
    plt.setp(ax.get_xticklabels(), rotation=45, ha='right', fontsize=8.5)
    ax.grid(True, alpha=0.12)

# ---- Panel 1: weekly volume + rolling EF ----
ax1 = fig.add_subplot(gs[0])
ax1.set_facecolor(BG)
if weekly:
    wd = np.array([d2n(w['week_start']) for w in weekly])
    wkm = np.array([w['km'] for w in weekly])
    ax1.bar(wd, wkm, width=6, align='edge', color=C_VOL, edgecolor='white', linewidth=0.5, zorder=2, label='Weekly km')
    # 4-week trailing mean over the weeks actually present in the window
    # (weeks are consecutive Mondays; a week with no runs has no row and is
    # treated as 0 km, so divide by the number of calendar weeks covered).
    roll = []
    for i in range(len(weekly)):
        lo = wd[i] - 27
        m = (wd >= lo) & (wd <= wd[i])
        weeks_covered = min(4, int((wd[i] - wd[0]) // 7) + 1)
        roll.append(wkm[m].sum() / weeks_covered)
    ax1.plot(wd + 3.5, roll, '-', color=C_VOL_LINE, lw=2, zorder=3, label='4-week avg')
ax1.set_ylabel('Running volume (km/week)', fontsize=10)
ax1.set_ylim(0, None)
ax1b = ax1.twinx()
draw_trend(ax1b, rd, ref, rprov, 'EF, 90-day centred median', lw=2.8)
ax1b.set_ylabel('Efficiency factor (m/min per bpm)', fontsize=10, color=C_TREND)
ax1b.tick_params(axis='y', labelcolor=C_TREND)
h1, l1 = ax1.get_legend_handles_labels()
h2, l2 = ax1b.get_legend_handles_labels()
ax1.legend(h1 + h2, l1 + l2, loc='upper left', fontsize=8.5)
ax1.set_title('Volume vs aerobic efficiency  |  efficiency follows volume with a lag of a few weeks', fontsize=12, fontweight='bold')
month_axis(ax1)
draw_events(ax1, at_top=False)

# ---- Panel 2: EF scatter, temperature coloured, rolling median + IQR ----
ax2 = fig.add_subplot(gs[1])
ax2.set_facecolor(BG)
if len(rd):
    ax2.fill_between(rd, rq1, rq3, color=C_BAND, alpha=0.08, zorder=1, label='90-day interquartile range')
draw_trend(ax2, rd, ref, rprov, '90-day centred median')
has_t = ~np.isnan(ctemp)
sc = ax2.scatter(cd[has_t], cef[has_t], c=ctemp[has_t], cmap='coolwarm', vmin=-10, vmax=25,
                 s=ckm * 3.2, alpha=0.75, edgecolors='white', linewidth=0.4, zorder=3)
if (~has_t).any():
    ax2.scatter(cd[~has_t], cef[~has_t], color='#bdc3c7', s=ckm[~has_t] * 3.2, alpha=0.6,
                edgecolors='white', linewidth=0.4, zorder=3, label='no weather record')
if len(od):
    ax2.scatter(od, oef, marker='x', color=C_OUT, s=28, alpha=0.8, zorder=2, label='outlier (excluded)')
# monthly medians
months = sorted(set(r['date'][:7] for r in clean))
for m in months:
    mask = np.array([r['date'][:7] == m for r in clean])
    if mask.sum() >= 3:
        mx = np.mean(cd[mask]); my = np.median(cef[mask])
        ax2.plot(mx, my, 'D', color=C_MONTH, markersize=6, zorder=5, markeredgecolor='white', markeredgewidth=0.8)
        ax2.annotate(datetime.strptime(m, '%Y-%m').strftime('%b'), (mx, my), textcoords='offset points',
                     xytext=(0, 9), fontsize=7.5, fontweight='bold', color=C_MONTH, ha='center', zorder=6)
cb = plt.colorbar(sc, ax=ax2, pad=0.01, shrink=0.8)
cb.set_label('Temperature (°C)', fontsize=9)
lo = np.percentile(cef, 2) * 0.95; hi = np.percentile(cef, 98) * 1.05
ax2.set_ylim(lo, hi)
ax2.set_ylabel('Efficiency factor (m/min per bpm)' + (', heat-adjusted' if heat_adjusted else ''), fontsize=10)
ax2.set_title('Aerobic efficiency per run  |  colour = temperature, size = distance, diamond = monthly median (3+ runs)', fontsize=12, fontweight='bold')
ax2.legend(loc='lower right', fontsize=8.5)
month_axis(ax2)
draw_events(ax2)

# ---- Panel 3: easy pace normalised to the reference HR ----
ax3 = fig.add_subplot(gs[2])
ax3.set_facecolor(BG)
if len(rd):
    ax3.fill_between(rd, rpace_q1, rpace_q3, color=C_BAND, alpha=0.08, zorder=1)
draw_trend(ax3, rd, rpace, rprov, '90-day centred median')
ax3.scatter(cd, cpace, color='#5b9bd5', s=ckm * 2.6, alpha=0.55, edgecolors='white', linewidth=0.4, zorder=3, label='run')
if len(od):
    ax3.scatter(od, opace, marker='x', color=C_OUT, s=28, alpha=0.8, zorder=2, label='outlier (excluded)')
plo = np.percentile(cpace, 2) - 15; phi = np.percentile(cpace, 98) + 15
ax3.set_ylim(phi, plo)  # inverted: faster up
ax3.yaxis.set_major_formatter(FuncFormatter(pace_fmt))
ax3.set_ylabel(f'Easy pace at HR {ref_hr} (min/km)', fontsize=10)
ax3.set_title(f'Easy pace normalised to HR {ref_hr}  |  the same EF series, read as pace', fontsize=12, fontweight='bold')
ax3.legend(loc='lower right', fontsize=8.5)
month_axis(ax3)
draw_events(ax3)

fig.savefig(output_path, dpi=150, bbox_inches='tight')
print(f"OK:{output_path}")
`;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function generateAerobicChart(
  months: number = 8,
  annotations: ChartAnnotation[] = [],
  heatAdjusted: boolean = false
): Promise<ChartResult> {
  const rows = queryAerobicData(months);
  if (rows.length === 0) {
    return { outputPath: "", runCount: 0, summary: `No runs found in the last ${months} months. Sync activities first.` };
  }

  const zones = await loadTrainingZones();
  const lt1 = zones?.hr.confirmed ? zones.hr.lt1 : null;

  const cohort = selectAerobicCohort(rows, { lt1, heatAdjust: heatAdjusted });
  if (cohort.runs.filter(r => !r.outlier).length < MIN_WINDOW_N) {
    return {
      outputPath: "",
      runCount: 0,
      summary: `Only ${cohort.runs.length} comparable easy runs in the last ${months} months (need ${MIN_WINDOW_N}). Cohort: HR ${cohort.hrBand[0]}–${cohort.hrBand[1]}, 5–35 km, flat, outdoor, not hard sessions.`,
    };
  }

  const rolling = rollingMedianSeries(cohort.runs);
  const centred = centredMedianSeries(cohort.runs);
  const trend = computeTrendWindows(cohort.runs, rolling, cohort.refHr);
  // When the prior is off, compute the with-prior windows once so the summary
  // can say how much it would move the headline, without becoming a second headline.
  let heatAlternative: TrendSummary | null = null;
  if (!heatAdjusted) {
    const alt = selectAerobicCohort(rows, { lt1, heatAdjust: true });
    heatAlternative = computeTrendWindows(alt.runs, rollingMedianSeries(alt.runs), alt.refHr);
  }
  const monthly = monthlyRows(cohort.runs, cohort.refHr, queryMonthlyVolume(months));
  const weekly = queryWeeklyVolume(months);

  // Races the DB knows about, plus whatever the coach passed from memory.
  const seen = new Set<string>();
  const allAnnotations = [...queryRaceAnnotations(months), ...annotations]
    .filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a.date) && a.label)
    .filter(a => { const k = `${a.date}|${a.label}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));

  const chartsDir = path.join(getDataDir(), "charts");
  await fs.mkdir(chartsDir, { recursive: true });
  const outputPath = path.join(chartsDir, `aerobic-${new Date().toISOString().slice(0, 10)}.png`);

  const payload = {
    months,
    ref_hr: cohort.refHr,
    hr_band: cohort.hrBand,
    heat_adjusted: heatAdjusted,
    heat_prior: HEAT_PRIOR,
    runs: cohort.runs.map(r => ({
      date: r.date, ef: r.ef, norm_pace_sec_per_km: r.norm_pace_sec_per_km,
      distance_km: r.distance_km, temp_c: r.temp_c, outlier: r.outlier,
    })),
    centred,
    weekly,
    annotations: allAnnotations,
  };

  const proc = Bun.spawn(["python3", "-c", PYTHON_CHART_SCRIPT, outputPath], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errMsg = stderr.trim() || stdout.trim() || "Unknown error";
    if (errMsg.includes("No module named")) {
      throw new Error(`Python dependency missing. Install with: pip3 install matplotlib numpy\n\n${errMsg}`);
    }
    throw new Error(`Chart generation failed (exit ${exitCode}): ${errMsg}`);
  }

  try { await open(outputPath); } catch { /* chart still on disk */ }

  const summary = buildSummary({ cohort, rolling, trend, months: monthly, annotations: allAnnotations, horizonMonths: months, heatAdjusted, heatAlternative });
  return { outputPath, runCount: cohort.runs.length, summary };
}
