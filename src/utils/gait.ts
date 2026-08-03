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

import type { SplitType, MovementBreakdown, GaitSegment, GradeBand, GradeBandSeconds } from "../types/index.js";

export type Gait = "run" | "walk" | "pause";

/** Min duration (s) for a walk segment to be surfaced (filters GPS jitter). */
const MIN_WALK_SEGMENT_S = 20;
/** Min duration (s) for a pause to be surfaced. */
const MIN_PAUSE_SEGMENT_S = 10;
/**
 * Signed grade banding. A binary climb/flat cutoff hid gentle 1-3% climbs and
 * downhills inside "flat" (the RTTS "83 min walked on even ground" misread —
 * recut with signed bands it was 63 min flat, 118 min uphill, 0 downhill).
 */
export function gradeToBand(gradePct: number): GradeBand {
  if (gradePct < -1) return "descent";
  if (gradePct <= 1) return "flat";
  if (gradePct <= 3) return "gentle_up";
  if (gradePct <= 6) return "moderate_up";
  return "steep_up";
}

const emptyBands = (): GradeBandSeconds => ({
  descent: 0, flat: 0, gentle_up: 0, moderate_up: 0, steep_up: 0,
});

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

/**
 * Time-weighted average speed over [start,end) for samples matching `keep`.
 *
 * `speed` is always the raw stream — it gates which samples count as moving.
 * `values` is what gets averaged, and is the grade-adjusted effort speed for
 * every pacing metric here (see the note on the effortSpeed parameter of
 * computeMovementBreakdown). Splitting the two matters because a sample can be
 * genuinely stopped while its Minetti-scaled twin is still above the threshold.
 */
function avgSpeedWhere(
  speed: number[], time: number[], gait: Gait[], start: number, end: number,
  keep: (g: Gait) => boolean, values: number[] = speed,
): number | null {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || speed[i] < 0.5 || !keep(gait[i])) continue;
    sum += values[i] * dt;
    count += dt;
  }
  return count > 0 ? sum / count : null;
}

/** Time-weighted average HR over [start,end) for samples matching `keep`. Rounded. */
function avgHrWhere(
  hr: number[], time: number[], gait: Gait[], start: number, end: number,
  keep: (g: Gait) => boolean,
): number | null {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || hr[i] <= 0 || !keep(gait[i])) continue;
    sum += hr[i] * dt;
    count += dt;
  }
  return count > 0 ? Math.round(sum / count) : null;
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
 * @param hr       Per-sample HR (bpm) or null. Enables per-gait-state HR, so a
 *                 walking-deflated whole-run average is never the only HR view.
 * @param effortSpeed Per-sample grade-adjusted (Minetti) speed, or null to fall
 *                 back to raw speed. Every pacing metric derived here — the
 *                 run-only split, the run-only fatigue index, and the moving
 *                 split that feeds split_driver — is computed on this, so a
 *                 downhill start / uphill finish does not masquerade as a fade.
 *                 The whole-run split_type and fatigue_index_pct in
 *                 stream-analysis have always been grade-adjusted; these were
 *                 not, and the two disagreeing is what put a phantom "mild late
 *                 pace fade" into a real athlete-facing analysis (activity
 *                 19569913259: "even"/0.6% adjusted vs "positive"/5.3% raw, the
 *                 whole gap being a +22m closing climb). Gait classification
 *                 and all time accounting still use raw speed — a walk is a
 *                 walk regardless of grade.
 */
export function computeMovementBreakdown(
  speed: number[],
  time: number[],
  distance: number[],
  grade: number[] | null,
  cadence: number[] | null,
  hr: number[] | null = null,
  effortSpeed: number[] | null = null,
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

  // Run-only split + fatigue, on grade-adjusted effort speed.
  const effort = effortSpeed ?? speed;
  const midIdx = distanceFractionIdx(distance, 0.5);
  const isRun = (g: Gait) => g === "run";
  const r1 = avgSpeedWhere(speed, time, gait, 0, midIdx, isRun, effort);
  const r2 = avgSpeedWhere(speed, time, gait, midIdx, n, isRun, effort);
  const runOnlySplit = r1 != null && r2 != null ? ratioToSplit(r1, r2) : null;

  const q75Idx = distanceFractionIdx(distance, 0.75);
  const f1 = avgSpeedWhere(speed, time, gait, 0, q75Idx, isRun, effort);
  const f2 = avgSpeedWhere(speed, time, gait, q75Idx, n, isRun, effort);
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

  // Walk time per signed grade band, accumulated per-sample so a walk segment
  // spanning an up-then-down roller contributes to both bands instead of
  // averaging to "flat".
  let walkBands: GradeBandSeconds | null = null;
  let walkBandsByHalf: [GradeBandSeconds, GradeBandSeconds] | null = null;
  if (grade) {
    walkBands = emptyBands();
    walkBandsByHalf = [emptyBands(), emptyBands()];
    for (let i = 1; i < n; i++) {
      const dt = time[i] - time[i - 1];
      if (dt <= 0 || gait[i] !== "walk" || grade[i] == null) continue;
      const band = gradeToBand(grade[i]);
      walkBands[band] += dt;
      walkBandsByHalf[i < midIdx ? 0 : 1][band] += dt;
    }
    const roundBands = (b: GradeBandSeconds) => {
      for (const k of Object.keys(b) as GradeBand[]) b[k] = Math.round(b[k]);
    };
    roundBands(walkBands);
    walkBandsByHalf.forEach(roundBands);
  }

  // Per-gait-state HR.
  const runAvgHr = hr ? avgHrWhere(hr, time, gait, 0, n, isRun) : null;
  const walkAvgHr = hr ? avgHrWhere(hr, time, gait, 0, n, g => g === "walk") : null;
  const runHrByHalf: [number | null, number | null] = hr
    ? [avgHrWhere(hr, time, gait, 0, midIdx, isRun), avgHrWhere(hr, time, gait, midIdx, n, isRun)]
    : [null, null];

  // split_driver: what drove any back-half slowdown.
  //
  // A back-half slowdown in *moving* pace is attributed to walking unless the
  // run-only pace itself faded materially. The "material" bar is a >=5% run-only
  // slowdown — the same well-coupled/normal line the cardiac-drift metric uses.
  // A smaller run-only drift (e.g. ~3% / ~17s/km over an ultra) is ordinary
  // aerobic decoupling, not a running fade, so it stays "walking".
  const MATERIAL_RUN_FADE_PCT = 5;
  const m1 = avgSpeedWhere(speed, time, gait, 0, midIdx, g => g !== "pause", effort);
  const m2 = avgSpeedWhere(speed, time, gait, midIdx, n, g => g !== "pause", effort);
  const movingSplit = m1 != null && m2 != null ? ratioToSplit(m1, m2) : null;
  const walkGrew = walkShareByHalf[1] > walkShareByHalf[0];
  const runFaded = (runOnlyFatigue ?? 0) >= MATERIAL_RUN_FADE_PCT;
  let splitDriver: MovementBreakdown["split_driver"];
  if (movingSplit !== "positive" && !runFaded) {
    // Nothing slowed on either view — say so. This branch used to fall into
    // "running" via a `walkPct < 2` short-circuit, which made every walk-free
    // run report split_driver="running" whether or not anything faded. Since
    // SKILL.md names that value as the evidence required to claim a back-half
    // fade, the check validated fade claims by construction.
    splitDriver = "none";
  } else if (walkPct < 2) {
    splitDriver = "running"; // no walk-driven slowdown — the running itself slowed
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
          grade_band: avgGrade == null ? null : gradeToBand(avgGrade),
        });
      } else if (kind === "pause" && durS >= MIN_PAUSE_SEGMENT_S) {
        pauses.push({
          kind: "pause",
          start_km: Math.round((distance[segStart - 1] / 1000) * 10) / 10,
          duration_s: Math.round(durS),
          avg_grade_pct: null,
          grade_band: null,
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
    run_avg_hr: runAvgHr,
    walk_avg_hr: walkAvgHr,
    run_avg_hr_by_half: runHrByHalf,
    walk_grade_band_s: walkBands,
    walk_grade_band_s_by_half: walkBandsByHalf,
    walks,
    pauses,
  };
}
