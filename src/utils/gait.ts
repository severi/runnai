/**
 * Gait classification for run/walk/pause segmentation.
 *
 * The stream-analysis pipeline historically modelled a run as "moving vs
 * stopped", a road-running assumption. Trail/ultra runs are deliberately
 * run-walk (walk the climbs, hike aid stations), and folding walk samples into
 * pace corrupts split-type and fatigue metrics — a back-half slowdown reads as
 * a running fade when it's really more walking.
 *
 * Detection is cadence-primary: cadence separates walking (~120-130 spm) from
 * running (~160-185 spm) at ~92% accuracy (Chase 2023), far better than speed
 * (55-79% at the transition) because a tired slow-jog keeps running cadence
 * while a walk at the same speed does not. Speed+grade is a lower-confidence
 * fallback when cadence is absent.
 */

import type { SplitType, MovementBreakdown, GaitSegment } from "../types/index.js";

export type Gait = "run" | "walk" | "pause";

/** Min duration (s) for a walk segment to be surfaced (filters GPS jitter). */
const MIN_WALK_SEGMENT_S = 20;
/** Min duration (s) for a pause to be surfaced. */
const MIN_PAUSE_SEGMENT_S = 10;
/** Avg grade (%) at or above which a walk is terrain-driven (a climb). */
const CLIMB_GRADE_PCT = 3.0;

/**
 * Normalize a cadence stream to true steps/min.
 *
 * Strava stores cadence per-leg (~half true spm) for foot sports. We threshold
 * in true spm, so a per-leg stream must be doubled first. Auto-detected from
 * the distribution: human running cadence is ~150-185 true spm, so if the
 * busiest part of the stream sits well below that (75th percentile < 110), the
 * stream is per-leg and gets doubled. Already-full streams pass through.
 */
export function normalizeCadence(cadence: number[]): number[] {
  const nonzero = cadence.filter(c => c > 0).sort((a, b) => a - b);
  if (nonzero.length === 0) return cadence.slice();
  const p75 = nonzero[Math.floor(nonzero.length * 0.75)];
  const perLeg = p75 < 110;
  return cadence.map(c => (c > 0 && perLeg ? c * 2 : c));
}

/** Walk/run cadence boundary in true steps/min (Chase 2023: 135-140 spm). */
export const RUN_WALK_CADENCE_SPM = 140;
/** Time gap (s) between samples that indicates a paused/auto-paused watch. */
export const PAUSE_GAP_S = 15;
/** Speed (m/s) below which a sample is treated as not-running movement. */
export const WALK_SPEED_MS = 1.8; // ~9:15/km — fallback only, when cadence absent

/**
 * Classify each stream sample as run / walk / pause.
 *
 * - **pause**: the sample sits across a time gap >= PAUSE_GAP_S (watch paused).
 * - **walk** vs **run**: cadence < RUN_WALK_CADENCE_SPM → walk. Cadence is
 *   normalized to true spm first. When cadence is missing for a sample (0) or
 *   the whole stream is absent, fall back to a speed cutoff (lower confidence).
 *
 * @param speed   Per-sample speed (m/s), e.g. from deriveSpeed. speed[0] = 0.
 * @param time    Per-sample elapsed seconds.
 * @param cadence Raw cadence stream (per-leg or full) or null when unavailable.
 */
export function classifyGait(
  speed: number[],
  time: number[],
  cadence: number[] | null,
): Gait[] {
  const n = speed.length;
  const cad = cadence ? normalizeCadence(cadence) : null;
  const out = new Array<Gait>(n);
  out[0] = "pause";

  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    if (dt >= PAUSE_GAP_S) {
      out[i] = "pause";
      continue;
    }
    const c = cad ? cad[i] : 0;
    if (c > 0) {
      out[i] = c < RUN_WALK_CADENCE_SPM ? "walk" : "run";
    } else {
      // No cadence for this sample — speed fallback.
      out[i] = speed[i] < WALK_SPEED_MS ? "walk" : "run";
    }
  }

  return out;
}

/** Classify a first-half/second-half speed ratio as a split type (2% band). */
function ratioToSplit(avg1: number, avg2: number): SplitType | null {
  if (avg1 <= 0 || avg2 <= 0) return null;
  const ratio = avg2 / avg1;
  if (ratio > 1.02) return "negative";
  if (ratio < 0.98) return "positive";
  return "even";
}

/** Time-weighted average speed over [start,end) for samples matching `keep`. */
function avgSpeedWhere(
  speed: number[], time: number[], gait: Gait[], start: number, end: number,
  keep: (g: Gait) => boolean,
): number | null {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || speed[i] < 0.5 || !keep(gait[i])) continue;
    sum += speed[i] * dt;
    count += dt;
  }
  return count > 0 ? sum / count : null;
}

/** Index at which cumulative distance first reaches `fraction` of the total. */
function distanceFractionIdx(distance: number[], fraction: number): number {
  const total = distance[distance.length - 1] - distance[0];
  const target = distance[0] + total * fraction;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] >= target) return i;
  }
  return distance.length - 1;
}

/**
 * Decompose a run into running / walking / paused time and derive run-only
 * pacing metrics, so a back-half slowdown driven by walk breaks is not misread
 * as a running fade.
 *
 * @param speed    Per-sample speed (m/s).
 * @param time     Per-sample elapsed seconds.
 * @param distance Per-sample cumulative distance (m).
 * @param grade    Per-sample grade (%) or null.
 * @param cadence  Raw cadence stream (per-leg or full) or null.
 */
export function computeMovementBreakdown(
  speed: number[],
  time: number[],
  distance: number[],
  grade: number[] | null,
  cadence: number[] | null,
): MovementBreakdown {
  const gait = classifyGait(speed, time, cadence);
  const n = gait.length;

  // Time per class. Pause keeps its full gap duration; run/walk samples never
  // span a gap (those are classified pause), so capping is unnecessary there.
  let runS = 0, walkS = 0, pauseS = 0;
  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0) continue;
    if (gait[i] === "pause") pauseS += dt;
    else if (gait[i] === "walk") walkS += dt;
    else runS += dt;
  }
  const movingS = runS + walkS;
  const walkPct = movingS > 0 ? Math.round((walkS / movingS) * 100) : 0;

  // Run-only split + fatigue.
  const midIdx = distanceFractionIdx(distance, 0.5);
  const isRun = (g: Gait) => g === "run";
  const r1 = avgSpeedWhere(speed, time, gait, 0, midIdx, isRun);
  const r2 = avgSpeedWhere(speed, time, gait, midIdx, n, isRun);
  const runOnlySplit = r1 != null && r2 != null ? ratioToSplit(r1, r2) : null;

  const q75Idx = distanceFractionIdx(distance, 0.75);
  const f1 = avgSpeedWhere(speed, time, gait, 0, q75Idx, isRun);
  const f2 = avgSpeedWhere(speed, time, gait, q75Idx, n, isRun);
  const runOnlyFatigue = f1 != null && f2 != null && f1 > 0
    ? Math.round(((f1 - f2) / f1) * 1000) / 10 : null;

  // Walk share per half (walk time / moving time within each distance half).
  const walkShareHalf = (start: number, end: number): number => {
    let w = 0, mv = 0;
    for (let i = Math.max(1, start); i < end; i++) {
      const dt = time[i] - time[i - 1];
      if (dt <= 0 || gait[i] === "pause") continue;
      mv += dt;
      if (gait[i] === "walk") w += dt;
    }
    return mv > 0 ? Math.round((w / mv) * 100) : 0;
  };
  const walkShareByHalf: [number, number] = [walkShareHalf(0, midIdx), walkShareHalf(midIdx, n)];

  // split_driver: what drove any back-half slowdown.
  //
  // A back-half slowdown in *moving* pace is attributed to walking unless the
  // run-only pace itself faded materially. The "material" bar is a >=5% run-only
  // slowdown — the same well-coupled/normal line the cardiac-drift metric uses.
  // A smaller run-only drift (e.g. ~3% / ~17s/km over an ultra) is ordinary
  // aerobic decoupling, not a running fade, so it stays "walking".
  const MATERIAL_RUN_FADE_PCT = 5;
  const m1 = avgSpeedWhere(speed, time, gait, 0, midIdx, g => g !== "pause");
  const m2 = avgSpeedWhere(speed, time, gait, midIdx, n, g => g !== "pause");
  const movingSplit = m1 != null && m2 != null ? ratioToSplit(m1, m2) : null;
  const walkGrew = walkShareByHalf[1] > walkShareByHalf[0];
  const runFaded = (runOnlyFatigue ?? 0) >= MATERIAL_RUN_FADE_PCT;
  let splitDriver: MovementBreakdown["split_driver"];
  if (walkPct < 2 || movingSplit !== "positive") {
    splitDriver = "running"; // no walk-driven slowdown (running itself may have faded)
  } else if (runFaded) {
    splitDriver = walkGrew ? "mixed" : "running"; // running faded; walking too?
  } else {
    splitDriver = "walking"; // moving pace fell but run-only held — walk-driven
  }

  // Build contiguous segments and surface walks + pauses.
  const walks: GaitSegment[] = [];
  const pauses: GaitSegment[] = [];
  let segStart = 1;
  for (let i = 2; i <= n; i++) {
    if (i === n || gait[i] !== gait[segStart]) {
      const kind = gait[segStart];
      const endIdx = i - 1;
      const durS = time[endIdx] - time[segStart - 1];
      if (kind === "walk" && durS >= MIN_WALK_SEGMENT_S) {
        let gSum = 0, gc = 0;
        if (grade) {
          for (let j = segStart; j <= endIdx; j++) {
            if (grade[j] != null) { gSum += grade[j]; gc++; }
          }
        }
        const avgGrade = gc > 0 ? Math.round((gSum / gc) * 10) / 10 : null;
        walks.push({
          kind: "walk",
          start_km: Math.round((distance[segStart - 1] / 1000) * 10) / 10,
          duration_s: Math.round(durS),
          avg_grade_pct: avgGrade,
          terrain: avgGrade == null ? null : avgGrade >= CLIMB_GRADE_PCT ? "climb" : "flat",
        });
      } else if (kind === "pause" && durS >= MIN_PAUSE_SEGMENT_S) {
        pauses.push({
          kind: "pause",
          start_km: Math.round((distance[segStart - 1] / 1000) * 10) / 10,
          duration_s: Math.round(durS),
          avg_grade_pct: null,
          terrain: null,
        });
      }
      segStart = i;
    }
  }

  return {
    run_s: Math.round(runS),
    walk_s: Math.round(walkS),
    pause_s: Math.round(pauseS),
    walk_pct: walkPct,
    run_only_split_type: runOnlySplit,
    run_only_fatigue_index_pct: runOnlyFatigue,
    split_driver: splitDriver,
    walk_share_by_half: walkShareByHalf,
    walks,
    pauses,
  };
}
