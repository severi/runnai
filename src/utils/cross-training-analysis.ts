/**
 * Deterministic analysis for continuous cross-training sessions.
 *
 * Rides (outdoor, virtual, trainer), walks, hikes, ski, rowing, swimming and
 * similar reach Strava as a continuous effort: a heart-rate stream, often a
 * power stream on the bike, sometimes distance. They are not runs (pace and
 * grade-adjusted pace mean nothing here, and treadmill-style distance is
 * simulated on a trainer), not intermittent sessions (there are no bouts and
 * breaks to cut), and not lifts (HR does reflect intensity here).
 *
 * What applies is the steady-state load: how hard the session was by heart
 * rate and, when present, by power, and whether the two stayed in the same
 * relation from the first half to the second (aerobic decoupling). This
 * module measures exactly that, from the stream alone.
 *
 * Pure functions, no DB, no async. Bump CROSS_TRAINING_ANALYSIS_VERSION
 * whenever an output changes meaning so cached results are recomputed.
 */

import type { HrZones, HrZoneDistribution } from "../types/index.js";
import { rollingAvgTime, computeHrZones, computeTRIMP } from "./stream-analysis.js";

export const CROSS_TRAINING_ANALYSIS_VERSION = 1;

export interface CrossTrainingStream {
  time: number[];
  heartrate?: number[];
  watts?: number[];
  cadence?: number[];
}

export interface CrossTrainingHr {
  avg: number;
  max: number;
  /** Session max as a percentage of the athlete's max HR. */
  max_hr_pct: number;
  zones: HrZoneDistribution;
  trimp: number | null;
  time_above_lt1_s: number;
  time_above_lt2_s: number;
  first_half_avg: number;
  second_half_avg: number;
  /** Second-half mean over first-half mean, minus one, in percent. */
  drift_pct: number;
}

export interface PowerHalf {
  avg_watts: number;
  normalized_watts: number;
  avg_hr: number | null;
  /** Normalized power per heart beat; null without heart rate. */
  pw_hr: number | null;
}

export interface CrossTrainingPower {
  avg_watts: number;
  /** Coggan normalized power: 30 s rolling mean, fourth-power mean, fourth root. */
  normalized_watts: number;
  /** normalized / average. 1.0 is perfectly steady; above ~1.1 is surgy. */
  variability_index: number;
  max_watts: number;
  work_kj: number;
  /** Share of time at zero watts (freewheeling / stopped pedalling). */
  coasting_pct: number;
  peaks: {
    p5s_watts: number | null;
    p1m_watts: number | null;
    p5m_watts: number | null;
    p20m_watts: number | null;
  };
  /**
   * 95% of the 20-minute peak. A ballpark from this ride only; a proper FTP
   * needs a maximal 20-minute effort or a ramp test. Null when the ride is
   * too short for a 20-minute window.
   */
  ftp_estimate_watts: number | null;
  halves: { first: PowerHalf; second: PowerHalf };
  /**
   * Aerobic decoupling: (first-half Pw:Hr - second-half Pw:Hr) / first-half,
   * in percent. Positive means HR climbed relative to power. Under ~5% is
   * the usual "aerobically coupled" mark. Null without heart rate.
   */
  decoupling_pct: number | null;
}

export interface CrossTrainingCadence {
  /** Mean of non-zero samples. */
  avg_rpm: number;
  /** Share of time with cadence above zero. */
  pedalling_pct: number;
}

export interface CrossTrainingAnalysisResult {
  duration_s: number;
  hr: CrossTrainingHr | null;
  power: CrossTrainingPower | null;
  cadence: CrossTrainingCadence | null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Time-weighted mean over [from, to) sample indices. */
function weightedMean(values: number[], time: number[], from: number, to: number): number {
  let sum = 0;
  let dur = 0;
  for (let i = Math.max(from, 1); i < to; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30) continue;
    sum += values[i] * dt;
    dur += dt;
  }
  return dur > 0 ? sum / dur : 0;
}

/** Fourth-power mean of a 30 s rolling average, fourth root. */
function normalizedPower(values: number[], time: number[], from: number, to: number): number {
  const slice = values.slice(from, to);
  const t = time.slice(from, to);
  if (slice.length === 0) return 0;
  const smooth = rollingAvgTime(slice, t, 30);
  let sum = 0;
  let dur = 0;
  for (let i = 1; i < smooth.length; i++) {
    const dt = t[i] - t[i - 1];
    if (dt <= 0 || dt > 30) continue;
    sum += Math.pow(smooth[i], 4) * dt;
    dur += dt;
  }
  return dur > 0 ? Math.pow(sum / dur, 0.25) : 0;
}

/**
 * Highest mean over any window of at least `windowS` seconds. Null when the
 * stream is shorter than the window, so a 15-minute ride has no 20-minute peak.
 */
function peakAverage(values: number[], time: number[], windowS: number): number | null {
  const n = values.length;
  if (n < 2 || time[n - 1] - time[0] < windowS) return null;
  let best = -Infinity;
  let left = 0;
  let sum = 0;
  let dur = 0;
  for (let right = 1; right < n; right++) {
    const dt = time[right] - time[right - 1];
    if (dt > 0 && dt <= 30) {
      sum += values[right] * dt;
      dur += dt;
    }
    while (time[right] - time[left] > windowS) {
      const dtl = time[left + 1] - time[left];
      if (dtl > 0 && dtl <= 30) {
        sum -= values[left + 1] * dtl;
        dur -= dtl;
      }
      left++;
    }
    if (time[right] - time[left] >= windowS - 1 && dur > 0) {
      best = Math.max(best, sum / dur);
    }
  }
  return best === -Infinity ? null : Math.round(best);
}

function timeAbove(hr: number[], time: number[], threshold: number): number {
  let s = 0;
  for (let i = 1; i < hr.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30) continue;
    if (hr[i] > threshold) s += dt;
  }
  return s;
}

function analyseHr(hr: number[], time: number[], zones: HrZones, mid: number): CrossTrainingHr {
  const avg = weightedMean(hr, time, 0, hr.length);
  const first = weightedMean(hr, time, 0, mid);
  const second = weightedMean(hr, time, mid, hr.length);
  return {
    avg: Math.round(avg),
    max: Math.max(...hr),
    max_hr_pct: round1((Math.max(...hr) / zones.max_hr) * 100),
    zones: computeHrZones(hr, time, zones),
    trimp: computeTRIMP(hr, time, zones),
    time_above_lt1_s: timeAbove(hr, time, zones.lt1),
    time_above_lt2_s: timeAbove(hr, time, zones.lt2),
    first_half_avg: Math.round(first),
    second_half_avg: Math.round(second),
    drift_pct: first > 0 ? round1((second / first - 1) * 100) : 0,
  };
}

function powerHalf(watts: number[], hr: number[] | undefined, time: number[], from: number, to: number): PowerHalf {
  const avg = weightedMean(watts, time, from, to);
  const np = normalizedPower(watts, time, from, to);
  const avgHr = hr ? weightedMean(hr, time, from, to) : null;
  return {
    avg_watts: Math.round(avg),
    normalized_watts: Math.round(np),
    avg_hr: avgHr === null ? null : Math.round(avgHr),
    pw_hr: avgHr && avgHr > 0 ? Math.round((np / avgHr) * 1000) / 1000 : null,
  };
}

function analysePower(watts: number[], hr: number[] | undefined, time: number[], mid: number): CrossTrainingPower {
  const n = watts.length;
  const avg = weightedMean(watts, time, 0, n);
  const np = normalizedPower(watts, time, 0, n);
  let work = 0;
  let coast = 0;
  let dur = 0;
  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30) continue;
    work += watts[i] * dt;
    dur += dt;
    if (watts[i] <= 0) coast += dt;
  }
  const p20 = peakAverage(watts, time, 1200);
  const first = powerHalf(watts, hr, time, 0, mid);
  const second = powerHalf(watts, hr, time, mid, n);
  return {
    avg_watts: Math.round(avg),
    normalized_watts: Math.round(np),
    variability_index: avg > 0 ? Math.round((np / avg) * 100) / 100 : 1,
    max_watts: Math.max(...watts),
    work_kj: round1(work / 1000),
    coasting_pct: dur > 0 ? round1((coast / dur) * 100) : 0,
    peaks: {
      p5s_watts: peakAverage(watts, time, 5),
      p1m_watts: peakAverage(watts, time, 60),
      p5m_watts: peakAverage(watts, time, 300),
      p20m_watts: p20,
    },
    ftp_estimate_watts: p20 === null ? null : Math.round(p20 * 0.95),
    halves: { first, second },
    decoupling_pct:
      first.pw_hr && second.pw_hr ? round1(((first.pw_hr - second.pw_hr) / first.pw_hr) * 100) : null,
  };
}

function analyseCadence(cadence: number[], time: number[]): CrossTrainingCadence | null {
  let sum = 0;
  let pedal = 0;
  let dur = 0;
  for (let i = 1; i < cadence.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30) continue;
    dur += dt;
    if (cadence[i] > 0) {
      sum += cadence[i] * dt;
      pedal += dt;
    }
  }
  if (dur === 0 || pedal === 0) return null;
  return { avg_rpm: Math.round(sum / pedal), pedalling_pct: round1((pedal / dur) * 100) };
}

export function computeCrossTrainingAnalysis(
  stream: CrossTrainingStream,
  zones: HrZones,
): CrossTrainingAnalysisResult {
  const { time } = stream;
  const n = time.length;
  const duration_s = n > 0 ? time[n - 1] - time[0] : 0;
  // Split halves by elapsed time, not by sample count, so a pause does not
  // shift the midpoint.
  const midTime = time[0] + duration_s / 2;
  let mid = n;
  for (let i = 0; i < n; i++) {
    if (time[i] >= midTime) { mid = i; break; }
  }

  const hr = stream.heartrate?.length === n ? stream.heartrate : undefined;
  const watts = stream.watts?.length === n ? stream.watts : undefined;
  const cadence = stream.cadence?.length === n ? stream.cadence : undefined;

  return {
    duration_s,
    hr: hr && n > 1 ? analyseHr(hr, time, zones, mid) : null,
    power: watts && n > 1 ? analysePower(watts, hr, time, mid) : null,
    cadence: cadence && n > 1 ? analyseCadence(cadence, time) : null,
  };
}
