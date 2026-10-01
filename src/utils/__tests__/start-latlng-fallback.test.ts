// Strava can return `start_latlng: []` (and an empty summary polyline) for a
// run that has full GPS — seen on a watch "Track Run" mode activity whose
// latlng stream carried a point every second. With no start coordinates the
// run got no weather and the coach told the athlete it "had no GPS data".
// The latlng stream is the fallback, and a later re-sync of the summary must
// not wipe the recovered coordinates.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDb, closeDb, saveActivityStreams, upsertActivities } from "../activities-db.js";
import type { StravaActivity } from "../../types/index.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-latlng-"));
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

function trackRun(start_latlng: StravaActivity["start_latlng"]): StravaActivity {
  return {
    id: 90000000001, name: "Cooper", type: "Run", sport_type: "Run",
    start_date: "2026-10-01T15:20:27Z", start_date_local: "2026-10-01T18:20:27Z",
    distance: 3273, moving_time: 720, elapsed_time: 725, total_elevation_gain: 0,
    average_speed: 4.5, max_speed: 5.5, trainer: false, start_latlng,
  } as StravaActivity;
}

function coords() {
  return getDb().prepare(
    "SELECT start_latitude, start_longitude FROM activities WHERE id = 90000000001"
  ).get() as { start_latitude: number | null; start_longitude: number | null };
}

describe("start coordinates fallback", () => {
  test("an empty start_latlng is filled from the first latlng stream point", () => {
    upsertActivities([trackRun([] as unknown as [number, number])]);
    expect(coords()).toEqual({ start_latitude: null, start_longitude: null });

    saveActivityStreams(90000000001, { time: [0, 1], latlng: [[52.37, 4.9], [52.371, 4.901]] });
    expect(coords()).toEqual({ start_latitude: 52.37, start_longitude: 4.9 });
  });

  test("the stream never overrides coordinates Strava did send", () => {
    upsertActivities([trackRun([52.0, 4.0])]);
    saveActivityStreams(90000000001, { time: [0, 1], latlng: [[52.37, 4.9], [52.371, 4.901]] });
    expect(coords()).toEqual({ start_latitude: 52.0, start_longitude: 4.0 });
  });

  test("re-upserting the summary keeps recovered coordinates", () => {
    upsertActivities([trackRun([] as unknown as [number, number])]);
    saveActivityStreams(90000000001, { time: [0, 1], latlng: [[52.37, 4.9]] });
    upsertActivities([trackRun([] as unknown as [number, number])]);
    expect(coords()).toEqual({ start_latitude: 52.37, start_longitude: 4.9 });
  });
});
