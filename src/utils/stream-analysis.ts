import type {
  ActivityStream,
  HrZones,
  HrZoneDistribution,
  SplitType,
  PhaseSegment,
  HrTrend,
  DetectedInterval,
  StreamAnalysisResult,
} from "../types/index.js";

export const STREAM_ANALYSIS_VERSION = 3;

/** Lap boundary hint for phase detection. */
export interface LapHint {
  start_index: number;
  end_index: number;
  distance: number;
}

/**
 * Detect whether laps are manual (athlete-pressed) or auto-generated (e.g., 1km auto-lap).
 * Returns lap boundary indices only if laps appear manual.
 *
 * Heuristic: exclude first and last laps (often partial), then check if the
 * remaining laps have low distance variance (CV < 15% and clustered near a
 * round number like 1km/0.5km). If so → auto-lap → return null.
 */
/**
 * Check if laps are auto-generated (e.g. 1km or 1mi auto-lap).
 *
 * Excludes first and last laps (often partial), then checks if inner laps
 * have low distance variance (CV < 15%) near a round distance.
 */
export function isAutoLap(laps: { distance: number }[]): boolean {
  if (laps.length < 3) return true;
  const inner = laps.slice(1, -1);
  if (inner.length < 2) return true;
  const dists = inner.map(l => l.distance);
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  if (mean === 0) return true;
  const variance = dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length;
  const cv = Math.sqrt(variance) / mean;
  const nearRound = [500, 1000, 1609].some(r => Math.abs(mean - r) < r * 0.1);
  return cv < 0.15 && nearRound;
}

/**
 * Detect whether laps are manual (athlete-pressed) or auto-generated.
 * Returns lap boundary indices only if laps appear manual.
 */
export function detectManualLaps(laps: LapHint[]): number[] | null {
  if (isAutoLap(laps)) return null;
  return laps.slice(1).map(l => l.start_index);
}

/**
 * Compute all stream-derived metrics for a running activity.
 *
 * Pure function: arrays in, structured metrics out. No DB, no async.
 *
 * Pipeline: deriveSpeed → smooth (30s pace, 10s HR) → Tier 1 (HR zones,
 * cardiac drift, pace CV, split type, TRIMP) → Tier 2 (NGP, fatigue index,
 * cadence drift, EF) → Tier 3 (phase detection, interval detection).
 *
 * @param streams - Per-second Strava streams. `time` and `distance` required;
 *   `heartrate`, `grade_smooth`, `cadence` optional (metrics that need them return null).
 * @param hrZones - Athlete's HR zone boundaries (LT1/LT2/max). Null disables
 *   HR zone distribution and TRIMP.
 * @param movingTimeS - Activity moving time in seconds. Used as a minimum
 *   threshold for cardiac drift (< 600s → null).
 * @param easyPaceRef - Athlete's easy pace in sec/km. Drives phase detection
 *   thresholds: work = faster than easyPace * 1.05, recovery = slower than * 0.95.
 * @returns Complete analysis result. Fields are null when input data is insufficient.
 */
export function computeStreamAnalysis(
  streams: ActivityStream,
  hrZones: HrZones | null,
  movingTimeS: number,
  easyPaceRef: number,
  lapHints?: LapHint[] | null
): StreamAnalysisResult {
  const { time, distance } = streams;
  const hr = streams.heartrate ?? null;
  const grade = streams.grade_smooth ?? null;
  const altitude = streams.altitude ?? null;
  const cadence = streams.cadence ?? null;

  // Derive per-second speed (m/s) from distance/time differentials
  const speed = deriveSpeed(time, distance);

  // Smooth streams
  const smoothedSpeed = rollingAvgTime(speed, time, 30);
  const smoothedHr = hr ? rollingAvgTime(hr, time, 10) : null;

  // GAP-adjusted speed: when grade data exists, use Minetti-adjusted speed
  // for effort-dependent metrics. On flat terrain, falls back to raw speed.
  const smoothedEffortSpeed = grade ? computeSmoothedGapSpeed(speed, grade, time) : smoothedSpeed;

  // Tier 1
  const hrZoneDist = smoothedHr && hrZones
    ? computeHrZones(smoothedHr, time, hrZones) : null;
  const cardiacDrift = smoothedHr && smoothedEffortSpeed
    ? computeCardiacDrift(smoothedEffortSpeed, smoothedHr, time, distance, movingTimeS) : null;
  const paceCV = computePaceVariabilityCV(smoothedEffortSpeed, time);
  const splitType = computeSplitType(smoothedEffortSpeed, time, distance);
  const trimp = hr && hrZones
    ? computeTRIMP(hr, time, hrZones) : null;

  // Tier 2
  const ngp = grade ? computeNGP(speed, grade, time) : null;
  const fatigueIndex = computeFatigueIndex(smoothedEffortSpeed, time, distance);
  const cadenceDrift = cadence ? computeCadenceDrift(cadence, time) : null;
  const avgHr = smoothedHr ? arrayMean(smoothedHr.filter((_, i) => speed[i] > 0.5)) : null;
  const ef = ngp && avgHr && avgHr > 0
    ? round((1000 / ngp) / avgHr, 4) : null; // NGP speed (m/s) / avg HR

  // Tier 3
  const manualLapBoundaries = lapHints ? detectManualLaps(lapHints) : null;
  const phases = detectPhases(smoothedEffortSpeed, smoothedSpeed, smoothedHr, time, distance, altitude, easyPaceRef, manualLapBoundaries);
  const intervals = detectIntervals(phases);

  return {
    hr_zones: hrZoneDist,
    cardiac_drift_pct: cardiacDrift,
    pace_variability_cv: paceCV,
    split_type: splitType,
    trimp: trimp,
    ngp_sec_per_km: ngp,
    fatigue_index_pct: fatigueIndex,
    cadence_drift_spm: cadenceDrift,
    efficiency_factor: ef,
    phases,
    intervals,
    computed_at: new Date().toISOString(),
    stream_analysis_version: STREAM_ANALYSIS_VERSION,
  };
}

// --- Smoothing helpers ---

/**
 * Derive per-second instantaneous speed (m/s) from cumulative distance/time.
 * Uses finite differences: speed[i] = (dist[i] - dist[i-1]) / (time[i] - time[i-1]).
 * First element is always 0. Duplicate timestamps (dt=0) produce 0 speed.
 */
function deriveSpeed(time: number[], distance: number[]): number[] {
  const n = time.length;
  const speed = new Array<number>(n);
  speed[0] = 0;
  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    const dd = distance[i] - distance[i - 1];
    speed[i] = dt > 0 ? dd / dt : 0;
  }
  return speed;
}

/**
 * Time-based backward-looking rolling average. O(n) two-pointer approach.
 * Window is defined in seconds, not sample count.
 * Used for 30s pace smoothing and 10s HR smoothing.
 */
function rollingAvgTime(values: number[], time: number[], windowS: number): number[] {
  const n = values.length;
  const result = new Array<number>(n);
  let left = 0;
  let sum = 0;
  let count = 0;

  for (let right = 0; right < n; right++) {
    sum += values[right];
    count++;
    // Shrink window from left if too wide
    while (time[right] - time[left] > windowS) {
      sum -= values[left];
      count--;
      left++;
    }
    result[right] = count > 0 ? sum / count : 0;
  }
  return result;
}

/**
 * Distance-based rolling average for altitude smoothing. O(n) two-pointer.
 * Window defined in meters. Falls back to raw value when count is 0.
 * Preferred over time-based smoothing for altitude because GPS altitude noise
 * correlates with distance traveled, not elapsed time.
 */
export function distanceWindowSmooth(values: number[], dist: number[], windowM: number): number[] {
  const n = values.length;
  const result = new Array<number>(n);
  let left = 0;
  let sum = 0;
  let count = 0;

  for (let right = 0; right < n; right++) {
    sum += values[right];
    count++;
    while (dist[right] - dist[left] > windowM) {
      sum -= values[left];
      count--;
      left++;
    }
    result[right] = count > 0 ? sum / count : values[right];
  }
  return result;
}

/**
 * Compute GAP-adjusted speed and smooth it with 30s rolling average.
 * Applies Minetti cost factor per sample so uphill effort maps to higher speed
 * and downhill maps to lower speed. Used for effort-dependent metrics.
 */
function computeSmoothedGapSpeed(speed: number[], grade: number[], time: number[]): number[] {
  const n = speed.length;
  const gapSpeed = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    gapSpeed[i] = speed[i] * minettiGapFactor(grade[i] ?? 0);
  }
  return rollingAvgTime(gapSpeed, time, 30);
}

// --- Tier 1 ---

/**
 * Distribute time-in-zone across 5 Friel-style HR zones.
 * Zone boundaries: Z1 < LT1*0.88, Z2 < LT1, Z3 < LT2, Z4 < maxHR*0.97, Z5 >= maxHR*0.97.
 * Samples with HR <= 0 or time gaps > 30s are skipped.
 */
function computeHrZones(hr: number[], time: number[], zones: HrZones): HrZoneDistribution {
  const z1Max = zones.lt1 * 0.88;  // recovery ceiling
  const z2Max = zones.lt1;          // aerobic ceiling
  const z3Max = zones.lt2;          // tempo ceiling
  const z4Max = zones.max_hr * 0.97; // threshold ceiling

  const dist: HrZoneDistribution = {
    zone1_s: 0, zone2_s: 0, zone3_s: 0, zone4_s: 0, zone5_s: 0, total_hr_s: 0,
  };

  for (let i = 1; i < hr.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30) continue; // skip gaps/pauses
    const bpm = hr[i];
    if (bpm <= 0) continue;

    if (bpm < z1Max) dist.zone1_s += dt;
    else if (bpm < z2Max) dist.zone2_s += dt;
    else if (bpm < z3Max) dist.zone3_s += dt;
    else if (bpm < z4Max) dist.zone4_s += dt;
    else dist.zone5_s += dt;
    dist.total_hr_s += dt;
  }

  return dist;
}

/**
 * Cardiac drift (Pa:HR decoupling): percentage drop in efficiency factor
 * (EF = speed/HR) from first half to second half of run, split by distance.
 * Positive = HR rose relative to pace (normal drift).
 * Interpretation: < 5% well coupled, 5-10% normal, > 10% high drift.
 * Returns null for runs < 10 min or degenerate data.
 */
function computeCardiacDrift(
  speed: number[], hr: number[], time: number[], distance: number[], movingTimeS: number
): number | null {
  if (movingTimeS < 600) return null;

  const totalDist = distance[distance.length - 1] - distance[0];
  const halfDist = totalDist / 2;

  // Find the midpoint index by distance
  let midIdx = 0;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] - distance[0] >= halfDist) { midIdx = i; break; }
  }
  if (midIdx === 0) return null;

  // Compute EF = avg speed / avg HR for each half (only moving samples)
  const ef1 = computeHalfEF(speed, hr, time, 0, midIdx);
  const ef2 = computeHalfEF(speed, hr, time, midIdx, speed.length);
  if (ef1 === null || ef2 === null || ef1 === 0) return null;

  return round(((ef1 - ef2) / ef1) * 100, 1);
}

/** Time-weighted average EF (speed/HR) over a slice. Excludes stopped (< 0.5 m/s) and invalid HR samples. */
function computeHalfEF(
  speed: number[], hr: number[], time: number[], start: number, end: number
): number | null {
  let speedSum = 0, hrSum = 0, count = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || speed[i] < 0.5 || hr[i] <= 0) continue;
    speedSum += speed[i] * dt;
    hrSum += hr[i] * dt;
    count += dt;
  }
  if (count === 0 || hrSum === 0) return null;
  const avgSpeed = speedSum / count;
  const avgHr = hrSum / count;
  return avgSpeed / avgHr;
}

/**
 * Coefficient of variation of smoothed pace: stddev/mean * 100 (%).
 * Lower = more even pacing. Excludes stopped samples (< 0.5 m/s).
 * Returns null when fewer than 30 moving samples exist.
 */
function computePaceVariabilityCV(speed: number[], time: number[]): number | null {
  const movingSpeeds: number[] = [];
  for (let i = 1; i < speed.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || speed[i] < 0.5) continue;
    movingSpeeds.push(speed[i]);
  }
  if (movingSpeeds.length < 30) return null;

  const mean = arrayMean(movingSpeeds);
  if (mean === 0) return null;
  const variance = movingSpeeds.reduce((s, v) => s + (v - mean) ** 2, 0) / movingSpeeds.length;
  return round((Math.sqrt(variance) / mean) * 100, 1);
}

/**
 * Classify split as negative (faster second half), positive (slower), or even.
 * Uses a 2% speed ratio threshold. Returns null for runs < 1km.
 */
function computeSplitType(speed: number[], time: number[], distance: number[]): SplitType | null {
  const totalDist = distance[distance.length - 1] - distance[0];
  if (totalDist < 1000) return null; // too short

  const halfDist = totalDist / 2;
  let midIdx = 0;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] - distance[0] >= halfDist) { midIdx = i; break; }
  }
  if (midIdx === 0) return null;

  const avgSpeed1 = movingAvgSpeed(speed, time, 0, midIdx);
  const avgSpeed2 = movingAvgSpeed(speed, time, midIdx, speed.length);
  if (avgSpeed1 === null || avgSpeed2 === null || avgSpeed1 === 0) return null;

  const ratio = avgSpeed2 / avgSpeed1;
  if (ratio > 1.02) return "negative"; // second half faster
  if (ratio < 0.98) return "positive"; // second half slower
  return "even";
}

/** Time-weighted average speed over a slice, excluding stopped samples. */
function movingAvgSpeed(speed: number[], time: number[], start: number, end: number): number | null {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || speed[i] < 0.5) continue;
    sum += speed[i] * dt;
    count += dt;
  }
  return count > 0 ? sum / count : null;
}

/**
 * Banister TRIMPexp training load.
 * Formula: sum((dt/60) * HRr * 0.64 * e^(1.92 * HRr))
 * where HRr = (HR - HRrest) / (HRmax - HRrest), clamped to [0,1].
 * HRrest estimated as LT1 * 0.65. Gender constant 1.92 (male default).
 * Returns null when max_hr <= estimated resting HR.
 */
function computeTRIMP(hr: number[], time: number[], zones: HrZones): number | null {
  const hrRest = zones.lt1 * 0.65;
  const hrMax = zones.max_hr;
  if (hrMax <= hrRest) return null;

  let trimp = 0;
  for (let i = 1; i < hr.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || hr[i] <= 0) continue;
    const hrr = Math.max(0, Math.min(1, (hr[i] - hrRest) / (hrMax - hrRest)));
    trimp += (dt / 60) * hrr * 0.64 * Math.exp(1.92 * hrr);
  }

  return round(trimp, 1);
}

// --- Tier 2 ---

/**
 * Minetti 2002 polynomial: energy cost of running on grade (J/kg/m).
 * Cr(g) = 155.4g^5 - 30.4g^4 - 43.3g^3 + 46.3g^2 + 19.5g + 3.6
 * Grade is a fraction (-0.45 to 0.45), clamped at extremes.
 * Flat cost = 3.6 J/kg/m.
 */
function minettiCost(gradeFraction: number): number {
  const g = Math.max(-0.45, Math.min(0.45, gradeFraction));
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
}

const FLAT_COST = minettiCost(0); // 3.6 J/kg/m

/**
 * Grade-adjusted pace factor: ratio of energy cost at given grade vs flat.
 * Returns 1.0 on flat, > 1.0 uphill (harder), < 1.0 moderate downhill (easier).
 * @param gradePct - Grade as a percentage (e.g., 10 for 10% grade).
 */
export function minettiGapFactor(gradePct: number): number {
  return minettiCost(gradePct / 100) / FLAT_COST;
}

/**
 * Normalized Graded Pace (sec/km). Adapts Coggan's Normalized Power for running:
 * 1. Per-second GAP-adjusted speed via Minetti polynomial
 * 2. 30s rolling average
 * 3. Fourth-power mean → fourth root (penalizes variability)
 * 4. Convert m/s → sec/km
 * Returns null for activities < 60 data points.
 */
function computeNGP(speed: number[], grade: number[], time: number[]): number | null {
  const n = speed.length;
  if (n < 60) return null;

  // 1. Compute per-second GAP-adjusted speed
  const gapSpeed = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const factor = minettiGapFactor(grade[i] ?? 0);
    gapSpeed[i] = speed[i] * factor;
  }

  // 2. Apply 30-second rolling average
  const smoothed = rollingAvgTime(gapSpeed, time, 30);

  // 3. Fourth power average, then fourth root (Coggan NP algorithm)
  let sum4 = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (smoothed[i] < 0.5) continue; // skip stopped
    sum4 += smoothed[i] ** 4;
    count++;
  }
  if (count === 0) return null;

  const ngpSpeedMS = (sum4 / count) ** 0.25;
  if (ngpSpeedMS <= 0) return null;

  // Convert m/s to sec/km
  return round(1000 / ngpSpeedMS, 1);
}

/**
 * Fatigue index: percentage speed drop in last 25% vs first 75% of run distance.
 * Positive = slowed down, negative = sped up. Returns null for runs < 2km.
 */
function computeFatigueIndex(speed: number[], time: number[], distance: number[]): number | null {
  const totalDist = distance[distance.length - 1] - distance[0];
  if (totalDist < 2000) return null; // too short

  const q75Dist = distance[0] + totalDist * 0.75;
  let q75Idx = 0;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] >= q75Dist) { q75Idx = i; break; }
  }

  const avgFirst75 = movingAvgSpeed(speed, time, 0, q75Idx);
  const avgLast25 = movingAvgSpeed(speed, time, q75Idx, speed.length);
  if (avgFirst75 === null || avgLast25 === null || avgFirst75 === 0) return null;

  // Positive = slowed down (fatigued), negative = sped up
  return round(((avgFirst75 - avgLast25) / avgFirst75) * 100, 1);
}

/**
 * Cadence drift: difference in time-weighted average cadence between first
 * third and last third of run (spm). Positive = cadence rose, negative = fell.
 * Middle third is excluded. Returns null for runs < 10 min.
 */
function computeCadenceDrift(cadence: number[], time: number[]): number | null {
  const totalTime = time[time.length - 1] - time[0];
  if (totalTime < 600) return null; // need > 10 min

  const thirdTime = totalTime / 3;
  const t1End = time[0] + thirdTime;
  const t3Start = time[0] + 2 * thirdTime;

  let sum1 = 0, count1 = 0, sum3 = 0, count3 = 0;
  for (let i = 1; i < cadence.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || cadence[i] <= 0) continue;
    if (time[i] <= t1End) { sum1 += cadence[i] * dt; count1 += dt; }
    if (time[i] >= t3Start) { sum3 += cadence[i] * dt; count3 += dt; }
  }
  if (count1 === 0 || count3 === 0) return null;

  return round((sum3 / count3) - (sum1 / count1), 1);
}

// --- Tier 3: Phase Detection ---

const MIN_PHASE_DURATION_S = 60;     // phases shorter than this get merged
const STOPPED_SPEED_THRESHOLD = 0.3; // m/s — below this = stopped
const STOPPED_MIN_DURATION_S = 10;   // stopped phases below this are ignored

/**
 * Segment the activity into warmup/work/recovery/cooldown/stopped phases.
 *
 * Uses a hysteresis state machine on effort speed (GAP-adjusted when grade
 * data is available, raw speed otherwise):
 * - Stopped: raw speed < 0.3 m/s (always checked on raw, not GAP)
 * - Work: effort speed >= easySpeed * 1.05
 * - Easy/Recovery: effort speed < easySpeed * 0.95
 * - Hysteresis band: between thresholds, maintain current phase
 *
 * For hilly terrain, this correctly classifies uphill climbs as "work"
 * (high GAP speed = high effort) and downhill as "recovery" (low GAP speed).
 *
 * Output metrics (avg_pace) use raw speed so displayed paces are actual,
 * not grade-adjusted.
 *
 * @param effortSpeed - GAP-adjusted smoothed speed for classification
 * @param rawSpeed - Actual smoothed speed for output pace computation
 * @param altitude - Altitude stream for per-phase elevation gain/loss (optional)
 */
function detectPhases(
  effortSpeed: number[],
  rawSpeed: number[],
  hr: number[] | null,
  time: number[],
  distance: number[],
  altitude: number[] | null,
  easyPaceRef: number,
  lapBoundaries?: number[] | null
): PhaseSegment[] {
  const n = effortSpeed.length;
  if (n < 10) return [];

  // Smooth altitude for elevation computation (reduces GPS noise)
  const smoothedAlt = altitude ? distanceWindowSmooth(altitude, distance, 50) : null;

  // Convert easy pace ref (sec/km) to speed (m/s)
  // When grade data is present, effortSpeed is GAP-adjusted, so thresholds
  // operate on effort-equivalent speed
  const easySpeed = easyPaceRef > 0 ? 1000 / easyPaceRef : 2.5; // fallback ~6:40/km
  const workThreshold = easySpeed * 1.05;  // faster than easy = work
  const easyThreshold = easySpeed * 0.95;  // slower than work speed = easy/recovery

  type RawPhase = "stopped" | "work" | "easy";
  const rawPhases: { phase: RawPhase; startIdx: number; endIdx: number }[] = [];
  // Use raw speed for stopped detection (GAP can inflate stopped-but-on-steep-grade)
  let currentPhase: RawPhase = rawSpeed[0] < STOPPED_SPEED_THRESHOLD ? "stopped"
    : effortSpeed[0] >= workThreshold ? "work" : "easy";
  let phaseStart = 0;

  for (let i = 1; i < n; i++) {
    let newPhase: RawPhase;
    if (rawSpeed[i] < STOPPED_SPEED_THRESHOLD) {
      newPhase = "stopped";
    } else if (effortSpeed[i] >= workThreshold) {
      newPhase = "work";
    } else if (effortSpeed[i] < easyThreshold) {
      newPhase = "easy";
    } else {
      newPhase = currentPhase; // hysteresis: stay in current phase
    }

    if (newPhase !== currentPhase) {
      rawPhases.push({ phase: currentPhase, startIdx: phaseStart, endIdx: i - 1 });
      currentPhase = newPhase;
      phaseStart = i;
    }
  }
  rawPhases.push({ phase: currentPhase, startIdx: phaseStart, endIdx: n - 1 });

  // Split phases at manual lap boundaries where effort changes across the boundary.
  // This helps when the state machine's smoothing window straddles a transition
  // (e.g., athlete stops briefly at hilltop then descends — lap button captures the exact moment).
  const splitPhases = lapBoundaries && lapBoundaries.length > 0
    ? splitAtLapBoundaries(rawPhases, lapBoundaries, effortSpeed, easySpeed)
    : rawPhases;

  // Merge short phases into neighbors
  const merged = mergeShortPhases(splitPhases, time);

  // Convert to PhaseSegments and label warmup/cooldown
  const totalDist = distance[n - 1] - distance[0];
  const warmupMaxDist = totalDist * 0.15;
  const cooldownMinDist = totalDist * 0.85;

  const segments: PhaseSegment[] = [];
  for (let si = 0; si < merged.length; si++) {
    const p = merged[si];
    const startS = time[p.startIdx];
    const endS = time[p.endIdx];
    const distM = distance[p.endIdx] - distance[p.startIdx];
    const avgPace = computeSegmentPace(rawSpeed, time, p.startIdx, p.endIdx);
    const avgHr = hr ? computeSegmentAvgHr(hr, time, p.startIdx, p.endIdx) : null;
    const elev = smoothedAlt ? computeSegmentElevation(smoothedAlt, p.startIdx, p.endIdx) : null;

    let phase: PhaseSegment["phase"];
    if (p.phase === "stopped") {
      phase = "stopped";
    } else if (si === 0 && p.phase === "easy" && distM < warmupMaxDist && distM > 0) {
      phase = "warmup";
    } else if (si === merged.length - 1 && p.phase === "easy" && distance[p.startIdx] - distance[0] > cooldownMinDist) {
      phase = "cooldown";
    } else if (p.phase === "work") {
      phase = "work";
    } else {
      phase = "recovery";
    }

    // Compute HR trend for work phases with sufficient distance and HR data
    const hrTrend = (phase === "work" && distM >= 2000 && hr)
      ? computeSegmentHrTrend(hr, distance, time, p.startIdx, p.endIdx)
      : null;

    segments.push({
      phase, start_s: startS, end_s: endS, distance_m: round(distM, 0),
      avg_pace_sec_per_km: avgPace, avg_hr: avgHr,
      elevation_gain_m: elev ? round(elev.gain, 0) : null,
      elevation_loss_m: elev ? round(elev.loss, 0) : null,
      hr_trend: hrTrend,
    });
  }

  return segments;
}

/** Compute elevation gain and loss over a segment from smoothed altitude. */
function computeSegmentElevation(
  altitude: number[], startIdx: number, endIdx: number
): { gain: number; loss: number } {
  let gain = 0, loss = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const delta = altitude[i] - altitude[i - 1];
    if (delta > 0) gain += delta;
    else loss += -delta;
  }
  return { gain, loss };
}

/**
 * Split phases at manual lap boundaries where effort differs on each side.
 *
 * For each lap boundary that falls inside a non-stopped phase, compute average
 * effort speed on each side. If they fall into different effort categories
 * (work vs easy), split the phase at the boundary. This lets athlete-pressed
 * lap buttons refine phase edges that the smoothing window may blur.
 */
function splitAtLapBoundaries(
  phases: { phase: string; startIdx: number; endIdx: number }[],
  boundaries: number[],
  effortSpeed: number[],
  easySpeed: number
): { phase: string; startIdx: number; endIdx: number }[] {
  const workThreshold = easySpeed * 1.05;
  const result: typeof phases = [];

  for (const p of phases) {
    if (p.phase === "stopped") {
      result.push({ ...p });
      continue;
    }

    // Find lap boundaries within this phase (with margin to avoid tiny splits)
    const splits = boundaries.filter(b => b > p.startIdx + 5 && b < p.endIdx - 5);
    if (splits.length === 0) {
      result.push({ ...p });
      continue;
    }

    // Split at each boundary where effort changes category
    let segStart = p.startIdx;
    for (const splitIdx of splits) {
      const leftAvg = segmentMean(effortSpeed, segStart, splitIdx - 1);
      const rightAvg = segmentMean(effortSpeed, splitIdx, p.endIdx);
      const leftIsWork = leftAvg >= workThreshold;
      const rightIsWork = rightAvg >= workThreshold;

      if (leftIsWork !== rightIsWork) {
        // Effort changes across boundary — split here
        result.push({ phase: leftIsWork ? "work" : "easy", startIdx: segStart, endIdx: splitIdx - 1 });
        segStart = splitIdx;
      }
    }
    // Push remaining segment
    const finalAvg = segmentMean(effortSpeed, segStart, p.endIdx);
    result.push({ phase: finalAvg >= workThreshold ? "work" : "easy", startIdx: segStart, endIdx: p.endIdx });
  }

  return result;
}

/** Average of array slice [start, end] inclusive. */
function segmentMean(arr: number[], start: number, end: number): number {
  let sum = 0, count = 0;
  for (let i = start; i <= end; i++) { sum += arr[i]; count++; }
  return count > 0 ? sum / count : 0;
}

/**
 * Merge phases shorter than MIN_PHASE_DURATION_S into neighbors.
 * Backward merge pass: short non-stopped phases merge into previous.
 * Forward merge: if first phase is still short, merge into next.
 * Adjacent same-phase segments are collapsed after merging.
 */
function mergeShortPhases(
  phases: { phase: string; startIdx: number; endIdx: number }[],
  time: number[]
): { phase: string; startIdx: number; endIdx: number }[] {
  if (phases.length <= 1) return phases;

  // Merge short non-stopped phases into same-type neighbors only.
  // If no same-type neighbor exists, keep the phase — it's a distinct effort
  // (e.g., short work phase between stopped and recovery in hill repeats).
  let result = [...phases.map(p => ({ ...p }))];

  for (let pass = 0; pass < 3; pass++) {
    const next: typeof result = [];
    for (let i = 0; i < result.length; i++) {
      const p = result[i];
      const duration = time[p.endIdx] - time[p.startIdx];

      if (duration < MIN_PHASE_DURATION_S && p.phase !== "stopped") {
        const prev = next.length > 0 ? next[next.length - 1] : null;
        const nextP = i + 1 < result.length ? result[i + 1] : null;

        if (prev && prev.phase === p.phase) {
          prev.endIdx = p.endIdx;
        } else if (nextP && nextP.phase === p.phase) {
          nextP.startIdx = p.startIdx;
        } else {
          // No same-type neighbor — keep as distinct phase
          next.push(p);
        }
      } else {
        // Collapse adjacent same-phase
        const prev = next.length > 0 ? next[next.length - 1] : null;
        if (prev && prev.phase === p.phase) {
          prev.endIdx = p.endIdx;
        } else {
          next.push(p);
        }
      }
    }
    if (next.length === result.length) break;
    result = next;
  }

  return result;
}

/** Time-weighted average pace (sec/km) for a segment. Inclusive end index. */
function computeSegmentPace(speed: number[], time: number[], start: number, end: number): number | null {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i <= end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || speed[i] < 0.5) continue;
    sum += speed[i] * dt;
    count += dt;
  }
  if (count === 0 || sum === 0) return null;
  const avgSpeed = sum / count;
  return round(1000 / avgSpeed, 1);
}

/** Time-weighted average HR for a segment, rounded to whole bpm. Inclusive end index. */
function computeSegmentAvgHr(hr: number[], time: number[], start: number, end: number): number | null {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i <= end; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30 || hr[i] <= 0) continue;
    sum += hr[i] * dt;
    count += dt;
  }
  return count > 0 ? round(sum / count, 0) : null;
}

// --- HR Trend Analysis ---

/**
 * Linear regression slope for an array of values indexed by position.
 * Returns the slope in units-per-index (e.g., bpm per km if each value is a per-km average).
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

/** Standard deviation of an array. */
function stdDev(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
}

/**
 * Analyze HR trend within a segment by building per-km windowed averages
 * and classifying the shape as stable / step-then-plateau / linear drift / variable.
 *
 * This prevents the "endpoints-only fallacy" where comparing only first and last
 * values suggests continuous drift when the actual pattern is a quick initial rise
 * followed by stabilization.
 *
 * Requires >= 2km of data with HR. Returns null otherwise.
 */
export function computeSegmentHrTrend(
  hr: number[], distance: number[], time: number[], startIdx: number, endIdx: number
): HrTrend | null {
  const segDist = distance[endIdx] - distance[startIdx];
  if (segDist < 2000) return null;

  // Build per-km windowed HR averages
  const startDist = distance[startIdx];
  const numWindows = Math.floor(segDist / 1000);
  if (numWindows < 2) return null;

  const windowHrs: number[] = [];
  let winLeft = startIdx;

  for (let w = 0; w < numWindows; w++) {
    const targetDist = startDist + (w + 1) * 1000;
    let winRight = winLeft;
    while (winRight < endIdx && distance[winRight + 1] <= targetDist) winRight++;

    // Time-weighted avg HR for this window
    const avg = computeSegmentAvgHr(hr, time, winLeft, winRight);
    if (avg !== null) windowHrs.push(avg);
    winLeft = winRight + 1;
  }

  if (windowHrs.length < 2) return null;

  const n = windowHrs.length;

  // Overall linear regression slope (bpm per km)
  const driftPerKm = linearRegressionSlope(windowHrs);
  const overallStd = stdDev(windowHrs);

  // Find settle point: use last 70% as baseline, find first window within 3 bpm
  const baselineStart = Math.max(1, Math.ceil(n * 0.3));
  const baselineSlice = windowHrs.slice(baselineStart);
  const baseline = arrayMean(baselineSlice);

  // Find first km where HR is within 3 bpm of baseline (settled)
  let settleKm = 0;
  for (let k = 0; k < Math.min(n - 1, Math.ceil(n * 0.5)); k++) {
    if (Math.abs(windowHrs[k] - baseline) <= 3) break;
    settleKm = k + 1;
  }
  if (settleKm >= n - 1) settleKm = 0; // no clear settle found

  const initialHr = settleKm > 0
    ? round(arrayMean(windowHrs.slice(0, settleKm)), 0)
    : round(windowHrs[0], 0);
  const settledSlice = windowHrs.slice(settleKm);
  const settledHr = round(arrayMean(settledSlice), 0);
  const plateauMin = round(Math.min(...settledSlice), 0);
  const plateauMax = round(Math.max(...settledSlice), 0);

  // Post-settle drift to distinguish step_then_plateau from continuous drift
  const postSettleDrift = settledSlice.length >= 2
    ? linearRegressionSlope(settledSlice) : driftPerKm;

  // Classify pattern
  let pattern: HrTrend["pattern"];
  if (overallStd < 3 && Math.abs(driftPerKm) < 1) {
    pattern = "stable";
  } else if (settleKm > 0 && initialHr < settledHr - 3 && Math.abs(postSettleDrift) < 2) {
    pattern = "step_then_plateau";
  } else if (Math.abs(driftPerKm) >= 1.5) {
    pattern = "linear_drift";
  } else {
    pattern = "variable";
  }

  return {
    pattern,
    initial_hr: initialHr,
    settled_hr: settledHr,
    settle_km: settleKm,
    plateau_range: [plateauMin, plateauMax],
    drift_bpm_per_km: round(driftPerKm, 1),
  };
}

// --- Interval Detection ---

/**
 * Convert phase segments into structured interval reps.
 * Pairs each "work" phase with the immediately following "recovery" phase.
 * Requires at least 2 work phases to classify as an interval workout.
 * Filters spurious intervals: if one work phase holds >80% of total work
 * distance, it's a continuous run with a minor tail, not an interval workout.
 * Returns empty array for continuous runs.
 */
function detectIntervals(phases: PhaseSegment[]): DetectedInterval[] {
  // Find alternating work/recovery patterns
  const workPhases = phases.filter(p => p.phase === "work");
  if (workPhases.length < 2) return []; // need at least 2 work bouts for intervals

  // Filter: if one work phase dominates (>80% of total work distance), not intervals
  const totalWorkDist = workPhases.reduce((s, p) => s + p.distance_m, 0);
  if (totalWorkDist > 0) {
    const maxWorkDist = Math.max(...workPhases.map(p => p.distance_m));
    if (maxWorkDist / totalWorkDist > 0.8) return [];
  }

  const intervals: DetectedInterval[] = [];
  let repNum = 0;

  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p.phase !== "work") continue;

    repNum++;
    const nextRecovery = i + 1 < phases.length && phases[i + 1].phase === "recovery"
      ? phases[i + 1] : null;

    intervals.push({
      rep_number: repNum,
      work_start_s: p.start_s,
      work_end_s: p.end_s,
      work_distance_m: p.distance_m,
      work_avg_pace_sec_per_km: p.avg_pace_sec_per_km ?? 0,
      work_avg_hr: p.avg_hr,
      rest_start_s: nextRecovery?.start_s ?? null,
      rest_end_s: nextRecovery?.end_s ?? null,
      rest_distance_m: nextRecovery?.distance_m ?? null,
    });
  }

  return intervals;
}

// --- Utilities ---

function arrayMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
