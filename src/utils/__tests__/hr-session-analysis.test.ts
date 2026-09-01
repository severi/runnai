// Deterministic analysis for heart-rate-only sessions: court and racket sports,
// team games, anything intermittent that Strava records without a distance
// stream. The synthetic traces below encode the shape of a real evening of
// 5v5 basketball (warm-up, short games, sit-down breaks) without any athlete data.

import { describe, test, expect } from "bun:test";
import { computeHrSessionAnalysis, HR_SESSION_ANALYSIS_VERSION } from "../hr-session-analysis.js";
import type { HrZones } from "../../types/index.js";

const zones: HrZones = { source: "manual", lt1: 160, lt2: 178, max_hr: 197, confirmed: true };

interface Segment { seconds: number; hr: number | ((t: number) => number) }

/** Concatenate constant or ramped HR segments into a 1 Hz stream. */
function trace(segments: Segment[]): { time: number[]; heartrate: number[] } {
  const time: number[] = [];
  const heartrate: number[] = [];
  let t = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.seconds; i++) {
      time.push(t);
      heartrate.push(Math.round(typeof seg.hr === "function" ? seg.hr(i / seg.seconds) : seg.hr));
      t++;
    }
  }
  return { time, heartrate };
}

const ramp = (from: number, to: number) => (f: number) => from + (to - from) * f;

/** 20 min warm-up, then N games with sit-down breaks between them. */
function basketball(opts: { games: number; peaks?: number[]; floors?: number[] }) {
  const segs: Segment[] = [{ seconds: 600, hr: ramp(105, 140) }, { seconds: 600, hr: ramp(140, 150) }];
  for (let g = 0; g < opts.games; g++) {
    const peak = opts.peaks?.[g] ?? 185;
    segs.push({ seconds: 240, hr: peak });
    if (g < opts.games - 1) {
      const floor = opts.floors?.[g] ?? 130;
      segs.push({ seconds: 90, hr: ramp(peak, floor) }, { seconds: 30, hr: floor });
    }
  }
  return trace(segs);
}

describe("computeHrSessionAnalysis", () => {
  test("exposes a version so cached results can be recomputed on change", () => {
    expect(HR_SESSION_ANALYSIS_VERSION).toBeGreaterThanOrEqual(1);
  });

  test("finds every game and every break of a basketball evening", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 8 }), zones);

    expect(r.bouts).toHaveLength(8);
    expect(r.breaks).toHaveLength(7);
    for (const b of r.bouts) {
      expect(b.peak_hr).toBe(185);
      expect(b.duration_s).toBeGreaterThanOrEqual(200);
      expect(b.duration_s).toBeLessThanOrEqual(300);
    }
    for (const b of r.breaks) {
      expect(b.floor_hr).toBe(130);
      expect(b.drop_bpm).toBe(55);
    }
  });

  test("play starts after the warm-up, and the play-period mean excludes it", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 8 }), zones);

    expect(r.play_start_s).toBeGreaterThanOrEqual(1150);
    expect(r.play_start_s).toBeLessThanOrEqual(1260);
    expect(r.play_avg_hr).toBeGreaterThan(r.avg_hr);
    expect(r.play_avg_hr).toBeGreaterThan(165);
  });

  test("session totals: max, percent of max, time above 90% and above LT2, zones, TRIMP", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 8 }), zones);

    expect(r.duration_s).toBe(1200 + 8 * 240 + 7 * 120 - 1);
    expect(r.max_hr).toBe(185);
    expect(r.max_hr_pct).toBeCloseTo(185 / 197 * 100, 0);
    // 8 games at 185 sit above 90% of 197 (177.3) and above LT2 (178).
    expect(r.time_above_90pct_s).toBeGreaterThanOrEqual(1900);
    expect(r.time_above_90pct_s).toBeLessThanOrEqual(2050);
    expect(r.time_above_lt2_s).toBeGreaterThanOrEqual(1900);
    expect(r.excursions_above_90pct).toBe(8);
    expect(r.hr_zones.total_hr_s).toBeGreaterThan(0);
    expect(r.hr_zones.zone4_s).toBeGreaterThan(0);
    expect(r.trimp).toBeGreaterThan(0);
  });

  test("the largest 60-second drop into each break is reported", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 3 }), zones);
    // Peak 185 ramps to 130 over 90s, so the steepest 60s window sheds about 37 bpm.
    for (const b of r.breaks) {
      expect(b.max_drop_60s_bpm).toBeGreaterThanOrEqual(30);
      expect(b.max_drop_60s_bpm).toBeLessThanOrEqual(45);
    }
  });

  test("low drill bouts before the first full-intensity bout are warm-up, not play", () => {
    const drills = trace([
      { seconds: 600, hr: ramp(105, 140) },
      { seconds: 120, hr: 166 },            // shooting drill
      { seconds: 120, hr: ramp(166, 135) },
      { seconds: 90, hr: 165 },             // another drill
      { seconds: 120, hr: ramp(165, 135) },
    ]);
    const games = basketball({ games: 6 });
    const offset = drills.time.length;
    const merged = {
      time: [...drills.time, ...games.time.slice(1200).map(t => t - 1200 + offset)],
      heartrate: [...drills.heartrate, ...games.heartrate.slice(1200)],
    };
    const r = computeHrSessionAnalysis(merged, zones);

    const warmups = r.bouts.filter(b => b.is_warmup);
    expect(warmups.map(b => b.peak_hr)).toEqual([166, 165]);
    expect(r.bouts.filter(b => !b.is_warmup)).toHaveLength(6);
    // The smoothed stream lags the raw step by a few seconds.
    expect(r.play_start_s).toBeGreaterThanOrEqual(offset);
    expect(r.play_start_s).toBeLessThanOrEqual(offset + 10);
    expect(r.halves.first.bouts + r.halves.second.bouts).toBe(6);
    expect(r.breaks.filter(b => !b.is_warmup)).toHaveLength(5);
    expect(r.peak_drift_bpm).toBe(0);
  });

  test("a steady session reports flat peaks and floors", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 8 }), zones);

    expect(r.halves.first.bouts).toBe(4);
    expect(r.halves.second.bouts).toBe(4);
    expect(r.peak_drift_bpm).toBe(0);
    expect(r.floor_drift_bpm).toBe(0);
  });

  test("fading peaks and rising floors show as signed drift", () => {
    const r = computeHrSessionAnalysis(
      basketball({
        games: 8,
        peaks: [186, 186, 188, 190, 178, 176, 175, 174],
        floors: [130, 128, 126, 145, 150, 155, 158],
      }),
      zones,
    );

    expect(r.peak_drift_bpm).toBeLessThan(-8);
    expect(r.floor_drift_bpm).toBeGreaterThan(15);
  });

  test("adapts its thresholds to a lower-intensity racket session", () => {
    const tennis = trace([
      { seconds: 300, hr: ramp(95, 120) },
      ...Array.from({ length: 6 }, () => [
        { seconds: 300, hr: 150 } as Segment,
        { seconds: 60, hr: ramp(150, 115) } as Segment,
        { seconds: 60, hr: 115 } as Segment,
      ]).flat(),
    ]);
    const r = computeHrSessionAnalysis(tennis, zones);

    expect(r.bouts).toHaveLength(6);
    expect(r.breaks).toHaveLength(5);
    expect(r.bouts[0].peak_hr).toBe(150);
    expect(r.breaks[0].floor_hr).toBe(115);
    expect(r.time_above_90pct_s).toBe(0);
  });

  test("a flat trace has no bouts and null drift instead of invented structure", () => {
    const r = computeHrSessionAnalysis(trace([{ seconds: 1800, hr: 140 }]), zones);

    expect(r.bouts).toHaveLength(0);
    expect(r.breaks).toHaveLength(0);
    expect(r.play_start_s).toBeNull();
    expect(r.peak_drift_bpm).toBeNull();
    expect(r.floor_drift_bpm).toBeNull();
    expect(r.avg_hr).toBe(140);
  });

  test("explicit thresholds override the adaptive ones", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 8 }), zones, {
      bout_enter_bpm: 190,
      bout_exit_bpm: 186,
    });

    expect(r.bouts).toHaveLength(0);
    expect(r.thresholds.bout_enter_bpm).toBe(190);
    expect(r.thresholds.source).toBe("explicit");
  });

  test("reports the thresholds it derived", () => {
    const r = computeHrSessionAnalysis(basketball({ games: 8 }), zones);

    expect(r.thresholds.source).toBe("adaptive");
    expect(r.thresholds.bout_enter_bpm).toBeGreaterThan(150);
    expect(r.thresholds.bout_enter_bpm).toBeLessThan(185);
    expect(r.thresholds.bout_exit_bpm).toBeLessThan(r.thresholds.bout_enter_bpm);
  });
});
