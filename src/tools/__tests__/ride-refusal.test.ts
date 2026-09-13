// Rides have no analysis layer yet. Both analysis tools accept any activity ID,
// so without a guard a 40 km ride gets classified by "pace" against easy-run
// references, or bout-analysed as if it were basketball. These pin the refusal.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getRunAnalysisTool } from "../run-analysis.js";
import { getSessionAnalysisTool } from "../session-analysis.js";
import { getDb, closeDb } from "../../utils/activities-db.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

function seedRide(id: number, sportType: "Ride" | "VirtualRide") {
  getDb().prepare(`
    INSERT INTO activities (id, name, type, sport_type, start_date, start_date_local, distance, moving_time, elapsed_time,
      total_elevation_gain, average_speed, max_speed, average_heartrate, trainer)
    VALUES (?, 'Ride', 'Ride', ?, '2026-09-10T17:00:00Z', '2026-09-10T20:00:00Z', 40000, 5400, 5500, 300, 7.4, 14, 138, ?)
  `).run(id, sportType, sportType === "VirtualRide" ? 1 : 0);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-ride-refusal-"));
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

describe("ride refusal", () => {
  for (const sportType of ["Ride", "VirtualRide"] as const) {
    test(`get_run_analysis refuses a ${sportType} instead of classifying it as a run`, async () => {
      seedRide(1, sportType);
      const result = await call(getRunAnalysisTool, { activity_id: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/ride/i);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM activity_analysis WHERE activity_id = 1").get()).toEqual({ n: 0 });
    });

    test(`get_session_analysis refuses a ${sportType} instead of bout-analysing it`, async () => {
      seedRide(2, sportType);
      const result = await call(getSessionAnalysisTool, { activity_id: 2 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/ride/i);
    });
  }
});
