import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const tmp = mkdtempSync(path.join(tmpdir(), "runnai-garmin-"));
mkdirSync(path.join(tmp, "strava"), { recursive: true });
process.env.RUNNAI_DATA_DIR = tmp;

const { upsertActivities, upsertGear, getGearWithUsage, getActivitiesWithoutDetail, findActivityNearStart } =
  await import("../../utils/activities-db.js");
const { dropCrossSourceDuplicates, resolveSince } = await import("../client.js");
const { getDataSource } = await import("../../utils/data-source.js");

function activity(id: number, startUtc: string, source?: "strava" | "garmin"): any {
  return {
    id, name: `Run ${id}`, type: "Run", sport_type: "Run",
    start_date: startUtc, start_date_local: startUtc,
    distance: 10000, moving_time: 3000, elapsed_time: 3000,
    total_elevation_gain: 0, average_speed: 3.3, max_speed: 4, trainer: false,
    source,
  };
}

afterEach(() => {
  delete process.env.RUNNAI_DATA_SOURCE;
});

describe("data source resolution", () => {
  test("defaults to strava, then config.json, env var wins", () => {
    expect(getDataSource()).toBe("strava");
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ dataSource: "garmin" }));
    expect(getDataSource()).toBe("garmin");
    process.env.RUNNAI_DATA_SOURCE = "strava";
    expect(getDataSource()).toBe("strava");
    writeFileSync(path.join(tmp, "config.json"), "{ not json");
    delete process.env.RUNNAI_DATA_SOURCE;
    expect(getDataSource()).toBe("strava");
  });
});

describe("cross-source dedupe", () => {
  test("a Garmin activity within 60 s of a Strava row is the same session", () => {
    upsertActivities([activity(90000000001, "2026-04-12T07:00:00Z")]);

    const kept = dropCrossSourceDuplicates([
      activity(24000000001, "2026-04-12T07:00:59Z", "garmin"), // same session, 59 s apart
      activity(24000000002, "2026-04-12T07:01:01Z", "garmin"), // 61 s — a different session
      activity(24000000003, "2026-04-13T07:00:00Z", "garmin"),
    ]);
    expect(kept.map(a => a.id)).toEqual([24000000002, 24000000003]);
  });

  test("re-syncing a Garmin row does not dedupe it against itself", () => {
    upsertActivities([activity(24000000010, "2026-05-01T06:00:00Z", "garmin")]);
    expect(dropCrossSourceDuplicates([activity(24000000010, "2026-05-01T06:00:00Z", "garmin")]).length).toBe(1);
    expect(findActivityNearStart("2026-05-01T06:00:30Z", 60)).toBe(24000000010);
  });
});

describe("source-scoped queries", () => {
  test("detail backfill only offers rows the active source can fetch", () => {
    upsertActivities([
      activity(90000000020, "2026-03-01T07:00:00Z"),
      activity(24000000020, "2026-06-01T07:00:00Z", "garmin"),
    ]);
    const ids = () => getActivitiesWithoutDetail(100).map(a => a.id);
    expect(ids()).toContain(90000000020);
    expect(ids()).not.toContain(24000000020);
    process.env.RUNNAI_DATA_SOURCE = "garmin";
    expect(ids()).toContain(24000000020);
    expect(ids()).not.toContain(90000000020);
  });

  test("gear lists only the active source's shoes", () => {
    upsertGear([
      { id: "g1", name: "Strava Shoe", primary: true, distance: 500000, retired: false },
      { id: "garmin:abc", name: "Garmin Shoe", primary: false, distance: 300000, retired: false },
    ]);
    expect(getGearWithUsage().map(g => g.name)).toEqual(["Strava Shoe"]);
    process.env.RUNNAI_DATA_SOURCE = "garmin";
    expect(getGearWithUsage().map(g => g.name)).toEqual(["Garmin Shoe"]);
  });
});

describe("resolveSince", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  test("incremental steps back a day from the latest activity", () => {
    expect(resolveSince(30, undefined, true, "2026-06-08T09:00:00Z", now)).toBe("2026-06-07");
  });
  test("first incremental sync pulls 180 days", () => {
    expect(resolveSince(30, undefined, true, null, now)).toBe("2025-12-12");
  });
  test("explicit date and full window", () => {
    expect(resolveSince(30, "2026-05-01", false, null, now)).toBe("2026-05-01");
    expect(resolveSince(7, undefined, false, null, now)).toBe("2026-06-03");
  });
});
