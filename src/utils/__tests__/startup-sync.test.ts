import { describe, test, expect } from "bun:test";
import { formatNewRunsPrompt, formatCompactStatus, parseRaceCountdowns, findCurrentWeekNumber, type StartupContext } from "../startup-sync.js";

describe("parseRaceCountdowns", () => {
  test("parses race dates from CONTEXT.md format", () => {
    const context = `# Athlete Context

## Target Races
- **Vienna Marathon** — Apr 19, 2026 (A race, road, flat) — TARGET 3:45:00 (5:19/km)
- **Race to the Stones 100km** — Jul 11, 2026 (A race, trail, Ridgeway, non-stop, 1350m elev)
`;
    const today = new Date(2026, 2, 8); // Mar 8, 2026
    const result = parseRaceCountdowns(context, today);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Vienna Marathon");
    expect(result[0].date).toBe("2026-04-19");
    expect(result[0].daysAway).toBe(42);
    expect(result[1].name).toBe("Race to the Stones 100km");
    expect(result[1].date).toBe("2026-07-11");
  });

  test("returns empty array when no races found", () => {
    const result = parseRaceCountdowns("# No races here", new Date());
    expect(result).toHaveLength(0);
  });

  test("filters out past races", () => {
    const context = `## Target Races
- **Past Race** — Jan 1, 2020 (done)
- **Future Race** — Dec 31, 2030 (upcoming)
`;
    const result = parseRaceCountdowns(context, new Date(2026, 0, 1));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Future Race");
  });
});

describe("findCurrentWeekNumber", () => {
  test("finds week number for a date within plan range", () => {
    const planContent = `# Plan

**Plan Duration:** 18 weeks (Mar 9 – Jul 11, 2026)

## Week 1: Build

**Dates:** Monday March 9 - Sunday March 15

Some content.

## Week 2: Peak

**Dates:** Monday March 16 - Sunday March 22

Some content.
`;
    expect(findCurrentWeekNumber(planContent, new Date(2026, 2, 10))).toBe(1);
    expect(findCurrentWeekNumber(planContent, new Date(2026, 2, 17))).toBe(2);
  });

  test("returns null before plan starts", () => {
    const planContent = `# Plan

## Week 1: Build

**Dates:** Monday March 9 - Sunday March 15
`;
    expect(findCurrentWeekNumber(planContent, new Date(2026, 2, 5))).toBeNull();
  });
});

describe("formatNewRunsPrompt", () => {
  test("formats new run IDs into a focused analysis prompt", () => {
    const ctx: StartupContext = {
      sync: {
        status: "new_activities",
        message: '2 new runs synced.\n\nNew runs:\n- 2026-03-07: "Tempo 8K" (id: 123) — 9.7km @ 5:05/km\n- 2026-03-08: "Easy Run" (id: 456) — 9.4km @ 5:55/km',
        newRunIds: [123, 456],
      },
      recentSummary: "",
      planExcerpt: null,
      raceCountdowns: [],
    };
    const prompt = formatNewRunsPrompt(ctx);
    expect(prompt).toContain("123");
    expect(prompt).toContain("456");
    expect(prompt).toContain("get_run_analysis");
    expect(prompt).toContain("Tempo 8K");
  });

  test("includes sync message with run details", () => {
    const ctx: StartupContext = {
      sync: {
        status: "new_activities",
        message: '1 new activity synced.\n\nNew runs:\n- 2026-03-07: "Long Run" (id: 789) — 26km @ 6:04/km',
        newRunIds: [789],
      },
      recentSummary: "",
      planExcerpt: null,
      raceCountdowns: [],
    };
    const prompt = formatNewRunsPrompt(ctx);
    expect(prompt).toContain("789");
    expect(prompt).toContain("Long Run");
  });
});

describe("formatCompactStatus", () => {
  test("formats no-op sync with races and plan", () => {
    const ctx: StartupContext = {
      sync: { status: "up_to_date", message: "Already up to date.", newRunIds: [] },
      recentSummary: "",
      planExcerpt: {
        name: "vienna-marathon-2026",
        currentWeek: "## Week 1: Build 1\n\n| Day | Date | Session | Details |\n|---|---|---|---|\n| Mon | Mar 9 | Easy 10K | Z1-Z2 |\n| Tue | Mar 10 | Rest | |\n| Wed | Mar 11 | Tempo 8K | 3x2K @ LT |",
        nextWeek: "",
      },
      raceCountdowns: [
        { name: "Vienna Marathon", date: "2026-04-19", daysAway: 41, weeksAway: 6 },
      ],
    };
    const result = formatCompactStatus(ctx);
    expect(result).toContain("Synced");
    expect(result).toContain("Vienna Marathon");
    expect(result).toContain("41 days");
    expect(result).toContain("Week 1: Build 1");
    expect(result).toContain("Easy 10K");
    expect(result).toContain("Tempo 8K");
    expect(result).not.toContain("Rest");
  });

  test("formats error state", () => {
    const ctx: StartupContext = {
      sync: { status: "error", message: "Not authorized", newRunIds: [], needsAuth: true },
      recentSummary: "",
      planExcerpt: null,
      raceCountdowns: [],
    };
    const result = formatCompactStatus(ctx);
    expect(result).toContain("Not authorized");
    expect(result).toContain("strava-auth");
  });
});
