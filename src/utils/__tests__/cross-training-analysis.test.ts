// Deterministic analysis for continuous cross-training: rides (with or without
// power), walks, hikes, ski, rowing — anything that is neither a run, an
// intermittent HR session nor a lift. Synthetic 1 Hz streams only.

import { describe, test, expect } from "bun:test";
import { computeCrossTrainingAnalysis, CROSS_TRAINING_ANALYSIS_VERSION } from "../cross-training-analysis.js";
import type { HrZones } from "../../types/index.js";

const zones: HrZones = { source: "manual", lt1: 160, lt2: 178, max_hr: 197, confirmed: true };

function stream(seconds: number, watts?: (t: number) => number, hr?: (t: number) => number) {
  const time: number[] = [];
  const w: number[] = [];
  const h: number[] = [];
  for (let t = 0; t < seconds; t++) {
    time.push(t);
    if (watts) w.push(Math.round(watts(t)));
    if (hr) h.push(Math.round(hr(t)));
  }
  return { time, watts: watts ? w : undefined, heartrate: hr ? h : undefined };
}

describe("computeCrossTrainingAnalysis", () => {
  test("has a version", () => {
    expect(CROSS_TRAINING_ANALYSIS_VERSION).toBeGreaterThanOrEqual(1);
  });

  test("steady power: normalized equals average, VI 1.0, work from the integral, peaks all equal", () => {
    const r = computeCrossTrainingAnalysis(stream(3600, () => 200, () => 140), zones);
    expect(r.duration_s).toBe(3599);
    expect(r.power).not.toBeNull();
    expect(r.power!.avg_watts).toBe(200);
    expect(r.power!.normalized_watts).toBe(200);
    expect(r.power!.variability_index).toBeCloseTo(1.0, 2);
    expect(r.power!.work_kj).toBeCloseTo(720, 0);
    expect(r.power!.peaks.p5s_watts).toBe(200);
    expect(r.power!.peaks.p20m_watts).toBe(200);
    expect(r.power!.ftp_estimate_watts).toBe(190);
    expect(r.power!.coasting_pct).toBe(0);
  });

  test("surging power: normalized sits above average and the short peak finds the surge", () => {
    // 60 s at 300 W then 60 s at 100 W, repeated for an hour.
    const r = computeCrossTrainingAnalysis(stream(3600, (t) => (Math.floor(t / 60) % 2 === 0 ? 300 : 100)), zones);
    expect(r.power!.avg_watts).toBe(200);
    expect(r.power!.normalized_watts).toBeGreaterThan(215);
    expect(r.power!.variability_index).toBeGreaterThan(1.05);
    expect(r.power!.peaks.p5s_watts).toBe(300);
    expect(r.power!.peaks.p1m_watts).toBe(300);
    expect(r.hr).toBeNull();
  });

  test("coasting is the share of time at zero watts", () => {
    const r = computeCrossTrainingAnalysis(stream(1000, (t) => (t < 250 ? 0 : 200)), zones);
    expect(r.power!.coasting_pct).toBeCloseTo(25, 0);
  });

  test("a ride shorter than twenty minutes has no 20-minute peak and no FTP estimate", () => {
    const r = computeCrossTrainingAnalysis(stream(900, () => 200), zones);
    expect(r.power!.peaks.p5m_watts).toBe(200);
    expect(r.power!.peaks.p20m_watts).toBeNull();
    expect(r.power!.ftp_estimate_watts).toBeNull();
  });

  test("constant power with rising heart rate shows positive decoupling", () => {
    const r = computeCrossTrainingAnalysis(stream(3600, () => 200, (t) => 130 + 20 * (t / 3600)), zones);
    expect(r.power!.halves.first.avg_hr).toBeLessThan(r.power!.halves.second.avg_hr!);
    expect(r.power!.decoupling_pct).toBeGreaterThan(5);
    expect(r.power!.decoupling_pct).toBeLessThan(20);
  });

  test("steady heart rate with steady power shows near-zero decoupling", () => {
    const r = computeCrossTrainingAnalysis(stream(3600, () => 200, () => 140), zones);
    expect(Math.abs(r.power!.decoupling_pct!)).toBeLessThan(1);
  });

  test("heart rate only: zones, TRIMP and drift are present, power is null", () => {
    const r = computeCrossTrainingAnalysis(stream(3600, undefined, (t) => (t < 1800 ? 140 : 150)), zones);
    expect(r.power).toBeNull();
    expect(r.hr).not.toBeNull();
    expect(r.hr!.avg).toBe(145);
    expect(r.hr!.max).toBe(150);
    expect(r.hr!.max_hr_pct).toBeCloseTo(76.1, 0);
    expect(r.hr!.zones.total_hr_s).toBeGreaterThan(3500);
    expect(r.hr!.trimp).toBeGreaterThan(0);
    expect(r.hr!.first_half_avg).toBe(140);
    expect(r.hr!.second_half_avg).toBe(150);
    expect(r.hr!.drift_pct).toBeCloseTo(7.1, 0);
    expect(r.hr!.time_above_lt1_s).toBe(0);
  });

  test("cadence averages the pedalling samples only", () => {
    const s = { ...stream(100, () => 200), cadence: Array.from({ length: 100 }, (_, i) => (i < 50 ? 0 : 90)) };
    const r = computeCrossTrainingAnalysis(s, zones);
    expect(r.cadence!.avg_rpm).toBe(90);
    expect(r.cadence!.pedalling_pct).toBeGreaterThan(49);
    expect(r.cadence!.pedalling_pct).toBeLessThan(52);
  });

  test("nothing to analyse without heart rate or power", () => {
    const r = computeCrossTrainingAnalysis({ time: [0, 1, 2] }, zones);
    expect(r.hr).toBeNull();
    expect(r.power).toBeNull();
    expect(r.duration_s).toBe(2);
  });
});
