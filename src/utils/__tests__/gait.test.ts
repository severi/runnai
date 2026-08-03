import { describe, test, expect } from "bun:test";
import { normalizeCadence, classifyGait, computeMovementBreakdown } from "../gait.js";
import { minettiGapFactor } from "../stream-analysis.js";

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
    // And the walk segments are surfaced, banded by grade (4% = moderate climb).
    expect(m.walks.length).toBeGreaterThan(0);
    expect(m.walks.every(w => w.grade_band === "moderate_up")).toBe(true);
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

  test("steady continuous run: no walks, nothing slowed → driver=none", () => {
    // Was asserting driver="running" — that was the bug, not the spec. A walk-free
    // run used to short-circuit to "running" whether or not it slowed at all.
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    for (let i = 0; i < 1800; i++) { time.push(i); d += 3.0; distance.push(d); cadence.push(170); grade.push(0); }
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);
    expect(m.walk_s).toBe(0);
    expect(m.walks.length).toBe(0);
    expect(m.split_driver).toBe("none");
  });

  // ─── Grade bands ───────────────────────────────────────────────────────────
  // The RTTS follow-up failure: a binary climb/flat label with a 3% cutoff
  // lumped 1-3% gentle climbs AND downhills into "flat", so "83 min walked on
  // even ground" was wrong and the athlete caught it. Signed bands from
  // per-sample grade make the walk-terrain distribution native data.

  test("walk segments carry signed grade_band, not a binary label", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    const push = (s: number, c: number, g: number) => { const t = time.length; time.push(t); d += s; distance.push(d); cadence.push(c); grade.push(g); };
    // Running with four walk breaks on distinct grades: -4% descent, 0% flat,
    // 2% gentle, 8% steep. Each walk 60s.
    const walkGrades = [-4, 0, 2, 8];
    for (const wg of walkGrades) {
      for (let i = 0; i < 300; i++) push(3.3, 170, 0);
      for (let i = 0; i < 60; i++) push(1.2, 120, wg);
    }
    for (let i = 0; i < 300; i++) push(3.3, 170, 0);
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);

    expect(m.walks.map(w => w.grade_band)).toEqual(["descent", "flat", "gentle_up", "steep_up"]);
  });

  test("walk time aggregates by grade band, whole run and by half", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    const push = (s: number, c: number, g: number) => { const t = time.length; time.push(t); d += s; distance.push(d); cadence.push(c); grade.push(g); };
    // H1: run + 120s walking on 5% climbs. H2 (same distance shape): run +
    // 120s walking on 0% flat and 60s on -3% descents — the "walking spread to
    // flats and downhills late" fingerprint.
    for (let i = 0; i < 600; i++) push(3.3, 170, 0);
    for (let i = 0; i < 120; i++) push(1.2, 120, 5);
    for (let i = 0; i < 600; i++) push(3.3, 170, 0);
    for (let i = 0; i < 120; i++) push(1.2, 120, 0);
    for (let i = 0; i < 60; i++) push(1.2, 120, -3);
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence);

    expect(m.walk_grade_band_s!.moderate_up).toBe(120);
    expect(m.walk_grade_band_s!.flat).toBe(120);
    expect(m.walk_grade_band_s!.descent).toBe(60);
    expect(m.walk_grade_band_s!.gentle_up).toBe(0);
    expect(m.walk_grade_band_s!.steep_up).toBe(0);
    // By half: climbs-only early, flat+descent late.
    expect(m.walk_grade_band_s_by_half![0].moderate_up).toBeGreaterThan(0);
    expect(m.walk_grade_band_s_by_half![0].descent).toBe(0);
    expect(m.walk_grade_band_s_by_half![1].descent).toBeGreaterThan(0);
    expect(m.walk_grade_band_s_by_half![1].moderate_up).toBe(0);
  });

  test("no grade stream → null bands and null aggregates", () => {
    const { time, distance, cadence } = makeWalkBreakSecondHalf();
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, null, cadence);

    expect(m.walks.every(w => w.grade_band === null)).toBe(true);
    expect(m.walk_grade_band_s).toBeNull();
    expect(m.walk_grade_band_s_by_half).toBeNull();
  });

  // ─── Per-gait-state HR ─────────────────────────────────────────────────────
  // The RTTS 100km failure: whole-run avg HR 128 was 65% walking (HR ~110-135)
  // blended with 35% running (HR 143-153). Reading 128 as "the effort" produced
  // "engine was never troubled → legs were the limiter". Per-state HR makes the
  // compositional artifact visible in the data itself.

  test("run-walk session: run_avg_hr and walk_avg_hr separate the two states", () => {
    const { time, distance, cadence, grade } = makeWalkBreakSecondHalf();
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));
    // HR 150 while running (cadence 170), 115 while walking (cadence 120).
    const hr = cadence.map(c => (c >= 140 ? 150 : 115));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, hr);

    expect(m.run_avg_hr).toBe(150);
    expect(m.walk_avg_hr).toBe(115);
    // Run-only HR per half exposes drift within the running itself.
    expect(m.run_avg_hr_by_half).toEqual([150, 150]);
  });

  test("run-only HR by half surfaces running-HR drift a blended average hides", () => {
    const { time, distance, cadence, grade } = makeWalkBreakSecondHalf();
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));
    const midT = time[time.length - 1] / 2;
    // Running HR 145 in H1, 155 in H2; walking always 115.
    const hr = cadence.map((c, i) => (c >= 140 ? (time[i] <= midT ? 145 : 155) : 115));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, hr);

    // Halves split by distance, so the exact H2 value blends a little H1 —
    // assert the drift direction and magnitude, not an exact figure.
    expect(m.run_avg_hr_by_half[0]).toBe(145);
    expect(m.run_avg_hr_by_half[1]!).toBeGreaterThan(150);
  });

  test("no HR stream → HR fields null", () => {
    const { time, distance, cadence, grade } = makeWalkBreakSecondHalf();
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, null);

    expect(m.run_avg_hr).toBeNull();
    expect(m.walk_avg_hr).toBeNull();
    expect(m.run_avg_hr_by_half).toEqual([null, null]);
  });

  test("continuous run with no walking → walk_avg_hr null, run_avg_hr set", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    for (let i = 0; i < 1800; i++) { time.push(i); d += 3.0; distance.push(d); cadence.push(170); grade.push(0); }
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));
    const hr = time.map(() => 142);

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, hr);

    expect(m.run_avg_hr).toBe(142);
    expect(m.walk_avg_hr).toBeNull();
  });
});

// ─── Grade contamination of run-only split/fatigue ───────────────────────────
// The Aug 2 2026 failure (activity 19569913259, 14.6km, zero walking): the
// whole-run split_type/fatigue_index are Minetti-adjusted and read "even" /
// 0.6%, but run_only_split_type/run_only_fatigue_index_pct were computed on RAW
// speed and read "positive" / 5.3%. The 5.3% was the closing climb (laps 13-15
// net +11/+6/+5m after an opening two laps at net -10m each), not a fade. The
// reviewer trusted the raw twin and a "mild late pace fade" was written into
// the athlete's analysis. Run-only metrics must use the same grade-adjusted
// effort speed the whole-run metrics use.

/**
 * Continuous run at constant *effort*: downhill opening, flat middle, uphill
 * close. Raw speed tracks the grade; grade-adjusted effort speed is flat.
 */
function makeDownhillStartUphillFinish() {
  const time: number[] = [], distance: number[] = [], cadence: number[] = [],
        grade: number[] = [], effortSpeed: number[] = [];
  let d = 0;
  const EFFORT_MS = 3.2; // constant grade-adjusted effort throughout
  const push = (g: number) => {
    const raw = EFFORT_MS / minettiGapFactor(g);
    time.push(time.length); d += raw; distance.push(d);
    cadence.push(170); grade.push(g); effortSpeed.push(EFFORT_MS);
  };
  for (let i = 0; i < 600; i++) push(-3);  // downhill open
  for (let i = 0; i < 1800; i++) push(0);  // flat middle
  for (let i = 0; i < 600; i++) push(3);   // uphill close
  const speed = [0];
  for (let i = 1; i < time.length; i++) {
    speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));
  }
  effortSpeed[0] = 0;
  return { time, distance, cadence, grade, speed, effortSpeed };
}

describe("computeMovementBreakdown — grade adjustment", () => {
  test("constant effort over downhill start / uphill finish is NOT a fade", () => {
    const { time, distance, cadence, grade, speed, effortSpeed } = makeDownhillStartUphillFinish();

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, null, effortSpeed);

    expect(m.walk_pct).toBe(0);
    expect(m.run_only_split_type).toBe("even");
    expect(Math.abs(m.run_only_fatigue_index_pct ?? 0)).toBeLessThan(5);
  });

  test("raw speed on the same run would read as a fade (documents the bug)", () => {
    const { time, distance, cadence, grade, speed } = makeDownhillStartUphillFinish();

    // No effort speed supplied → falls back to raw, which the terrain distorts.
    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, null, null);

    expect(m.run_only_split_type).toBe("positive");
    expect(m.run_only_fatigue_index_pct ?? 0).toBeGreaterThan(5);
  });

  test("a real fade at constant grade is still caught", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [],
          grade: number[] = [], effortSpeed: number[] = [];
    let d = 0;
    const push = (s: number) => {
      time.push(time.length); d += s; distance.push(d);
      cadence.push(170); grade.push(0); effortSpeed.push(s);
    };
    for (let i = 0; i < 2400; i++) push(3.33);
    for (let i = 0; i < 600; i++) push(2.90); // ~13% slower, flat ground
    const speed = [0];
    for (let i = 1; i < time.length; i++) {
      speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));
    }
    effortSpeed[0] = 0;

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, null, effortSpeed);

    expect(m.run_only_fatigue_index_pct ?? 0).toBeGreaterThanOrEqual(5);
    expect(m.split_driver).toBe("running");
  });
});

// ─── split_driver must not rubber-stamp fade claims ──────────────────────────
// The second half of the Aug 2 failure: `walkPct < 2` short-circuited to
// split_driver="running" on ANY run without walk breaks, regardless of whether
// anything slowed. SKILL.md lists split_driver==="running" as the evidence
// required to claim "faded in the back half" — so the check green-lit the claim
// by construction. "none" is the honest answer when nothing slowed.

describe("split_driver", () => {
  test("steady continuous run with no slowdown → 'none', not 'running'", () => {
    const time: number[] = [], distance: number[] = [], cadence: number[] = [], grade: number[] = [];
    let d = 0;
    for (let i = 0; i < 1800; i++) { time.push(i); d += 3.0; distance.push(d); cadence.push(170); grade.push(0); }
    const speed = [0];
    for (let i = 1; i < time.length; i++) speed.push((distance[i] - distance[i - 1]) / (time[i] - time[i - 1]));

    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, null, speed);

    expect(m.split_driver).toBe("none");
  });

  test("terrain-shaped run with constant effort → 'none'", () => {
    const { time, distance, cadence, grade, speed, effortSpeed } = makeDownhillStartUphillFinish();
    const m = computeMovementBreakdown(speed, time, distance, grade, cadence, null, effortSpeed);
    expect(m.split_driver).toBe("none");
  });
});
