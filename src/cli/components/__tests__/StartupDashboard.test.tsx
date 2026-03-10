import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { StartupDashboard } from "../StartupDashboard.js";
import type { StartupContext } from "../../../utils/startup-sync.js";

const baseCtx: StartupContext = {
  sync: { status: "up_to_date", message: "Already up to date.", newRunIds: [] },
  recentSummary: "",
  planExcerpt: null,
  raceCountdowns: [],
};

describe("StartupDashboard", () => {
  test("renders generic greeting when loading (ctx=null)", () => {
    const { lastFrame } = render(<StartupDashboard ctx={null} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("Coach");
    expect(output).toContain("Syncing your training data");
  });

  test("renders sync status for no-op", () => {
    const { lastFrame } = render(<StartupDashboard ctx={baseCtx} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("Strava synced");
    expect(output).toContain("up to date");
  });

  test("renders personalized greeting replacing generic", () => {
    const { lastFrame } = render(
      <StartupDashboard ctx={baseCtx} greeting="Build phase starts today!" />
    );
    const output = lastFrame()!;
    expect(output).toContain("Build phase starts today!");
    expect(output).not.toContain("Syncing your training data");
    expect(output).not.toContain("Warming up");
  });

  test("renders race countdowns", () => {
    const ctx: StartupContext = {
      ...baseCtx,
      raceCountdowns: [
        { name: "Vienna Marathon", date: "2026-04-19", daysAway: 42, weeksAway: 6 },
        { name: "Race to the Stones", date: "2026-07-11", daysAway: 125, weeksAway: 18 },
      ],
    };
    const { lastFrame } = render(<StartupDashboard ctx={ctx} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("Vienna Marathon");
    expect(output).toContain("42 days");
    expect(output).toContain("6 weeks");
    expect(output).toContain("Race to the Stones");
  });

  test("renders plan excerpt current week", () => {
    const ctx: StartupContext = {
      ...baseCtx,
      planExcerpt: {
        name: "vienna-marathon-2026",
        currentWeek: "## Week 1: Build 1\n\n| Day | Session |\n|---|---|\n| Mon | Easy 9km |",
        nextWeek: "",
      },
    };
    const { lastFrame } = render(<StartupDashboard ctx={ctx} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("vienna-marathon-2026");
    expect(output).toContain("Week 1");
    expect(output).toContain("Mon");
    expect(output).toContain("Easy 9km");
  });

  test("renders new activities sync status", () => {
    const ctx: StartupContext = {
      ...baseCtx,
      sync: {
        status: "new_activities",
        message: '2 new activities synced.\n\n- Mar 7: "Tempo 8K" (id: 123) — 9.7km @ 5:05/km',
        newRunIds: [123],
      },
    };
    const { lastFrame } = render(<StartupDashboard ctx={ctx} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("2 new activities");
  });

  test("renders error state with auth hint", () => {
    const ctx: StartupContext = {
      ...baseCtx,
      sync: { status: "error", message: "Strava not authorized", newRunIds: [], needsAuth: true },
    };
    const { lastFrame } = render(<StartupDashboard ctx={ctx} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("Strava not authorized");
    expect(output).toContain("strava-auth");
  });

  test("renders nothing for missing plan and races", () => {
    const { lastFrame } = render(<StartupDashboard ctx={baseCtx} greeting={null} />);
    const output = lastFrame()!;
    expect(output).toContain("Strava synced");
    expect(output).not.toContain("Week");
  });
});
