import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { athleteNotesFromDescription, STRAVA_ATTRIBUTION } from "../athlete-notes.js";
import { getDb, closeDb, upsertActivities, setActivityDescription } from "../activities-db.js";
import type { StravaActivity } from "../../types/index.js";

// The athlete's own Strava description is the only Class C source the data
// pipeline can carry (how it felt, what the intent was). It never reached the
// coach: the list endpoint doesn't return it, and the detail fetch discarded it.

describe("athleteNotesFromDescription", () => {
  test("returns the athlete's text trimmed", () => {
    expect(athleteNotesFromDescription("  legs heavy after yesterday's game \n")).toBe("legs heavy after yesterday's game");
  });

  test("returns null for empty or missing text", () => {
    expect(athleteNotesFromDescription(null)).toBeNull();
    expect(athleteNotesFromDescription("")).toBeNull();
    expect(athleteNotesFromDescription("   \n ")).toBeNull();
  });

  test("returns null when the description is the coach's own Strava push", () => {
    // After a write-back, the live description is the coach's public post plus
    // the attribution line. Re-syncing that must not present the coach's words
    // back to the coach as the athlete's account.
    expect(athleteNotesFromDescription("Steady 12k, HR settled early." + STRAVA_ATTRIBUTION)).toBeNull();
  });
});

describe("activity description persistence", () => {
  let tmp: string;
  let originalEnv: string | undefined;

  const summary = (id: number, extra: Partial<StravaActivity> = {}): StravaActivity => ({
    id, name: "Morning Run", type: "Run", sport_type: "Run",
    start_date: "2026-09-01T06:00:00Z", start_date_local: "2026-09-01T08:00:00Z",
    distance: 10000, moving_time: 3000, elapsed_time: 3100, total_elevation_gain: 40,
    average_speed: 3.33, max_speed: 4, ...extra,
  });

  const readDescription = (id: number) =>
    (getDb().prepare("SELECT description FROM activities WHERE id = ?").get(id) as { description: string | null }).description;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-athlete-notes-"));
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

  test("setActivityDescription stores the detail-endpoint description", () => {
    upsertActivities([summary(1)]);
    setActivityDescription(1, "felt flat, slept badly");
    expect(readDescription(1)).toBe("felt flat, slept badly");
  });

  test("re-syncing from the list endpoint keeps a stored description", () => {
    // Incremental sync re-upserts the latest activity from the summary list,
    // which carries no description field. That must not wipe what the detail
    // fetch stored.
    upsertActivities([summary(2)]);
    setActivityDescription(2, "tempo by feel");
    upsertActivities([summary(2)]);
    expect(readDescription(2)).toBe("tempo by feel");
  });

  test("an explicit description in the upsert still wins", () => {
    upsertActivities([summary(3, { description: "first" })]);
    upsertActivities([summary(3, { description: "second" })]);
    expect(readDescription(3)).toBe("second");
  });
});
