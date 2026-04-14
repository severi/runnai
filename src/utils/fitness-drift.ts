import { getDb } from "./activities-db.js";
import { loadTrainingZones, formatPaceRange, formatPaceSec } from "./training-zones.js";
import type { FitnessDriftSignal, PaceRange, PhaseSegment, HrZones } from "../types/index.js";

/** A single phase-level easy-pace observation extracted from a run. */
export interface EasyPaceSample {
  date: string;            // YYYY-MM-DD
  activityId: number;
  paceSecPerKm: number;    // pace of the work phase
  avgHr: number;           // average HR of the work phase
  distanceM: number;
}

/**
 * Configuration knobs for the drift detector. Exported as constants so the
 * unit tests can reproduce the math, and so a future "loosen for taper /
 * tighten for build" tweak is one place.
 */
export const DRIFT_CONFIG = {
  /** Lookback window in days. */
  LOOKBACK_DAYS: 60,
  /** Minimum work phase distance to count as a sample. */
  MIN_PHASE_DISTANCE_M: 2000,
  /** Maximum cardiac drift % to count as a "clean" run. */
  MAX_CARDIAC_DRIFT_PCT: 8,
  /** HR window expressed as a fraction of LT1: [LT1*low, LT1*high]. */
  Z2_HR_LOW_FRAC: 0.88,
  Z2_HR_HIGH_FRAC: 1.0,
  /** Minimum delta vs stored zone midpoint to register as drift (sec/km). */
  MIN_DELTA_SEC_PER_KM: 10,
  /** Sample / window thresholds. Improvements confirm faster than declines. */
  IMPROVING_MIN_SAMPLES: 10,
  IMPROVING_MIN_DAYS: 14,
  DECLINING_MIN_SAMPLES: 20,
  DECLINING_MIN_DAYS: 21,
} as const;

interface DbRow {
  id: number;
  start_date_local: string;
  run_type: string | null;
  cardiac_drift_pct: number | null;
  phases: string | null;
}

function ymd(date: string): string {
  return date.slice(0, 10);
}

/**
 * Extract phase-level easy pace samples from raw DB rows.
 * Pure helper — exposed for unit testing.
 */
export function extractEasyPaceSamples(
  rows: DbRow[],
  hrZones: HrZones
): EasyPaceSample[] {
  const z2Low = hrZones.lt1 * DRIFT_CONFIG.Z2_HR_LOW_FRAC;
  const z2High = hrZones.lt1 * DRIFT_CONFIG.Z2_HR_HIGH_FRAC;

  const samples: EasyPaceSample[] = [];
  for (const row of rows) {
    if (row.cardiac_drift_pct != null && row.cardiac_drift_pct > DRIFT_CONFIG.MAX_CARDIAC_DRIFT_PCT) continue;
    if (row.run_type === "tempo" || row.run_type === "intervals" || row.run_type === "threshold" || row.run_type === "race" || row.run_type === "fartlek") continue;
    if (!row.phases) continue;

    let phases: PhaseSegment[];
    try {
      phases = JSON.parse(row.phases) as PhaseSegment[];
    } catch {
      continue;
    }

    for (const phase of phases) {
      if (phase.phase !== "work") continue;
      if (phase.distance_m < DRIFT_CONFIG.MIN_PHASE_DISTANCE_M) continue;
      if (phase.avg_hr == null || phase.avg_pace_sec_per_km == null) continue;
      if (phase.avg_hr < z2Low || phase.avg_hr > z2High) continue;

      samples.push({
        date: ymd(row.start_date_local),
        activityId: row.id,
        paceSecPerKm: phase.avg_pace_sec_per_km,
        avgHr: phase.avg_hr,
        distanceM: phase.distance_m,
      });
    }
  }
  return samples;
}

/** Median of a numeric array. Returns 0 for empty input. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Days between two YYYY-MM-DD strings (inclusive). */
function daysBetween(a: string, b: string): number {
  const ad = new Date(a + "T00:00:00").getTime();
  const bd = new Date(b + "T00:00:00").getTime();
  return Math.abs(Math.round((bd - ad) / (1000 * 60 * 60 * 24)));
}

/**
 * Pure analysis function: given samples and a stored easy range, compute the
 * drift signal. No DB or filesystem dependencies.
 */
export function analyzeDrift(
  samples: EasyPaceSample[],
  storedEasy: PaceRange | null
): FitnessDriftSignal {
  if (samples.length === 0) {
    return {
      observed_easy_pace_sec: 0,
      sample_count: 0,
      date_range: { start: "", end: "" },
      stored_easy_pace: storedEasy,
      delta_sec_per_km: null,
      direction: "stable",
      confidence: "low",
      should_prompt: false,
      summary: "No clean Z2 samples in lookback window.",
    };
  }

  const sortedByDate = [...samples].sort((a, b) => a.date.localeCompare(b.date));
  const dateStart = sortedByDate[0].date;
  const dateEnd = sortedByDate[sortedByDate.length - 1].date;
  const observedMedian = median(samples.map(s => s.paceSecPerKm));

  if (!storedEasy) {
    return {
      observed_easy_pace_sec: Math.round(observedMedian),
      sample_count: samples.length,
      date_range: { start: dateStart, end: dateEnd },
      stored_easy_pace: null,
      delta_sec_per_km: null,
      direction: "stable",
      confidence: samples.length >= DRIFT_CONFIG.IMPROVING_MIN_SAMPLES ? "high" : "low",
      should_prompt: samples.length >= DRIFT_CONFIG.IMPROVING_MIN_SAMPLES,
      summary: `Observed easy pace at Z2 HR: ${formatPaceSec(observedMedian)}/km (${samples.length} samples). No stored easy range yet — propose initial pace zones.`,
    };
  }

  const storedMid = (storedEasy.min_sec + storedEasy.max_sec) / 2;
  const delta = observedMedian - storedMid;
  const absDelta = Math.abs(delta);
  const windowDays = daysBetween(dateStart, dateEnd);

  let direction: FitnessDriftSignal["direction"];
  if (absDelta < DRIFT_CONFIG.MIN_DELTA_SEC_PER_KM) direction = "stable";
  else if (delta < 0) direction = "improving";
  else direction = "declining";

  let confidence: FitnessDriftSignal["confidence"];
  let shouldPrompt = false;

  if (direction === "stable") {
    // Same gating as "improving" so a single-day burst can't be reported as
    // high-confidence stable when get_fitness_drift is queried directly.
    confidence =
      samples.length >= DRIFT_CONFIG.IMPROVING_MIN_SAMPLES && windowDays >= DRIFT_CONFIG.IMPROVING_MIN_DAYS
        ? "high"
        : samples.length >= DRIFT_CONFIG.IMPROVING_MIN_SAMPLES / 2
          ? "medium"
          : "low";
    shouldPrompt = false;
  } else if (direction === "improving") {
    if (samples.length >= DRIFT_CONFIG.IMPROVING_MIN_SAMPLES && windowDays >= DRIFT_CONFIG.IMPROVING_MIN_DAYS) {
      confidence = "high";
      shouldPrompt = true;
    } else if (samples.length >= DRIFT_CONFIG.IMPROVING_MIN_SAMPLES / 2) {
      confidence = "medium";
    } else {
      confidence = "low";
    }
  } else {
    // declining — require longer window
    if (samples.length >= DRIFT_CONFIG.DECLINING_MIN_SAMPLES && windowDays >= DRIFT_CONFIG.DECLINING_MIN_DAYS) {
      confidence = "high";
      shouldPrompt = true;
    } else if (samples.length >= DRIFT_CONFIG.DECLINING_MIN_SAMPLES / 2) {
      confidence = "medium";
    } else {
      confidence = "low";
    }
  }

  const summary = buildSummary(direction, observedMedian, storedEasy, delta, samples.length, windowDays);

  return {
    observed_easy_pace_sec: Math.round(observedMedian),
    sample_count: samples.length,
    date_range: { start: dateStart, end: dateEnd },
    stored_easy_pace: storedEasy,
    delta_sec_per_km: Math.round(delta),
    direction,
    confidence,
    should_prompt: shouldPrompt,
    summary,
  };
}

function buildSummary(
  direction: FitnessDriftSignal["direction"],
  observedMedian: number,
  stored: PaceRange,
  delta: number,
  samples: number,
  windowDays: number
): string {
  const obs = formatPaceSec(observedMedian);
  const storedStr = formatPaceRange(stored);
  if (direction === "stable") {
    return `Easy pace at Z2 HR is stable around ${obs}/km, matching stored range ${storedStr} (${samples} samples / ${windowDays}d).`;
  }
  const sign = delta < 0 ? "faster" : "slower";
  const absDelta = Math.abs(Math.round(delta));
  if (direction === "improving") {
    return `Easy pace at Z2 HR has shifted ~${absDelta}s/km ${sign}: observed ${obs}/km vs stored ${storedStr} (${samples} samples / ${windowDays}d).`;
  }
  return `Easy pace at Z2 HR has slowed ~${absDelta}s/km: observed ${obs}/km vs stored ${storedStr} (${samples} samples / ${windowDays}d). Could be fatigue, illness, or detraining — verify before downgrading.`;
}

/**
 * Compute fitness drift from the database. Loads recent runs, extracts
 * Z2 work-phase samples, compares to stored easy pace zone, returns the signal.
 * Returns null if HR zones aren't confirmed (we can't define Z2).
 */
export async function computeFitnessDrift(today: Date = new Date()): Promise<FitnessDriftSignal | null> {
  const zones = await loadTrainingZones();
  if (!zones?.hr.confirmed) return null;

  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - DRIFT_CONFIG.LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = getDb().prepare(
    `SELECT a.id, a.start_date_local, a.run_type,
            asa.cardiac_drift_pct, asa.phases
     FROM activities a
     LEFT JOIN activity_stream_analysis asa ON asa.activity_id = a.id
     WHERE a.type = 'Run' AND (a.trainer = 0 OR a.trainer IS NULL)
       AND date(a.start_date_local) >= date(?)
       AND asa.phases IS NOT NULL
     ORDER BY a.start_date_local ASC`
  ).all(cutoffStr) as DbRow[];

  const samples = extractEasyPaceSamples(rows, { ...zones.hr });
  return analyzeDrift(samples, zones.pace?.easy ?? null);
}
