// The stream cache used to declare distance_data NOT NULL, which rejected every
// indoor activity: a basketball or gym session has a full 1 Hz heartrate stream
// and no distance at all, so the save threw and the coach had nothing to read.
// These tests pin the fix and the one-time migration of the legacy table.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDb, closeDb, saveActivityStreams, getActivityStreams } from "../activities-db.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-streams-db-"));
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

function insertActivity(id: number, sportType = "Basketball") {
  getDb().prepare(
    `INSERT INTO activities (id, type, sport_type, trainer) VALUES (?, 'Workout', ?, 1)`
  ).run(id, sportType);
}

describe("activity_streams without distance", () => {
  test("a heartrate-only stream round-trips with distance undefined", () => {
    insertActivity(1);
    saveActivityStreams(1, { time: [0, 1, 2], heartrate: [120, 150, 180] });

    const got = getActivityStreams(1);
    expect(got).not.toBeNull();
    expect(got!.time).toEqual([0, 1, 2]);
    expect(got!.heartrate).toEqual([120, 150, 180]);
    expect(got!.distance).toBeUndefined();
  });

  test("a legacy table with NOT NULL distance is migrated and keeps its rows", () => {
    // Build the pre-fix schema: let the current migrations create everything,
    // then swap activity_streams back to the NOT NULL shape a real installed
    // database has.
    getDb();
    closeDb();
    const dbPath = path.join(tmp, "strava", "activities.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE activity_streams;
      CREATE TABLE activity_streams (
        activity_id INTEGER PRIMARY KEY REFERENCES activities(id),
        time_data TEXT NOT NULL,
        distance_data TEXT NOT NULL,
        heartrate_data TEXT,
        altitude_data TEXT,
        grade_smooth_data TEXT,
        cadence_data TEXT,
        fetched_at TEXT
      );
      INSERT INTO activities (id, type, trainer) VALUES (7, 'Run', 0);
      INSERT INTO activity_streams (activity_id, time_data, distance_data, heartrate_data, fetched_at)
        VALUES (7, '[0,1]', '[0,3]', '[130,131]', '2026-01-01T00:00:00Z');
    `);
    legacy.close();

    // Opening through getDb runs the migrations.
    const existing = getActivityStreams(7);
    expect(existing).toEqual({
      time: [0, 1], distance: [0, 3], heartrate: [130, 131],
      altitude: undefined, grade_smooth: undefined, cadence: undefined,
    });

    insertActivity(8);
    saveActivityStreams(8, { time: [0, 1], heartrate: [140, 141] });
    expect(getActivityStreams(8)!.distance).toBeUndefined();

    const notnull = (getDb().prepare("PRAGMA table_info(activity_streams)").all() as { name: string; notnull: number }[])
      .find(c => c.name === "distance_data")!.notnull;
    expect(notnull).toBe(0);
  });
});
