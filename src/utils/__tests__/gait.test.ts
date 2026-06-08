import { describe, test, expect } from "bun:test";
import { normalizeCadence, classifyGait, computeMovementBreakdown } from "../gait.js";

// ─── normalizeCadence ────────────────────────────────────────────────────────
// Strava stores cadence per-leg (~half true steps/min) for foot sports.
// Verified on activity 18809261217: running median 83 per-leg (=166 true),
// walking median 64 per-leg (=128 true). The classifier thresholds in true
// spm, so per-leg streams must be doubled first.

describe("normalizeCadence", () => {
  test("doubles per-leg cadence (running ~83/leg → ~166 spm)", () => {
    const perLeg = [0, 83, 84, 82, 83, 64, 65, 83];
    const out = normalizeCadence(perLeg);
    expect(out).toEqual([0, 166, 168, 164, 166, 128, 130, 166]);
  });

  test("leaves already-full cadence unchanged (running ~166 spm)", () => {
    const full = [0, 166, 168, 170, 164, 128, 130, 166];
    const out = normalizeCadence(full);
    expect(out).toEqual(full);
  });

  test("preserves zeros (no cadence reading)", () => {
    const perLeg = [0, 0, 83, 0, 84];
    const out = normalizeCadence(perLeg);
    expect(out).toEqual([0, 0, 166, 0, 168]);
  });
});

// ─── classifyGait ────────────────────────────────────────────────────────────
// Per-sample run/walk/pause. Cadence is the primary signal; speed is the
// fallback only when cadence is absent.

/** Build aligned speed/time/cadence arrays of length n with constant values. */
function constStreams(n: number, speedMS: number, cadenceFull: number | null) {
  const time = Array.from({ length: n }, (_, i) => i);
  const speed = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : speedMS));
  const cadence = cadenceFull == null ? null : Array.from({ length: n }, () => cadenceFull);
  return { time, speed, cadence };
}

describe("classifyGait", () => {
  test("running cadence at normal speed → all run", () => {
    const { speed, time, cadence } = constStreams(60, 3.0, 165);
    const g = classifyGait(speed, time, cadence);
    expect(g.slice(1).every(x => x === "run")).toBe(true);
  });

  test("walking cadence → all walk", () => {
    const { speed, time, cadence } = constStreams(60, 1.2, 125);
    const g = classifyGait(speed, time, cadence);
    expect(g.slice(1).every(x => x === "walk")).toBe(true);
  });

  test("slow-jog (low speed, running cadence) → run, NOT walk", () => {
    // The exact failure that misread tired slow-jogging as walking: 8:20/km is
    // slow, but cadence stays in running range. Speed alone would call this walk.
    const { speed, time, cadence } = constStreams(60, 2.0, 165);
    const g = classifyGait(speed, time, cadence);
    expect(g.slice(1).every(x => x === "run")).toBe(true);
  });

  test("paused-watch gap (dt >= 15s) → pause", () => {
    // The km-23 error: a 122s watch-paused gap was counted as a slow walk.
    const time = [0, 1, 2, 124, 125, 126]; // 122s jump between idx 2 and 3
    const dist = [0, 3, 6, 6.1, 9, 12];
    const speed = dist.map((d, i) => (i === 0 ? 0 : (d - dist[i - 1]) / (time[i] - time[i - 1])));
    const cadence = [0, 165, 165, 0, 165, 165];
    const g = classifyGait(speed, time, cadence);
    expect(g[3]).toBe("pause");
    expect(g[4]).toBe("run");
  });

  test("no cadence → speed fallback (slow = walk, fast = run)", () => {
    const walk = constStreams(60, 1.2, null);
    expect(classifyGait(walk.speed, walk.time, null).slice(1).every(x => x === "walk")).toBe(true);
    const run = constStreams(60, 3.0, null);
    expect(classifyGait(run.speed, run.time, null).slice(1).every(x => x === "run")).toBe(true);
  });
});

// ─── computeMovementBreakdown ────────────────────────────────────────────────
// The core fix: when the back half slows only because of more walking, run-only
// pace must stay flat (driver = "walking"), even though overall moving pace drops.

/**
 * Build a run whose FIRST half is steady running and SECOND half is the same
 * running pace interrupted by walk breaks. Overall moving pace drops in H2, but
 * run-only pace is identical across halves.
 */
function makeWalkBreakSecondHalf() {
  const time: number[] = [];
  const distance: number[] = [];
  const cadence: number[] = [];
  const grade: number[] = [];
  let d = 0;
  const push = (speedMS: number, cad: number, g: number) => {
    const t = time.length;
    time.push(t);
    d += speedMS;
    distance.push(d);
    cadence.push(cad);
    grade.push(g);
  };
  // H1: 1800s steady running at 3.33 m/s (5:00/km), cadence 170, flat
  for (let i = 0; i < 1800; i++) push(3.33, 170, 0);
  // H2: 1800s — alternate 120s running (3.33 m/s, cad 170) with 60s walking
  // (1.2 m/s, cad 120) on a 4% climb.
  for (let block = 0; block < 10; block++) {
    for (let i = 0; i < 120; i++) push(3.33, 170, 0);
    for (let i = 0; i < 60; i++) push(1.2, 120, 4);
  }
  return { time, distance, cadence, grade };
}

describe("computeMovementBreakdown", () => {
  test("walk-driven back-half slowdown: run-only stays flat, driver=walking", () => {
    const { time, distance, cadence, grade } = makeWalkBreakSecondHalf();
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);

    // Running held essentially flat across halves...
    expect(m.run_only_split_type).not.toBe("positive");
    expect(Math.abs(m.run_only_fatigue_index_pct ?? 0)).toBeLessThan(5);
    // ...but walking grew in the second half...
    expect(m.walk_share_by_half[1]).toBeGreaterThan(m.walk_share_by_half[0]);
    // ...so the slowdown is attributed to walking, not a running fade.
    expect(m.split_driver).toBe("walking");
    // And the walk segments are surfaced, tagged as climbs by grade.
    expect(m.walks.length).toBeGreaterThan(0);
    expect(m.walks.every(w => w.terrain === "climb")).toBe(true);
  });

  test("small run-only drift (<5%) with more walking → still walking, not mixed", () => {
    // Real-world nuance (activity 18809261217): run-only pace drifted ~3% (17s/km
    // over 50km), which is normal aerobic decoupling, not a fade. With walking up
    // in H2, the driver is still "walking" — running effectively held.
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    const push = (s: number, c: number, g: number) => { const t = time.length; time.push(t); d += s; distance.push(d); cadence.push(c); grade.push(g); };
    // H1: steady running 3.33 m/s
    for (let i = 0; i < 1800; i++) push(3.33, 170, 0);
    // H2: running 3% slower (3.23 m/s) + walk breaks
    for (let block = 0; block < 10; block++) {
      for (let i = 0; i < 120; i++) push(3.23, 170, 0);
      for (let i = 0; i < 60; i++) push(1.2, 120, 4);
    }
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);
    expect(Math.abs(m.run_only_fatigue_index_pct ?? 0)).toBeLessThan(5);
    expect(m.split_driver).toBe("walking");
  });

  test("large run-only fade (>=5%) plus more walking → mixed", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    const push = (s: number, c: number, g: number) => { const t = time.length; time.push(t); d += s; distance.push(d); cadence.push(c); grade.push(g); };
    for (let i = 0; i < 1800; i++) push(3.33, 170, 0);
    // H2: running ~12% slower (2.93 m/s) — a real fade — plus walk breaks
    for (let block = 0; block < 10; block++) {
      for (let i = 0; i < 120; i++) push(2.93, 170, 0);
      for (let i = 0; i < 60; i++) push(1.2, 120, 4);
    }
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);
    expect(m.run_only_fatigue_index_pct ?? 0).toBeGreaterThanOrEqual(5);
    expect(m.split_driver).toBe("mixed");
  });

  test("steady continuous run: no walks, driver=running", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    for (let i = 0; i < 1800; i++) { time.push(i); d += 3.0; distance.push(d); cadence.push(170); grade.push(0); }
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);
    expect(m.walk_s).toBe(0);
    expect(m.walks.length).toBe(0);
    expect(m.split_driver).toBe("running");
  });
});
