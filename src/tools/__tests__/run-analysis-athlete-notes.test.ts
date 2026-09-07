import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getRunAnalysisTool } from "../run-analysis.js";
import { getDb, closeDb } from "../../utils/activities-db.js";
import { CURRENT_ANALYSIS_VERSION } from "../../utils/activity-analysis.js";
import { STRAVA_ATTRIBUTION } from "../../utils/athlete-notes.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

function seedRun(id: number, description: string | null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO activities (id, name, type, sport_type, start_date, start_date_local, distance, moving_time, elapsed_time,
      total_elevation_gain, average_speed, max_speed, average_heartrate, description, trainer)
    VALUES (?, 'Morning Run', 'Run', 'Run', '2026-09-01T06:00:00Z', '2026-09-01T08:00:00Z', 10000, 3000, 3100, 40, 3.33, 4, 145, ?, 0)
  `).run(id, description);
  db.prepare(`
    INSERT INTO activity_analysis (activity_id, run_type, distance_m, moving_time_s, pace_sec_per_km, avg_heartrate,
      lap_summaries, analyzed_at, analysis_version)
    VALUES (?, 'easy', 10000, 3000, 300, 145, '[]', ?, ?)
  `).run(id, new Date().toISOString(), CURRENT_ANALYSIS_VERSION);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-run-notes-"));
  await fs.mkdir(path.join(tmp, "strava"), { recursive: true });
  await fs.mkdir(path.join(tmp, "athlete"), { recursive: true });
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

describe("get_run_analysis athlete_notes", () => {
  test("surfaces the athlete's Strava description as athlete_notes", async () => {
    seedRun(1, "legs heavy from Tuesday's game, kept it honest");
    const out = JSON.parse((await call(getRunAnalysisTool, { activity_id: 1 })).content[0].text);
    expect(out.athlete_notes).toBe("legs heavy from Tuesday's game, kept it honest");
  });

  test("athlete_notes is null when there is no description", async () => {
    seedRun(2, null);
    const out = JSON.parse((await call(getRunAnalysisTool, { activity_id: 2 })).content[0].text);
    expect(out.athlete_notes).toBeNull();
  });

  test("the coach's own pushed description does not come back as athlete_notes", async () => {
    seedRun(3, "Steady 10k." + STRAVA_ATTRIBUTION);
    const out = JSON.parse((await call(getRunAnalysisTool, { activity_id: 3 })).content[0].text);
    expect(out.athlete_notes).toBeNull();
  });
});
