import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import { parseStrengthFit } from "../parse-fit.js";

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
