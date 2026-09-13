// Rides carry power on Strava's summary list (average/weighted/max watts,
// kilojoules, whether a meter was used). These pin that the sync stores them,
// that a legacy DB grows the columns, and that the watts stream round-trips.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDb, closeDb, upsertActivities, saveActivityStreams, getActivityStreams } from "../activities-db.js";
import type { StravaActivity } from "../../types/index.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-power-"));
  await fs.mkdir(path.join(tmp, "strava"), { recursive: true });
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  closeDb();
});
afterEach(async () => {
  closeDb();
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

const RIDE: StravaActivity = {
  id: 90000000010, name: "Zwift ride", type: "Ride", sport_type: "VirtualRide",
  start_date: "2026-09-10T17:00:00Z", start_date_local: "2026-09-10T20:00:00Z",
  distance: 30000, moving_time: 3600, elapsed_time: 3650, total_elevation_gain: 250,
  average_speed: 8.33, max_speed: 14, average_heartrate: 140, max_heartrate: 165, trainer: true,
  average_watts: 185, weighted_average_watts: 198, max_watts: 520, kilojoules: 666, device_watts: true,
};

const LEGACY_ACTIVITIES = `CREATE TABLE activities (
  id INTEGER PRIMARY KEY, name TEXT, type TEXT, sport_type TEXT, start_date TEXT, start_date_local TEXT,
  distance REAL, moving_time INTEGER, elapsed_time INTEGER, total_elevation_gain REAL, average_speed REAL, max_speed REAL,
  average_heartrate REAL, max_heartrate REAL, suffer_score INTEGER, average_cadence REAL, workout_type INTEGER,
  description TEXT, trainer INTEGER DEFAULT 0
)`;

describe("ride power on the summary list", () => {
  test("upsert stores average, weighted and max watts, kilojoules and the meter flag", () => {
    upsertActivities([RIDE]);
    const row = getDb().prepare(
      "SELECT average_watts, weighted_average_watts, max_watts, kilojoules, device_watts FROM activities WHERE id = ?"
    ).get(RIDE.id) as Record<string, number | null>;
    expect(row).toEqual({ average_watts: 185, weighted_average_watts: 198, max_watts: 520, kilojoules: 666, device_watts: 1 });
  });

  test("an activity without power stores nulls, not zeros", () => {
    const { average_watts, weighted_average_watts, max_watts, kilojoules, device_watts, ...noPower } = RIDE;
    upsertActivities([{ ...noPower, id: 90000000011 }]);
    const row = getDb().prepare(
      "SELECT average_watts, weighted_average_watts, max_watts, kilojoules, device_watts FROM activities WHERE id = ?"
    ).get(90000000011) as Record<string, number | null>;
    expect(row).toEqual({ average_watts: null, weighted_average_watts: null, max_watts: null, kilojoules: null, device_watts: null });
  });

  test("a legacy database without power columns gains them on open", () => {
    const legacy = new Database(path.join(tmp, "strava", "activities.db"));
    legacy.exec(LEGACY_ACTIVITIES);
    legacy.close();

    const cols = (getDb().prepare("PRAGMA table_info(activities)").all() as { name: string }[]).map(c => c.name);
    for (const c of ["average_watts", "weighted_average_watts", "max_watts", "kilojoules", "device_watts"]) {
      expect(cols).toContain(c);
    }
  });
});

describe("watts stream", () => {
  test("round-trips through the stream cache", () => {
    upsertActivities([RIDE]);
    saveActivityStreams(RIDE.id, { time: [0, 1, 2], heartrate: [120, 130, 140], watts: [150, 210, 180] });
    expect(getActivityStreams(RIDE.id)?.watts).toEqual([150, 210, 180]);
  });

  test("is undefined when the activity has none", () => {
    upsertActivities([RIDE]);
    saveActivityStreams(RIDE.id, { time: [0, 1, 2], heartrate: [120, 130, 140] });
    expect(getActivityStreams(RIDE.id)?.watts).toBeUndefined();
  });

  test("a legacy stream table without watts_data gains the column on open", () => {
    const legacy = new Database(path.join(tmp, "strava", "activities.db"));
    legacy.exec(LEGACY_ACTIVITIES);
    legacy.exec(`CREATE TABLE activity_streams (activity_id INTEGER PRIMARY KEY REFERENCES activities(id), time_data TEXT NOT NULL,
      distance_data TEXT, heartrate_data TEXT, altitude_data TEXT, grade_smooth_data TEXT, cadence_data TEXT, fetched_at TEXT)`);
    legacy.exec(`INSERT INTO activities (id, type, sport_type) VALUES (7, 'Ride', 'Ride')`);
    legacy.exec(`INSERT INTO activity_streams (activity_id, time_data, heartrate_data) VALUES (7, '[0,1]', '[100,110]')`);
    legacy.close();

    saveActivityStreams(7, { time: [0, 1], heartrate: [100, 110], watts: [200, 220] });
    expect(getActivityStreams(7)?.watts).toEqual([200, 220]);
  });
});
