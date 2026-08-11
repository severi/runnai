import { test, expect, describe } from "bun:test";
import { detectHillProfile, classifyRun } from "../run-classifier.js";
import type { ActivityLapRecord, HrZones } from "../../types/index.js";

// Build a lap record from the fields the classifier actually reads.
function lap(
  i: number,
  distance: number,
  gain: number,
  loss: number,
  paceSecPerKm = 400,
  hr = 147,
): ActivityLapRecord {
  return {
    activity_id: 1,
    lap_index: i,
    distance,
    elapsed_time: Math.round((paceSecPerKm * distance) / 1000),
    moving_time: Math.round((paceSecPerKm * distance) / 1000),
    average_speed: distance / Math.max(1, (paceSecPerKm * distance) / 1000),
    max_speed: 0,
    average_heartrate: hr,
    max_heartrate: hr + 8,
    start_index: i * 100,
    end_index: i * 100 + 99,
    elevation_gain: gain,
    elevation_loss: loss,
  };
}

const ZONES: HrZones = { source: "manual", lt1: 155, lt2: 170, max_hr: 185, confirmed: true };
const EASY_PACE_REF = 400; // 6:40/km

describe("detectHillProfile — hill-repeat false positives", () => {
  // Real failure shape (activity 90000000005): a 32.8km Z2 long run over rolling trail,
  // recorded with 1km auto-laps. +376m total (~11.5 m/km). The per-km gain/loss
  // alternates ~20 times across 33 laps, which the old detector read as "2x reps".
  // Per-km terrain undulation is NOT workout structure.
  const ROLLING_LONG_RUN: Array<[number, number]> = [
    [33, 0.8], [5.6, 10.8], [8, 3.8], [6.6, 7.4], [3.2, 23.6], [7.8, 22.4],
    [10.8, 16], [8.8, 13.4], [17.6, 15], [7.4, 12.4], [10.2, 24.6], [3.2, 10.8],
    [20, 6.6], [9.4, 18.8], [19.4, 6.4], [11, 16.6], [7, 7], [44, 9.6],
    [8.4, 28.2], [7.8, 26], [4.8, 9.2], [12.8, 5.4], [14.2, 5.8], [7, 12.6],
    [17, 5.4], [6.8, 16], [13.4, 7], [9, 16.8], [6.2, 6.8], [10.8, 6],
    [14.8, 3.6], [6.2, 10], [4, 3.8],
  ];
  const distances = ROLLING_LONG_RUN.map((_, idx) =>
    idx === 27 ? 938.11 : idx === 32 ? 828.12 : 1000,
  );
  const laps = ROLLING_LONG_RUN.map(([g, l], idx) =>
    lap(idx + 1, distances[idx], g, l),
  );
  const totalDist = distances.reduce((a, b) => a + b, 0);

  test("rolling long run on 1km auto-laps is NOT a hill repeat", () => {
    const profile = detectHillProfile(laps, totalDist);
    expect(profile).not.toBeNull();
    expect(profile!.category).not.toBe("hill_repeat");
    expect(profile!.hillRepeatCount).toBeNull();
  });

  test("classifyRun does not label the rolling long run as hill_repeat", () => {
    const profile = detectHillProfile(laps, totalDist);
    const result = classifyRun(
      { id: 1, distance: totalDist, moving_time: Math.round((400 * totalDist) / 1000),
        average_speed: 2.5, average_heartrate: 147, workout_type: null },
      laps, ZONES, EASY_PACE_REF, profile,
    );
    expect(result.run_type).not.toBe("hill_repeat");
    expect(result.run_type).toBe("long_run");
  });
});

describe("classifyByPaceAndHr — slow long run is not a recovery run", () => {
  // Real failure shape (activity 90000000005): 32.8km Z2 long run @ 6:40/km, avg HR 147.
  // The athlete's easy-pace reference is faster (~6:00/km), so 6:40 lands in the
  // slow-pace branch; at Z2 HR that branch returned "recovery" with no distance
  // guard. A deliberately-slow Z2 long run has the same pace+HR signature as a
  // recovery run — only distance distinguishes them. Recovery runs are short.
  const REAL_EASY_REF = 360; // 6:00/km — the actual computeEasyPaceRef() value
  const distM = 32800;
  const paceSecKm = 400; // 6:40/km — slower than 360 * 1.05 = 378

  function classify(distanceM: number) {
    return classifyRun(
      {
        id: 1,
        distance: distanceM,
        moving_time: Math.round((paceSecKm * distanceM) / 1000),
        average_speed: 1000 / paceSecKm,
        average_heartrate: 147, // Z2 (zones lt1 = 155)
        workout_type: null,
      },
      [], // no laps → classifyByPaceAndHr path
      ZONES,
      REAL_EASY_REF,
    );
  }

  test("32.8km slow Z2 run classifies as long_run, not recovery", () => {
    expect(classify(distM).run_type).toBe("long_run");
  });

  test("a genuinely short slow Z2 run is still recovery", () => {
    expect(classify(6000).run_type).toBe("recovery");
  });
});

describe("classifyStructuredLapRun — session-mode work/rest split", () => {
  // Real failure shape (activity 90000000006): a continuous ~20min tempo
  // bracketed by a brisk warmup and cooldown. The old work threshold
  // (lap-pace median × 0.92) sits a fixed offset below the median — which
  // lands BETWEEN the session's two pace modes, so the ×0.92 offset cut INTO
  // the work cluster. The slowest tempo lap (a windy km) fell to "rest", the
  // remaining work laps read as alternating, and a dead-on-plan tempo was
  // classified "fartlek 4x4/5min".
  const TEMPO_PACES = [310, 330, 318, 268, 280, 266, 270, 267, 340, 338];
  const TEMPO_DISTS = [1000, 1000, 800, 1000, 1000, 1000, 1000, 400, 1000, 800];
  const tempoLaps = TEMPO_PACES.map((p, i) =>
    lap(i + 1, TEMPO_DISTS[i], 2, 2, p, i >= 3 && i <= 7 ? 160 : 140),
  );
  const tempoDist = TEMPO_DISTS.reduce((a, b) => a + b, 0);

  test("tempo with brisk warmup/cooldown is tempo, not fartlek", () => {
    const result = classifyRun(
      { id: 3, distance: tempoDist, moving_time: 2680, average_speed: 3.36,
        average_heartrate: 150, workout_type: null },
      tempoLaps, ZONES, EASY_PACE_REF,
    );
    expect(result.run_type).toBe("tempo");
    expect(result.run_type_detail).toContain("4.4km");
  });

  test("intervals survive a brisk warmup lap (tightening guard)", () => {
    // 6x1km reps with jog recoveries; warmup/cooldown laps are brisk enough to
    // land on the fast side of the largest sorted-pace gap (the biggest gap is
    // reps-vs-jogs). The work-cluster ceiling (median × 1.12) must push the
    // warmup/cooldown back to rest, or this reads as "8x" with ruined pattern.
    const paces = [340, 250, 600, 250, 600, 250, 600, 250, 600, 250, 600, 250, 345];
    const dists = [1000, 1000, 250, 1000, 250, 1000, 250, 1000, 250, 1000, 250, 1000, 1000];
    const laps6x = paces.map((p, i) => lap(i + 1, dists[i], 1, 1, p, p < 300 ? 168 : 140));
    const total = dists.reduce((a, b) => a + b, 0);

    const result = classifyRun(
      { id: 4, distance: total, moving_time: 3000, average_speed: 3.0,
        average_heartrate: 155, workout_type: null },
      laps6x, ZONES, EASY_PACE_REF,
    );
    expect(result.run_type).toBe("intervals");
    expect(result.run_type_detail).toBe("6x1km");
  });

  test("single-mode manual-lap run has no work/rest structure", () => {
    // Steady pace, irregular manual lap distances — pace wander of a few
    // sec/km must not be read as modes.
    const paces = [330, 328, 334, 326, 332, 329, 331, 333];
    const dists = [1000, 700, 1300, 900, 1100, 600, 1400, 800];
    const steadyLaps = paces.map((p, i) => lap(i + 1, dists[i], 2, 2, p));
    const total = dists.reduce((a, b) => a + b, 0);

    const result = classifyRun(
      { id: 5, distance: total, moving_time: 2574, average_speed: 3.03,
        average_heartrate: 147, workout_type: null },
      steadyLaps, ZONES, EASY_PACE_REF,
    );
    expect(["intervals", "fartlek"]).not.toContain(result.run_type);
  });
});

describe("detectHillProfile — genuine hill repeats still detected", () => {
  // Manual laps (600m reps, not near a round auto-lap distance), concentrated climbing:
  // 4 climb reps (+50m each) alternating with 4 descents. ~46 m/km.
  const reps: Array<[number, number]> = [
    [50, 5], [5, 50], [52, 4], [4, 52], [48, 6], [6, 48], [51, 5], [5, 51],
  ];
  const laps = reps.map(([g, l], idx) => lap(idx + 1, 600, g, l, 320));
  const totalDist = 600 * reps.length;

  test("manual-lap hill repeats are classified as hill_repeat", () => {
    const profile = detectHillProfile(laps, totalDist);
    expect(profile!.category).toBe("hill_repeat");
    expect(profile!.hillRepeatCount).toBe(4);

    const result = classifyRun(
      { id: 2, distance: totalDist, moving_time: Math.round((320 * totalDist) / 1000),
        average_speed: 3.1, average_heartrate: 165, workout_type: null },
      laps, ZONES, EASY_PACE_REF, profile,
    );
    expect(result.run_type).toBe("hill_repeat");
    expect(result.run_type_detail).toContain("4x reps");
  });
});
