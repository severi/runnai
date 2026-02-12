/**
 * Synthetic running data generator for eval fixtures.
 *
 * Generates 3 athlete profiles with realistic training data:
 *   1. New Runner      — VDOT 30, 3 months, beginner
 *   2. Experienced     — VDOT 45, 12 months, marathoner
 *   3. Comeback Runner — VDOT 40, 6 months with 2-month gap
 *
 * Usage: bun run evals/generate-fixtures.ts [--seed 42]
 */

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Seeded PRNG (xoshiro128** — deterministic, reproducible)
// ---------------------------------------------------------------------------

function createRng(seed: number) {
  let s = [seed, seed ^ 0xdeadbeef, seed ^ 0xcafebabe, seed ^ 0x12345678];
  const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));
  return {
    /** 0..1 */
    next(): number {
      const result = rotl(s[1] * 5, 7) * 9;
      const t = s[1] << 9;
      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= t;
      s[3] = rotl(s[3], 11);
      return (result >>> 0) / 4294967296;
    },
    /** Gaussian with mean/stddev */
    gaussian(mean: number, stddev: number): number {
      // Box-Muller transform
      const u1 = this.next();
      const u2 = this.next();
      const z = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
      return mean + z * stddev;
    },
    /** Integer in [min, max] inclusive */
    int(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    /** Pick random element */
    pick<T>(arr: T[]): T {
      return arr[this.int(0, arr.length - 1)];
    },
    /** Boolean with probability p */
    chance(p: number): boolean {
      return this.next() < p;
    },
  };
}

type Rng = ReturnType<typeof createRng>;

// ---------------------------------------------------------------------------
// VDOT tables (Jack Daniels' Running Formula, key values)
// Paces in seconds per km
// ---------------------------------------------------------------------------

interface VdotEntry {
  vdot: number;
  easyPace: [number, number]; // range [slow, fast] sec/km
  marathonPace: number;       // sec/km
  thresholdPace: number;      // sec/km
  intervalPace: number;       // sec/km
  repPace: number;            // sec/km
  race5k: number;             // seconds
  race10k: number;
  raceHalf: number;
  raceMarathon: number;
  // HR zones (typical for that fitness level)
  maxHr: number;
  lt2Hr: number;
  lt1Hr: number;
}

const VDOT_TABLE: Record<number, VdotEntry> = {
  30: {
    vdot: 30, easyPace: [465, 495], marathonPace: 415, thresholdPace: 388,
    intervalPace: 355, repPace: 335, race5k: 1840, race10k: 3826,
    raceHalf: 8464, raceMarathon: 17357, maxHr: 195, lt2Hr: 170, lt1Hr: 152,
  },
  35: {
    vdot: 35, easyPace: [405, 430], marathonPace: 362, thresholdPace: 338,
    intervalPace: 310, repPace: 292, race5k: 1560, race10k: 3240,
    raceHalf: 7200, raceMarathon: 14880, maxHr: 192, lt2Hr: 172, lt1Hr: 155,
  },
  40: {
    vdot: 40, easyPace: [360, 384], marathonPace: 322, thresholdPace: 301,
    intervalPace: 275, repPace: 260, race5k: 1350, race10k: 2810,
    raceHalf: 6240, raceMarathon: 13080, maxHr: 190, lt2Hr: 174, lt1Hr: 157,
  },
  45: {
    vdot: 45, easyPace: [327, 350], marathonPace: 290, thresholdPace: 269,
    intervalPace: 244, repPace: 230, race5k: 1185, race10k: 2470,
    raceHalf: 5495, raceMarathon: 11449, maxHr: 188, lt2Hr: 175, lt1Hr: 160,
  },
  50: {
    vdot: 50, easyPace: [301, 322], marathonPace: 264, thresholdPace: 244,
    intervalPace: 221, repPace: 208, race5k: 1050, race10k: 2190,
    raceHalf: 4860, raceMarathon: 10140, maxHr: 186, lt2Hr: 176, lt1Hr: 162,
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunType = "easy" | "tempo" | "intervals" | "fartlek" | "long_run" | "race" | "recovery" | "threshold" | "progression" | "unknown";

interface Activity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance: number;           // meters
  moving_time: number;        // seconds
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;      // m/s
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  suffer_score: number | null;
  average_cadence: number | null;
  workout_type: number | null;
  description: string | null;
  trainer: number;
  detail_fetched: number;
  start_latitude: number | null;
  start_longitude: number | null;
  run_type: string | null;
  run_type_detail: string | null;
}

interface Lap {
  activity_id: number;
  lap_index: number;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  average_speed: number;
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  start_index: number;
  end_index: number;
}

interface BestEffort {
  strava_effort_id: number;
  activity_id: number;
  distance_name: string;
  distance_meters: number;
  elapsed_time: number;
  moving_time: number;
  pace_per_km: number;
  start_index: number;
  end_index: number;
  pr_rank: number | null;
  fetched_at: string;
}

interface WeekTemplate {
  day: number; // 0=Sun, 1=Mon, ...
  type: RunType;
  distanceKm: number;
  detail?: string;
}

interface ProfileConfig {
  name: string;
  vdot: number;
  weeks: number;
  runsPerWeek: [number, number]; // range
  weekTemplate: WeekTemplate[];
  crossTraining: { type: string; sport_type: string; name: string; distKm: number; movingMin: number }[];
  crossTrainingPerWeek: number;
  hasTrainingPlan: boolean;
  hasPr: boolean;
  gapWeeks?: [number, number]; // week range with no runs (injury gap)
  detrainingFactor?: number; // pace slowdown after gap (1.0 = no change, 1.08 = 8% slower)
}

// ---------------------------------------------------------------------------
// Activity naming (realistic Strava defaults)
// ---------------------------------------------------------------------------

function activityName(rng: Rng, hour: number, runType: RunType, detail: string | null): string {
  // 85% chance of default Strava name
  if (rng.chance(0.85)) {
    if (hour < 10) return "Morning Run";
    if (hour < 14) return "Lunch Run";
    if (hour < 17) return "Afternoon Run";
    return "Evening Run";
  }
  // 15% chance of a custom name
  switch (runType) {
    case "intervals": return detail || "Intervals";
    case "fartlek": return detail || "Fartlek";
    case "tempo": return "Tempo Run";
    case "long_run": return "Long Run";
    case "race": return "Race";
    case "recovery": return "Recovery Jog";
    case "progression": return "Progression Run";
    default: return "Easy Run";
  }
}

function crossTrainingName(rng: Rng, hour: number, type: string): string {
  if (rng.chance(0.7)) {
    if (hour < 10) return `Morning ${type}`;
    if (hour < 14) return `Lunch ${type}`;
    if (hour < 17) return `Afternoon ${type}`;
    return `Evening ${type}`;
  }
  return type;
}

// ---------------------------------------------------------------------------
// Pace & HR helpers
// ---------------------------------------------------------------------------

function paceToSpeed(secPerKm: number): number {
  return 1000 / secPerKm; // m/s
}

function hrForPace(paceSecKm: number, vdotEntry: VdotEntry, rng: Rng): number {
  // Map pace to HR zone with noise
  const { easyPace, thresholdPace, intervalPace, maxHr, lt2Hr, lt1Hr } = vdotEntry;
  const easyMid = (easyPace[0] + easyPace[1]) / 2;

  let baseHr: number;
  if (paceSecKm >= easyMid) {
    // Easy / recovery zone
    baseHr = lt1Hr - 5 + (lt1Hr - (lt1Hr - 15)) * ((paceSecKm - easyMid) / 60);
  } else if (paceSecKm >= thresholdPace) {
    // Moderate to threshold
    const ratio = (easyMid - paceSecKm) / (easyMid - thresholdPace);
    baseHr = lt1Hr + ratio * (lt2Hr - lt1Hr);
  } else if (paceSecKm >= intervalPace) {
    const ratio = (thresholdPace - paceSecKm) / (thresholdPace - intervalPace);
    baseHr = lt2Hr + ratio * (maxHr - lt2Hr) * 0.8;
  } else {
    baseHr = maxHr * 0.95;
  }

  return Math.round(rng.gaussian(baseHr, 3));
}

// ---------------------------------------------------------------------------
// Lap generators
// ---------------------------------------------------------------------------

function generateAutoLaps(distanceM: number, paceSecKm: number, vdotEntry: VdotEntry, rng: Rng): { laps: Lap[]; avgHr: number | null; maxHr: number | null } {
  const lapDistM = 1000;
  const numFullLaps = Math.floor(distanceM / lapDistM);
  const remainder = distanceM - numFullLaps * lapDistM;
  const laps: Lap[] = [];
  let totalHr = 0;
  let peakHr = 0;
  let hrCount = 0;
  const hasHr = rng.chance(0.85);
  let indexCounter = 0;

  for (let i = 0; i < numFullLaps + (remainder > 100 ? 1 : 0); i++) {
    const isLast = i === numFullLaps;
    const lapDist = isLast ? remainder : lapDistM;

    // Pace jitter: ±5-15s/km, with cardiac drift on later laps
    const driftFactor = 1 + (i / numFullLaps) * rng.gaussian(0.03, 0.02);
    const jitter = rng.gaussian(0, 8);
    const lapPace = Math.max(paceSecKm * driftFactor + jitter, paceSecKm * 0.85);
    const lapTime = Math.round(lapPace * lapDist / 1000);
    const lapSpeed = lapDist / lapTime;

    const lapHr = hasHr ? hrForPace(lapPace, vdotEntry, rng) : null;
    if (lapHr !== null) {
      totalHr += lapHr;
      hrCount++;
      if (lapHr > peakHr) peakHr = lapHr;
    }

    const startIdx = indexCounter;
    indexCounter += Math.round(lapDist / 5);

    laps.push({
      activity_id: 0, // filled later
      lap_index: i,
      distance: lapDist,
      elapsed_time: lapTime + rng.int(0, 5),
      moving_time: lapTime,
      average_speed: lapSpeed,
      max_speed: lapSpeed * rng.gaussian(1.12, 0.03),
      average_heartrate: lapHr,
      max_heartrate: lapHr ? Math.round(lapHr + rng.int(3, 10)) : null,
      start_index: startIdx,
      end_index: startIdx + Math.round(lapDist / 5),
    });
  }

  const avgHr = hrCount > 0 ? Math.round(totalHr / hrCount) : null;
  const maxHrVal = peakHr > 0 ? peakHr + rng.int(2, 8) : null;
  return { laps, avgHr, maxHr: maxHrVal };
}

function generateIntervalLaps(
  warmupKm: number, intervals: { repDistM: number; reps: number; restDistM: number },
  cooldownKm: number, vdotEntry: VdotEntry, rng: Rng
): { laps: Lap[]; totalDistM: number; totalTimeS: number; avgHr: number | null; maxHr: number | null; detail: string } {
  const laps: Lap[] = [];
  let totalDist = 0;
  let totalTime = 0;
  let totalHr = 0;
  let peakHr = 0;
  let hrCount = 0;
  const hasHr = rng.chance(0.88);
  let indexCounter = 0;
  let lapIdx = 0;

  const addLap = (dist: number, paceSecKm: number, isRest = false) => {
    const jitter = rng.gaussian(0, isRest ? 12 : 5);
    const pace = Math.max(paceSecKm + jitter, paceSecKm * 0.85);
    const time = Math.round(pace * dist / 1000);
    const speed = dist / time;
    const hr = hasHr ? hrForPace(pace, vdotEntry, rng) : null;
    if (hr) { totalHr += hr; hrCount++; if (hr > peakHr) peakHr = hr; }

    const startIdx = indexCounter;
    indexCounter += Math.round(dist / 5);

    laps.push({
      activity_id: 0,
      lap_index: lapIdx++,
      distance: dist,
      elapsed_time: time + rng.int(0, 3),
      moving_time: time,
      average_speed: speed,
      max_speed: speed * rng.gaussian(1.1, 0.02),
      average_heartrate: hr,
      max_heartrate: hr ? Math.round(hr + rng.int(2, 8)) : null,
      start_index: startIdx,
      end_index: indexCounter,
    });
    totalDist += dist;
    totalTime += time;
  };

  // Warmup
  addLap(warmupKm * 1000, vdotEntry.easyPace[0]);

  // Reps
  const { repDistM, reps, restDistM } = intervals;
  for (let r = 0; r < reps; r++) {
    addLap(repDistM, vdotEntry.intervalPace);
    if (r < reps - 1) addLap(restDistM, vdotEntry.easyPace[1] * 1.1, true);
  }

  // Cooldown
  addLap(cooldownKm * 1000, vdotEntry.easyPace[0] * 1.03);

  const avgHr = hrCount > 0 ? Math.round(totalHr / hrCount) : null;
  const detail = repDistM >= 1000
    ? `${reps}x${Math.round(repDistM / 100) / 10}km`
    : `${reps}x${repDistM}m`;

  return { laps, totalDistM: totalDist, totalTimeS: totalTime, avgHr, maxHr: peakHr > 0 ? peakHr + rng.int(3, 8) : null, detail };
}

function generateFartlekLaps(
  totalDistKm: number, reps: number, workMin: number, restMin: number,
  vdotEntry: VdotEntry, rng: Rng
): { laps: Lap[]; totalDistM: number; totalTimeS: number; avgHr: number | null; maxHr: number | null; detail: string } {
  const laps: Lap[] = [];
  let totalDist = 0;
  let totalTime = 0;
  let totalHr = 0;
  let peakHr = 0;
  let hrCount = 0;
  const hasHr = rng.chance(0.88);
  let indexCounter = 0;
  let lapIdx = 0;

  const addLap = (durationSec: number, paceSecKm: number) => {
    const jitter = rng.gaussian(0, 10);
    const pace = Math.max(paceSecKm + jitter, paceSecKm * 0.85);
    const dist = Math.round(durationSec / pace * 1000);
    const speed = dist / durationSec;
    const hr = hasHr ? hrForPace(pace, vdotEntry, rng) : null;
    if (hr) { totalHr += hr; hrCount++; if (hr > peakHr) peakHr = hr; }

    const startIdx = indexCounter;
    indexCounter += Math.round(dist / 5);

    laps.push({
      activity_id: 0, lap_index: lapIdx++, distance: dist,
      elapsed_time: durationSec + rng.int(0, 5), moving_time: durationSec,
      average_speed: speed, max_speed: speed * rng.gaussian(1.15, 0.03),
      average_heartrate: hr, max_heartrate: hr ? Math.round(hr + rng.int(2, 8)) : null,
      start_index: startIdx, end_index: indexCounter,
    });
    totalDist += dist;
    totalTime += durationSec;
  };

  // Warmup ~2km
  const warmupTime = Math.round(2000 / (1000 / vdotEntry.easyPace[0]));
  addLap(warmupTime, vdotEntry.easyPace[0]);

  // Work/rest blocks with irregular durations (fartlek messiness)
  for (let r = 0; r < reps; r++) {
    const workSec = Math.round((workMin + rng.gaussian(0, 0.3)) * 60);
    const workPace = rng.gaussian(vdotEntry.thresholdPace, 10);
    addLap(workSec, workPace);

    if (r < reps - 1) {
      const restSec = Math.round((restMin + rng.gaussian(0, 0.4)) * 60);
      addLap(restSec, vdotEntry.easyPace[0] * 1.05);
    }
  }

  // Cooldown
  const cooldownTime = Math.round(1500 / (1000 / vdotEntry.easyPace[0]));
  addLap(cooldownTime, vdotEntry.easyPace[0] * 1.02);

  const avgHr = hrCount > 0 ? Math.round(totalHr / hrCount) : null;
  const detail = `${reps}x${workMin}/${restMin}min`;

  return { laps, totalDistM: totalDist, totalTimeS: totalTime, avgHr, maxHr: peakHr > 0 ? peakHr + rng.int(3, 8) : null, detail };
}

// ---------------------------------------------------------------------------
// Best efforts from an activity
// ---------------------------------------------------------------------------

const BEST_EFFORT_DISTANCES: { name: string; meters: number }[] = [
  { name: "400m", meters: 400 },
  { name: "1/2 mile", meters: 805 },
  { name: "1K", meters: 1000 },
  { name: "1 mile", meters: 1609 },
  { name: "2 mile", meters: 3219 },
  { name: "5K", meters: 5000 },
  { name: "10K", meters: 10000 },
  { name: "15K", meters: 15000 },
  { name: "10 mile", meters: 16093 },
  { name: "Half-Marathon", meters: 21097 },
];

function generateBestEfforts(activityId: number, distanceM: number, avgPaceSecKm: number, rng: Rng, effortIdBase: number): BestEffort[] {
  const efforts: BestEffort[] = [];
  for (const { name, meters } of BEST_EFFORT_DISTANCES) {
    if (meters > distanceM * 0.95) break;

    // Shorter segments within a run are faster than average
    const segmentRatio = meters / distanceM;
    const paceBonus = segmentRatio < 0.3 ? rng.gaussian(0.95, 0.02) : segmentRatio < 0.7 ? rng.gaussian(0.97, 0.01) : 1.0;
    const segPace = avgPaceSecKm * paceBonus;
    const elapsed = Math.round(segPace * meters / 1000);

    efforts.push({
      strava_effort_id: effortIdBase + efforts.length,
      activity_id: activityId,
      distance_name: name,
      distance_meters: meters,
      elapsed_time: elapsed,
      moving_time: elapsed - rng.int(0, 3),
      pace_per_km: segPace,
      start_index: rng.int(0, 100),
      end_index: rng.int(100, 500),
      pr_rank: null, // filled in post-processing
      fetched_at: new Date().toISOString(),
    });
  }
  return efforts;
}

// ---------------------------------------------------------------------------
// Activity generator
// ---------------------------------------------------------------------------

let globalActivityId = 1000000000;
let globalEffortId = 5000000000;

function generateActivity(
  date: Date, runType: RunType, distKm: number, detail: string | null,
  vdotEntry: VdotEntry, rng: Rng, detrainFactor = 1.0
): { activity: Activity; laps: Lap[]; bestEfforts: BestEffort[] } {
  const id = globalActivityId++;
  const hour = rng.pick([6, 7, 8, 11, 12, 15, 16, 17]);
  date.setHours(hour, rng.int(0, 59), rng.int(0, 59));

  // Determine pace based on run type
  let basePace: number;
  switch (runType) {
    case "easy": basePace = rng.gaussian((vdotEntry.easyPace[0] + vdotEntry.easyPace[1]) / 2, 5); break;
    case "recovery": basePace = rng.gaussian(vdotEntry.easyPace[1] * 1.05, 5); break;
    case "long_run": basePace = rng.gaussian(vdotEntry.easyPace[0] * 1.02, 5); break;
    case "tempo": basePace = rng.gaussian(vdotEntry.thresholdPace * 1.03, 4); break;
    case "threshold": basePace = rng.gaussian(vdotEntry.thresholdPace, 3); break;
    case "race": basePace = rng.gaussian(vdotEntry.thresholdPace * 0.96, 3); break;
    case "progression": basePace = rng.gaussian(vdotEntry.easyPace[0], 5); break;
    default: basePace = rng.gaussian((vdotEntry.easyPace[0] + vdotEntry.easyPace[1]) / 2, 8); break;
  }
  basePace *= detrainFactor;

  // Generate laps and detailed data based on run type
  let laps: Lap[];
  let totalDist: number;
  let totalTime: number;
  let avgHr: number | null;
  let maxHr: number | null;
  let computedDetail = detail;

  if (runType === "intervals" && detail) {
    // Parse detail like "6x1km" or "8x400m"
    const match = detail.match(/(\d+)x(\d+)(km|m)/);
    if (match) {
      const reps = parseInt(match[1]);
      const repDist = parseInt(match[2]) * (match[3] === "km" ? 1000 : 1);
      const result = generateIntervalLaps(2, { repDistM: repDist, reps, restDistM: rng.pick([200, 400]) }, 1.5, vdotEntry, rng);
      laps = result.laps;
      totalDist = result.totalDistM;
      totalTime = result.totalTimeS;
      avgHr = result.avgHr;
      maxHr = result.maxHr;
      computedDetail = result.detail;
    } else {
      const result = generateAutoLaps(distKm * 1000, basePace, vdotEntry, rng);
      laps = result.laps;
      totalDist = distKm * 1000;
      totalTime = Math.round(basePace * distKm);
      avgHr = result.avgHr;
      maxHr = result.maxHr;
    }
  } else if (runType === "fartlek") {
    const reps = rng.int(5, 10);
    const workMin = rng.pick([2, 3, 4]);
    const restMin = rng.pick([1, 2]);
    const result = generateFartlekLaps(distKm, reps, workMin, restMin, vdotEntry, rng);
    laps = result.laps;
    totalDist = result.totalDistM;
    totalTime = result.totalTimeS;
    avgHr = result.avgHr;
    maxHr = result.maxHr;
    computedDetail = result.detail;
  } else {
    totalDist = Math.round(distKm * 1000 + rng.gaussian(0, 50));
    const result = generateAutoLaps(totalDist, basePace, vdotEntry, rng);
    laps = result.laps;
    totalTime = Math.round(basePace * totalDist / 1000);
    avgHr = result.avgHr;
    maxHr = result.maxHr;
  }

  // Fill in activity_id on laps
  for (const lap of laps) lap.activity_id = id;

  const avgSpeed = totalDist / totalTime;
  const maxSpeed = avgSpeed * rng.gaussian(1.25, 0.08);
  const elevation = Math.round(distKm * rng.gaussian(8, 4));

  const activity: Activity = {
    id,
    name: activityName(rng, hour, runType, computedDetail),
    type: "Run",
    sport_type: "Run",
    start_date: date.toISOString(),
    start_date_local: date.toISOString().replace("Z", ""),
    distance: totalDist,
    moving_time: totalTime,
    elapsed_time: totalTime + rng.int(30, 300),
    total_elevation_gain: Math.max(0, elevation),
    average_speed: avgSpeed,
    max_speed: maxSpeed,
    average_heartrate: avgHr,
    max_heartrate: maxHr,
    suffer_score: avgHr ? Math.round(rng.gaussian(avgHr / 3, 10)) : null,
    average_cadence: rng.chance(0.8) ? Math.round(rng.gaussian(170, 5)) : null,
    workout_type: runType === "race" ? 1 : null,
    description: null,
    trainer: 0,
    detail_fetched: 1,
    start_latitude: rng.gaussian(60.17, 0.02),
    start_longitude: rng.gaussian(24.94, 0.03),
    run_type: runType,
    run_type_detail: computedDetail,
  };

  // Best efforts
  const effortBase = globalEffortId;
  globalEffortId += 20;
  const bestEfforts = generateBestEfforts(id, totalDist, basePace, rng, effortBase);

  return { activity, laps, bestEfforts };
}

function generateCrossTraining(
  date: Date, config: { type: string; sport_type: string; name: string; distKm: number; movingMin: number },
  rng: Rng
): Activity {
  const id = globalActivityId++;
  const hour = rng.pick([7, 8, 12, 16, 17, 18]);
  date.setHours(hour, rng.int(0, 59), rng.int(0, 59));

  const dist = config.distKm > 0 ? Math.round(config.distKm * 1000 + rng.gaussian(0, 200)) : 0;
  const movingTime = Math.round(config.movingMin * 60 + rng.gaussian(0, 120));

  return {
    id,
    name: crossTrainingName(rng, hour, config.name),
    type: config.type,
    sport_type: config.sport_type,
    start_date: date.toISOString(),
    start_date_local: date.toISOString().replace("Z", ""),
    distance: dist,
    moving_time: movingTime,
    elapsed_time: movingTime + rng.int(60, 600),
    total_elevation_gain: dist > 0 ? Math.round(rng.gaussian(dist / 100, 20)) : 0,
    average_speed: dist > 0 ? dist / movingTime : 0,
    max_speed: dist > 0 ? (dist / movingTime) * rng.gaussian(1.5, 0.2) : 0,
    average_heartrate: rng.chance(0.5) ? Math.round(rng.gaussian(130, 15)) : null,
    max_heartrate: rng.chance(0.5) ? Math.round(rng.gaussian(155, 15)) : null,
    suffer_score: null,
    average_cadence: null,
    workout_type: null,
    description: null,
    trainer: 0,
    detail_fetched: 0,
    start_latitude: rng.gaussian(60.17, 0.02),
    start_longitude: rng.gaussian(24.94, 0.03),
    run_type: null,
    run_type_detail: null,
  };
}

// ---------------------------------------------------------------------------
// Profile generators
// ---------------------------------------------------------------------------

function generateProfile(config: ProfileConfig, rng: Rng): { activities: Activity[]; laps: Lap[]; bestEfforts: BestEffort[] } {
  const vdot = VDOT_TABLE[config.vdot];
  const activities: Activity[] = [];
  const allLaps: Lap[] = [];
  const allBestEfforts: BestEffort[] = [];

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - config.weeks * 7);

  for (let week = 0; week < config.weeks; week++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(weekStart.getDate() + week * 7);

    // Check if this week is in the injury gap
    if (config.gapWeeks && week >= config.gapWeeks[0] && week < config.gapWeeks[1]) {
      // Maybe one walk during the gap
      if (rng.chance(0.15)) {
        const walkDay = rng.int(0, 6);
        const walkDate = new Date(weekStart);
        walkDate.setDate(walkDate.getDate() + walkDay);
        activities.push(generateCrossTraining(walkDate, {
          type: "Walk", sport_type: "Walk", name: "Walk", distKm: rng.gaussian(3, 0.5), movingMin: rng.gaussian(40, 10),
        }, rng));
      }
      continue;
    }

    // Detraining factor: after gap, pace is slower
    let detrainFactor = 1.0;
    if (config.gapWeeks && config.detrainingFactor && week >= config.gapWeeks[1]) {
      const weeksBack = week - config.gapWeeks[1];
      // Gradually recover over ~6 weeks
      detrainFactor = 1 + (config.detrainingFactor - 1) * Math.max(0, 1 - weeksBack / 6);
    }

    // Decide how many runs this week (with some randomness)
    const targetRuns = rng.int(config.runsPerWeek[0], config.runsPerWeek[1]);
    // Sometimes skip runs (life happens)
    const actualRuns = rng.chance(0.1) ? Math.max(1, targetRuns - rng.int(1, 2)) : targetRuns;

    // Pick which template slots to use
    const template = [...config.weekTemplate].slice(0, actualRuns);

    for (const slot of template) {
      const runDate = new Date(weekStart);
      // Add some day variation (±1 day from template)
      const dayOffset = rng.chance(0.2) ? rng.pick([-1, 1]) : 0;
      runDate.setDate(runDate.getDate() + Math.max(0, Math.min(6, slot.day + dayOffset)));

      // Distance variation (±10%)
      const dist = slot.distanceKm * rng.gaussian(1.0, 0.08);

      const { activity, laps, bestEfforts } = generateActivity(
        runDate, slot.type, Math.max(2, dist), slot.detail ?? null,
        vdot, rng, detrainFactor
      );
      activities.push(activity);
      allLaps.push(...laps);
      allBestEfforts.push(...bestEfforts);
    }

    // Cross-training
    if (config.crossTrainingPerWeek > 0 && rng.chance(0.6)) {
      const numCross = rng.int(0, config.crossTrainingPerWeek);
      for (let i = 0; i < numCross; i++) {
        const ctDay = rng.int(0, 6);
        const ctDate = new Date(weekStart);
        ctDate.setDate(ctDate.getDate() + ctDay);
        const ctConfig = rng.pick(config.crossTraining);
        activities.push(generateCrossTraining(ctDate, ctConfig, rng));
      }
    }
  }

  // Sort by date
  activities.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  // Post-process: assign PR ranks to best efforts
  assignPrRanks(allBestEfforts);

  return { activities, laps: allLaps, bestEfforts: allBestEfforts };
}

function assignPrRanks(efforts: BestEffort[]) {
  const byDistance = new Map<string, BestEffort[]>();
  for (const e of efforts) {
    if (!byDistance.has(e.distance_name)) byDistance.set(e.distance_name, []);
    byDistance.get(e.distance_name)!.push(e);
  }
  for (const [, distEfforts] of byDistance) {
    distEfforts.sort((a, b) => a.elapsed_time - b.elapsed_time);
    for (let i = 0; i < Math.min(3, distEfforts.length); i++) {
      distEfforts[i].pr_rank = i + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Profile configs
// ---------------------------------------------------------------------------

const PROFILES: ProfileConfig[] = [
  {
    name: "new-runner",
    vdot: 30,
    weeks: 13,
    runsPerWeek: [2, 4],
    weekTemplate: [
      { day: 1, type: "easy", distanceKm: 4 },
      { day: 3, type: "easy", distanceKm: 5 },
      { day: 5, type: "easy", distanceKm: 4.5 },
      { day: 0, type: "easy", distanceKm: 6 },
    ],
    crossTraining: [
      { type: "Walk", sport_type: "Walk", name: "Walk", distKm: 3, movingMin: 40 },
    ],
    crossTrainingPerWeek: 1,
    hasTrainingPlan: false,
    hasPr: false,
  },
  {
    name: "experienced-marathoner",
    vdot: 45,
    weeks: 52,
    runsPerWeek: [4, 6],
    weekTemplate: [
      { day: 1, type: "easy", distanceKm: 10 },
      { day: 2, type: "intervals", distanceKm: 12, detail: "6x1km" },
      { day: 3, type: "easy", distanceKm: 8 },
      { day: 4, type: "tempo", distanceKm: 10 },
      { day: 5, type: "recovery", distanceKm: 6 },
      { day: 0, type: "long_run", distanceKm: 22 },
    ],
    crossTraining: [
      { type: "Ride", sport_type: "Ride", name: "Ride", distKm: 25, movingMin: 60 },
      { type: "Walk", sport_type: "Walk", name: "Walk", distKm: 4, movingMin: 50 },
      { type: "Workout", sport_type: "Badminton", name: "Badminton", distKm: 0, movingMin: 60 },
    ],
    crossTrainingPerWeek: 2,
    hasTrainingPlan: true,
    hasPr: true,
  },
  {
    name: "comeback-runner",
    vdot: 40,
    weeks: 26,
    runsPerWeek: [3, 5],
    weekTemplate: [
      { day: 1, type: "easy", distanceKm: 8 },
      { day: 2, type: "fartlek", distanceKm: 10 },
      { day: 3, type: "easy", distanceKm: 7 },
      { day: 5, type: "easy", distanceKm: 8 },
      { day: 0, type: "long_run", distanceKm: 16 },
    ],
    crossTraining: [
      { type: "Walk", sport_type: "Walk", name: "Walk", distKm: 3, movingMin: 35 },
      { type: "Ride", sport_type: "Ride", name: "Ride", distKm: 15, movingMin: 45 },
    ],
    crossTrainingPerWeek: 1,
    hasTrainingPlan: false,
    hasPr: true,
    gapWeeks: [8, 16], // weeks 8-15 = injury gap
    detrainingFactor: 1.08, // 8% slower after gap
  },
];

// ---------------------------------------------------------------------------
// DB writer
// ---------------------------------------------------------------------------

function createDb(dbPath: string): Database {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY, name TEXT, type TEXT, sport_type TEXT,
      start_date TEXT, start_date_local TEXT, distance REAL,
      moving_time INTEGER, elapsed_time INTEGER, total_elevation_gain REAL,
      average_speed REAL, max_speed REAL, average_heartrate REAL,
      max_heartrate REAL, suffer_score INTEGER, average_cadence REAL,
      workout_type INTEGER, description TEXT, trainer INTEGER DEFAULT 0,
      detail_fetched INTEGER DEFAULT 0, start_latitude REAL, start_longitude REAL,
      run_type TEXT, run_type_detail TEXT
    );
    CREATE INDEX idx_start_date ON activities(start_date_local);
    CREATE INDEX idx_type ON activities(type);
    CREATE INDEX idx_distance ON activities(distance);

    CREATE TABLE activity_laps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id INTEGER REFERENCES activities(id),
      lap_index INTEGER, distance REAL, elapsed_time INTEGER, moving_time INTEGER,
      average_speed REAL, max_speed REAL, average_heartrate REAL, max_heartrate REAL,
      start_index INTEGER, end_index INTEGER, UNIQUE(activity_id, lap_index)
    );

    CREATE TABLE strava_best_efforts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, strava_effort_id INTEGER UNIQUE,
      activity_id INTEGER REFERENCES activities(id), distance_name TEXT,
      distance_meters REAL, elapsed_time REAL, moving_time REAL, pace_per_km REAL,
      start_index INTEGER, end_index INTEGER, pr_rank INTEGER, fetched_at TEXT,
      UNIQUE(activity_id, distance_name)
    );
    CREATE INDEX idx_sbe_distance ON strava_best_efforts(distance_name);

    CREATE TABLE best_efforts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id INTEGER REFERENCES activities(id),
      distance_name TEXT, distance_meters REAL, elapsed_time REAL, pace_per_km REAL,
      start_index INTEGER, end_index INTEGER, computed_at TEXT,
      UNIQUE(activity_id, distance_name)
    );

    CREATE TABLE race_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, race_distance TEXT,
      predicted_time REAL, confidence TEXT, basis TEXT, predicted_at TEXT
    );

    CREATE TABLE personal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, distance_name TEXT UNIQUE,
      time_seconds INTEGER, race_name TEXT, race_date TEXT, notes TEXT, recorded_at TEXT
    );
  `);
  return db;
}

function writeActivities(db: Database, activities: Activity[]) {
  const stmt = db.prepare(`
    INSERT INTO activities (id, name, type, sport_type, start_date, start_date_local,
      distance, moving_time, elapsed_time, total_elevation_gain, average_speed, max_speed,
      average_heartrate, max_heartrate, suffer_score, average_cadence, workout_type,
      description, trainer, detail_fetched, start_latitude, start_longitude, run_type, run_type_detail)
    VALUES ($id, $name, $type, $sport_type, $start_date, $start_date_local,
      $distance, $moving_time, $elapsed_time, $total_elevation_gain, $average_speed, $max_speed,
      $average_heartrate, $max_heartrate, $suffer_score, $average_cadence, $workout_type,
      $description, $trainer, $detail_fetched, $start_latitude, $start_longitude, $run_type, $run_type_detail)
  `);
  const tx = db.transaction((acts: Activity[]) => {
    for (const a of acts) {
      stmt.run({
        $id: a.id, $name: a.name, $type: a.type, $sport_type: a.sport_type,
        $start_date: a.start_date, $start_date_local: a.start_date_local,
        $distance: a.distance, $moving_time: a.moving_time, $elapsed_time: a.elapsed_time,
        $total_elevation_gain: a.total_elevation_gain, $average_speed: a.average_speed,
        $max_speed: a.max_speed, $average_heartrate: a.average_heartrate,
        $max_heartrate: a.max_heartrate, $suffer_score: a.suffer_score,
        $average_cadence: a.average_cadence, $workout_type: a.workout_type,
        $description: a.description, $trainer: a.trainer, $detail_fetched: a.detail_fetched,
        $start_latitude: a.start_latitude, $start_longitude: a.start_longitude,
        $run_type: a.run_type, $run_type_detail: a.run_type_detail,
      });
    }
  });
  tx(activities);
}

function writeLaps(db: Database, laps: Lap[]) {
  const stmt = db.prepare(`
    INSERT INTO activity_laps (activity_id, lap_index, distance, elapsed_time, moving_time,
      average_speed, max_speed, average_heartrate, max_heartrate, start_index, end_index)
    VALUES ($activity_id, $lap_index, $distance, $elapsed_time, $moving_time,
      $average_speed, $max_speed, $average_heartrate, $max_heartrate, $start_index, $end_index)
  `);
  const tx = db.transaction((items: Lap[]) => {
    for (const l of items) {
      stmt.run({
        $activity_id: l.activity_id, $lap_index: l.lap_index, $distance: l.distance,
        $elapsed_time: l.elapsed_time, $moving_time: l.moving_time, $average_speed: l.average_speed,
        $max_speed: l.max_speed, $average_heartrate: l.average_heartrate,
        $max_heartrate: l.max_heartrate, $start_index: l.start_index, $end_index: l.end_index,
      });
    }
  });
  tx(laps);
}

function writeBestEfforts(db: Database, efforts: BestEffort[]) {
  const stmt = db.prepare(`
    INSERT INTO strava_best_efforts (strava_effort_id, activity_id, distance_name, distance_meters,
      elapsed_time, moving_time, pace_per_km, start_index, end_index, pr_rank, fetched_at)
    VALUES ($strava_effort_id, $activity_id, $distance_name, $distance_meters,
      $elapsed_time, $moving_time, $pace_per_km, $start_index, $end_index, $pr_rank, $fetched_at)
  `);
  const tx = db.transaction((items: BestEffort[]) => {
    for (const e of items) {
      stmt.run({
        $strava_effort_id: e.strava_effort_id, $activity_id: e.activity_id,
        $distance_name: e.distance_name, $distance_meters: e.distance_meters,
        $elapsed_time: e.elapsed_time, $moving_time: e.moving_time, $pace_per_km: e.pace_per_km,
        $start_index: e.start_index, $end_index: e.end_index, $pr_rank: e.pr_rank,
        $fetched_at: e.fetched_at,
      });
    }
  });
  tx(efforts);
}

function writePersonalRecords(db: Database, vdotEntry: VdotEntry) {
  db.prepare(`
    INSERT INTO personal_records (distance_name, time_seconds, race_name, race_date, notes, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("10K", vdotEntry.race10k, "Helsinki City Run", "2025-05-17", null, "2025-05-17");

  if (vdotEntry.vdot >= 40) {
    db.prepare(`
      INSERT INTO personal_records (distance_name, time_seconds, race_name, race_date, notes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("Half-Marathon", vdotEntry.raceHalf, "HCR Half Marathon", "2025-09-20", null, "2025-09-20");
  }

  if (vdotEntry.vdot >= 45) {
    db.prepare(`
      INSERT INTO personal_records (distance_name, time_seconds, race_name, race_date, notes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("Marathon", vdotEntry.raceMarathon, "Helsinki Marathon", "2025-10-18", "First marathon!", "2025-10-18");
  }
}

// ---------------------------------------------------------------------------
// CONTEXT.md generators
// ---------------------------------------------------------------------------

function newRunnerContext(): string {
  return `# Athlete Profile

## Basic Info
- Name: Alex
- Age: 32
- Location: Helsinki, Finland
- Running since: November 2025

## Current Status
- Beginner runner, ~3 runs per week
- Typical distance: 4-6 km
- No races completed yet
- Building consistent base

## Goals
- Complete a 10K race (spring 2026)
- Run 3-4 times per week consistently
- Avoid injury

## Health Notes
- No current injuries
- Sedentary desk job, running is primary exercise
- Mild IT band tightness after longer runs (>5km)

## Preferences
- Prefers evening runs (after work)
- Runs from home, flat urban routes
- Uses Garmin Forerunner 55

## Training History
- Started C25K program in November 2025
- Graduated to continuous running in December 2025
- Currently running all easy pace
`;
}

function experiencedMarathonerContext(): string {
  return `# Athlete Profile

## Basic Info
- Name: Mikko
- Age: 38
- Location: Helsinki, Finland
- Running since: 2019

## Current Status
- Experienced runner, 5-6 runs per week
- Weekly volume: 60-75 km
- Run types: easy, tempo, intervals, long runs
- Currently training for spring marathon (April 2026)

## Race History
- Marathon: 3:10:49 (Helsinki Marathon, Oct 2025) — PR
- Half Marathon: 1:31:35 (HCR Half, Sep 2025) — PR
- 10K: 41:10 (Helsinki City Run, May 2025) — PR

## Goals
- Break 3:05 at Helsinki Marathon (April 2026)
- Sub-40 10K

## Health Notes
- History of mild plantar fasciitis (resolved 2024)
- Tight calves, does regular stretching
- Recovers well with 1-2 easy days after hard sessions

## Preferences
- Long runs on Sunday mornings
- Quality sessions Tuesday/Thursday
- Easy runs before work (6-7am)
- Uses Garmin Forerunner 265
- Cross-trains with cycling and occasional badminton

## Training Approach
- Follows Pfitzinger-style periodization
- Believes in 80/20 easy/hard split
- Values consistency over heroic workouts
`;
}

function comebackRunnerContext(): string {
  return `# Athlete Profile

## Basic Info
- Name: Sara
- Age: 35
- Location: Helsinki, Finland
- Running since: 2021

## Current Status
- Returning from knee injury (patellofemoral syndrome)
- Was running 50km/week pre-injury
- Currently ~20km/week, rebuilding
- Cleared by physio to run without restrictions (Jan 2026)

## Race History
- Half Marathon: 1:44:00 (pre-injury, spring 2025)
- 10K: 46:50 (spring 2025)

## Goals
- Return to 40-50km weekly volume safely
- Complete a half marathon in fall 2026
- Stay injury-free

## Health Notes
- Knee injury: patellofemoral syndrome, Aug-Oct 2025
- Did physio and strength training during gap
- Currently no pain, but cautious about volume increases
- Doing knee-specific strength work 2x/week

## Preferences
- Prefers flat routes (easier on knee)
- Avoids consecutive hard days
- Cross-trains with cycling
- Uses Garmin Forerunner 255

## Training History
- 4 years of running experience pre-injury
- Was doing fartleks and long runs regularly
- Currently all easy runs + occasional short fartlek
`;
}

function hrZonesFile(vdotEntry: VdotEntry, confirmed: boolean): string {
  return JSON.stringify({
    source: confirmed ? "manual" : "estimated",
    lt1: vdotEntry.lt1Hr,
    lt2: vdotEntry.lt2Hr,
    max_hr: vdotEntry.maxHr,
    confirmed,
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Training plan (experienced marathoner only)
// ---------------------------------------------------------------------------

function trainingPlan(): string {
  return `# Helsinki Marathon Training Plan

**Target Race:** Helsinki Marathon — April 18, 2026
**Goal:** Sub-3:05 (pace: 4:23/km)
**Current Phase:** Build Phase (Week 6 of 16)

## Weekly Structure
- Mon: Easy 10km
- Tue: Quality session (intervals or tempo)
- Wed: Easy 8km
- Thu: Quality session (tempo or threshold)
- Fri: Recovery 6km
- Sat: Rest or cross-training
- Sun: Long run (progressive distance)

## Phase Schedule
- Weeks 1-4: Base (55-65km/week)
- Weeks 5-10: Build (65-80km/week) ← CURRENT
- Weeks 11-14: Peak (75-85km/week)
- Weeks 15-16: Taper

## Current Week (Week 6)
- Mon: Easy 10km @ 5:40-6:00/km
- Tue: 6x1km intervals @ 4:04/km, 400m jog recovery
- Wed: Easy 8km
- Thu: Tempo 8km @ 4:29/km (after 2km warmup, 1km cooldown)
- Fri: Recovery 6km
- Sun: Long run 26km @ 5:20-5:40/km
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const seedIdx = args.indexOf("--seed");
  const seed = seedIdx >= 0 ? parseInt(args[seedIdx + 1]) : 42;

  const fixturesDir = path.join(import.meta.dirname || __dirname, "fixtures");

  console.log(`Generating fixtures with seed ${seed}...`);

  for (const profileConfig of PROFILES) {
    const rng = createRng(seed);
    // Reset global IDs per profile for isolation
    globalActivityId = profileConfig.name === "new-runner" ? 1000000000
      : profileConfig.name === "experienced-marathoner" ? 2000000000
      : 3000000000;
    globalEffortId = globalActivityId * 5;

    console.log(`\n  Profile: ${profileConfig.name} (VDOT ${profileConfig.vdot}, ${profileConfig.weeks} weeks)`);

    const profileDir = path.join(fixturesDir, profileConfig.name);
    const { activities, laps, bestEfforts } = generateProfile(profileConfig, rng);

    const runs = activities.filter(a => a.type === "Run");
    const nonRuns = activities.filter(a => a.type !== "Run");
    console.log(`    Activities: ${activities.length} (${runs.length} runs, ${nonRuns.length} other)`);
    console.log(`    Laps: ${laps.length}`);
    console.log(`    Best efforts: ${bestEfforts.length}`);

    // Write SQLite DB
    const dbPath = path.join(profileDir, "strava/activities.db");
    const db = createDb(dbPath);
    writeActivities(db, activities);
    writeLaps(db, laps);
    writeBestEfforts(db, bestEfforts);

    if (profileConfig.hasPr) {
      writePersonalRecords(db, VDOT_TABLE[profileConfig.vdot]);
    }

    db.close();
    console.log(`    DB written: ${dbPath}`);

    // Write CONTEXT.md
    const contextDir = path.join(profileDir, "athlete");
    fs.mkdirSync(contextDir, { recursive: true });
    const contextContent = profileConfig.name === "new-runner"
      ? newRunnerContext()
      : profileConfig.name === "experienced-marathoner"
        ? experiencedMarathonerContext()
        : comebackRunnerContext();
    fs.writeFileSync(path.join(contextDir, "CONTEXT.md"), contextContent);

    // Write HR zones
    const stravaDir = path.join(profileDir, "strava");
    fs.mkdirSync(stravaDir, { recursive: true });
    const confirmed = profileConfig.name === "experienced-marathoner";
    fs.writeFileSync(path.join(stravaDir, "hr-zones.json"), hrZonesFile(VDOT_TABLE[profileConfig.vdot], confirmed));

    // Write memory dir
    const memoryDir = path.join(profileDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, ".gitkeep"), "");

    // Training plan (experienced only)
    if (profileConfig.hasTrainingPlan) {
      const plansDir = path.join(profileDir, "plans");
      fs.mkdirSync(plansDir, { recursive: true });
      fs.writeFileSync(path.join(plansDir, "marathon-2026.md"), trainingPlan());
    }

    // Stats
    if (runs.length > 0) {
      const totalKm = Math.round(runs.reduce((s, a) => s + a.distance, 0) / 1000);
      const avgPace = runs.reduce((s, a) => s + a.moving_time / (a.distance / 1000), 0) / runs.length;
      const paceMin = Math.floor(avgPace / 60);
      const paceSec = Math.round(avgPace % 60);
      const hrRuns = runs.filter(a => a.average_heartrate);
      const avgHr = hrRuns.length > 0 ? Math.round(hrRuns.reduce((s, a) => s + a.average_heartrate!, 0) / hrRuns.length) : "N/A";
      console.log(`    Total: ${totalKm}km, avg pace: ${paceMin}:${paceSec.toString().padStart(2, "0")}/km, avg HR: ${avgHr}, HR data: ${hrRuns.length}/${runs.length}`);
    }
  }

  console.log("\nDone!");
}

main();
