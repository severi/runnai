import { describe, test, expect } from "bun:test";
import {
  extractEasyPaceSamples,
  analyzeDrift,
  DRIFT_CONFIG,
  type EasyPaceSample,
} from "../fitness-drift.js";
import type { HrZones, PhaseSegment, PaceRange } from "../../types/index.js";

const HR_ZONES: HrZones = {
  source: "lactate_test",
  lt1: 152,
  lt2: 178,
  max_hr: 197,
  confirmed: true,
};

// Z2 band given LT1=152: 152*0.88=133.76 to 152.0
function workPhase(distance_m: number, pace: number, hr: number, withHr: boolean = true): PhaseSegment {
  return {
    phase: "work",
    start_s: 0,
    end_s: 1000,
    distance_m,
    avg_pace_sec_per_km: pace,
    avg_hr: withHr ? hr : null,
    peak_hr: null,
    elevation_gain_m: 0,
    elevation_loss_m: 0,
    hr_trend: null,
  };
}

function makeRow(opts: {
  id: number;
  date: string;
  run_type?: string | null;
  cardiac_drift_pct?: number | null;
  phases: PhaseSegment[];
}) {
  return {
    id: opts.id,
    start_date_local: opts.date + "T07:00:00",
    run_type: opts.run_type ?? "easy",
    cardiac_drift_pct: opts.cardiac_drift_pct ?? 2,
    phases: JSON.stringify(opts.phases),
  };
}

describe("extractEasyPaceSamples", () => {
  test("extracts work phases with HR in Z2 band", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        phases: [workPhase(5000, 310, 145)],
      }),
    ];
    const samples = extractEasyPaceSamples(rows, HR_ZONES);
    expect(samples).toHaveLength(1);
    expect(samples[0].paceSecPerKm).toBe(310);
    expect(samples[0].avgHr).toBe(145);
  });

  test("excludes phases below the Z2 HR band (recovery zone)", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        phases: [workPhase(5000, 380, 120)], // HR 120 is below 134
      }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(0);
  });

  test("excludes phases above the Z2 HR band (tempo)", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        phases: [workPhase(5000, 280, 165)], // HR 165 is above LT1=152
      }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(0);
  });

  test("excludes short phases below MIN_PHASE_DISTANCE_M", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        phases: [workPhase(1500, 300, 145)], // 1.5km < 2km min
      }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(0);
  });

  test("excludes runs with high cardiac drift", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        cardiac_drift_pct: 12,
        phases: [workPhase(5000, 310, 145)],
      }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(0);
  });

  test("excludes tempo, intervals, threshold, race, fartlek runs", () => {
    const rows = [
      makeRow({ id: 1, date: "2026-04-01", run_type: "tempo", phases: [workPhase(5000, 310, 145)] }),
      makeRow({ id: 2, date: "2026-04-02", run_type: "intervals", phases: [workPhase(5000, 310, 145)] }),
      makeRow({ id: 3, date: "2026-04-03", run_type: "threshold", phases: [workPhase(5000, 310, 145)] }),
      makeRow({ id: 4, date: "2026-04-04", run_type: "race", phases: [workPhase(5000, 310, 145)] }),
      makeRow({ id: 5, date: "2026-04-05", run_type: "fartlek", phases: [workPhase(5000, 310, 145)] }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(0);
  });

  test("includes easy and long_run types", () => {
    const rows = [
      makeRow({ id: 1, date: "2026-04-01", run_type: "easy", phases: [workPhase(5000, 310, 145)] }),
      makeRow({ id: 2, date: "2026-04-02", run_type: "long_run", phases: [workPhase(8000, 320, 148)] }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(2);
  });

  test("extracts multiple work phases from a single run", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        phases: [
          workPhase(2000, 320, 142),
          workPhase(3000, 305, 146),
          { phase: "recovery", start_s: 0, end_s: 100, distance_m: 200, avg_pace_sec_per_km: 480, avg_hr: 130, peak_hr: null, elevation_gain_m: 0, elevation_loss_m: 0, hr_trend: null },
          workPhase(2500, 312, 144),
        ],
      }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(3);
  });

  test("skips phases with null HR or null pace", () => {
    const rows = [
      makeRow({
        id: 1,
        date: "2026-04-01",
        phases: [
          workPhase(5000, 310, 145, false), // null hr
          { phase: "work", start_s: 0, end_s: 100, distance_m: 5000, avg_pace_sec_per_km: null, avg_hr: 145, peak_hr: null, elevation_gain_m: 0, elevation_loss_m: 0, hr_trend: null },
        ],
      }),
    ];
    expect(extractEasyPaceSamples(rows, HR_ZONES)).toHaveLength(0);
  });
});

describe("analyzeDrift", () => {
  function makeSamples(count: number, paceMedian: number, daysSpan: number): EasyPaceSample[] {
    const samples: EasyPaceSample[] = [];
    const start = new Date(2026, 2, 15); // Mar 15
    for (let i = 0; i < count; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + Math.floor((i / count) * daysSpan));
      samples.push({
        date: d.toISOString().slice(0, 10),
        activityId: 1000 + i,
        paceSecPerKm: paceMedian + (i % 5 === 0 ? 5 : -3), // small noise around median
        avgHr: 145,
        distanceM: 5000,
      });
    }
    return samples;
  }

  const stored: PaceRange = { min_sec: 350, max_sec: 380 }; // 5:50–6:20/km, midpoint 365

  test("returns low confidence with no samples", () => {
    const result = analyzeDrift([], stored);
    expect(result.sample_count).toBe(0);
    expect(result.confidence).toBe("low");
    expect(result.should_prompt).toBe(false);
  });

  test("flags high-confidence improvement when samples exceed thresholds", () => {
    // 22 samples over 22 days, median ~310 (45s/km faster than midpoint 365)
    const samples = makeSamples(22, 310, 22);
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("improving");
    expect(result.confidence).toBe("high");
    expect(result.should_prompt).toBe(true);
    expect(result.delta_sec_per_km).toBeLessThan(-30);
    expect(result.observed_easy_pace_sec).toBeGreaterThan(300);
    expect(result.observed_easy_pace_sec).toBeLessThan(320);
  });

  test("does NOT flag improvement with too few samples", () => {
    const samples = makeSamples(5, 310, 22);
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("improving");
    expect(result.should_prompt).toBe(false);
    expect(result.confidence === "low" || result.confidence === "medium").toBe(true);
  });

  test("does NOT flag improvement with too short a window", () => {
    const samples = makeSamples(15, 310, 5); // 15 samples but only 5 days
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("improving");
    expect(result.should_prompt).toBe(false);
  });

  test("requires longer window to flag a decline", () => {
    // 12 samples over 12 days, median 400 (35s slower) — would trigger if improving, but declining needs more
    const samples = makeSamples(12, 400, 12);
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("declining");
    expect(result.should_prompt).toBe(false);
  });

  test("flags high-confidence decline only when samples and window meet stricter thresholds", () => {
    // 22 samples over 25 days, median 400
    const samples = makeSamples(22, 400, 25);
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("declining");
    expect(result.confidence).toBe("high");
    expect(result.should_prompt).toBe(true);
  });

  test("treats small delta as stable (within MIN_DELTA_SEC_PER_KM)", () => {
    const samples = makeSamples(15, 360, 22); // 5s/km from midpoint 365
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("stable");
    expect(result.should_prompt).toBe(false);
  });

  test("does NOT report high-confidence stable when window is too short", () => {
    // 15 samples crammed into a 3-day window — no temporal spread
    const samples = makeSamples(15, 360, 3);
    const result = analyzeDrift(samples, stored);
    expect(result.direction).toBe("stable");
    expect(result.confidence).not.toBe("high");
    expect(result.should_prompt).toBe(false);
  });

  test("handles missing stored zone (first time setup)", () => {
    const samples = makeSamples(15, 310, 22);
    const result = analyzeDrift(samples, null);
    expect(result.stored_easy_pace).toBeNull();
    expect(result.delta_sec_per_km).toBeNull();
    expect(result.should_prompt).toBe(true);
    expect(result.summary).toContain("propose initial");
  });

  test("the asymmetric thresholds match DRIFT_CONFIG", () => {
    expect(DRIFT_CONFIG.IMPROVING_MIN_SAMPLES).toBeLessThan(DRIFT_CONFIG.DECLINING_MIN_SAMPLES);
    expect(DRIFT_CONFIG.IMPROVING_MIN_DAYS).toBeLessThan(DRIFT_CONFIG.DECLINING_MIN_DAYS);
  });
});
