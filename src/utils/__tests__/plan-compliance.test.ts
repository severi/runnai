import { describe, test, expect } from "bun:test";
import { buildComplianceEntries, type ActivityRow } from "../plan-compliance.js";
import type { ParsedWorkout } from "../plan-parser.js";

const workouts: ParsedWorkout[] = [
  {
    weekNumber: 1,
    sessionIndex: 0,
    date: "2026-03-09T00:00:00",
    sessionName: "Easy",
    details: "9km easy, 5:50-6:20/km.",
    externalId: "runnai:test:w1:s0",
  },
  {
    weekNumber: 1,
    sessionIndex: 1,
    date: "2026-03-10T00:00:00",
    sessionName: "Tempo",
    details: "12km total: 2km WU, 30min tempo, 2km CD.",
    externalId: "runnai:test:w1:s1",
  },
  {
    weekNumber: 1,
    sessionIndex: 2,
    date: "2026-03-14T00:00:00",
    sessionName: "Long Run",
    details: "26km easy with 12km at MP.",
    externalId: "runnai:test:w1:s2",
  },
];

function makeActivity(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: 1,
    name: "Run",
    distance: 10000,
    moving_time: 3600,
    run_type: "easy",
    start_date_local: "2026-03-09T07:00:00",
    ...overrides,
  };
}

describe("buildComplianceEntries", () => {
  test("matches activities to planned workouts by date prefix", () => {
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, distance: 9100, moving_time: 3300, start_date_local: "2026-03-09T07:00:00" }),
      makeActivity({ id: 2, distance: 12200, moving_time: 3700, start_date_local: "2026-03-10T18:30:00", run_type: "tempo" }),
      makeActivity({ id: 3, distance: 26400, moving_time: 8800, start_date_local: "2026-03-14T08:15:00", run_type: "long_run" }),
    ];
    const result = buildComplianceEntries(workouts, activities, new Date(2026, 2, 15));
    expect(result).toHaveLength(3);
    expect(result[0].status).toBe("completed");
    expect(result[0].actual?.id).toBe(1);
    expect(result[0].actual?.distance_km).toBe(9.1);
    expect(result[1].status).toBe("completed");
    expect(result[1].actual?.id).toBe(2);
    expect(result[2].status).toBe("completed");
    expect(result[2].actual?.id).toBe(3);
  });

  test("marks past planned workouts without activities as missed", () => {
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, start_date_local: "2026-03-09T07:00:00" }),
    ];
    const result = buildComplianceEntries(workouts, activities, new Date(2026, 2, 15));
    expect(result[0].status).toBe("completed");
    expect(result[1].status).toBe("missed");
    expect(result[1].actual).toBeNull();
    expect(result[2].status).toBe("missed");
  });

  test("marks future planned workouts as upcoming", () => {
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, start_date_local: "2026-03-09T07:00:00" }),
    ];
    // Today is Mar 10 — Mar 14 (long run) is in the future
    const result = buildComplianceEntries(workouts, activities, new Date(2026, 2, 10));
    expect(result[0].status).toBe("completed");
    expect(result[1].status).toBe("upcoming"); // Tempo today, no activity yet
    expect(result[2].status).toBe("upcoming"); // Long run in 4 days
  });

  test("treats today's planned date with no activity as upcoming, not missed", () => {
    const todayWorkout: ParsedWorkout = {
      weekNumber: 1,
      sessionIndex: 0,
      date: "2026-03-10T00:00:00",
      sessionName: "Tempo",
      details: "12km total.",
      externalId: "runnai:test:w1:s0",
    };
    const result = buildComplianceEntries([todayWorkout], [], new Date(2026, 2, 10));
    expect(result[0].status).toBe("upcoming");
  });

  test("picks the longest activity when multiple runs happen on the same day", () => {
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, distance: 3000, start_date_local: "2026-03-09T06:00:00", name: "Shakeout" }),
      makeActivity({ id: 2, distance: 9100, start_date_local: "2026-03-09T17:00:00", name: "Main run" }),
    ];
    const result = buildComplianceEntries([workouts[0]], activities, new Date(2026, 2, 15));
    expect(result[0].actual?.id).toBe(2);
    expect(result[0].actual?.name).toBe("Main run");
    expect(result[0].extras).toHaveLength(1);
    expect(result[0].extras[0].id).toBe(1);
    expect(result[0].extras[0].name).toBe("Shakeout");
  });

  test("extras is empty when at most one run happens on the planned day", () => {
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, distance: 9100, start_date_local: "2026-03-09T06:00:00", name: "Solo" }),
    ];
    const result = buildComplianceEntries([workouts[0]], activities, new Date(2026, 2, 15));
    expect(result[0].actual?.id).toBe(1);
    expect(result[0].extras).toHaveLength(0);
  });

  test("computes pace correctly from distance and moving_time", () => {
    const activities: ActivityRow[] = [
      // 9100m in 3000s = 5:30/km = 330 sec/km
      makeActivity({ id: 1, distance: 9100, moving_time: 3000, start_date_local: "2026-03-09T07:00:00" }),
    ];
    const result = buildComplianceEntries([workouts[0]], activities, new Date(2026, 2, 15));
    expect(result[0].actual?.pace_sec_per_km).toBe(330);
  });

  test("returns empty array when no workouts provided", () => {
    const result = buildComplianceEntries([], [], new Date(2026, 2, 15));
    expect(result).toHaveLength(0);
  });

  test("preserves planned session name and details on each entry", () => {
    const result = buildComplianceEntries(workouts, [], new Date(2026, 2, 15));
    expect(result[0].planned.sessionName).toBe("Easy");
    expect(result[1].planned.sessionName).toBe("Tempo");
    expect(result[1].planned.details).toBe("12km total: 2km WU, 30min tempo, 2km CD.");
    expect(result[0].planned.date).toBe("2026-03-09");
  });

  test("tags each entry with the actual weekday of its date (no off-by-one)", () => {
    const result = buildComplianceEntries(workouts, [], new Date(2026, 2, 15));
    // 2026-03-09 is a Monday, 03-10 Tuesday, 03-14 Saturday — by date, not plan position.
    expect(result[0].planned.weekday).toBe("Monday");
    expect(result[1].planned.weekday).toBe("Tuesday");
    expect(result[2].planned.weekday).toBe("Saturday");
  });

  test("actual.weekday derives from the activity's local date, not a TZ-shifted parse", () => {
    // A late-evening run stored with a trailing Z must still report its local weekday.
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, start_date_local: "2026-03-14T23:30:00Z" }),
    ];
    const result = buildComplianceEntries([workouts[2]], activities, new Date(2026, 2, 15));
    expect(result[0].actual?.weekday).toBe("Saturday");
  });

  test("completedRunIndex counts only completed runs in date order, skipping missed", () => {
    // Middle workout (Tue Tempo) has no activity → missed; it must not consume an index.
    const activities: ActivityRow[] = [
      makeActivity({ id: 1, start_date_local: "2026-03-09T07:00:00" }),
      makeActivity({ id: 3, start_date_local: "2026-03-14T08:15:00" }),
    ];
    const result = buildComplianceEntries(workouts, activities, new Date(2026, 2, 15));
    expect(result[0].status).toBe("completed");
    expect(result[0].completedRunIndex).toBe(1);
    expect(result[1].status).toBe("missed");
    expect(result[1].completedRunIndex).toBeNull();
    expect(result[2].status).toBe("completed");
    expect(result[2].completedRunIndex).toBe(2); // not 3 — the missed row is skipped
  });
});
