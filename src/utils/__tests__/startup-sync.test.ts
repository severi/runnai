import { describe, test, expect } from "bun:test";
import { formatNewRunsPrompt, formatCompactStatus, parseRaceCountdowns, type StartupContext } from "../startup-sync.js";
import { findCurrentWeekNumber } from "../plan-parser.js";

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
      weekCompliance: null,
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const prompt = formatNewRunsPrompt(ctx);
    expect(prompt).toContain("123");
    expect(prompt).toContain("456");
    expect(prompt).toContain("New Run Analysis");
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
      weekCompliance: null,
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const prompt = formatNewRunsPrompt(ctx);
    expect(prompt).toContain("789");
    expect(prompt).toContain("Long Run");
  });
});

describe("formatCompactStatus backlog", () => {
  test("shows awaiting-analysis count when up_to_date but newRunIds present", () => {
    const ctx: StartupContext = {
      sync: {
        status: "up_to_date",
        message: "Already up to date.\n\nRuns awaiting analysis from prior sessions:\n- 2026-05-09: \"Morning Run\" (id: 18436408502) — 26.1km @ 6:21/km",
        newRunIds: [18436408502],
      },
      recentSummary: "",
      planExcerpt: null,
      raceCountdowns: [],
      weekCompliance: null,
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const status = formatCompactStatus(ctx);
    expect(status).toContain("awaiting analysis");
    expect(status).toContain("1 run");
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
      weekCompliance: null,
      newRunPlanContext: [],
      fitnessDrift: null,
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

  test("highlights today's session with → marker and inlines its details", () => {
    // Pick today's day-of-week dynamically so the test is robust to "what day did
    // someone run this on" — we just inject a row for today and verify it gets
    // marked. Other days stay terse.
    const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
    const todayLabel = dows[new Date().getDay()];
    // Build a small plan where today is one row and another day is a different row.
    const otherLabel = todayLabel === "Mon" ? "Tue" : "Mon";
    const ctx: StartupContext = {
      sync: { status: "up_to_date", message: "Already up to date.", newRunIds: [] },
      recentSummary: "",
      planExcerpt: {
        name: "test-plan",
        currentWeek: `## Week 9: Build 1

| Day | Date | Session | Details |
|---|---|---|---|
| ${otherLabel} | Mar 9 | Easy | 9km easy. |
| ${todayLabel} | Mar 10 | Tempo | 10km tempo @ Z3. |
`,
        nextWeek: "",
      },
      raceCountdowns: [],
      weekCompliance: null,
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const result = formatCompactStatus(ctx);
    // Today's row is marked with → AND has details inline.
    expect(result).toMatch(new RegExp(`→ ${todayLabel}\\s+Tempo — 10km tempo @ Z3\\.`));
    // The other day is NOT marked → and does NOT have details inline.
    expect(result).toMatch(new RegExp(`  ${otherLabel}\\s+Easy$`, "m"));
    expect(result).not.toContain(`→ ${otherLabel}`);
    expect(result).not.toMatch(new RegExp(`${otherLabel}.*9km easy`));
  });

  test("inlines compliance stats onto week title and drops duplicate header", () => {
    const ctx: StartupContext = {
      sync: { status: "up_to_date", message: "Already up to date.", newRunIds: [] },
      recentSummary: "",
      planExcerpt: {
        name: "test-plan",
        currentWeek: "## Week 9: Build 1\n\n| Day | Date | Session | Details |\n|---|---|---|---|\n| Mon | May 4 | Hill | 5x200m. |\n",
        nextWeek: "",
      },
      raceCountdowns: [],
      weekCompliance: {
        weekNumber: 9,
        planSlug: "test-plan",
        summary: { completed: 2, missed: 0, upcoming: 4, total: 6, completedKm: 20, plannedKm: 70 },
        entries: [
          {
            planned: { date: "2026-05-04", sessionName: "Hill", details: "", weekNumber: 9 },
            actual: { id: 1, name: "Hill", distance_km: 10, pace_sec_per_km: 320, run_type: "intervals", start_date_local: "2026-05-04T07:00:00" },
            extras: [],
            status: "completed",
          },
          {
            planned: { date: "2026-05-09", sessionName: "Long Run", details: "", weekNumber: 9 },
            actual: null,
            extras: [],
            status: "upcoming",
          },
        ],
      },
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const result = formatCompactStatus(ctx);
    // Compliance stats inlined onto the week-title line.
    expect(result).toContain("Week 9: Build 1 · 2/6 done · 20/70km");
    // No duplicate "Week 9" header — the legacy compliance section emitted a
    // plain "Week N · ..." line on its own. Should appear exactly once now,
    // inlined onto the title.
    const weekHeaderCount = (result.match(/^Week 9/gm) || []).length;
    expect(weekHeaderCount).toBe(1);
    expect(result).not.toContain("upcoming:");
  });

  test("marks missed days inline with ✗ and surfaces actuals (incl. doubles) on a 'did:' sub-line", () => {
    const ctx: StartupContext = {
      sync: { status: "up_to_date", message: "Already up to date.", newRunIds: [] },
      recentSummary: "",
      planExcerpt: {
        name: "test-plan",
        currentWeek: [
          "## Week 9: Build 1",
          "",
          "| Day | Date | Session | Details |",
          "|---|---|---|---|",
          "| Mon | May 4 | Hill | 5x200m. |",
          "| Tue | May 5 | Easy | 9km |",
          "| Thu | May 7 | Easy + Strength | 8km easy |",
        ].join("\n"),
        nextWeek: "",
      },
      raceCountdowns: [],
      weekCompliance: {
        weekNumber: 9,
        planSlug: "test-plan",
        summary: { completed: 2, missed: 1, upcoming: 0, total: 3, completedKm: 28.6, plannedKm: 50 },
        entries: [
          {
            planned: { date: "2026-05-04", sessionName: "Hill", details: "", weekNumber: 9 },
            actual: { id: 1, name: "Hill", distance_km: 10, pace_sec_per_km: 320, run_type: "intervals", start_date_local: "2026-05-04T07:00:00" },
            extras: [],
            status: "completed",
          },
          {
            planned: { date: "2026-05-05", sessionName: "Easy", details: "", weekNumber: 9 },
            actual: null,
            extras: [],
            status: "missed",
          },
          {
            planned: { date: "2026-05-07", sessionName: "Easy + Strength", details: "", weekNumber: 9 },
            actual: { id: 2, name: "Afternoon", distance_km: 9.3, pace_sec_per_km: 357, run_type: "easy", start_date_local: "2026-05-07T16:18:16Z" },
            extras: [
              { id: 3, name: "Morning", distance_km: 9.3, pace_sec_per_km: 385, run_type: "easy", start_date_local: "2026-05-07T08:48:49Z" },
            ],
            status: "completed",
          },
        ],
      },
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const result = formatCompactStatus(ctx);
    // Inline status markers replace the legacy bottom "missed: ..." callout
    expect(result).toMatch(/✓ Mon\s+Hill/);
    expect(result).toMatch(/✗ Tue\s+Easy/);
    expect(result).toMatch(/✓ Thu\s+Easy \+ Strength/);
    // Doubles surfaced — both Thursday runs visible on the "did:" sub-line
    expect(result).toMatch(/did: 9\.3km @ 5:57\/km · 9\.3km @ 6:25\/km/);
    // Single run on Mon also gets a "did:" line
    expect(result).toMatch(/did: 10km @ 5:20\/km/);
    // The redundant bottom callout is gone now that ✗ shows inline
    expect(result).not.toContain("missed:");
  });

  test("formats error state", () => {
    const ctx: StartupContext = {
      sync: { status: "error", message: "Not authorized", newRunIds: [], needsAuth: true },
      recentSummary: "",
      planExcerpt: null,
      raceCountdowns: [],
      weekCompliance: null,
      newRunPlanContext: [],
      fitnessDrift: null,
    };
    const result = formatCompactStatus(ctx);
    expect(result).toContain("Not authorized");
    expect(result).toContain("strava-auth");
  });
});
