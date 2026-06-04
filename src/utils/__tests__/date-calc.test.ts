import { describe, test, expect } from "bun:test";
import { computeDateDiff } from "../date-calc.js";

// Pin "today" so assertions are deterministic regardless of wall clock.
const TODAY = new Date(2026, 5, 4); // Thursday 2026-06-04

describe("computeDateDiff", () => {
  test("diffs target against today by default", () => {
    const result = computeDateDiff("2026-06-06", undefined, TODAY);
    if ("error" in result) throw new Error(result.error);
    expect(result.days_difference).toBe(2);
    expect(result.from_date).toBe("2026-06-04");
    expect(result.is_future).toBe(true);
    expect(result.is_past).toBe(false);
    expect(result.is_same_day).toBe(false);
  });

  test("diffs two arbitrary dates when from_date is given", () => {
    // The exact failure case: Wed Jun 3 run vs Sat Jun 6 50km = 3 days,
    // Thu Jun 4 run vs Sat Jun 6 = 2 days.
    const wed = computeDateDiff("2026-06-06", "2026-06-03", TODAY);
    const thu = computeDateDiff("2026-06-06", "2026-06-04", TODAY);
    if ("error" in wed || "error" in thu) throw new Error("unexpected error");
    expect(wed.days_difference).toBe(3);
    expect(thu.days_difference).toBe(2);
  });

  test("returns weekday names for both endpoints", () => {
    const result = computeDateDiff("2026-06-06", "2026-06-03", TODAY);
    if ("error" in result) throw new Error(result.error);
    expect(result.from_weekday).toBe("Wednesday");
    expect(result.target_weekday).toBe("Saturday");
  });

  test("negative difference and is_past for a target before from_date", () => {
    const result = computeDateDiff("2026-05-28", "2026-06-04", TODAY);
    if ("error" in result) throw new Error(result.error);
    expect(result.days_difference).toBe(-7);
    expect(result.weeks_difference).toBe(-1);
    expect(result.is_past).toBe(true);
    expect(result.is_future).toBe(false);
  });

  test("same-day diff is 0 with is_same_day true", () => {
    const result = computeDateDiff("2026-06-04", "2026-06-04", TODAY);
    if ("error" in result) throw new Error(result.error);
    expect(result.days_difference).toBe(0);
    expect(result.is_same_day).toBe(true);
    expect(result.human_readable).toBe("Same day");
  });

  test("human_readable keeps today-relative phrasing when from_date omitted", () => {
    expect(computeDateDiff("2026-06-06", undefined, TODAY)).toMatchObject({
      human_readable: "2 days from now (0 weeks away)",
    });
    expect(computeDateDiff("2026-05-28", undefined, TODAY)).toMatchObject({
      human_readable: "7 days ago (1 weeks ago)",
    });
  });

  test("human_readable names both endpoints when from_date is given", () => {
    const result = computeDateDiff("2026-06-06", "2026-06-03", TODAY);
    if ("error" in result) throw new Error(result.error);
    expect(result.human_readable).toBe(
      "3 days from Wednesday 2026-06-03 to Saturday 2026-06-06"
    );
  });

  test("rejects malformed dates", () => {
    expect(computeDateDiff("06/06/2026", undefined, TODAY)).toHaveProperty("error");
    expect(computeDateDiff("2026-06-06", "yesterday", TODAY)).toHaveProperty("error");
    expect(computeDateDiff("2026-13-40", undefined, TODAY)).toHaveProperty("error");
  });

  test("parses dates as local calendar days (no UTC shift)", () => {
    // A reference date late in the local evening must not shift the day.
    const lateEvening = new Date(2026, 5, 4, 23, 45);
    const result = computeDateDiff("2026-06-06", undefined, lateEvening);
    if ("error" in result) throw new Error(result.error);
    expect(result.days_difference).toBe(2);
  });
});
