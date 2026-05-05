import { describe, test, expect } from "bun:test";
import { renderDiff } from "../plan-diff.js";

const PLAN_A = `# Plan
**Plan Created:** 2026-03-05

## Week 1: Build
| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy. |
| Tue | Mar 10 | Tempo | 12km tempo. |

## Week 2: Build
| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 16 | Easy | 10km easy. |
`;

const PLAN_B = `# Plan
**Plan Created:** 2026-03-05

## Week 1: Build
| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy. |
| Tue | Mar 10 | Tempo | 14km tempo (was 12). |

## Week 2: Build
| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 16 | Easy | 10km easy. |
`;

describe("renderDiff", () => {
  test("identifies changed weeks via prose comparison", () => {
    const out = renderDiff(PLAN_A, PLAN_B, { mode: "summary" });
    expect(out).toContain("Week 1");
    expect(out).not.toContain("Week 2 changed"); // unchanged
  });

  test("returns 'no changes' when contents identical", () => {
    expect(renderDiff(PLAN_A, PLAN_A, { mode: "summary" })).toContain("No changes detected");
  });

  test("unified mode emits diff hunks", () => {
    const out = renderDiff(PLAN_A, PLAN_B, { mode: "unified" });
    expect(out).toMatch(/-.*12km tempo/);
    expect(out).toMatch(/\+.*14km tempo/);
  });
});
