import type { ActivityLapRecord, HrZones, ClassificationResult, RunType, HillProfile } from "../types/index.js";
import { formatPace } from "./format.js";
import { isAutoLap } from "./stream-analysis.js";

interface ActivityData {
  id: number;
  distance: number;
  moving_time: number;
  average_speed: number;
  average_heartrate: number | null;
  workout_type: number | null;
}

export function detectHillProfile(
  laps: ActivityLapRecord[],
  totalDistanceM: number
): HillProfile | null {
  const lapsWithElev = laps.filter(
    l => l.elevation_gain !== null && l.elevation_loss !== null
  );
  if (lapsWithElev.length === 0) return null;

  const totalGain = lapsWithElev.reduce((s, l) => s + (l.elevation_gain ?? 0), 0);
  const totalLoss = lapsWithElev.reduce((s, l) => s + (l.elevation_loss ?? 0), 0);
  const gainPerKm = totalDistanceM > 0 ? (totalGain / totalDistanceM) * 1000 : 0;
  const maxSegmentGain = Math.max(...lapsWithElev.map(l => l.elevation_gain ?? 0));

  // Hill-repeat detection requires *manual* laps (one lap pressed per rep) AND concentrated
  // climbing. On auto-laps (every ~1km) the per-lap gain/loss alternation is just rolling-terrain
  // noise sampled per kilometre, not workout structure — otherwise a long run over rolling trails
  // reads as "hill repeats" (e.g. a 32.8km Z2 long run, +376m / 11.5 m/km, became "2x reps").
  // The gainPerKm gate excludes flat/rolling terrain that merely undulates; real hill sessions
  // concentrate vertical into short reps.
  let hillRepeatCount: number | null = null;
  if (!isAutoLap(laps) && lapsWithElev.length >= 4 && gainPerKm >= 20) {
    const climbLaps = lapsWithElev.filter(l => (l.elevation_gain ?? 0) > 25);
    const descendLaps = lapsWithElev.filter(l => (l.elevation_loss ?? 0) > 25);
    if (climbLaps.length >= 2 && descendLaps.length >= 2) {
      if (checkAlternatingElevation(lapsWithElev)) {
        hillRepeatCount = climbLaps.length;
      }
    }
  }

  if (hillRepeatCount !== null) {
    return { category: "hill_repeat", totalGainM: totalGain, totalLossM: totalLoss,
             gainPerKm, maxSegmentGainM: maxSegmentGain, hillRepeatCount };
  }
  if (gainPerKm >= 25) {
    return { category: "hilly", totalGainM: totalGain, totalLossM: totalLoss,
             gainPerKm, maxSegmentGainM: maxSegmentGain, hillRepeatCount: null };
  }
  if (gainPerKm >= 12) {
    return { category: "rolling", totalGainM: totalGain, totalLossM: totalLoss,
             gainPerKm, maxSegmentGainM: maxSegmentGain, hillRepeatCount: null };
  }
  return { category: "flat", totalGainM: totalGain, totalLossM: totalLoss,
           gainPerKm, maxSegmentGainM: maxSegmentGain, hillRepeatCount: null };
}

function checkAlternatingElevation(laps: ActivityLapRecord[]): boolean {
  // Check if laps alternate between primarily-climbing and primarily-descending
  let alternations = 0;
  for (let i = 1; i < laps.length; i++) {
    const prevClimb = (laps[i - 1].elevation_gain ?? 0) > (laps[i - 1].elevation_loss ?? 0);
    const currClimb = (laps[i].elevation_gain ?? 0) > (laps[i].elevation_loss ?? 0);
    if (prevClimb !== currClimb) alternations++;
  }
  return alternations >= Math.floor(laps.length * 0.6);
}

export function classifyRun(
  activity: ActivityData,
  laps: ActivityLapRecord[],
  hrZones: HrZones | null,
  easyPaceRef: number,
  hillProfile?: HillProfile | null
): ClassificationResult {
  // Race override from Strava workout_type
  if (activity.workout_type === 1) {
    return { run_type: "race", run_type_detail: null, confidence: "high" };
  }

  // Hill repeat override
  if (hillProfile?.category === "hill_repeat" && hillProfile.hillRepeatCount) {
    return {
      run_type: "hill_repeat",
      run_type_detail: `${hillProfile.hillRepeatCount}x reps, +${Math.round(hillProfile.totalGainM)}m`,
      confidence: "high",
    };
  }

  let result: ClassificationResult;

  if (laps.length === 0) {
    result = classifyByPaceAndHr(activity, hrZones, easyPaceRef);
  } else {
    const autoLap = isAutoLap(laps);
    if (autoLap) {
      result = classifyByPaceAndHr(activity, hrZones, easyPaceRef);
    } else {
      result = classifyStructuredLapRun(activity, laps, hrZones, easyPaceRef);
    }
  }

  // Annotate with terrain info for rolling/hilly runs
  if (hillProfile && hillProfile.category !== "flat" && hillProfile.category !== "hill_repeat") {
    const elevNote = `+${Math.round(hillProfile.gainPerKm)}m/km`;
    result.run_type_detail = result.run_type_detail
      ? `${result.run_type_detail}, ${elevNote}`
      : elevNote;
  }

  return result;
}

function classifyByPaceAndHr(
  activity: ActivityData,
  hrZones: HrZones | null,
  easyPaceRef: number
): ClassificationResult {
  const paceSecKm = activity.distance > 0
    ? (activity.moving_time / activity.distance) * 1000
    : easyPaceRef;

  const hr = activity.average_heartrate;
  const distKm = activity.distance / 1000;

  // Determine HR zone if available
  const hrZone = hr && hrZones ? getHrZone(hr, hrZones) : null;

  // Slow pace + low HR → recovery or easy. Distance overrides: a long run held
  // deliberately slow at Z2 has the same pace+HR signature as a recovery run, so
  // without this guard a 32km Z2 long run reads as "recovery". Recovery runs are short.
  if (paceSecKm > easyPaceRef * 1.05) {
    if (distKm >= 15) {
      return { run_type: "long_run", run_type_detail: null, confidence: "medium" };
    }
    if (hrZone && hrZone <= 2) {
      return { run_type: "recovery", run_type_detail: null, confidence: "medium" };
    }
    return { run_type: "easy", run_type_detail: null, confidence: "low" };
  }

  // Normal easy pace + low HR → easy or long_run
  if (paceSecKm >= easyPaceRef * 0.95) {
    if (distKm >= 15) {
      return { run_type: "long_run", run_type_detail: null, confidence: "medium" };
    }
    return { run_type: "easy", run_type_detail: null, confidence: "medium" };
  }

  // Faster pace
  if (hrZone && hrZone >= 4) {
    return { run_type: "threshold", run_type_detail: null, confidence: "medium" };
  }
  if (hrZone === 3) {
    return { run_type: "tempo", run_type_detail: null, confidence: "medium" };
  }

  // Fast pace without HR data - guess based on distance
  if (distKm >= 15) {
    return { run_type: "long_run", run_type_detail: null, confidence: "low" };
  }

  return { run_type: "unknown", run_type_detail: null, confidence: "low" };
}

function classifyStructuredLapRun(
  activity: ActivityData,
  laps: ActivityLapRecord[],
  hrZones: HrZones | null,
  easyPaceRef: number
): ClassificationResult {
  if (laps.length < 3) {
    return classifyByPaceAndHr(activity, hrZones, easyPaceRef);
  }

  const lapPaces = laps.map(l => l.distance > 0 ? (l.moving_time / l.distance) * 1000 : 0);

  // Check for progression (monotonically decreasing pace across main laps)
  if (isProgression(lapPaces)) {
    return { run_type: "progression", run_type_detail: null, confidence: "high" };
  }

  // Separate work/rest by the session's own pace modes. The old split
  // (median × 0.92) put the boundary a fixed offset from the median — which
  // sits BETWEEN the modes when warmup/cooldown run brisk, slicing into the
  // work cluster: a continuous tempo lost its slowest work lap to "rest" and
  // the remainder read as an alternating fartlek.
  const modes = splitLapModes(lapPaces);

  if (!modes || modes.workLaps.length < 2) {
    // Check for sustained tempo block with warmup/cooldown
    const tempoResult = detectTempoBlock(laps, lapPaces, easyPaceRef);
    if (tempoResult) return tempoResult;

    return classifyByPaceAndHr(activity, hrZones, easyPaceRef);
  }

  const { workLaps, restLaps } = modes;

  // Check if work laps alternate with rest laps (interval pattern)
  const hasAlternating = isAlternatingPattern(workLaps, restLaps);
  if (!hasAlternating) {
    // Consecutive work cluster = a continuous fast block. For sub-long-run
    // distances that is a tempo, not "unknown". (≥15km keeps its long-run
    // classification: a fast-finish long run is still a long run.)
    const isConsecutive =
      workLaps[workLaps.length - 1] - workLaps[0] + 1 === workLaps.length;
    if (isConsecutive && activity.distance / 1000 < 15) {
      const blockLaps = laps.slice(workLaps[0], workLaps[workLaps.length - 1] + 1);
      const blockDist = blockLaps.reduce((s, l) => s + l.distance, 0);
      const blockTime = blockLaps.reduce((s, l) => s + l.moving_time, 0);
      if (blockDist > 0) {
        const detail = `${(blockDist / 1000).toFixed(1)}km @ ${formatPace((blockTime / blockDist) * 1000)}`;
        return { run_type: "tempo", run_type_detail: detail, confidence: "high" };
      }
    }
    return classifyByPaceAndHr(activity, hrZones, easyPaceRef);
  }

  // Check work lap distance regularity
  const workDistances = workLaps.map(i => laps[i].distance);
  const cv = coefficientOfVariation(workDistances);

  if (cv < 0.15) {
    // Regular distances → intervals
    const detail = formatIntervalDetail(workLaps, laps);
    return { run_type: "intervals", run_type_detail: detail, confidence: "high" };
  }

  // Irregular distances → fartlek
  const detail = formatFartlekDetail(workLaps, restLaps, laps);
  return { run_type: "fartlek", run_type_detail: detail, confidence: "high" };
}

/**
 * Split lap paces into work/rest clusters at the session's own mode boundary.
 *
 * 1. Cut at the largest gap in the sorted paces (crude 1-D two-mode split).
 * 2. Require real separation — fast-cluster mean ≥8% faster than slow-cluster
 *    mean — else the session is single-mode and there is no work/rest
 *    structure (returns null).
 * 3. Tighten: the largest gap can land above a brisk warmup (e.g. reps at
 *    4:10, warmup 5:40, jog 10:00 — the biggest gap is jog-side), pulling the
 *    warmup into the work cluster. Intra-mode wander is ≤~10%, so anything
 *    slower than the work cluster's median × 1.12 is pushed back to rest.
 */
function splitLapModes(
  lapPaces: number[]
): { workLaps: number[]; restLaps: number[] } | null {
  if (lapPaces.length < 3) return null;
  const sorted = [...lapPaces].sort((a, b) => a - b);

  let gapIdx = -1;
  let bestGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > bestGap) { bestGap = gap; gapIdx = i; }
  }
  if (gapIdx <= 0) return null;

  const fastMean = sorted.slice(0, gapIdx).reduce((a, b) => a + b, 0) / gapIdx;
  const slowMean = sorted.slice(gapIdx).reduce((a, b) => a + b, 0) / (sorted.length - gapIdx);
  if (fastMean > slowMean * 0.92) return null; // modes not separated

  const boundary = (sorted[gapIdx - 1] + sorted[gapIdx]) / 2;
  const workPaces = lapPaces.filter(p => p <= boundary);
  const workCeiling = getMedian(workPaces) * 1.12;

  const workLaps: number[] = [];
  const restLaps: number[] = [];
  for (let i = 0; i < lapPaces.length; i++) {
    if (lapPaces[i] <= boundary && lapPaces[i] <= workCeiling) workLaps.push(i);
    else restLaps.push(i);
  }
  return { workLaps, restLaps };
}

function isProgression(paces: number[]): boolean {
  if (paces.length < 3) return false;

  // Allow first and last to be warmup/cooldown
  const corePaces = paces.length > 4 ? paces.slice(1, -1) : paces;

  let decreasing = 0;
  for (let i = 1; i < corePaces.length; i++) {
    if (corePaces[i] < corePaces[i - 1] * 1.01) {
      decreasing++;
    }
  }

  return decreasing >= (corePaces.length - 1) * 0.8;
}

function detectTempoBlock(
  laps: ActivityLapRecord[],
  lapPaces: number[],
  easyPaceRef: number
): ClassificationResult | null {
  if (laps.length < 3) return null;

  // Look for a sustained fast block (faster than easy) with warmup/cooldown
  const fastThreshold = easyPaceRef * 0.92;
  let fastStart = -1;
  let fastEnd = -1;

  for (let i = 0; i < lapPaces.length; i++) {
    if (lapPaces[i] < fastThreshold) {
      if (fastStart === -1) fastStart = i;
      fastEnd = i;
    } else if (fastStart !== -1 && i > fastEnd + 1) {
      break;
    }
  }

  if (fastStart === -1) return null;

  const fastLapCount = fastEnd - fastStart + 1;
  if (fastLapCount < 2) return null;

  // Must have warmup or cooldown
  if (fastStart === 0 && fastEnd === lapPaces.length - 1) return null;

  const tempoDistance = laps
    .slice(fastStart, fastEnd + 1)
    .reduce((sum, l) => sum + l.distance, 0);
  const distKm = tempoDistance / 1000;
  const avgPace = laps
    .slice(fastStart, fastEnd + 1)
    .reduce((sum, l) => sum + l.moving_time, 0) / tempoDistance * 1000;
  const detail = `${distKm.toFixed(1)}km @ ${formatPace(avgPace)}`;
  return { run_type: "tempo", run_type_detail: detail, confidence: "high" };
}

function isAlternatingPattern(workLaps: number[], restLaps: number[]): boolean {
  if (workLaps.length < 2) return false;

  // Check that work laps are not all consecutive
  let alternations = 0;
  const allLaps = [...workLaps.map(i => ({ i, type: "work" })), ...restLaps.map(i => ({ i, type: "rest" }))];
  allLaps.sort((a, b) => a.i - b.i);

  for (let i = 1; i < allLaps.length; i++) {
    if (allLaps[i].type !== allLaps[i - 1].type) {
      alternations++;
    }
  }

  return alternations >= workLaps.length;
}

function formatIntervalDetail(workLaps: number[], laps: ActivityLapRecord[]): string {
  const count = workLaps.length;
  const avgDistance = workLaps.reduce((sum, i) => sum + laps[i].distance, 0) / count;

  if (Math.abs(avgDistance - 1000) < 150) {
    return `${count}x1km`;
  }
  if (Math.abs(avgDistance - 800) < 100) {
    return `${count}x800m`;
  }
  if (Math.abs(avgDistance - 400) < 80) {
    return `${count}x400m`;
  }
  if (Math.abs(avgDistance - 1600) < 200 || Math.abs(avgDistance - 1609) < 200) {
    return `${count}x1mi`;
  }
  if (Math.abs(avgDistance - 2000) < 200) {
    return `${count}x2km`;
  }
  if (Math.abs(avgDistance - 1200) < 150) {
    return `${count}x1200m`;
  }

  // Fallback: round to nearest 100m
  const roundedM = Math.round(avgDistance / 100) * 100;
  return `${count}x${roundedM}m`;
}

function formatFartlekDetail(workLaps: number[], restLaps: number[], laps: ActivityLapRecord[]): string {
  const workCount = workLaps.length;

  // Average work and rest times
  const avgWorkTime = workLaps.reduce((sum, i) => sum + laps[i].moving_time, 0) / workCount;
  const avgRestTime = restLaps.length > 0
    ? restLaps.reduce((sum, i) => sum + laps[i].moving_time, 0) / restLaps.length
    : 0;

  const workMin = Math.round(avgWorkTime / 60);
  const restMin = Math.round(avgRestTime / 60);

  if (workMin > 0 && restMin > 0) {
    return `${workCount}x${workMin}/${restMin}min`;
  }
  if (workMin > 0) {
    return `${workCount}x${workMin}min`;
  }

  // Use seconds if under 1 min
  const workSec = Math.round(avgWorkTime / 10) * 10;
  return `${workCount}x${workSec}s`;
}

function getHrZone(hr: number, zones: HrZones): number {
  if (hr < zones.lt1) return hr < zones.lt1 * 0.88 ? 1 : 2;
  if (hr < zones.lt2) return 3;
  if (hr < zones.max_hr * 0.97) return 4;
  return 5;
}

function getMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
