import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import { parseStrengthFit, applyConnectEdits, cleanString, type StrengthSet, type StrengthSession, type ConnectSet } from "../parse-fit.js";

// Real Garmin Enduro 3 strength file. Kept as a fixture because every trap this
// parser handles was found in it, and each one silently produces a wrong
// coaching claim rather than an error.
const FIXTURE = "data/fit/23840025442_ACTIVITY.fit";
const has = fs.existsSync(FIXTURE);

describe.skipIf(!has)("parseStrengthFit", () => {
  test("totals match the file's own session record", async () => {
    const s = await parseStrengthFit(FIXTURE);
    expect(s.totalReps).toBe(86);           // session.total_cycles agrees
    expect(s.tonnageKg).toBe(2850);
    expect(s.workoutName).toBe("Fighter 1");
    expect(s.warnings).toEqual([]);
  });

  test("exercise names resolve from the file's own title messages", async () => {
    const s = await parseStrengthFit(FIXTURE);
    const names = [...new Set(s.sets.filter(x => x.type === "active").map(x => x.exerciseTitle))];
    expect(names).toEqual(["Squat", "Bench Press", "Weighted Pull-up"]);
  });

  test("indices decode from the bitfield rather than stringifying as objects", async () => {
    const s = await parseStrengthFit(FIXTURE);
    expect(s.sets.map(x => x.index)).toEqual([...Array(21).keys()]);
  });

  test("watch-timed rests are distinguished from athlete-ended ones", async () => {
    const s = await parseStrengthFit(FIXTURE);
    const timed = s.sets.filter(x => x.restWasTimed);
    // The three 60s bench rests were ended by the watch's timer, not the athlete.
    expect(timed.length).toBe(3);
    expect(timed.every(x => x.durationSec === 60)).toBe(true);
    // Squat/pull-up rests were athlete-ended and must NOT be flagged.
    expect(s.sets.some(x => x.type === "rest" && !x.restWasTimed)).toBe(true);
  });

  test("warm-ups are flagged and excluded from tonnage", async () => {
    const s = await parseStrengthFit(FIXTURE);
    const warmups = s.sets.filter(x => x.isWarmup);
    expect(warmups.length).toBe(2);
    expect(warmups.every(x => x.weightKg === 0)).toBe(true);
  });

  test("weight 0 is preserved as a value, not dropped as falsy", async () => {
    const s = await parseStrengthFit(FIXTURE);
    const bodyweightPullup = s.sets.find(x => x.exercise === "pull_up" && x.weightKg === 0);
    expect(bodyweightPullup).toBeDefined();
    expect(bodyweightPullup!.reps).toBe(5);
  });
});

// Synthetic — no fixture needed. A set corrected in Garmin Connect after the
// workout lives only in Connect; the watch's FIT is never rewritten.
function set(index: number, over: Partial<StrengthSet> = {}): StrengthSet {
  return {
    index, type: "active", offsetSec: index * 60, durationSec: 40, reps: 5, weightKg: 60,
    exercise: "squat", exerciseTitle: "Barbell Back Squat", restWasTimed: false,
    isWarmup: false, avgHr: 100, maxHr: 110, watchLogged: null, ...over,
  };
}
function session(sets: StrengthSet[]): StrengthSession {
  return {
    startTimeUtc: null, workoutName: "Fighter 2", totalElapsedSec: 600, activeSec: 0, restSec: 0,
    totalReps: 0, tonnageKg: 0, athleteWeightKg: null, avgHr: null, maxHr: null, calories: null,
    sets, connectEditsApplied: false, warnings: [],
  };
}
const active = (i: number, category: string, name: string | null, reps: number | null, grams: number | null): ConnectSet =>
  ({ messageIndex: i, setType: "ACTIVE", exercises: [{ category, name }], repetitionCount: reps, weight: grams });

describe("applyConnectEdits", () => {
  test("an exercise changed in Connect replaces the watch's, keeping FIT timing and HR", () => {
    const s = applyConnectEdits(session([set(0), set(1, { type: "rest", reps: null, weightKg: null, exercise: null, exerciseTitle: null })]), [
      active(0, "SQUAT", "BARBELL_FRONT_SQUAT", 5, 60000),
      { messageIndex: 1, setType: "REST", exercises: [] },
    ]);
    expect(s.connectEditsApplied).toBe(true);
    expect(s.sets[0].exerciseTitle).toBe("Barbell Front Squat");
    expect(s.sets[0].watchLogged).toEqual({ exerciseTitle: "Barbell Back Squat", reps: 5, weightKg: 60 });
    expect(s.sets[0].avgHr).toBe(100);
    expect(s.sets[1].type).toBe("rest");
  });

  test("corrected reps and weight flow into totals", () => {
    const s = applyConnectEdits(session([set(0)]), [active(0, "SQUAT", "BARBELL_BACK_SQUAT", 3, 70000)]);
    expect(s.sets[0].reps).toBe(3);
    expect(s.sets[0].weightKg).toBe(70);
    expect(s.totalReps).toBe(3);
    expect(s.tonnageKg).toBe(210);
  });

  test("a shorter watch step name for the same lift is not reported as an edit", () => {
    const s = applyConnectEdits(session([set(0, { exerciseTitle: "Squat" })]), [active(0, "SQUAT", "BARBELL_BACK_SQUAT", 5, 60000)]);
    expect(s.sets[0].watchLogged).toBeNull();
  });

  test("category-only Connect entries keep the watch's title", () => {
    const s = applyConnectEdits(
      session([set(0, { exercise: "bench_press", exerciseTitle: "Bench Press" })]),
      [active(0, "BENCH_PRESS", null, 5, 60000)],
    );
    expect(s.sets[0].exerciseTitle).toBe("Bench Press");
    expect(s.sets[0].watchLogged).toBeNull();
  });

  test("filler rests without a messageIndex are ignored; deleted sets are dropped with a warning", () => {
    const s = applyConnectEdits(session([set(0), set(1)]), [
      active(0, "SQUAT", "BARBELL_BACK_SQUAT", 5, 60000),
      { messageIndex: null, setType: "REST", exercises: [] },
    ]);
    expect(s.sets.map(x => x.index)).toEqual([0]);
    expect(s.warnings.some(w => w.includes("Set 1"))).toBe(true);
  });
});

describe("cleanString", () => {
  test("cuts FIT padding and trailing junk off exercise titles", () => {
    expect(cleanString("Barbell Deadlift\u0001(\b\u0007")).toBe("Barbell Deadlift");
    expect(cleanString("Bench Press=��\u0007")).toBe("Bench Press");
    expect(cleanString("Squat\u0000")).toBe("Squat");
    expect(cleanString("Weighted Pull-up")).toBe("Weighted Pull-up");
  });
});
