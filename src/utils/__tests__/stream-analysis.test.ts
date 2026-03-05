import { describe, test, expect } from "bun:test";
import {
  computeStreamAnalysis,
  distanceWindowSmooth,
  minettiGapFactor,
  detectManualLaps,
  STREAM_ANALYSIS_VERSION,
} from "../stream-analysis.js";
import type { LapHint } from "../stream-analysis.js";
import type { ActivityStream, HrZones } from "../../types/index.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

/** Generate a uniform run: constant pace, constant HR, flat terrain */
function makeUniformRun(opts: {
  durationS: number;
  paceSecPerKm: number;
  hr?: number;
  cadence?: number;
  gradePct?: number;
}): ActivityStream {
  const n = opts.durationS + 1; // include t=0
  const speedMS = 1000 / opts.paceSecPerKm;
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] | undefined = opts.hr ? [] : undefined;
  const cadence: number[] | undefined = opts.cadence ? [] : undefined;
  const grade_smooth: number[] | undefined = opts.gradePct != null ? [] : undefined;

  for (let i = 0; i < n; i++) {
    time.push(i);
    distance.push(i * speedMS);
    if (heartrate) heartrate.push(opts.hr!);
    if (cadence) cadence.push(opts.cadence!);
    if (grade_smooth) grade_smooth.push(opts.gradePct!);
  }

  return { time, distance, heartrate, cadence, grade_smooth };
}

/** Generate a run with two distinct paces (for split type / phase detection) */
function makeSplitRun(opts: {
  firstHalfPace: number;  // sec/km
  secondHalfPace: number; // sec/km
  halfDurationS: number;
  hr?: number;
}): ActivityStream {
  const speed1 = 1000 / opts.firstHalfPace;
  const speed2 = 1000 / opts.secondHalfPace;
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] | undefined = opts.hr ? [] : undefined;

  let dist = 0;
  const totalDuration = opts.halfDurationS * 2;
  for (let t = 0; t <= totalDuration; t++) {
    time.push(t);
    distance.push(dist);
    if (heartrate) heartrate.push(opts.hr!);
    const speed = t <= opts.halfDurationS ? speed1 : speed2;
    dist += speed;
  }

  return { time, distance, heartrate };
}

/** Standard HR zones for testing */
const TEST_ZONES: HrZones = {
  source: "lactate_test",
  lt1: 150,
  lt2: 170,
  max_hr: 190,
  confirmed: true,
};

// ─── distanceWindowSmooth ────────────────────────────────────────────────────

describe("distanceWindowSmooth", () => {
  test("smooths altitude over a distance window", () => {
    // Altitude with a spike; 100m window should dampen it
    const values = [100, 100, 110, 100, 100];
    const dist = [0, 50, 100, 150, 200];
    const smoothed = distanceWindowSmooth(values, dist, 100);
    expect(smoothed).toHaveLength(5);
    // The spike at index 2 should be reduced
    expect(smoothed[2]).toBeLessThan(110);
    expect(smoothed[2]).toBeGreaterThan(100);
  });

  test("returns original values for zero window", () => {
    const values = [10, 20, 30];
    const dist = [0, 100, 200];
    const smoothed = distanceWindowSmooth(values, dist, 0);
    expect(smoothed).toEqual(values);
  });

  test("handles empty arrays", () => {
    expect(distanceWindowSmooth([], [], 100)).toEqual([]);
  });

  test("single element returns itself", () => {
    expect(distanceWindowSmooth([42], [0], 100)).toEqual([42]);
  });
});

// ─── minettiGapFactor ────────────────────────────────────────────────────────

describe("minettiGapFactor", () => {
  test("flat grade returns factor ~1.0", () => {
    expect(minettiGapFactor(0)).toBeCloseTo(1.0, 5);
  });

  test("uphill returns factor > 1.0", () => {
    expect(minettiGapFactor(10)).toBeGreaterThan(1.0);
  });

  test("downhill returns factor < 1.0", () => {
    expect(minettiGapFactor(-10)).toBeLessThan(1.0);
  });

  test("steep uphill (20%) is harder than moderate (10%)", () => {
    expect(minettiGapFactor(20)).toBeGreaterThan(minettiGapFactor(10));
  });

  test("extreme grades are clamped (no blow-up)", () => {
    // 100% grade should be clamped to 45%
    const extreme = minettiGapFactor(100);
    const clamped = minettiGapFactor(45);
    expect(extreme).toBeCloseTo(clamped, 5);
  });
});

// ─── computeStreamAnalysis: minimal / edge cases ─────────────────────────────

describe("computeStreamAnalysis", () => {
  describe("edge cases", () => {
    test("very short run (< 10 data points) returns empty phases", () => {
      const streams: ActivityStream = {
        time: [0, 1, 2, 3, 4],
        distance: [0, 3, 6, 9, 12],
      };
      const result = computeStreamAnalysis(streams, null, 4, 360);
      expect(result.phases).toEqual([]);
      expect(result.intervals).toEqual([]);
      expect(result.stream_analysis_version).toBe(STREAM_ANALYSIS_VERSION);
    });

    test("no HR streams yields null for HR-dependent metrics", () => {
      const streams = makeUniformRun({ durationS: 120, paceSecPerKm: 300 });
      delete (streams as any).heartrate;
      const result = computeStreamAnalysis(streams, TEST_ZONES, 120, 300);
      expect(result.hr_zones).toBeNull();
      expect(result.cardiac_drift_pct).toBeNull();
      expect(result.trimp).toBeNull();
      expect(result.efficiency_factor).toBeNull();
    });

    test("no grade stream yields null for NGP and EF", () => {
      const streams = makeUniformRun({ durationS: 120, paceSecPerKm: 300, hr: 160 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 120, 300);
      expect(result.ngp_sec_per_km).toBeNull();
      expect(result.efficiency_factor).toBeNull();
    });

    test("null hrZones yields null for hr_zones and trimp", () => {
      const streams = makeUniformRun({ durationS: 120, paceSecPerKm: 300, hr: 160 });
      const result = computeStreamAnalysis(streams, null, 120, 300);
      expect(result.hr_zones).toBeNull();
      expect(result.trimp).toBeNull();
    });
  });

  // ─── Tier 1: HR Zones ──────────────────────────────────────────────────────

  describe("HR zone distribution", () => {
    test("constant HR in zone 3 accumulates all time in zone 3", () => {
      // Zone 3 = LT1 (150) to LT2 (170)
      const streams = makeUniformRun({ durationS: 300, paceSecPerKm: 300, hr: 160 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 300, 300);
      const z = result.hr_zones!;
      expect(z.zone3_s).toBeGreaterThan(0);
      expect(z.zone1_s).toBe(0);
      expect(z.zone2_s).toBe(0);
      expect(z.zone4_s).toBe(0);
      expect(z.zone5_s).toBe(0);
      // Total should be close to duration (minus smoothing ramp-up)
      expect(z.total_hr_s).toBeGreaterThan(250);
    });

    test("HR below zone 1 ceiling goes to zone 1", () => {
      // Zone 1 = < lt1 * 0.88 = < 132
      const streams = makeUniformRun({ durationS: 300, paceSecPerKm: 300, hr: 120 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 300, 300);
      expect(result.hr_zones!.zone1_s).toBeGreaterThan(0);
      expect(result.hr_zones!.zone2_s).toBe(0);
    });

    test("HR above maxHR * 0.97 goes to zone 5", () => {
      // Zone 5 = >= 190 * 0.97 = >= 184.3
      const streams = makeUniformRun({ durationS: 300, paceSecPerKm: 300, hr: 188 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 300, 300);
      expect(result.hr_zones!.zone5_s).toBeGreaterThan(0);
    });
  });

  // ─── Tier 1: Cardiac Drift ─────────────────────────────────────────────────

  describe("cardiac drift", () => {
    test("constant pace and HR yields near-zero drift", () => {
      const streams = makeUniformRun({ durationS: 1200, paceSecPerKm: 300, hr: 155 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 1200, 300);
      expect(result.cardiac_drift_pct).not.toBeNull();
      expect(Math.abs(result.cardiac_drift_pct!)).toBeLessThan(1);
    });

    test("returns null for runs < 10 min", () => {
      const streams = makeUniformRun({ durationS: 300, paceSecPerKm: 300, hr: 155 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 300, 300);
      expect(result.cardiac_drift_pct).toBeNull();
    });

    test("rising HR with constant pace yields positive drift", () => {
      // Build a run where HR rises from 150 to 170 over 20 min
      const n = 1201;
      const speedMS = 1000 / 300; // 5:00/km
      const time: number[] = [];
      const distance: number[] = [];
      const heartrate: number[] = [];
      for (let i = 0; i < n; i++) {
        time.push(i);
        distance.push(i * speedMS);
        heartrate.push(150 + (20 * i) / (n - 1)); // 150 → 170
      }
      const streams: ActivityStream = { time, distance, heartrate };
      const result = computeStreamAnalysis(streams, TEST_ZONES, 1200, 300);
      expect(result.cardiac_drift_pct).not.toBeNull();
      expect(result.cardiac_drift_pct!).toBeGreaterThan(0);
    });
  });

  // ─── Tier 1: Pace Variability ──────────────────────────────────────────────

  describe("pace variability CV", () => {
    test("constant pace yields low CV", () => {
      const streams = makeUniformRun({ durationS: 300, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 300, 300);
      expect(result.pace_variability_cv).not.toBeNull();
      expect(result.pace_variability_cv!).toBeLessThan(5);
    });

    test("returns null for very short runs (< 30 moving samples)", () => {
      const streams = makeUniformRun({ durationS: 20, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 20, 300);
      expect(result.pace_variability_cv).toBeNull();
    });
  });

  // ─── Tier 1: Split Type ────────────────────────────────────────────────────

  describe("split type", () => {
    test("even pace yields 'even'", () => {
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 600, 300);
      expect(result.split_type).toBe("even");
    });

    test("faster second half yields 'negative' split", () => {
      // First half 5:30/km, second half 4:30/km
      const streams = makeSplitRun({
        firstHalfPace: 330, secondHalfPace: 270,
        halfDurationS: 300,
      });
      const result = computeStreamAnalysis(streams, null, 600, 300);
      expect(result.split_type).toBe("negative");
    });

    test("slower second half yields 'positive' split", () => {
      const streams = makeSplitRun({
        firstHalfPace: 270, secondHalfPace: 330,
        halfDurationS: 300,
      });
      const result = computeStreamAnalysis(streams, null, 600, 300);
      expect(result.split_type).toBe("positive");
    });

    test("returns null for runs < 1km", () => {
      // 60s at 5:00/km = ~200m, well under 1km
      const streams = makeUniformRun({ durationS: 60, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 60, 300);
      expect(result.split_type).toBeNull();
    });
  });

  // ─── Tier 1: TRIMP ────────────────────────────────────────────────────────

  describe("TRIMP", () => {
    test("produces positive TRIMP for a real run", () => {
      const streams = makeUniformRun({ durationS: 1200, paceSecPerKm: 300, hr: 160 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 1200, 300);
      expect(result.trimp).not.toBeNull();
      expect(result.trimp!).toBeGreaterThan(0);
    });

    test("higher HR produces higher TRIMP", () => {
      const low = makeUniformRun({ durationS: 600, paceSecPerKm: 300, hr: 140 });
      const high = makeUniformRun({ durationS: 600, paceSecPerKm: 300, hr: 175 });
      const rLow = computeStreamAnalysis(low, TEST_ZONES, 600, 300);
      const rHigh = computeStreamAnalysis(high, TEST_ZONES, 600, 300);
      expect(rHigh.trimp!).toBeGreaterThan(rLow.trimp!);
    });

    test("longer run produces higher TRIMP at same HR", () => {
      const short = makeUniformRun({ durationS: 600, paceSecPerKm: 300, hr: 160 });
      const long = makeUniformRun({ durationS: 1800, paceSecPerKm: 300, hr: 160 });
      const rShort = computeStreamAnalysis(short, TEST_ZONES, 600, 300);
      const rLong = computeStreamAnalysis(long, TEST_ZONES, 1800, 300);
      expect(rLong.trimp!).toBeGreaterThan(rShort.trimp!);
    });

    test("returns null when hrZones.max_hr <= estimated resting HR", () => {
      const degenerateZones: HrZones = {
        source: "estimated", lt1: 150, lt2: 170, max_hr: 90, confirmed: false,
      };
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300, hr: 160 });
      const result = computeStreamAnalysis(streams, degenerateZones, 600, 300);
      expect(result.trimp).toBeNull();
    });
  });

  // ─── Tier 2: NGP ──────────────────────────────────────────────────────────

  describe("NGP (Normalized Graded Pace)", () => {
    test("flat terrain NGP is close to actual pace", () => {
      const streams = makeUniformRun({
        durationS: 600, paceSecPerKm: 300, gradePct: 0,
      });
      const result = computeStreamAnalysis(streams, null, 600, 300);
      expect(result.ngp_sec_per_km).not.toBeNull();
      // On flat, NGP should be very close to actual pace
      expect(Math.abs(result.ngp_sec_per_km! - 300)).toBeLessThan(10);
    });

    test("uphill NGP is faster (lower sec/km) than actual pace", () => {
      // Running 6:00/km on a 10% grade should yield a faster GAP
      const streams = makeUniformRun({
        durationS: 600, paceSecPerKm: 360, gradePct: 10,
      });
      const result = computeStreamAnalysis(streams, null, 600, 360);
      expect(result.ngp_sec_per_km).not.toBeNull();
      expect(result.ngp_sec_per_km!).toBeLessThan(360);
    });

    test("returns null for runs < 60 data points", () => {
      const streams = makeUniformRun({
        durationS: 50, paceSecPerKm: 300, gradePct: 0,
      });
      const result = computeStreamAnalysis(streams, null, 50, 300);
      expect(result.ngp_sec_per_km).toBeNull();
    });
  });

  // ─── Tier 2: Fatigue Index ─────────────────────────────────────────────────

  describe("fatigue index", () => {
    test("uniform pace yields near-zero fatigue", () => {
      const streams = makeUniformRun({ durationS: 1200, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 1200, 300);
      expect(result.fatigue_index_pct).not.toBeNull();
      expect(Math.abs(result.fatigue_index_pct!)).toBeLessThan(2);
    });

    test("slowing down yields positive fatigue index", () => {
      // First 75% at 4:30, last 25% at 5:30
      const n = 1201;
      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0;
      const speed1 = 1000 / 270; // 4:30/km
      const speed2 = 1000 / 330; // 5:30/km
      for (let i = 0; i < n; i++) {
        time.push(i);
        distance.push(dist);
        dist += i < n * 0.75 ? speed1 : speed2;
      }
      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, 1200, 300);
      expect(result.fatigue_index_pct).not.toBeNull();
      expect(result.fatigue_index_pct!).toBeGreaterThan(0);
    });

    test("returns null for runs < 2km", () => {
      // 120s at 5:00/km = 0.4km
      const streams = makeUniformRun({ durationS: 120, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 120, 300);
      expect(result.fatigue_index_pct).toBeNull();
    });
  });

  // ─── Tier 2: Cadence Drift ─────────────────────────────────────────────────

  describe("cadence drift", () => {
    test("constant cadence yields near-zero drift", () => {
      const streams = makeUniformRun({
        durationS: 1200, paceSecPerKm: 300, cadence: 180,
      });
      const result = computeStreamAnalysis(streams, null, 1200, 300);
      expect(result.cadence_drift_spm).not.toBeNull();
      expect(Math.abs(result.cadence_drift_spm!)).toBeLessThan(1);
    });

    test("rising cadence yields positive drift", () => {
      const n = 1201;
      const speedMS = 1000 / 300;
      const time: number[] = [];
      const distance: number[] = [];
      const cadence: number[] = [];
      for (let i = 0; i < n; i++) {
        time.push(i);
        distance.push(i * speedMS);
        cadence.push(170 + (20 * i) / (n - 1)); // 170 → 190
      }
      const streams: ActivityStream = { time, distance, cadence };
      const result = computeStreamAnalysis(streams, null, 1200, 300);
      expect(result.cadence_drift_spm).not.toBeNull();
      expect(result.cadence_drift_spm!).toBeGreaterThan(0);
    });

    test("returns null for runs < 10 min", () => {
      const streams = makeUniformRun({
        durationS: 300, paceSecPerKm: 300, cadence: 180,
      });
      const result = computeStreamAnalysis(streams, null, 300, 300);
      expect(result.cadence_drift_spm).toBeNull();
    });
  });

  // ─── Tier 2: Efficiency Factor ─────────────────────────────────────────────

  describe("efficiency factor", () => {
    test("produces EF when NGP and HR are available", () => {
      const streams = makeUniformRun({
        durationS: 600, paceSecPerKm: 300, hr: 160, gradePct: 0,
      });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 600, 300);
      expect(result.efficiency_factor).not.toBeNull();
      expect(result.efficiency_factor!).toBeGreaterThan(0);
    });

    test("EF is null without grade stream", () => {
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300, hr: 160 });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 600, 300);
      expect(result.efficiency_factor).toBeNull();
    });

    test("EF is null without HR stream", () => {
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300, gradePct: 0 });
      const result = computeStreamAnalysis(streams, null, 600, 300);
      expect(result.efficiency_factor).toBeNull();
    });

    test("faster pace at same HR yields higher EF", () => {
      const fast = makeUniformRun({
        durationS: 600, paceSecPerKm: 270, hr: 160, gradePct: 0,
      });
      const slow = makeUniformRun({
        durationS: 600, paceSecPerKm: 360, hr: 160, gradePct: 0,
      });
      const rFast = computeStreamAnalysis(fast, TEST_ZONES, 600, 270);
      const rSlow = computeStreamAnalysis(slow, TEST_ZONES, 600, 360);
      expect(rFast.efficiency_factor!).toBeGreaterThan(rSlow.efficiency_factor!);
    });
  });

  // ─── Tier 3: Phase Detection ───────────────────────────────────────────────

  describe("phase detection", () => {
    test("uniform easy run produces a single phase", () => {
      // 6:00/km with easyPaceRef at 6:00/km → right at the threshold
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 360 });
      const result = computeStreamAnalysis(streams, null, 600, 360);
      // Should have 1-2 phases (could be just easy/recovery)
      expect(result.phases.length).toBeGreaterThanOrEqual(1);
      expect(result.intervals).toEqual([]);
    });

    test("workout with warmup + work + cooldown detects phases", () => {
      // Build: 120s warmup (7:00/km) → 360s work (4:30/km) → 120s cooldown (7:00/km)
      const easyPace = 360; // 6:00/km
      const warmupSpeed = 1000 / 420; // 7:00/km
      const workSpeed = 1000 / 270;   // 4:30/km
      const cooldownSpeed = 1000 / 420;

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0;
      for (let t = 0; t <= 600; t++) {
        time.push(t);
        distance.push(dist);
        if (t < 120) dist += warmupSpeed;
        else if (t < 480) dist += workSpeed;
        else dist += cooldownSpeed;
      }

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, 600, easyPace);

      // Should detect at least warmup, work, and cooldown
      const phaseTypes = result.phases.map(p => p.phase);
      expect(phaseTypes).toContain("work");
      // Should have 2+ phases
      expect(result.phases.length).toBeGreaterThanOrEqual(2);
    });

    test("interval workout detects multiple work bouts", () => {
      // Build: alternating 120s work (4:00/km) + 90s recovery (7:00/km) x 4
      // Durations must be well above MIN_PHASE_DURATION_S (60s) after smoothing
      const easyPace = 360;
      const workSpeed = 1000 / 240;   // 4:00/km
      const recoverySpeed = 1000 / 420; // 7:00/km

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0;
      let t = 0;

      for (let rep = 0; rep < 4; rep++) {
        // Work phase: 120s
        for (let s = 0; s < 120; s++) {
          time.push(t);
          distance.push(dist);
          dist += workSpeed;
          t++;
        }
        // Recovery phase: 90s
        for (let s = 0; s < 90; s++) {
          time.push(t);
          distance.push(dist);
          dist += recoverySpeed;
          t++;
        }
      }
      // Final data point
      time.push(t);
      distance.push(dist);

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      // Should detect work phases
      const workPhases = result.phases.filter(p => p.phase === "work");
      expect(workPhases.length).toBeGreaterThanOrEqual(2);

      // Should detect intervals
      expect(result.intervals.length).toBeGreaterThanOrEqual(2);
      // Each interval should have a rep number
      for (let i = 0; i < result.intervals.length; i++) {
        expect(result.intervals[i].rep_number).toBe(i + 1);
      }
    });

    test("stopped segments are preserved (not merged)", () => {
      // Build: 120s running → 30s stopped → 120s running
      const runSpeed = 1000 / 300;
      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0;

      for (let t = 0; t <= 270; t++) {
        time.push(t);
        distance.push(dist);
        if (t >= 120 && t < 150) {
          // Stopped: no distance change
        } else {
          dist += runSpeed;
        }
      }

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, 240, 300);

      const stoppedPhases = result.phases.filter(p => p.phase === "stopped");
      // Should have a stopped phase (if > 10s)
      expect(stoppedPhases.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Tier 3: Interval Detection ────────────────────────────────────────────

  describe("interval detection", () => {
    test("returns empty for single-phase run", () => {
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 600, 360);
      expect(result.intervals).toEqual([]);
    });

    test("interval reps have distance and pace data", () => {
      // Build intervals: 4x (120s work at 4:00/km + 90s recovery at 7:00/km)
      const workSpeed = 1000 / 240;
      const recoverySpeed = 1000 / 420;
      const easyPace = 360;

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0;
      let t = 0;

      for (let rep = 0; rep < 4; rep++) {
        for (let s = 0; s < 120; s++) { time.push(t); distance.push(dist); dist += workSpeed; t++; }
        for (let s = 0; s < 90; s++) { time.push(t); distance.push(dist); dist += recoverySpeed; t++; }
      }
      time.push(t); distance.push(dist);

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      for (const interval of result.intervals) {
        expect(interval.work_distance_m).toBeGreaterThan(0);
        expect(interval.work_start_s).toBeLessThan(interval.work_end_s);
        expect(interval.rep_number).toBeGreaterThan(0);
      }
    });
  });

  // ─── Full pipeline integration ─────────────────────────────────────────────

  describe("full pipeline", () => {
    test("complete run with all streams produces all metrics", () => {
      const streams = makeUniformRun({
        durationS: 1200,
        paceSecPerKm: 300,
        hr: 160,
        cadence: 180,
        gradePct: 0,
      });
      const result = computeStreamAnalysis(streams, TEST_ZONES, 1200, 300);

      // All fields should be populated
      expect(result.hr_zones).not.toBeNull();
      expect(result.cardiac_drift_pct).not.toBeNull();
      expect(result.pace_variability_cv).not.toBeNull();
      expect(result.split_type).not.toBeNull();
      expect(result.trimp).not.toBeNull();
      expect(result.ngp_sec_per_km).not.toBeNull();
      expect(result.fatigue_index_pct).not.toBeNull();
      expect(result.cadence_drift_spm).not.toBeNull();
      expect(result.efficiency_factor).not.toBeNull();
      expect(result.phases.length).toBeGreaterThan(0);
      expect(result.computed_at).toBeTruthy();
      expect(result.stream_analysis_version).toBe(STREAM_ANALYSIS_VERSION);
    });

    test("bare minimum streams (time + distance only) still computes pace metrics", () => {
      const streams = makeUniformRun({ durationS: 1200, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 1200, 300);

      // Pace-based metrics should work
      expect(result.pace_variability_cv).not.toBeNull();
      expect(result.split_type).not.toBeNull();
      expect(result.fatigue_index_pct).not.toBeNull();
      expect(result.phases.length).toBeGreaterThan(0);

      // Everything else should be null
      expect(result.hr_zones).toBeNull();
      expect(result.cardiac_drift_pct).toBeNull();
      expect(result.trimp).toBeNull();
      expect(result.ngp_sec_per_km).toBeNull();
      expect(result.cadence_drift_spm).toBeNull();
      expect(result.efficiency_factor).toBeNull();
    });

    test("result is deterministic (same input → same output)", () => {
      const streams = makeUniformRun({
        durationS: 600, paceSecPerKm: 300, hr: 160, gradePct: 2,
      });
      const r1 = computeStreamAnalysis(streams, TEST_ZONES, 600, 300);
      const r2 = computeStreamAnalysis(streams, TEST_ZONES, 600, 300);

      // Everything except computed_at should match
      expect(r1.hr_zones).toEqual(r2.hr_zones);
      expect(r1.cardiac_drift_pct).toBe(r2.cardiac_drift_pct);
      expect(r1.pace_variability_cv).toBe(r2.pace_variability_cv);
      expect(r1.split_type).toBe(r2.split_type);
      expect(r1.trimp).toBe(r2.trimp);
      expect(r1.ngp_sec_per_km).toBe(r2.ngp_sec_per_km);
      expect(r1.fatigue_index_pct).toBe(r2.fatigue_index_pct);
      expect(r1.cadence_drift_spm).toBe(r2.cadence_drift_spm);
      expect(r1.efficiency_factor).toBe(r2.efficiency_factor);
      expect(r1.phases).toEqual(r2.phases);
      expect(r1.intervals).toEqual(r2.intervals);
    });
  });

  // ─── GAP-adjusted phase detection (hilly terrain) ────────────────────────────

  describe("GAP-adjusted phase detection", () => {
    test("uphill run at slow raw speed classified as work by GAP effort", () => {
      // Running 10:00/km uphill on 20% grade
      // GAP factor for 20% ≈ 3.5x → effort ~2:50/km → should be "work"
      // easyPaceRef = 360 (6:00/km) → easySpeed = 2.78 m/s
      // Raw speed = 1000/600 = 1.67 m/s (would be "easy" without GAP)
      const n = 601;
      const rawSpeedMS = 1000 / 600; // 10:00/km
      const time: number[] = [];
      const distance: number[] = [];
      const grade_smooth: number[] = [];
      const altitude: number[] = [];

      let dist = 0;
      let alt = 0;
      for (let i = 0; i < n; i++) {
        time.push(i);
        distance.push(dist);
        grade_smooth.push(20); // 20% grade
        altitude.push(alt);
        dist += rawSpeedMS;
        alt += rawSpeedMS * 0.2; // 20% of horizontal distance
      }

      const streams: ActivityStream = { time, distance, grade_smooth, altitude };
      const result = computeStreamAnalysis(streams, null, 600, 360);

      // Without GAP: raw speed 1.67 m/s < easyThreshold 2.64 → "easy/recovery"
      // With GAP: effort speed ~5.8 m/s >> workThreshold 2.92 → "work"
      const workPhases = result.phases.filter(p => p.phase === "work");
      expect(workPhases.length).toBeGreaterThanOrEqual(1);
    });

    test("hill repeats: climbs = work, descents = recovery", () => {
      // Simulate 4x hill repeats: 120s uphill at 12:00/km on 25% grade
      // then 120s downhill at 4:00/km on -25% grade
      const easyPace = 360; // 6:00/km
      const uphillSpeed = 1000 / 720;   // 12:00/km raw
      const downhillSpeed = 1000 / 240;  // 4:00/km raw

      const time: number[] = [];
      const distance: number[] = [];
      const grade_smooth: number[] = [];
      const altitude: number[] = [];
      let dist = 0;
      let alt = 100;
      let t = 0;

      for (let rep = 0; rep < 4; rep++) {
        // Uphill: 120s at slow raw speed, high grade
        for (let s = 0; s < 120; s++) {
          time.push(t); distance.push(dist);
          grade_smooth.push(25); altitude.push(alt);
          dist += uphillSpeed; alt += uphillSpeed * 0.25; t++;
        }
        // Downhill: 120s at fast raw speed, negative grade
        for (let s = 0; s < 120; s++) {
          time.push(t); distance.push(dist);
          grade_smooth.push(-25); altitude.push(alt);
          dist += downhillSpeed; alt -= downhillSpeed * 0.25; t++;
        }
      }
      time.push(t); distance.push(dist);
      grade_smooth.push(0); altitude.push(alt);

      const streams: ActivityStream = { time, distance, grade_smooth, altitude };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      // Climbs should be "work" (high GAP effort)
      const workPhases = result.phases.filter(p => p.phase === "work");
      expect(workPhases.length).toBeGreaterThanOrEqual(2);

      // Work phases should have positive elevation gain (uphill)
      for (const wp of workPhases) {
        if (wp.elevation_gain_m != null) {
          expect(wp.elevation_gain_m).toBeGreaterThan(0);
        }
      }

      // Recovery/easy phases should have positive elevation loss (downhill)
      const recoveryPhases = result.phases.filter(p =>
        p.phase === "recovery" || p.phase === "cooldown"
      );
      const hasDownhill = recoveryPhases.some(p =>
        p.elevation_loss_m != null && p.elevation_loss_m > 0
      );
      expect(hasDownhill).toBe(true);
    });

    test("flat terrain: GAP speed equals raw speed, behavior unchanged", () => {
      const streams = makeUniformRun({
        durationS: 600, paceSecPerKm: 300, gradePct: 0,
      });
      const withGrade = computeStreamAnalysis(streams, null, 600, 360);

      // Remove grade_smooth to get raw-speed-only path
      const { grade_smooth: _, ...noGrade } = streams;
      const withoutGrade = computeStreamAnalysis(noGrade as ActivityStream, null, 600, 360);

      // Phase classification should be the same
      expect(withGrade.phases.map(p => p.phase)).toEqual(
        withoutGrade.phases.map(p => p.phase)
      );
      expect(withGrade.split_type).toBe(withoutGrade.split_type);
    });
  });

  // ─── Per-phase elevation ────────────────────────────────────────────────────

  describe("per-phase elevation", () => {
    test("phases include elevation gain/loss when altitude stream present", () => {
      // Build: ascending run with altitude data
      const n = 601;
      const speedMS = 1000 / 300;
      const time: number[] = [];
      const distance: number[] = [];
      const altitude: number[] = [];
      let dist = 0;
      for (let i = 0; i < n; i++) {
        time.push(i);
        distance.push(dist);
        altitude.push(100 + i * 0.1); // 0.1m per second = 60m gain over 10min
        dist += speedMS;
      }

      const streams: ActivityStream = { time, distance, altitude };
      const result = computeStreamAnalysis(streams, null, 600, 300);

      // At least one phase should have elevation data
      const withElev = result.phases.filter(p => p.elevation_gain_m != null);
      expect(withElev.length).toBeGreaterThan(0);
      // Total gain across phases should be > 0
      const totalGain = result.phases.reduce((s, p) => s + (p.elevation_gain_m ?? 0), 0);
      expect(totalGain).toBeGreaterThan(0);
    });

    test("phases have null elevation when no altitude stream", () => {
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300 });
      const result = computeStreamAnalysis(streams, null, 600, 300);
      for (const p of result.phases) {
        expect(p.elevation_gain_m).toBeNull();
        expect(p.elevation_loss_m).toBeNull();
      }
    });
  });

  // ─── Short phase merging ───────────────────────────────────────────────────

  describe("short phase merging", () => {
    test("short work phases between stopped phases are not lost", () => {
      // Simulate hill repeats with brief stops at turnaround: stopped → work(50s) → recovery
      // The 50s work phase should NOT be absorbed into the stopped phase
      const easyPace = 360; // 6:00/km
      const workSpeed = 1000 / 270;     // 4:30/km (fast = work)
      const recoverySpeed = 1000 / 420; // 7:00/km (slow = recovery)

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0, t = 0;

      for (let rep = 0; rep < 4; rep++) {
        // Brief stop at top (15s)
        for (let s = 0; s < 15; s++) {
          time.push(t); distance.push(dist); t++;
        }
        // Short but real work phase (50s — below 60s MIN_PHASE_DURATION_S)
        for (let s = 0; s < 50; s++) {
          time.push(t); distance.push(dist); dist += workSpeed; t++;
        }
        // Recovery jog (120s)
        for (let s = 0; s < 120; s++) {
          time.push(t); distance.push(dist); dist += recoverySpeed; t++;
        }
      }
      // Final work phase (120s — long enough to not be merged)
      for (let s = 0; s < 120; s++) {
        time.push(t); distance.push(dist); dist += workSpeed; t++;
      }
      time.push(t); distance.push(dist);

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      // All 5 work bouts should be preserved (4 short + 1 long)
      const workPhases = result.phases.filter(p => p.phase === "work");
      expect(workPhases.length).toBe(5);
    });

    test("short recovery between two work phases is kept, both work phases preserved", () => {
      // work(120s) → recovery(40s) → work(120s) — short recovery kept as distinct phase,
      // both work phases preserved (interval detector pairs them)
      const easyPace = 360;
      const workSpeed = 1000 / 270;
      const recoverySpeed = 1000 / 420;

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0, t = 0;

      // Work
      for (let s = 0; s < 120; s++) { time.push(t); distance.push(dist); dist += workSpeed; t++; }
      // Short recovery
      for (let s = 0; s < 40; s++) { time.push(t); distance.push(dist); dist += recoverySpeed; t++; }
      // Work
      for (let s = 0; s < 120; s++) { time.push(t); distance.push(dist); dist += workSpeed; t++; }
      time.push(t); distance.push(dist);

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      // Both work phases preserved
      const workPhases = result.phases.filter(p => p.phase === "work");
      expect(workPhases.length).toBe(2);
    });
  });

  // ─── Spurious interval filter ──────────────────────────────────────────────

  describe("spurious interval filter", () => {
    test("one dominant work phase returns no intervals", () => {
      // Build: 500s work at 4:30/km + 60s recovery + 80s work at 5:00/km
      // First work phase is ~90% of work distance → spurious
      const easyPace = 360;
      const fastSpeed = 1000 / 270;   // 4:30/km
      const slowSpeed = 1000 / 420;   // 7:00/km
      const medSpeed = 1000 / 300;    // 5:00/km

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0, t = 0;

      // Big work phase
      for (let s = 0; s < 500; s++) {
        time.push(t); distance.push(dist); dist += fastSpeed; t++;
      }
      // Recovery
      for (let s = 0; s < 90; s++) {
        time.push(t); distance.push(dist); dist += slowSpeed; t++;
      }
      // Small work tail
      for (let s = 0; s < 80; s++) {
        time.push(t); distance.push(dist); dist += medSpeed; t++;
      }
      time.push(t); distance.push(dist);

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      // Should NOT be classified as intervals
      expect(result.intervals).toEqual([]);
    });

    test("balanced work phases still detected as intervals", () => {
      // 4x (120s work + 90s recovery) — each work phase ~25% of total
      const easyPace = 360;
      const workSpeed = 1000 / 240;
      const recoverySpeed = 1000 / 420;
      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0, t = 0;

      for (let rep = 0; rep < 4; rep++) {
        for (let s = 0; s < 120; s++) { time.push(t); distance.push(dist); dist += workSpeed; t++; }
        for (let s = 0; s < 90; s++) { time.push(t); distance.push(dist); dist += recoverySpeed; t++; }
      }
      time.push(t); distance.push(dist);

      const streams: ActivityStream = { time, distance };
      const result = computeStreamAnalysis(streams, null, t, easyPace);

      expect(result.intervals.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Lap hint detection & splitting ─────────────────────────────────────────

  describe("lap hints", () => {
    test("detectManualLaps returns null for auto-laps at 1km", () => {
      const laps: LapHint[] = [];
      for (let i = 0; i < 10; i++) {
        laps.push({ start_index: i * 300, end_index: (i + 1) * 300, distance: 1000 });
      }
      // Last lap partial
      laps.push({ start_index: 3000, end_index: 3150, distance: 500 });
      expect(detectManualLaps(laps)).toBeNull();
    });

    test("detectManualLaps returns boundaries for variable-distance laps", () => {
      const laps: LapHint[] = [
        { start_index: 0, end_index: 200, distance: 700 },
        { start_index: 200, end_index: 500, distance: 600 },
        { start_index: 500, end_index: 900, distance: 1200 },
        { start_index: 900, end_index: 1100, distance: 400 },
        { start_index: 1100, end_index: 1400, distance: 800 },
      ];
      const result = detectManualLaps(laps);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(4); // boundaries at start of laps 2-5
      expect(result![0]).toBe(200);
    });

    test("manual lap boundaries split phases where effort changes", () => {
      // Simulate: 200s segment where first 100s is fast (work) and last 100s is slow (recovery)
      // The state machine may blur the transition, but a lap boundary at index 100 should split it
      const easyPace = 360; // 6:00/km
      const workSpeed = 1000 / 270;     // 4:30/km
      const recoverySpeed = 1000 / 480; // 8:00/km

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0, t = 0;

      // Work phase
      for (let s = 0; s < 100; s++) { time.push(t); distance.push(dist); dist += workSpeed; t++; }
      // Recovery phase
      for (let s = 0; s < 100; s++) { time.push(t); distance.push(dist); dist += recoverySpeed; t++; }
      time.push(t); distance.push(dist);

      // Lap boundary at the transition point
      const lapHints: LapHint[] = [
        { start_index: 0, end_index: 99, distance: 100 * workSpeed },
        { start_index: 100, end_index: 200, distance: 100 * recoverySpeed },
      ];

      const withLaps = computeStreamAnalysis(
        { time, distance } as ActivityStream, null, t, easyPace, lapHints
      );
      const withoutLaps = computeStreamAnalysis(
        { time, distance } as ActivityStream, null, t, easyPace
      );

      // With lap hints, work phases should be at least as many as without
      const workWithLaps = withLaps.phases.filter(p => p.phase === "work").length;
      const workWithout = withoutLaps.phases.filter(p => p.phase === "work").length;
      expect(workWithLaps).toBeGreaterThanOrEqual(workWithout);
    });

    test("auto-laps have no effect on phase detection", () => {
      const streams = makeUniformRun({ durationS: 600, paceSecPerKm: 300 });

      // Auto-laps every 1km
      const autoLaps: LapHint[] = [];
      for (let i = 0; i < 6; i++) {
        autoLaps.push({ start_index: i * 100, end_index: (i + 1) * 100, distance: 1000 });
      }

      const withLaps = computeStreamAnalysis(streams, null, 600, 360, autoLaps);
      const withoutLaps = computeStreamAnalysis(streams, null, 600, 360);

      // Auto-laps should be detected and ignored — same phase structure
      expect(withLaps.phases.map(p => p.phase)).toEqual(withoutLaps.phases.map(p => p.phase));
    });

    test("detectManualLaps returns null for fewer than 3 laps", () => {
      const laps: LapHint[] = [
        { start_index: 0, end_index: 500, distance: 2000 },
        { start_index: 500, end_index: 800, distance: 1200 },
      ];
      expect(detectManualLaps(laps)).toBeNull();
    });

    test("detectManualLaps returns null for mile auto-laps (1609m)", () => {
      const laps: LapHint[] = [];
      for (let i = 0; i < 8; i++) {
        laps.push({ start_index: i * 500, end_index: (i + 1) * 500, distance: 1609 });
      }
      expect(detectManualLaps(laps)).toBeNull();
    });

    test("manual lap boundary with same effort on both sides does not split", () => {
      // Uniform work effort with a manual lap boundary in the middle
      const easyPace = 360;
      const workSpeed = 1000 / 270; // 4:30/km — solidly work

      const time: number[] = [];
      const distance: number[] = [];
      let dist = 0, t = 0;

      for (let s = 0; s < 200; s++) {
        time.push(t); distance.push(dist); dist += workSpeed; t++;
      }
      time.push(t); distance.push(dist);

      // Manual lap at index 100 — but effort is the same on both sides
      const lapHints: LapHint[] = [
        { start_index: 0, end_index: 99, distance: 100 * workSpeed },
        { start_index: 100, end_index: 200, distance: 100 * workSpeed },
      ];

      const withLaps = computeStreamAnalysis(
        { time, distance } as ActivityStream, null, t, easyPace, lapHints
      );

      // Should still be a single work phase — no split since effort is uniform
      const workPhases = withLaps.phases.filter(p => p.phase === "work");
      expect(workPhases.length).toBe(1);
    });
  });
});
