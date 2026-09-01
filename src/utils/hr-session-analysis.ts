/**
 * Deterministic analysis for heart-rate-only sessions.
 *
 * Court and racket sports, team games and most gym classes reach Strava with a
 * full 1 Hz heartrate stream and no distance, so none of the pace-derived
 * run metrics apply. What does apply is the intermittent shape of the effort:
 * bouts of play up near max, breaks between them, and whether the athlete
 * produced the same peaks and returned to the same floors late in the session
 * as early. This module measures exactly that, from the stream alone.
 *
 * Pure functions, no DB, no async. Bump HR_SESSION_ANALYSIS_VERSION whenever
 * an output changes meaning so cached results are recomputed.
 */

import type { HrZones, HrZoneDistribution } from "../types/index.js";
import { rollingAvgTime, computeHrZones, computeTRIMP } from "./stream-analysis.js";

export const HR_SESSION_ANALYSIS_VERSION = 1;

export interface HrOnlyStream {
  time: number[];
  heartrate: number[];
}

export interface HrSessionOptions {
  /** Smoothed HR at or above this starts a bout. Default: adaptive from the session. */
  bout_enter_bpm?: number;
  /** Smoothed HR below this for min_break_s confirms a break. Default: adaptive. */
  bout_exit_bpm?: number;
  /** Bouts shorter than this are ignored. Default 60. */
  min_bout_s?: number;
  /** A dip must last this long below the exit threshold to count as a break. Default 30. */
  min_break_s?: number;
  /** Rolling-average window for bout detection. Default 10. */
  smooth_s?: number;
}

export interface HrBout {
  index: number;
  start_s: number;
  end_s: number;
  duration_s: number;
  peak_hr: number;
  mean_hr: number;
  /**
   * True for bouts before the first full-intensity bout (peak within 90% of
   * the session's highest bout peak): drills and warm-up games, not play.
   */
  is_warmup: boolean;
}

export interface HrBreak {
  /** Index of the bout this break follows. */
  after_bout: number;
  start_s: number;
  end_s: number;
  duration_s: number;
  floor_hr: number;
  /** Preceding bout's peak minus this break's floor. */
  drop_bpm: number;
  /**
   * Largest fall in any 60 s window from the bout's final minute through the
   * break. Null when no full 60 s window fits.
   */
  max_drop_60s_bpm: number | null;
  /** True when the break follows a warm-up bout. */
  is_warmup: boolean;
}

export interface HrHalfSummary {
  bouts: number;
  breaks: number;
  mean_peak_hr: number | null;
  mean_floor_hr: number | null;
}

export interface HrSessionAnalysisResult {
  version: number;
  duration_s: number;
  avg_hr: number;
  max_hr: number;
  /** Session max as a percentage of the athlete's max HR. */
  max_hr_pct: number;
  /** Start of the first full-intensity bout; null when no bouts were found. */
  play_start_s: number | null;
  /** Mean HR from the first bout's start to the last bout's end; null without bouts. */
  play_avg_hr: number | null;
  time_above_90pct_s: number;
  time_above_lt2_s: number;
  /** Contiguous stretches of at least 5 s at or above 90% of max HR. */
  excursions_above_90pct: number;
  hr_zones: HrZoneDistribution;
  trimp: number | null;
  thresholds: {
    source: "adaptive" | "explicit";
    bout_enter_bpm: number;
    bout_exit_bpm: number;
  };
  bouts: HrBout[];
  breaks: HrBreak[];
  halves: { first: HrHalfSummary; second: HrHalfSummary };
  /** Second-half mean peak minus first-half mean peak. Negative means the peaks faded. */
  peak_drift_bpm: number | null;
  /** Second-half mean floor minus first-half mean floor. Positive means recovery got shallower. */
  floor_drift_bpm: number | null;
}

const DEFAULTS = { min_bout_s: 60, min_break_s: 30, smooth_s: 10 };
/** Below this spread between the 20th and 90th percentile the session has no bout structure. */
const MIN_SPREAD_BPM = 15;
const ENTER_FRACTION = 0.6;
const EXIT_FRACTION = 0.4;
/** A bout peaking below this share of the session's top bout peak, before that peak is first reached, is warm-up. */
const WARMUP_PEAK_FRACTION = 0.9;

export function computeHrSessionAnalysis(
  streams: HrOnlyStream,
  zones: HrZones,
  options: HrSessionOptions = {},
): HrSessionAnalysisResult {
  const { time, heartrate: hr } = streams;
  const n = Math.min(time.length, hr.length);
  if (n === 0) throw new Error("Empty heartrate stream");

  const minBoutS = options.min_bout_s ?? DEFAULTS.min_bout_s;
  const minBreakS = options.min_break_s ?? DEFAULTS.min_break_s;
  const smoothS = options.smooth_s ?? DEFAULTS.smooth_s;

  const smoothed = rollingAvgTime(hr, time, smoothS);
  const thresholds = resolveThresholds(hr, options);
  const rawBouts = thresholds ? detectBouts(smoothed, time, thresholds, minBreakS) : [];
  const bouts = rawBouts.filter(b => b.end - b.start >= minBoutS).map((b, i) => summariseBout(i, b, hr, time));
  flagWarmup(bouts);
  const breaks = buildBreaks(bouts, hr, time);
  const play = bouts.filter(b => !b.is_warmup);
  const halves = splitHalves(play, breaks.filter(b => !b.is_warmup));

  const ninety = zones.max_hr * 0.9;
  const duration = time[n - 1] - time[0];
  const playStart = play.length ? play[0].start_s : null;
  const playEnd = play.length ? play[play.length - 1].end_s : null;

  return {
    version: HR_SESSION_ANALYSIS_VERSION,
    duration_s: duration,
    avg_hr: round1(mean(hr.slice(0, n))),
    max_hr: Math.max(...hr.slice(0, n)),
    max_hr_pct: round1((Math.max(...hr.slice(0, n)) / zones.max_hr) * 100),
    play_start_s: playStart,
    play_avg_hr: playStart !== null && playEnd !== null
      ? round1(mean(hr.slice(indexAt(time, playStart), indexAt(time, playEnd) + 1)))
      : null,
    time_above_90pct_s: timeAtOrAbove(hr, time, ninety),
    time_above_lt2_s: timeAtOrAbove(hr, time, zones.lt2),
    excursions_above_90pct: countExcursions(hr, time, ninety, 5),
    hr_zones: computeHrZones(smoothed, time, zones),
    trimp: computeTRIMP(hr, time, zones),
    thresholds: thresholds
      ? { source: thresholds.source, bout_enter_bpm: thresholds.enter, bout_exit_bpm: thresholds.exit }
      : { source: "adaptive", bout_enter_bpm: 0, bout_exit_bpm: 0 },
    bouts,
    breaks,
    halves,
    peak_drift_bpm: diff(halves.second.mean_peak_hr, halves.first.mean_peak_hr),
    floor_drift_bpm: diff(halves.second.mean_floor_hr, halves.first.mean_floor_hr),
  };
}

// --- Thresholds ---

interface Thresholds { source: "adaptive" | "explicit"; enter: number; exit: number }

function resolveThresholds(hr: number[], options: HrSessionOptions): Thresholds | null {
  if (options.bout_enter_bpm !== undefined || options.bout_exit_bpm !== undefined) {
    const enter = options.bout_enter_bpm ?? (options.bout_exit_bpm! + 10);
    const exit = options.bout_exit_bpm ?? (enter - 10);
    return { source: "explicit", enter, exit };
  }
  const p20 = percentile(hr, 0.2);
  const p90 = percentile(hr, 0.9);
  const spread = p90 - p20;
  if (spread < MIN_SPREAD_BPM) return null;
  return {
    source: "adaptive",
    enter: Math.round(p20 + ENTER_FRACTION * spread),
    exit: Math.round(p20 + EXIT_FRACTION * spread),
  };
}

// --- Bout detection ---

interface RawBout { start: number; end: number }

/**
 * Hysteresis state machine on the smoothed stream. A bout begins when HR
 * reaches the enter threshold. It ends at the last sample at or above enter
 * before a dip that stays below the exit threshold for min_break_s, so a short
 * sag between two games (never reaching exit) stays inside one bout, while a
 * real sit-down splits them.
 */
function detectBouts(smoothed: number[], time: number[], t: Thresholds, minBreakS: number): RawBout[] {
  const bouts: RawBout[] = [];
  let inBout = false;
  let start = 0;
  let lastAboveEnter = 0;
  let belowExitSince: number | null = null;

  for (let i = 0; i < smoothed.length; i++) {
    const v = smoothed[i];
    if (!inBout) {
      if (v >= t.enter) { inBout = true; start = i; lastAboveEnter = i; belowExitSince = null; }
      continue;
    }
    if (v >= t.enter) { lastAboveEnter = i; belowExitSince = null; continue; }
    if (v < t.exit) {
      if (belowExitSince === null) belowExitSince = i;
      if (time[i] - time[belowExitSince] >= minBreakS) {
        bouts.push({ start: time[start], end: time[lastAboveEnter] });
        inBout = false;
        belowExitSince = null;
      }
    }
  }
  if (inBout) bouts.push({ start: time[start], end: time[lastAboveEnter] });
  return bouts;
}

function summariseBout(index: number, b: RawBout, hr: number[], time: number[]): HrBout {
  const i0 = indexAt(time, b.start);
  const i1 = indexAt(time, b.end);
  const slice = hr.slice(i0, i1 + 1);
  return {
    index,
    start_s: b.start,
    end_s: b.end,
    duration_s: b.end - b.start,
    peak_hr: Math.max(...slice),
    mean_hr: round1(mean(slice)),
    is_warmup: false,
  };
}

function flagWarmup(bouts: HrBout[]): void {
  if (bouts.length === 0) return;
  const top = Math.max(...bouts.map(b => b.peak_hr));
  for (const b of bouts) {
    if (b.peak_hr >= top * WARMUP_PEAK_FRACTION) break;
    b.is_warmup = true;
  }
}

function buildBreaks(bouts: HrBout[], hr: number[], time: number[]): HrBreak[] {
  const breaks: HrBreak[] = [];
  for (let i = 0; i + 1 < bouts.length; i++) {
    const prev = bouts[i];
    const next = bouts[i + 1];
    const i0 = indexAt(time, prev.end_s);
    const i1 = indexAt(time, next.start_s);
    const floor = Math.min(...hr.slice(i0, i1 + 1));
    breaks.push({
      after_bout: prev.index,
      start_s: prev.end_s,
      end_s: next.start_s,
      duration_s: next.start_s - prev.end_s,
      floor_hr: floor,
      drop_bpm: prev.peak_hr - floor,
      max_drop_60s_bpm: maxDrop60(hr, time, prev.end_s - 60, next.start_s),
      is_warmup: prev.is_warmup,
    });
  }
  return breaks;
}

/** Largest hr[t] - hr[t + 60] with both samples inside [fromS, toS]. */
function maxDrop60(hr: number[], time: number[], fromS: number, toS: number): number | null {
  let best: number | null = null;
  const iFrom = indexAt(time, Math.max(fromS, time[0]));
  for (let i = iFrom; i < hr.length && time[i] + 60 <= toS; i++) {
    const j = indexAt(time, time[i] + 60);
    if (time[j] !== time[i] + 60) continue;
    const drop = hr[i] - hr[j];
    if (best === null || drop > best) best = drop;
  }
  return best;
}

function splitHalves(bouts: HrBout[], breaks: HrBreak[]): HrSessionAnalysisResult["halves"] {
  const empty = (): HrHalfSummary => ({ bouts: 0, breaks: 0, mean_peak_hr: null, mean_floor_hr: null });
  if (bouts.length === 0) return { first: empty(), second: empty() };
  const playStart = bouts[0].start_s;
  const playEnd = bouts[bouts.length - 1].end_s;
  const mid = (playStart + playEnd) / 2;
  const isFirst = (a: number, b: number) => (a + b) / 2 < mid;

  const firstBouts = bouts.filter(b => isFirst(b.start_s, b.end_s));
  const secondBouts = bouts.filter(b => !isFirst(b.start_s, b.end_s));
  const firstBreaks = breaks.filter(b => isFirst(b.start_s, b.end_s));
  const secondBreaks = breaks.filter(b => !isFirst(b.start_s, b.end_s));

  const summary = (bs: HrBout[], ks: HrBreak[]): HrHalfSummary => ({
    bouts: bs.length,
    breaks: ks.length,
    mean_peak_hr: bs.length ? round1(mean(bs.map(b => b.peak_hr))) : null,
    mean_floor_hr: ks.length ? round1(mean(ks.map(k => k.floor_hr))) : null,
  });
  return { first: summary(firstBouts, firstBreaks), second: summary(secondBouts, secondBreaks) };
}

// --- Totals ---

function timeAtOrAbove(hr: number[], time: number[], threshold: number): number {
  let total = 0;
  for (let i = 1; i < hr.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 30) continue;
    if (hr[i] >= threshold) total += dt;
  }
  return total;
}

function countExcursions(hr: number[], time: number[], threshold: number, minS: number): number {
  let count = 0;
  let since: number | null = null;
  for (let i = 0; i < hr.length; i++) {
    if (hr[i] >= threshold) {
      if (since === null) since = time[i];
    } else if (since !== null) {
      if (time[i - 1] - since >= minS) count++;
      since = null;
    }
  }
  if (since !== null && time[hr.length - 1] - since >= minS) count++;
  return count;
}

// --- Helpers ---

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Index of the first sample whose time is at or after t (clamped to the last sample). */
function indexAt(time: number[], t: number): number {
  let lo = 0;
  let hi = time.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (time[m] < t) lo = m + 1; else hi = m;
  }
  return lo;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function diff(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : round1(a - b);
}
