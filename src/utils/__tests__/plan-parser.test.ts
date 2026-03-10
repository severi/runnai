import { describe, test, expect } from "bun:test";
import { parsePlan, extractPlanWeeks } from "../plan-parser.js";
import * as fs from "fs";
import * as path from "path";

const MINIMAL_PLAN = `# Test Plan

**Plan Created:** 2026-03-05

## Week 1: Build

**Dates:** Monday March 9 - Sunday March 15

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy, 5:50-6:20/km. |
| Tue | Mar 10 | Tempo | 12km total: 2km WU, 30min tempo. |
| Fri | Mar 13 | Rest | Complete rest. |
| Sat | Mar 14 | Long Run | **26km** easy with 8km at MP. |
`;

const TWO_WEEK_PLAN = `# Two Week Plan

**Plan Duration:** 4 weeks (Mar 9 - Apr 5, 2026)

## Week 1: Build

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy. |
| Tue | Mar 10 | Rest | |
| Wed | Mar 11 | Tempo | 12km total. |

## Week 2: Peak

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 16 | Easy | 10km easy. |
| Sat | Mar 21 | Long Run | 32km with MP finish. |
`;

describe("parsePlan", () => {
  test("parses minimal plan correctly", () => {
    const result = parsePlan(MINIMAL_PLAN, "test-plan");
    expect(result).toHaveLength(3);

    expect(result[0].weekNumber).toBe(1);
    expect(result[0].sessionIndex).toBe(0);
    expect(result[0].sessionName).toBe("Easy");
    expect(result[0].date).toBe("2026-03-09T00:00:00");
    expect(result[0].externalId).toBe("runnai:test-plan:w1:s0");

    expect(result[1].sessionName).toBe("Tempo");
    expect(result[1].sessionIndex).toBe(1);
    expect(result[1].date).toBe("2026-03-10T00:00:00");

    expect(result[2].sessionName).toBe("Long Run");
    expect(result[2].sessionIndex).toBe(2);
    expect(result[2].date).toBe("2026-03-14T00:00:00");
  });

  test("skips rest days", () => {
    const result = parsePlan(MINIMAL_PLAN, "test-plan");
    const sessions = result.map((w) => w.sessionName);
    expect(sessions).not.toContain("Rest");
  });

  test("strips markdown from details", () => {
    const result = parsePlan(MINIMAL_PLAN, "test-plan");
    const longRun = result.find((w) => w.sessionName === "Long Run");
    expect(longRun!.details).toBe("26km easy with 8km at MP.");
    expect(longRun!.details).not.toContain("**");
  });

  test("handles multiple weeks with correct session index reset", () => {
    const result = parsePlan(TWO_WEEK_PLAN, "multi-week");

    const week1 = result.filter((w) => w.weekNumber === 1);
    const week2 = result.filter((w) => w.weekNumber === 2);

    expect(week1).toHaveLength(2); // Easy + Tempo, Rest skipped
    expect(week2).toHaveLength(2); // Easy + Long Run

    // Session indices reset per week
    expect(week1[0].sessionIndex).toBe(0);
    expect(week1[1].sessionIndex).toBe(1);
    expect(week2[0].sessionIndex).toBe(0);
    expect(week2[1].sessionIndex).toBe(1);
  });

  test("weekFilter only exports selected weeks", () => {
    const result = parsePlan(TWO_WEEK_PLAN, "multi-week", [2]);
    expect(result.every((w) => w.weekNumber === 2)).toBe(true);
    expect(result).toHaveLength(2);
  });

  test("external IDs are unique", () => {
    const result = parsePlan(TWO_WEEK_PLAN, "multi-week");
    const ids = result.map((w) => w.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("extracts year from plan header", () => {
    const result = parsePlan(MINIMAL_PLAN, "test-plan");
    expect(result[0].date).toContain("2026");
  });

  test("ignores sections without Week N header", () => {
    const planWithOverview = `# Plan

**Plan Created:** 2026-01-01

## Plan Overview

| Phase | Week | Dates |
|-------|------|-------|
| Build | Week 1 | Jan 5-11 |

## Week 1: Build

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Jan 5 | Easy | 8km easy. |
`;
    const result = parsePlan(planWithOverview, "test");
    expect(result).toHaveLength(1);
    expect(result[0].sessionName).toBe("Easy");
  });

  test("ignores tables without Session column", () => {
    const planWith3ColTable = `# Plan

**Plan Created:** 2026-03-01

## Week 1: Transition

| Day | Date | Workout |
|-----|------|---------|
| Fri | Mar 6 | Easy jog |

## Week 2: Build

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km. |
`;
    const result = parsePlan(planWith3ColTable, "test");
    // Week 1 has no Session column -> skipped
    // Week 2 has Session column -> parsed
    expect(result).toHaveLength(1);
    expect(result[0].weekNumber).toBe(2);
  });

  test("parses real vienna plan", () => {
    const planPath = path.join(process.cwd(), "data/plans/vienna-marathon-2026.md");
    if (!fs.existsSync(planPath)) return; // skip if file doesn't exist

    const content = fs.readFileSync(planPath, "utf-8");
    const result = parsePlan(content, "vienna-marathon-2026");

    // Should have many workouts across 18 weeks
    expect(result.length).toBeGreaterThan(50);

    // Should cover weeks 1-18
    const weeks = [...new Set(result.map((w) => w.weekNumber))].sort((a, b) => a - b);
    expect(weeks[0]).toBe(1);
    expect(weeks[weeks.length - 1]).toBe(18);

    // No rest days should be present
    expect(result.every((w) => w.sessionName.toLowerCase() !== "rest")).toBe(true);

    // All dates should be in 2026
    expect(result.every((w) => w.date.startsWith("2026-"))).toBe(true);

    // External IDs should all be unique
    const ids = result.map((w) => w.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("extractPlanWeeks", () => {
  test("extracts a specific week's markdown section", () => {
    const markdown = `# Plan

## Week 1: Build

**Dates:** Monday March 9 - Sunday March 15
**Target Volume:** ~73km

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy. |
| Sat | Mar 14 | Long Run | 26km with MP. |

**Key workout:** Saturday's 26km.

---

## Week 2: Peak

**Dates:** Monday March 16 - Sunday March 22

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 16 | Easy | 10km easy. |
`;

    const result = extractPlanWeeks(markdown, [1]);
    expect(result).toHaveLength(1);
    expect(result[0].weekNumber).toBe(1);
    expect(result[0].markdown).toContain("Week 1: Build");
    expect(result[0].markdown).toContain("9km easy");
    expect(result[0].markdown).toContain("26km with MP");
    expect(result[0].markdown).not.toContain("Week 2");
  });

  test("extracts multiple weeks", () => {
    const markdown = `# Plan

## Week 1: Build

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km. |

## Week 2: Peak

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 16 | Easy | 10km. |

## Week 3: Taper

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 23 | Easy | 8km. |
`;

    const result = extractPlanWeeks(markdown, [1, 3]);
    expect(result).toHaveLength(2);
    expect(result[0].weekNumber).toBe(1);
    expect(result[1].weekNumber).toBe(3);
    expect(result[0].markdown).toContain("9km");
    expect(result[1].markdown).toContain("8km");
  });

  test("returns empty for non-existent week", () => {
    const markdown = `# Plan\n\n## Week 1: Build\n\nSome content.\n`;
    const result = extractPlanWeeks(markdown, [99]);
    expect(result).toHaveLength(0);
  });
});
